/**
 * @file publicWaRequest.js
 * @description POST /api/public/requests/wa: a booking REQUEST from a WhatsApp ad link or an
 * offer page (D62). No payment, no OTP, nothing held. Mounted inside /api/public.
 *
 * Creates an Appointment `{mode: "request", status: "requested", source.channel: "wa_ad"}`
 * with the campaign tag (and the offer, when it came from an offer page), then sends the
 * customer the existing `request_received` WhatsApp and alerts the owner. Reception confirms
 * or declines it in the staff app (routes/bookings.js).
 *
 * Because there is no OTP and no Turnstile (the link comes from an ad and friction costs
 * bookings), the spam controls are:
 *   - a honeypot field real people never see: a bot that fills it gets a convincing "ok" and
 *     nothing is stored;
 *   - 10 requests per IP per hour and 3 per phone per day (database-backed, shared by every
 *     server instance), plus the salon's own cap of active bookings per phone;
 *   - phone numbers normalised (+91, 0, spaces) so one person is one number, and an exact
 *     repeat of the same slot returns the first request instead of making a second;
 *   - past, too-soon, closed-day, off-grid and too-late-for-the-services times are refused.
 * Prices are computed here from the menu, never taken from the browser, and a discount is
 * never applied: the offer's words are recorded and reception applies it by hand.
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const Service = require("../models/Service");
const Customer = require("../models/Customer");
const Appointment = require("../models/Appointment");
const SiteSettings = require("../models/SiteSettings");
const { liveOffers, applyOffers } = require("../utils/offers");
const { PUBLIC_SERVICE_FILTER } = require("../utils/publicCatalogue");
const { mongoRateLimit, hit } = require("../middleware/mongoRateLimit");
const { alertNewRequest } = require("../utils/bookingAlerts");
const { isValidDate, salonDate } = require("../utils/time");
const wa = require("../utils/waRequest");
const offerPages = require("../utils/offerPages");

const router = express.Router();
const HOUR = 60 * 60 * 1000;
const MAX_ITEMS = 8;
const FIELDS = new Set(["services", "offerSlug", "campaign", "date", "time", "name", "phone", "website"]);

const ipLimit = mongoRateLimit({ name: "wa-request-ip", windowMs: HOUR, max: 10 });

function onlyKnownFields(req, res, next) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return res.status(400).json({ error: "VALIDATION", message: "Send the request as JSON." });
  const unknown = Object.keys(b).filter((k) => !FIELDS.has(k));
  if (unknown.length) return res.status(400).json({ error: "VALIDATION", message: "Unexpected fields.", fields: unknown });
  return next();
}

const validators = [
  body("services").optional().isArray({ max: MAX_ITEMS }).withMessage(`Choose up to ${MAX_ITEMS} services.`),
  body("services.*").isMongoId().withMessage("Unknown service."),
  body("offerSlug").optional({ nullable: true }).isString().matches(/^[a-z0-9-]{1,60}$/).withMessage("Unknown offer."),
  body("campaign").optional({ nullable: true }).isString().isLength({ max: 60 }),
  body("date").custom(isValidDate).withMessage("Choose a date."),
  body("time").matches(wa.TIME_RE).withMessage("Choose a time."),
  body("name")
    .isString()
    .trim()
    .isLength({ min: 2, max: 60 })
    .withMessage("Enter your name.")
    .matches(/^[\p{L}\p{M} .'-]+$/u)
    .withMessage("Enter your name using letters only."),
  body("phone")
    .customSanitizer((v) => Customer.normalisePhone(v))
    .custom((v) => v !== null)
    .withMessage("Enter a 10-digit mobile number."),
  body("website").optional({ nullable: true }).isString().isLength({ max: 300 }),
];

async function createWithUniqueRef(doc) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await Appointment.create({ ...doc, ref: Appointment.generateRef() });
    } catch (err) {
      if (err?.code === 11000 && err?.keyPattern?.ref) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a booking reference");
}

const summary = (appt, duplicate = false) => ({
  ref: appt.ref,
  status: appt.status,
  date: appt.requestedWindow?.date,
  time: appt.requestedWindow?.time,
  items: appt.guests.flatMap((g) => g.items.map((i) => ({ name: i.name }))),
  duplicate,
});

router.post("/requests/wa", onlyKnownFields, ipLimit, validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "VALIDATION", message: errors.array()[0].msg, fields: errors.array().map((e) => e.path) });
  }
  const b = req.body;

  // Honeypot: people cannot see this box. A bot that fills it is told "sent" and nothing is stored.
  if (typeof b.website === "string" && b.website.trim() !== "") {
    return res.status(201).json({ ref: Appointment.generateRef(), status: "requested", date: b.date, time: b.time, items: [], duplicate: false });
  }

  try {
    const settings = (await SiteSettings.getSingleton()).toObject();
    const today = salonDate();

    // ── What is being requested: an offer's services, or the customer's own pick ──
    let offerDoc = null;
    if (b.offerSlug) {
      offerDoc = await offerPages.findBySlug(b.offerSlug);
      if (!offerDoc) return res.status(400).json({ error: "OFFER_UNAVAILABLE", message: "That offer isn't available any more." });
      if (offerPages.stateOn(offerDoc, today) !== "live") {
        return res.status(400).json({ error: "OFFER_UNAVAILABLE", message: "That offer isn't running right now." });
      }
    }
    const wantedIds = offerDoc ? offerDoc.page.serviceIds.map(String) : [...new Set(b.services || [])];
    if (!wantedIds.length) return res.status(400).json({ error: "VALIDATION", message: "Choose at least one service.", fields: ["services"] });

    const found = await Service.find({ ...PUBLIC_SERVICE_FILTER, _id: { $in: wantedIds } }).lean();
    const byId = new Map(applyOffers(found, await liveOffers()).map((s) => [String(s._id), s]));
    if (wantedIds.some((id) => !byId.has(id))) {
      return res.status(400).json({ error: "SERVICE_UNAVAILABLE", message: "One of those services isn't available online. Refresh and try again." });
    }
    if (wantedIds.some((id) => byId.get(id).bookingMode === "walkin_only")) {
      return res.status(400).json({ error: "SERVICE_UNAVAILABLE", message: "One of those services is walk-in only." });
    }
    const items = wantedIds.map((id) => {
      const s = byId.get(id);
      return { serviceId: s._id, name: s.publicName || s.name, publicPrice: s.publicPrice, listPrice: s.price, durationMin: s.durationMinutes ?? null, bufferMin: s.bufferMinutes ?? 0 };
    });

    // ── The time: real, in the future, inside opening hours, with room for the services ──
    const problem = wa.slotProblem(settings, b.date, b.time, wa.minutesFor(items));
    if (problem) return res.status(400).json({ error: "OUTSIDE_HOURS", message: problem, fields: ["time"] });

    // ── The same person sending the same slot twice is one request ──
    const repeat = await wa.findDuplicate(b.phone, b.date, b.time);
    if (repeat) return res.status(200).json(summary(repeat, true));

    // ── Limits that count only real new requests ──
    const phoneHit = await hit({ name: "wa-request-phone", id: b.phone, windowMs: 24 * HOUR, max: 3 });
    if (!phoneHit.allowed) {
      return res.status(429).json({ error: "LIMIT_REACHED", message: "You've sent a few requests today. We'll be in touch on WhatsApp." });
    }
    const active = await Appointment.countDocuments({
      contact: b.phone,
      status: { $in: ["pending_payment", "requested", "confirmed"] },
      $or: [{ startAt: { $gte: new Date() } }, { startAt: null, "requestedWindow.date": { $gte: today } }],
    });
    if (active >= settings.maxActiveBookingsPerPhone) {
      return res.status(409).json({ error: "LIMIT_REACHED", message: "You already have requests with us. We'll sort them out on WhatsApp." });
    }

    // ── Save ──
    const now = new Date();
    const campaign = wa.cleanCampaign(b.campaign) || (offerDoc ? offerDoc.page.slug : null);
    const utm = { source: "whatsapp", medium: "ad", ...(campaign ? { campaign } : {}) };
    const customer = await Customer.findOneAndUpdate(
      { phone: b.phone },
      { $set: { name: b.name }, $setOnInsert: { createdFrom: "web", firstTouch: { utm, at: now } } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true }
    );
    const subtotal = items.reduce((n, i) => n + i.publicPrice, 0);
    const appt = await createWithUniqueRef({
      mode: "request",
      status: "requested",
      customerId: customer._id,
      contact: b.phone,
      name: b.name,
      guests: [{ guestKey: "g1", name: b.name, gender: null, customerId: customer._id, items }],
      requestedWindow: { date: b.date, window: wa.windowFor(settings, b.time), time: b.time },
      // Unpaid, and no discount applied: the price is the menu price; reception applies the offer by hand.
      pricing: { subtotal, discount: 0, total: subtotal, packageId: null },
      deposit: { required: false, amount: 0, status: "none" },
      source: {
        channel: "wa_ad",
        utm,
        campaign,
        offerSlug: offerDoc ? offerDoc.page.slug : null,
        offerHeadline: offerDoc ? offerDoc.page.headline || offerDoc.content?.headline || null : null,
        offerPrice: offerDoc ? offerDoc.page.price ?? null : null,
        offerPriceNote: offerDoc ? offerDoc.page.priceNote ?? null : null,
        promoCode: null,
      },
      policyVersion: settings.policyVersion,
      statusHistory: [{ from: null, to: "requested", at: now, by: "customer" }],
    });

    // Before responding: on Vercel, work after the response may never run. Neither call throws.
    await Promise.all([wa.sendReceived(appt), alertNewRequest(appt)]);

    return res.status(201).json(summary(appt));
  } catch (err) {
    console.error("[public] wa request error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Something went wrong. Try again, or message us on WhatsApp." });
  }
});

module.exports = router;
