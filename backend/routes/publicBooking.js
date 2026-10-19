/**
 * @file publicBooking.js
 * @description Online booking with the slot engine — the Phase 2 half of
 * `/api/public/*` (CONTROL_FLOW_AND_DATA_LOGIC.md §5, §14, T2.5–T2.8).
 *
 *   GET  /availability                      free start times for a date       60/IP/min
 *   POST /quote                             server price + payment options    60/IP/min
 *   POST /otp/send                          WhatsApp code     Turnstile · 3/phone/15 min · 10/IP/h
 *   POST /otp/verify                        → bookingToken (30 min)           5 tries per code
 *   POST /appointments                      create (hold + Razorpay order)    Turnstile · 5/phone/day
 *   POST /appointments/:ref/verify-payment  browser confirmation              NEVER limited
 *   GET  /booking/:token                    manage page (§9)                  30/IP/min
 *   GET  /booking/:token/calendar.ics       add to calendar
 *   GET  /booking/:token/availability       times to move to
 *   POST /booking/:token/cancel             customer cancels (fee kept, D18)   5/link/day
 *   POST /booking/:token/reschedule         customer moves it                  5/link/day
 *
 * Mounted inside routes/public.js, so it shares that router's connectDB
 * middleware and its place before the session and the global limiter (D16).
 *
 * ── Money ────────────────────────────────────────────────────────────────────
 * No route here accepts a price. The browser sends service ids and "full" or
 * "deposit"; utils/quote.js computes everything (CLAUDE.md). verify-payment
 * is payment-critical: it carries no rate limit, because throttling the call
 * that records money already taken is how 14 payments were lost. The Razorpay
 * webhook does the same job server-to-server and is the source of truth;
 * whichever arrives second changes nothing (E5).
 *
 * ── Who sees this ────────────────────────────────────────────────────────────
 * Engine bookings only exist for artists with `onlineBookable: true` (T2.22).
 * With nobody switched on, /availability returns no slots and the website
 * stays on request-lite (POST /requests).
 */

const express = require("express");
const { body, query, param, validationResult } = require("express-validator");
const Customer = require("../models/Customer");
const Appointment = require("../models/Appointment");
const SiteSettings = require("../models/SiteSettings");
const { mongoRateLimit, hit } = require("../middleware/mongoRateLimit");
const { verifyTurnstile } = require("../utils/turnstile");
const { clientIp } = require("../utils/audit");
const { salonDate, isValidDate, daysBetween } = require("../utils/time");
const { buildQuote } = require("../utils/quote");
const bookingToken = require("../utils/bookingToken");
const otp = require("../utils/otp");
const payments = require("../utils/payments");
const booking = require("../utils/booking");

const router = express.Router();

const HOUR = 60 * 60 * 1000;
const MAX_ITEMS_PER_GUEST = 8;
const UTM_FIELDS = ["source", "medium", "campaign", "content", "fbclid"];

/** public.js helpers, loaded lazily: public.js requires this file while it is still loading. */
const pub = () => require("./public");

const perIpMinute = (name) => mongoRateLimit({ name, windowMs: 60_000, max: 60 });

function sendValidation(res, errors) {
  return res.status(400).json({
    error: "VALIDATION",
    message: errors[0]?.msg || "Check the details and try again.",
    fields: errors.map((e) => e.path),
  });
}

/** BookingError → its status + stable code (§14); anything else → 500. */
function sendError(res, err, where) {
  if (err?.code && err.status) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...(err.alternatives ? { alternatives: err.alternatives } : {}),
    });
  }
  console.error(`[public-booking] ${where} error:`, err);
  return res.status(500).json({ error: "SERVER_ERROR", message: "Something went wrong. Try again, or message us on WhatsApp." });
}

/** §18: reject unknown top-level fields instead of ignoring them. */
const only = (fields) => (req, res, next) => {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    return res.status(400).json({ error: "VALIDATION", message: "Send the request as JSON." });
  }
  const unknown = Object.keys(b).filter((k) => !fields.includes(k));
  if (unknown.length) return res.status(400).json({ error: "VALIDATION", message: "Unexpected fields.", fields: unknown });
  return next();
};

async function resolvePackage(slug) {
  if (!slug) return null;
  const pkg = (await pub().livePackages()).find((p) => p.slug === slug);
  if (!pkg) throw new booking.BookingError("PACKAGE_UNAVAILABLE", "That package isn't available any more.");
  return pkg;
}

async function resolveArtist(slug) {
  if (!slug) return null;
  const match = (await pub().loadPublicArtists()).find((a) => a.slug === slug);
  if (!match) throw new booking.BookingError("ARTIST_UNAVAILABLE", "That artist isn't taking online bookings.");
  return String(match.doc._id);
}

const guestValidators = (field) => [
  body(field).isArray({ min: 1 }).withMessage("Choose at least one service."),
  body(`${field}.*.services`).isArray({ min: 0, max: MAX_ITEMS_PER_GUEST }).withMessage(`Choose up to ${MAX_ITEMS_PER_GUEST} services per person.`),
  body(`${field}.*.services.*`).isMongoId().withMessage("Unknown service."),
  body(`${field}.*.for`).optional({ nullable: true }).isIn(["her", "him"]).withMessage("Choose who each visit is for."),
  body(`${field}.*.name`).optional({ nullable: true }).isString().trim().isLength({ max: 60 }),
  body(`${field}.*`).custom((g) => {
    const extra = Object.keys(g || {}).filter((k) => !["services", "for", "name"].includes(k));
    if (extra.length) throw new Error("Unexpected fields.");
    return true;
  }),
];

// ─── GET /availability ───────────────────────────────────────────────────────
/**
 * ?date=YYYY-MM-DD&g=<id>,<id>&g=<id>&artist=<slug>&package=<slug>
 * Each `g` is one guest's services (group booking = several `g`, §4.2).
 */
router.get(
  "/availability",
  perIpMinute("availability"),
  [
    query("date").custom(isValidDate).withMessage("Choose a date."),
    query("artist").optional().matches(/^[a-z0-9-]{1,80}$/),
    query("package").optional().matches(/^[a-z0-9-]{1,80}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidation(res, errors.array());
    try {
      const raw = [].concat(req.query.g ?? []).map((s) => String(s).split(",").filter(Boolean));
      if (!raw.length && !req.query.package) raw.push([]);
      if (raw.some((ids) => ids.length > MAX_ITEMS_PER_GUEST || ids.some((id) => !/^[a-f0-9]{24}$/.test(id)))) {
        return res.status(400).json({ error: "VALIDATION", message: "Unknown service.", fields: ["g"] });
      }
      const settings = await SiteSettings.getSingleton();
      if (raw.length > settings.maxGuests) {
        return res.status(400).json({ error: "VALIDATION", message: `Book up to ${settings.maxGuests} people at a time.` });
      }
      const ahead = daysBetween(salonDate(), req.query.date);
      if (ahead < 0 || ahead > settings.horizonDays) {
        return res.status(400).json({ error: "OUTSIDE_HOURS", message: `Choose a date within the next ${settings.horizonDays} days.` });
      }

      const pkg = await resolvePackage(req.query.package);
      const artistId = await resolveArtist(req.query.artist);
      const selection = await booking.prepareSelection(raw.length ? raw.map((services) => ({ services })) : [{ services: [] }], pkg);
      const out = await booking.findSlots({ date: req.query.date, selection, artistId });

      // Short shared cache: bursts are absorbed, a taken slot reappears for ≤ 30 s
      // at most — and the create call re-checks anyway (§4.3).
      res.set("Cache-Control", "public, s-maxage=30, stale-while-revalidate=30");
      return res.json({ date: req.query.date, mode: out.mode, patchTestDelay: out.patchTestDelay, slots: out.slots });
    } catch (err) {
      return sendError(res, err, "availability");
    }
  }
);

// ─── POST /quote ─────────────────────────────────────────────────────────────
router.post("/quote", only(["guests", "packageSlug"]), perIpMinute("quote"), [
  ...guestValidators("guests"),
  body("packageSlug").optional({ nullable: true }).matches(/^[a-z0-9-]{1,80}$/),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidation(res, errors.array());
  try {
    const settings = (await SiteSettings.getSingleton()).toObject();
    if (req.body.guests.length > settings.maxGuests) {
      return res.status(400).json({ error: "VALIDATION", message: `Book up to ${settings.maxGuests} people at a time.` });
    }
    const pkg = await resolvePackage(req.body.packageSlug);
    const selection = await booking.prepareSelection(req.body.guests, pkg);
    const quote = buildQuote({ guests: selection.guests, services: selection.services, settings, pkg });
    return res.json({ ...quote, mode: "instant" });
  } catch (err) {
    return sendError(res, err, "quote");
  }
});

// ─── POST /otp/send ──────────────────────────────────────────────────────────
const phoneField = body("phone")
  .customSanitizer((v) => Customer.normalisePhone(v))
  .custom((v) => v !== null)
  .withMessage("Enter a 10-digit mobile number.");

router.post(
  "/otp/send",
  only(["phone", "turnstileToken"]),
  mongoRateLimit({ name: "otp-ip", windowMs: HOUR, max: 10 }),
  [phoneField, body("turnstileToken").optional({ nullable: true }).isString()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidation(res, errors.array());
    try {
      const ts = await verifyTurnstile(req.body.turnstileToken, clientIp(req));
      if (!ts.ok) return res.status(400).json({ error: "TURNSTILE_FAILED", message: "Couldn't verify you're human. Try again." });

      const phoneHit = await hit({ name: "otp-phone", id: req.body.phone, windowMs: 15 * 60_000, max: 3 });
      if (!phoneHit.allowed) {
        return res.status(429).json({ error: "LIMIT_REACHED", message: "We've sent a few codes already. Wait 15 minutes and try again." });
      }
      const sent = await otp.send(req.body.phone);
      if (!sent.ok) {
        return res.status(503).json({ error: "OTP_UNAVAILABLE", message: "We couldn't send a code right now. Message us on WhatsApp to book." });
      }
      // Same reply whether or not the number is a customer: no enumeration (§18).
      return res.json({ sent: true, channel: sent.channel === "dev" ? "dev" : "whatsapp", expiresAt: sent.expiresAt });
    } catch (err) {
      return sendError(res, err, "otp send");
    }
  }
);

// ─── POST /otp/verify ────────────────────────────────────────────────────────
router.post(
  "/otp/verify",
  only(["phone", "code"]),
  mongoRateLimit({ name: "otp-verify-ip", windowMs: HOUR, max: 30 }),
  [phoneField, body("code").isString().matches(/^\d{6}$/).withMessage("Enter the 6-digit code.")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidation(res, errors.array());
    try {
      const out = await otp.check(req.body.phone, req.body.code);
      if (!out.ok) {
        return res.status(400).json({
          error: out.error,
          message: out.error === "OTP_INVALID" ? "That code isn't right. Check it and try again." : "That code has expired. Ask for a new one.",
          ...(out.attemptsLeft != null ? { attemptsLeft: out.attemptsLeft } : {}),
        });
      }
      const { token, expiresAt } = bookingToken.issue(req.body.phone);
      // Prefill for a returning customer: their own name only, after proving the phone is theirs.
      const c = await Customer.findOne({ phone: req.body.phone }, { name: 1, gender: 1 }).lean();
      return res.json({
        bookingToken: token,
        expiresAt,
        customer: c ? { name: c.name || null, for: c.gender === "male" ? "him" : c.gender === "female" ? "her" : null } : null,
      });
    } catch (err) {
      return sendError(res, err, "otp verify");
    }
  }
);

// ─── POST /appointments ──────────────────────────────────────────────────────
const APPOINTMENT_FIELDS = [
  "bookingToken", "phone", "name", "guests", "packageSlug", "startAt", "artistSlug",
  "payment", "policyAccepted", "whatsappOptIn", "notes", "utm", "turnstileToken",
];

function cleanUtm(utm) {
  if (!utm || typeof utm !== "object") return null;
  const out = {};
  for (const k of UTM_FIELDS) {
    if (typeof utm[k] === "string" && utm[k].trim()) out[k] = utm[k].trim().slice(0, k === "fbclid" ? 255 : 100);
  }
  return Object.keys(out).length ? out : null;
}

/** The booking's public face: no list prices, no internal notes, no staff phones. */
function publicBooking(appt) {
  return {
    ref: appt.ref,
    status: appt.status,
    mode: appt.mode,
    startAt: appt.startAt,
    endAt: appt.endAt,
    holdExpiresAt: appt.holdExpiresAt,
    guests: appt.guests.map((g) => ({
      key: g.guestKey,
      name: g.name,
      items: g.items.map((i) => ({ name: i.name, price: i.publicPrice, artistName: i.artistName, startAt: i.startAt, endAt: i.endAt })),
    })),
    pricing: { subtotal: appt.pricing.subtotal, discount: appt.pricing.discount, total: appt.pricing.total },
    payment: { kind: appt.deposit.kind, amount: appt.deposit.amount, status: appt.deposit.status },
  };
}

router.post(
  "/appointments",
  only(APPOINTMENT_FIELDS),
  mongoRateLimit({ name: "appointment-ip", windowMs: HOUR, max: 10 }),
  [
    phoneField,
    body("bookingToken").isString().withMessage("Verify your phone number first."),
    body("name").isString().trim().isLength({ min: 2, max: 60 }).withMessage("Enter your name.")
      .matches(/^[\p{L}\p{M} .'-]+$/u).withMessage("Enter your name using letters only."),
    ...guestValidators("guests"),
    body("packageSlug").optional({ nullable: true }).matches(/^[a-z0-9-]{1,80}$/),
    body("artistSlug").optional({ nullable: true }).matches(/^[a-z0-9-]{1,80}$/),
    body("startAt").isISO8601({ strict: true }).withMessage("Pick a time."),
    body("payment").isIn(["full", "deposit"]).withMessage("Choose how you'd like to pay."),
    body("policyAccepted").equals("true").withMessage("Please accept the booking policy."),
    body("whatsappOptIn").optional().isBoolean({ strict: true }),
    body("notes").optional({ nullable: true }).isString().trim().isLength({ max: 300 }).withMessage("Keep the note under 300 characters."),
    body("utm").optional({ nullable: true }).isObject(),
    body("utm.*").optional({ nullable: true }).isString().isLength({ max: 255 }),
    body("turnstileToken").optional({ nullable: true }).isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidation(res, errors.array());
    const b = req.body;
    try {
      if (!bookingToken.verify(b.bookingToken, b.phone)) {
        return res.status(401).json({ error: "OTP_EXPIRED", message: "Your verification has expired. Verify your phone again." });
      }
      const ts = await verifyTurnstile(b.turnstileToken, clientIp(req));
      if (!ts.ok) return res.status(400).json({ error: "TURNSTILE_FAILED", message: "Couldn't verify you're human. Try again." });

      const phoneHit = await hit({ name: "appointment-phone", id: b.phone, windowMs: 24 * HOUR, max: 5 });
      if (!phoneHit.allowed) {
        return res.status(429).json({ error: "LIMIT_REACHED", message: "You've made several bookings today. Message us on WhatsApp for more." });
      }

      const pkg = await resolvePackage(b.packageSlug);
      const artistId = await resolveArtist(b.artistSlug);
      const selection = await booking.prepareSelection(b.guests, pkg);
      const out = await booking.createBooking({
        phone: b.phone,
        name: b.name.trim(),
        selection,
        startAt: b.startAt,
        artistId,
        paymentKind: b.payment,
        utm: cleanUtm(b.utm),
        notes: b.notes,
        whatsappOptIn: b.whatsappOptIn === true,
      });

      return res.status(201).json({
        booking: publicBooking(out.appt),
        manageToken: out.manageToken,
        order: out.order
          ? { id: out.order.id, amount: out.order.amount, currency: out.order.currency || "INR", keyId: process.env.RAZORPAY_KEY_ID || null }
          : null,
      });
    } catch (err) {
      return sendError(res, err, "create");
    }
  }
);

// ─── POST /appointments/:ref/verify-payment ──────────────────────────────────
/**
 * The browser's "I paid" call after Razorpay checkout. The checkout signature
 * proves Razorpay issued this payment for this order. Payment-critical: no
 * rate limit, idempotent, and the webhook makes the same change if this call
 * never arrives.
 */
router.post(
  "/appointments/:ref/verify-payment",
  [
    param("ref").matches(/^EXP-[A-Z0-9]{5}$/),
    body("razorpay_order_id").isString(),
    body("razorpay_payment_id").isString(),
    body("razorpay_signature").isString(),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "VALIDATION", message: "Payment details are missing." });
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
    try {
      if (!payments.checkoutSignatureOk(orderId, paymentId, signature)) {
        return res.status(400).json({ error: "PAYMENT_INVALID", message: "We couldn't verify that payment. If money left your account, message us — it is safe." });
      }
      const appt = await Appointment.findOne({ ref: req.params.ref, "deposit.razorpayOrderId": orderId }, { _id: 1 }).lean();
      if (!appt) return res.status(404).json({ error: "NOT_FOUND", message: "Booking not found." });

      // Amount: the order was created by the server for exactly deposit.amount,
      // and Razorpay only captures that order's amount; the webhook re-checks it.
      const out = await booking.confirmPayment({ orderId, paymentId });
      const current = out.appt || (await Appointment.findById(appt._id).lean());
      return res.json({ outcome: out.outcome, booking: publicBooking(current) });
    } catch (err) {
      return sendError(res, err, "verify-payment");
    }
  }
);

// ─── Manage link (§9, T2.11) ─────────────────────────────────────────────────
/**
 * The link in the confirmation WhatsApp: /booking/<token>. The token is an
 * HMAC of the booking id (D40) and only its hash is stored, so it can't be
 * guessed or enumerated. Anyone holding the link can SEE the booking; cancel
 * and reschedule also need a fresh WhatsApp code once the link is more than
 * a day old (a forwarded message shouldn't be enough to cancel someone).
 */
const manageReadLimit = mongoRateLimit({ name: "manage-read", windowMs: 60_000, max: 30 });
const manageWriteLimit = mongoRateLimit({ name: "manage-write", windowMs: 24 * HOUR, max: 5, keyBy: (req) => String(req.params.token || "").slice(0, 100) });

async function loadManaged(req, res) {
  const appt = await booking.findByManageToken(req.params.token);
  if (!appt) {
    res.status(404).json({ error: "NOT_FOUND", message: "We couldn't find that booking. Check the link in your WhatsApp message." });
    return null;
  }
  return appt;
}

function freshEnough(req, appt, rules) {
  if (!rules.needsOtp) return true;
  return bookingToken.verify(req.body?.bookingToken, appt.contact);
}

router.get("/booking/:token", manageReadLimit, async (req, res) => {
  try {
    const appt = await loadManaged(req, res);
    if (!appt) return;
    const settings = (await SiteSettings.getSingleton()).toObject();
    res.set("Cache-Control", "no-store");
    return res.json({
      booking: publicBooking(appt),
      rules: booking.manageRules(appt, settings),
      refund: appt.refund?.amount ? { amount: appt.refund.amount, status: appt.refund.status } : null,
      // Last two digits only: enough to recognise the number a code would go to.
      phoneHint: `••••••••${String(appt.contact).slice(-2)}`,
      salon: {
        phone: settings.contact?.phone || null,
        whatsapp: settings.contact?.whatsapp || null,
        mapUrl: settings.contact?.mapUrl || null,
        address: settings.contact?.address || null,
        // So "move to another time" lists only the days the salon is open, as the booking sheet does.
        openingHours: settings.openingHours,
        holidays: (settings.holidays || []).filter((d) => d >= salonDate()),
      },
    });
  } catch (err) {
    return sendError(res, err, "manage view");
  }
});

router.get("/booking/:token/calendar.ics", manageReadLimit, async (req, res) => {
  try {
    const appt = await loadManaged(req, res);
    if (!appt) return;
    if (!appt.startAt) return res.status(404).json({ error: "NOT_FOUND" });
    const settings = (await SiteSettings.getSingleton()).toObject();
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${appt.ref}.ics"`);
    return res.send(booking.icsFor(appt, settings));
  } catch (err) {
    return sendError(res, err, "calendar");
  }
});

router.get("/booking/:token/availability", manageReadLimit, [query("date").custom(isValidDate).withMessage("Choose a date.")], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidation(res, errors.array());
  try {
    const appt = await loadManaged(req, res);
    if (!appt) return;
    const Service = require("../models/Service");
    const ids = [...new Set(appt.guests.flatMap((g) => g.items.map((i) => String(i.serviceId))))];
    const docs = await Service.find({ _id: { $in: ids } }).lean();
    const selection = {
      guests: appt.guests.map((g) => ({ key: g.guestKey, serviceIds: g.items.map((i) => String(i.serviceId)) })),
      services: new Map(docs.map((d) => [String(d._id), d])),
    };
    const firstArtist = appt.guests[0]?.items[0]?.artistId ? String(appt.guests[0].items[0].artistId) : null;
    const out = await booking.findSlots({ date: req.query.date, selection, artistId: firstArtist, excludeAppointmentId: appt._id, phone: appt.contact });
    res.set("Cache-Control", "no-store");
    return res.json({ date: req.query.date, slots: out.slots });
  } catch (err) {
    return sendError(res, err, "manage availability");
  }
});

router.post("/booking/:token/cancel", only(["bookingToken", "reason"]), manageWriteLimit, [body("reason").optional({ nullable: true }).isString().isLength({ max: 300 })], async (req, res) => {
  try {
    const appt = await loadManaged(req, res);
    if (!appt) return;
    const settings = (await SiteSettings.getSingleton()).toObject();
    const rules = booking.manageRules(appt, settings);
    if (!rules.canCancel) return res.status(409).json({ error: "LIMIT_REACHED", message: "This booking can't be cancelled online any more. Message us on WhatsApp." });
    if (!freshEnough(req, appt, rules)) return res.status(401).json({ error: "OTP_REQUIRED", message: "For your security, verify your phone with a WhatsApp code first." });
    const out = await booking.cancelByCustomer(appt, { reason: req.body.reason?.trim() || null });
    if (!out.ok) return res.status(409).json({ error: "CONFLICT", message: "This booking just changed. Reload the page." });
    const { alertBooking } = require("../utils/bookingAlerts");
    await alertBooking(out.appt, "cancelled_by_customer");
    return res.json({ booking: publicBooking(out.appt), refund: out.appt.refund?.amount ? { amount: out.appt.refund.amount, status: out.appt.refund.status } : null });
  } catch (err) {
    return sendError(res, err, "manage cancel");
  }
});

router.post("/booking/:token/reschedule", only(["bookingToken", "startAt"]), manageWriteLimit, [body("startAt").isISO8601({ strict: true }).withMessage("Pick a time.")], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidation(res, errors.array());
  try {
    const appt = await loadManaged(req, res);
    if (!appt) return;
    const settings = (await SiteSettings.getSingleton()).toObject();
    const rules = booking.manageRules(appt, settings);
    if (!freshEnough(req, appt, rules)) return res.status(401).json({ error: "OTP_REQUIRED", message: "For your security, verify your phone with a WhatsApp code first." });
    const updated = await booking.rescheduleBooking(appt, { startAt: req.body.startAt });
    return res.json({ booking: publicBooking(updated), rules: booking.manageRules(updated, settings) });
  } catch (err) {
    return sendError(res, err, "manage reschedule");
  }
});

module.exports = router;
module.exports.publicBooking = publicBooking;
