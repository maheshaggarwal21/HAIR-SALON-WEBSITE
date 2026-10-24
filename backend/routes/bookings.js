/**
 * @file bookings.js
 * @description Staff side of website requests and bookings — `/api/bookings/*`
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §6.1, §7, T1.10).
 *
 * Phase 1 (request-lite):
 *   GET   /requests?status=      bookings.view    list, newest first (open requests by day)
 *   POST  /:id/confirm           bookings.manage  "Confirm with time": date + time (+ artist)
 *   POST  /:id/decline           bookings.manage
 *   POST  /:id/cancel            bookings.manage  salon cancels a confirmed booking
 *   PATCH /:id/note              bookings.manage  staff-only note
 *
 * Every status change is a CONDITIONAL update on the status the receptionist
 * saw (`{_id, status: "requested"}`). If two people act on the same request at
 * once, one wins and the other gets 409 with the current state — nobody
 * silently overwrites a colleague. Appointments are never deleted (CLAUDE.md).
 *
 * Phase 1 confirmation sets a time but takes no slot locks: the receptionist
 * checks the artist's day by hand, exactly as for a phone booking today.
 *
 * Phase 2 (T2.10): a request made through the slot engine already HOLDS its
 * time (startAt + hold SlotLocks until requestExpiresAt). "Confirm" on one of
 * those approves it at that time — the holds turn firm in a transaction
 * (utils/booking.approveRequest); date/time from the body are ignored.
 * Decline and cancel go through utils/booking.releaseBySalon for every
 * booking: locks are deleted so the time is sellable again, and anything the
 * customer paid is queued for a full refund (D18: salon side = all back).
 */

const express = require("express");
const { body, query, validationResult } = require("express-validator");
const connectDB = require("../db");
const Appointment = require("../models/Appointment");
const Artist = require("../models/Artist");
const SiteSettings = require("../models/SiteSettings");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const validateId = require("../middleware/validateId");
const audit = require("../utils/audit");
const { isValidDate, salonInstant, salonDate, TIME_RE } = require("../utils/time");
const { DEFAULT_DURATION_MINUTES } = require("../models/Service");
const waRequest = require("../utils/waRequest");
const booking = require("../utils/booking");
const { approveRequest, closeBooking } = booking;
const { dayBoard } = require("../utils/board");
const Customer = require("../models/Customer");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[bookings] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

const LIST_STATUSES = ["requested", "confirmed", "declined", "cancelled", "all"];

function actor(req) {
  return { by: req.session?.name || "staff", byUserId: req.session?.userId || null };
}

/** Fields the Requests page needs. listPrice stays out even for staff lists. */
function toStaffView(a) {
  return {
    _id: a._id,
    ref: a.ref,
    mode: a.mode,
    status: a.status,
    name: a.name,
    contact: a.contact,
    items: (a.guests || []).flatMap((g) =>
      g.items.map((i) => ({
        serviceId: i.serviceId,
        name: i.name,
        price: i.publicPrice,
        durationMin: i.durationMin,
        artistName: i.artistName,
      }))
    ),
    gender: a.guests?.[0]?.gender ?? null,
    total: a.pricing?.total ?? 0,
    discount: a.pricing?.discount ?? 0,
    requestedWindow: a.requestedWindow,
    preferredArtistId: a.preferredArtistId,
    preferredArtistName: a.preferredArtistName,
    startAt: a.startAt,
    endAt: a.endAt,
    notes: a.notes,
    internalNote: a.internalNote,
    utm: a.source?.utm ?? null,
    channel: a.source?.channel ?? null,
    // WhatsApp-ad requests (D62): the ad tag, and the offer so reception can apply the matching discount by hand.
    campaign: a.source?.campaign ?? null,
    offer: a.source?.offerSlug
      ? { slug: a.source.offerSlug, headline: a.source.offerHeadline ?? null, price: a.source.offerPrice ?? null, priceNote: a.source.offerPriceNote ?? null }
      : null,
    unpaid: a.mode === "request" && !(a.deposit?.amount > 0),
    // The package the customer chose (D64): its name, ONE price and the services as printed on the poster.
    package: a.source?.offerPackage?.name
      ? { name: a.source.offerPackage.name, price: a.source.offerPackage.price, services: a.source.offerPackage.services || [], durationMinutes: a.source.offerPackage.durationMinutes ?? null }
      : null,
    createdAt: a.createdAt,
    // Phase 2: engine bookings hold a time and may carry money.
    requestExpiresAt: a.requestExpiresAt ?? null,
    deposit: a.deposit?.amount ? { kind: a.deposit.kind, amount: a.deposit.amount, status: a.deposit.status } : null,
    refund: a.refund?.amount ? { amount: a.refund.amount, status: a.refund.status, error: a.refund.error ?? null } : null,
    checkedInAt: a.checkedInAt ?? null,
    finishedAt: a.finishedAt ?? null,
    visitId: a.visitId ?? null,
    lockConflict: Boolean(a.lockConflict),
    lastChange: a.statusHistory?.[a.statusHistory.length - 1] ?? null,
  };
}

async function conflict(res, id) {
  const current = await Appointment.findById(id).select("status ref").lean();
  if (!current) return res.status(404).json({ error: "Booking not found" });
  return res.status(409).json({
    error: `This booking is already ${current.status}.`,
    status: current.status,
  });
}

// ─── GET /requests ───────────────────────────────────────────────────────────
router.get(
  "/requests",
  authorizePermission(PERMISSIONS.BOOKINGS_VIEW),
  [query("status").optional().isIn(LIST_STATUSES)],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "Unknown status" });
    try {
      const status = req.query.status || "requested";
      const filter = { mode: "request", ...(status === "all" ? {} : { status }) };
      // Open requests: soonest requested day first, so today's are on top.
      const sort = status === "requested" ? { "requestedWindow.date": 1, createdAt: 1 } : { updatedAt: -1 };

      const [rows, counts, settings] = await Promise.all([
        Appointment.find(filter).sort(sort).limit(200).lean(),
        Appointment.aggregate([{ $match: { mode: "request" } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
        SiteSettings.getSingleton(),
      ]);
      return res.json({
        requests: rows.map(toStaffView),
        counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
        requestWindows: settings.requestWindows,
      });
    } catch (err) {
      console.error("[bookings] list error:", err);
      return res.status(500).json({ error: "Failed to load requests" });
    }
  }
);

// ─── POST /:id/confirm ───────────────────────────────────────────────────────
router.post(
  "/:id/confirm",
  validateId,
  authorizePermission(PERMISSIONS.BOOKINGS_MANAGE),
  [
    // Required for request-lite; an engine request already has its time.
    body("date").optional({ nullable: true }).custom(isValidDate).withMessage("Pick a date"),
    body("time").optional({ nullable: true }).matches(TIME_RE).withMessage("Pick a time"),
    body("artistId").optional({ nullable: true }).isMongoId().withMessage("Unknown artist"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const appt = await Appointment.findById(req.params.id);
      if (!appt) return res.status(404).json({ error: "Booking not found" });
      if (appt.status !== "requested") return conflict(res, appt._id);

      // Engine request: approve at the time it already holds.
      if (appt.startAt && appt.requestExpiresAt) {
        const out = await approveRequest(appt._id, actor(req));
        if (!out.ok && out.error === "SLOT_TAKEN") {
          return res.status(409).json({ error: "That time is no longer free (the hold lapsed and someone else booked it). Decline it, or call the customer to move it." });
        }
        if (!out.ok) return conflict(res, appt._id);
        await audit.record({
          action: "booking.confirmed",
          req,
          target: { name: out.appt.name },
          meta: { appointmentId: String(out.appt._id), ref: out.appt.ref, startAt: out.appt.startAt, endAt: out.appt.endAt, engine: true },
        });
        return res.json({ request: toStaffView(out.appt) });
      }
      if (!req.body.date || !req.body.time) return res.status(400).json({ error: "Pick a date and time" });

      let artist = null;
      if (req.body.artistId) {
        artist = await Artist.findOne({ _id: req.body.artistId, isActive: true }, { name: 1 }).lean();
        if (!artist) return res.status(400).json({ error: "That artist is not active" });
      }

      // Chain the items back to back from the agreed time. A service still on
      // its one-hour estimate is planned at that estimate — generous on purpose.
      const startAt = salonInstant(req.body.date, req.body.time);
      let cursor = startAt.getTime();
      const guests = appt.guests.map((g) => {
        const plain = g.toObject();
        plain.items = plain.items.map((i) => {
          const itemStart = new Date(cursor);
          const itemEnd = new Date(cursor + (i.durationMin || DEFAULT_DURATION_MINUTES) * 60_000);
          cursor = itemEnd.getTime() + (i.bufferMin || 0) * 60_000;
          return {
            ...i,
            startAt: itemStart,
            endAt: itemEnd,
            artistId: artist ? artist._id : i.artistId,
            artistName: artist ? artist.name : i.artistName,
          };
        });
        return plain;
      });
      let endAt = new Date(cursor);
      // A package (D64) takes as long as the owner said, even when only some of its services are on the service list.
      const pkgMinutes = appt.source?.offerPackage?.durationMinutes;
      if (pkgMinutes) endAt = new Date(Math.max(endAt.getTime(), startAt.getTime() + pkgMinutes * 60_000));
      const who = actor(req);

      const updated = await Appointment.findOneAndUpdate(
        { _id: appt._id, status: "requested" },
        {
          $set: { status: "confirmed", startAt, endAt, guests },
          $push: { statusHistory: { from: "requested", to: "confirmed", at: new Date(), ...who } },
        },
        { returnDocument: "after", runValidators: true }
      ).lean();
      if (!updated) return conflict(res, appt._id);

      // WhatsApp-ad requests (D62) are told at once, with the confirmed time. Request-lite
      // bookings from the website are still handled by phone, as before. Never throws.
      if (updated.source?.channel === "wa_ad") await waRequest.sendConfirmed(updated);

      await audit.record({
        action: "booking.confirmed",
        req,
        target: { name: updated.name },
        meta: {
          appointmentId: String(updated._id),
          ref: updated.ref,
          startAt: updated.startAt,
          endAt: updated.endAt,
          artist: artist?.name ?? null,
        },
      });
      return res.json({ request: toStaffView(updated) });
    } catch (err) {
      console.error("[bookings] confirm error:", err);
      return res.status(500).json({ error: "Failed to confirm" });
    }
  }
);

// ─── POST /:id/decline and /:id/cancel ───────────────────────────────────────

function statusChange({ from, to, action, auditAction }) {
  return [
    validateId,
    authorizePermission(PERMISSIONS.BOOKINGS_MANAGE),
    [
      body("reason").optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
      // Who cancelled decides the money (D18): the salon refunds all; a customer
      // cancelling (by phone) leaves the cancellation fee kept.
      body("side").optional().isIn(["salon", "customer"]),
    ],
    async (req, res) => {
      if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "Reason is too long" });
      try {
        const reason = req.body.reason?.trim() || null;
        const side = to === "cancelled" && req.body.side === "customer" ? "customer" : "salon";
        const out = await closeBooking(req.params.id, { from, to, side, reason, ...actor(req) });
        if (!out.ok) return conflict(res, req.params.id);
        const updated = out.appt;

        await audit.record({
          action: auditAction,
          req,
          target: { name: updated.name },
          meta: { appointmentId: String(updated._id), ref: updated.ref, reason, side, refund: updated.refund?.amount || 0 },
        });
        return res.json({ request: toStaffView(updated) });
      } catch (err) {
        console.error(`[bookings] ${action} error:`, err);
        return res.status(500).json({ error: `Failed to ${action}` });
      }
    },
  ];
}

router.post("/:id/decline", ...statusChange({ from: "requested", to: "declined", action: "decline", auditAction: "booking.declined" }));
router.post("/:id/cancel", ...statusChange({ from: ["confirmed", "checked_in"], to: "cancelled", action: "cancel", auditAction: "booking.cancelled" }));

// ─── PATCH /:id/note ─────────────────────────────────────────────────────────
router.patch(
  "/:id/note",
  validateId,
  authorizePermission(PERMISSIONS.BOOKINGS_MANAGE),
  [body("note").isString().trim().isLength({ max: 500 }).withMessage("Keep the note under 500 characters")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const note = req.body.note.trim() || null;
      const before = await Appointment.findById(req.params.id).select("internalNote").lean();
      if (!before) return res.status(404).json({ error: "Booking not found" });

      const updated = await Appointment.findByIdAndUpdate(
        req.params.id,
        { $set: { internalNote: note } },
        { returnDocument: "after" }
      ).lean();
      if (before.internalNote !== note) {
        await audit.record({
          action: "booking.note_changed",
          req,
          target: { name: updated.name },
          meta: { appointmentId: String(updated._id), ref: updated.ref, from: before.internalNote, to: note },
        });
      }
      return res.json({ request: toStaffView(updated) });
    } catch (err) {
      console.error("[bookings] note error:", err);
      return res.status(500).json({ error: "Failed to save note" });
    }
  }
);

// ═══ Phase 2: Today board and front desk (CF §7, T2.14–T2.18) ═══════════════

const OID = /^[a-f0-9]{24}$/i;

function firstError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg, field: errors.array()[0].path });
  return true;
}

/** BookingError → status + message (+ who is in the way); anything else → 500. */
function sendBookingError(res, err, what) {
  if (err?.code && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code, conflicts: err.conflicts, alternatives: err.alternatives });
  }
  console.error(`[bookings] ${what} error:`, err);
  return res.status(500).json({ error: `Failed to ${what}` });
}

// ─── GET /day?date= ──────────────────────────────────────────────────────────
router.get("/day", authorizePermission(PERMISSIONS.BOOKINGS_VIEW), [query("date").custom(isValidDate)], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "Pick a date" });
  try {
    return res.json(await dayBoard(req.query.date));
  } catch (err) {
    console.error("[bookings] day error:", err);
    return res.status(500).json({ error: "Failed to load the day" });
  }
});

// ─── GET /availability — the desk's view of free times (E22) ─────────────────
/** ?date=&services=id,id&artistId= — every active artist, no lead time or online share. */
router.get(
  "/availability",
  authorizePermission(PERMISSIONS.BOOKINGS_VIEW),
  [query("date").custom(isValidDate), query("services").matches(/^[a-f0-9]{24}(,[a-f0-9]{24}){0,7}$/i), query("artistId").optional().isMongoId()],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "Pick a date and services" });
    try {
      const { loadEngineInput } = require("../utils/availabilityLoader");
      const { availability } = require("../utils/availability");
      const Service = require("../models/Service");
      const ids = req.query.services.split(",");
      const docs = await Service.find({ _id: { $in: ids }, isActive: true }).lean();
      if (docs.length !== new Set(ids).size) return res.status(400).json({ error: "Choose services from the list" });
      const services = new Map(docs.map((d) => [String(d._id), d]));
      const { input } = await loadEngineInput({ date: req.query.date, guests: [{ key: "g1", serviceIds: ids }], services, artistId: req.query.artistId || null, staff: true });
      const out = availability(input);
      return res.json({
        slots: out.slots.map((s) => ({
          startAt: new Date(s.startAt),
          endAt: new Date(s.endAt),
          remaining: s.remaining,
          items: s.chains[0].items.map((i) => ({ serviceId: i.serviceId, artistId: i.artistId, artistName: i.artistName, startAt: new Date(i.startAt) })),
        })),
      });
    } catch (err) {
      return sendBookingError(res, err, "load free times");
    }
  }
);

// ─── POST /walkin (T2.15) ────────────────────────────────────────────────────
router.post(
  "/walkin",
  authorizePermission(PERMISSIONS.BOOKINGS_MANAGE),
  [
    body("name").isString().trim().isLength({ min: 1, max: 60 }).withMessage("Enter the client's name"),
    body("phone").optional({ nullable: true, checkFalsy: true }).customSanitizer((v) => Customer.normalisePhone(v)).custom((v) => v !== null).withMessage("Enter a 10-digit mobile number, or leave it empty"),
    body("gender").optional({ nullable: true }).isIn(["female", "male", "other", null]),
    body("artistId").isMongoId().withMessage("Pick an artist"),
    body("serviceIds").isArray({ min: 1, max: 8 }).withMessage("Pick at least one service"),
    body("serviceIds.*").matches(OID).withMessage("Unknown service"),
    body("startAt").optional({ nullable: true }).isISO8601(),
    body("force").optional().isBoolean({ strict: true }),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const out = await booking.createWalkin({ ...req.body, phone: req.body.phone || null, ...actor(req) });
      await audit.record({
        action: "booking.walkin_created",
        req,
        target: { name: out.appt.name },
        meta: { appointmentId: String(out.appt._id), ref: out.appt.ref, startAt: out.appt.startAt, forcedOver: out.conflicts.map((c) => c.ref).filter(Boolean) },
      });
      return res.status(201).json({ booking: toStaffView(out.appt), conflicts: out.conflicts });
    } catch (err) {
      return sendBookingError(res, err, "add the walk-in");
    }
  }
);

// ─── POST /staff — phone or desk booking through the engine (E22) ───────────
router.post(
  "/staff",
  authorizePermission(PERMISSIONS.BOOKINGS_MANAGE),
  [
    body("name").isString().trim().isLength({ min: 1, max: 60 }).withMessage("Enter the client's name"),
    body("phone").customSanitizer((v) => Customer.normalisePhone(v)).custom((v) => v !== null).withMessage("Enter a 10-digit mobile number"),
    body("for").optional({ nullable: true }).isIn(["her", "him"]),
    body("serviceIds").isArray({ min: 1, max: 8 }).withMessage("Pick at least one service"),
    body("serviceIds.*").matches(OID),
    body("startAt").isISO8601().withMessage("Pick a time"),
    body("artistId").optional({ nullable: true }).isMongoId(),
    body("channel").optional().isIn(["phone", "desk", "whatsapp"]),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const Service = require("../models/Service");
      const ids = req.body.serviceIds.map(String);
      const docs = await Service.find({ _id: { $in: ids }, isActive: true }).lean();
      if (docs.length !== new Set(ids).size) return res.status(400).json({ error: "Choose services from the list" });
      const services = new Map(docs.map((d) => [String(d._id), d]));
      const gender = req.body.for === "him" ? "male" : req.body.for === "her" ? "female" : null;
      const selection = { guests: [{ key: "g1", name: req.body.name.trim(), gender, serviceIds: ids }], services, pkg: null };
      const who = actor(req);
      const out = await booking.createBooking({
        phone: req.body.phone,
        name: req.body.name.trim(),
        selection,
        startAt: req.body.startAt,
        artistId: req.body.artistId || null,
        paymentKind: "full",
        staff: { channel: req.body.channel || "phone", by: who.by, byUserId: who.byUserId },
      });
      await audit.record({
        action: "booking.created_by_staff",
        req,
        target: { name: out.appt.name },
        meta: { appointmentId: String(out.appt._id), ref: out.appt.ref, startAt: out.appt.startAt, channel: out.appt.source.channel },
      });
      return res.status(201).json({ booking: toStaffView(out.appt) });
    } catch (err) {
      return sendBookingError(res, err, "save the booking");
    }
  }
);

// ─── POST /:id/approve (T2.10) — engine request at its held time ─────────────
router.post("/:id/approve", validateId, authorizePermission(PERMISSIONS.BOOKINGS_MANAGE), async (req, res) => {
  try {
    const out = await approveRequest(req.params.id, actor(req));
    if (!out.ok && out.error === "SLOT_TAKEN") return res.status(409).json({ error: "That time is no longer free. Decline it, or move it first." });
    if (!out.ok) return conflict(res, req.params.id);
    await audit.record({ action: "booking.confirmed", req, target: { name: out.appt.name }, meta: { appointmentId: String(out.appt._id), ref: out.appt.ref, engine: true } });
    return res.json({ booking: toStaffView(out.appt) });
  } catch (err) {
    return sendBookingError(res, err, "approve");
  }
});

// ─── POST /:id/move (T2.17) ──────────────────────────────────────────────────
router.post(
  "/:id/move",
  validateId,
  authorizePermission(PERMISSIONS.BOOKINGS_MANAGE),
  [body("startAt").isISO8601().withMessage("Pick a time"), body("artistId").optional({ nullable: true }).isMongoId(), body("reason").optional({ nullable: true }).isString().trim().isLength({ max: 120 })],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const out = await booking.moveBooking(req.params.id, { startAt: req.body.startAt, artistId: req.body.artistId || null, reason: req.body.reason || null, ...actor(req) });
      if (!out.ok) return conflict(res, req.params.id);
      await audit.record({
        action: "booking.moved",
        req,
        target: { name: out.appt.name },
        meta: { appointmentId: String(out.appt._id), ref: out.appt.ref, from: out.before, to: { startAt: out.appt.startAt, artistId: req.body.artistId || null } },
      });
      return res.json({ booking: toStaffView(out.appt) });
    } catch (err) {
      return sendBookingError(res, err, "move the booking");
    }
  }
);

// ─── POST /:id/check-in and /:id/no-show ─────────────────────────────────────
router.post("/:id/check-in", validateId, authorizePermission(PERMISSIONS.BOOKINGS_MANAGE), async (req, res) => {
  try {
    const out = await booking.checkIn(req.params.id, actor(req));
    if (!out.ok) return conflict(res, req.params.id);
    await audit.record({ action: "booking.checked_in", req, target: { name: out.appt.name }, meta: { appointmentId: String(out.appt._id), ref: out.appt.ref } });
    return res.json({ booking: toStaffView(out.appt) });
  } catch (err) {
    return sendBookingError(res, err, "check in");
  }
});

router.post("/:id/finish", validateId, authorizePermission(PERMISSIONS.BOOKINGS_MANAGE), async (req, res) => {
  try {
    const out = await booking.finish(req.params.id);
    if (!out.ok) return conflict(res, req.params.id);
    await audit.record({ action: "booking.finished", req, target: { name: out.appt.name }, meta: { appointmentId: String(out.appt._id), ref: out.appt.ref } });
    return res.json({ booking: toStaffView(out.appt) });
  } catch (err) {
    return sendBookingError(res, err, "finish");
  }
});

router.post("/:id/no-show", validateId, authorizePermission(PERMISSIONS.BOOKINGS_MANAGE), async (req, res) => {
  try {
    const out = await booking.markNoShow(req.params.id, actor(req));
    if (!out.ok && out.error === "TOO_EARLY") return res.status(400).json({ error: out.message });
    if (!out.ok) return conflict(res, req.params.id);
    await audit.record({
      action: "booking.no_show",
      req,
      target: { name: out.appt.name },
      meta: { appointmentId: String(out.appt._id), ref: out.appt.ref, refund: out.appt.refund?.amount || 0 },
    });
    return res.json({ booking: toStaffView(out.appt) });
  } catch (err) {
    return sendBookingError(res, err, "mark no-show");
  }
});

// ─── POST /block and /unblock — training, lunch… ─────────────────────────────
const blockValidators = [
  body("artistId").isMongoId().withMessage("Pick an artist"),
  body("startAt").isISO8601().withMessage("Pick a start"),
  body("endAt").isISO8601().withMessage("Pick an end"),
  body("note").optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
];

router.post("/block", authorizePermission(PERMISSIONS.BOOKINGS_MANAGE), blockValidators, async (req, res) => {
  if (firstError(req, res)) return;
  try {
    const out = await booking.blockTime({ ...req.body, note: req.body.note?.trim() || null });
    const a = await Artist.findById(req.body.artistId, { name: 1 }).lean();
    await audit.record({ action: "booking.time_blocked", req, target: { name: a?.name ?? null }, meta: { artistId: req.body.artistId, startAt: out.startAt, endAt: out.endAt, note: req.body.note || null } });
    return res.status(201).json(out);
  } catch (err) {
    return sendBookingError(res, err, "block the time");
  }
});

router.post("/unblock", authorizePermission(PERMISSIONS.BOOKINGS_MANAGE), blockValidators, async (req, res) => {
  if (firstError(req, res)) return;
  try {
    const out = await booking.unblockTime(req.body);
    const a = await Artist.findById(req.body.artistId, { name: 1 }).lean();
    await audit.record({ action: "booking.time_unblocked", req, target: { name: a?.name ?? null }, meta: { artistId: req.body.artistId, startAt: req.body.startAt, endAt: req.body.endAt, blocks: out.blocks } });
    return res.json(out);
  } catch (err) {
    return sendBookingError(res, err, "unblock the time");
  }
});

// ─── Refunds (T2.17, E24) ────────────────────────────────────────────────────
router.get("/refunds", authorizePermission(PERMISSIONS.BOOKINGS_REFUND), async (_req, res) => {
  try {
    const [open, recent] = await Promise.all([
      Appointment.find({ "refund.status": { $in: ["pending", "processing", "failed"] } }).sort({ "refund.requestedAt": 1 }).limit(200).lean(),
      Appointment.find({ "refund.status": "processed" }).sort({ "refund.processedAt": -1 }).limit(30).lean(),
    ]);
    const view = (a) => ({
      ...toStaffView(a),
      refund: { ...a.refund },
      paid: a.deposit?.amount || 0,
      paymentId: a.deposit?.razorpayPaymentId || null,
      cancelledBy: a.cancelledBy,
      cancelReason: a.cancelReason,
    });
    const settings = await SiteSettings.getSingleton();
    return res.json({ open: open.map(view), recent: recent.map(view), autoRefundSalonSide: settings.autoRefundSalonSide !== false });
  } catch (err) {
    console.error("[bookings] refunds error:", err);
    return res.status(500).json({ error: "Failed to load refunds" });
  }
});

// ─── Cancellation fees kept (D51) ────────────────────────────────────────────
/**
 * Money the salon KEPT from customers who cancelled late or didn't come. It
 * lives only on the Appointment (no Visit is ever created for it), so the
 * Refunds screen lists it per IST month — otherwise it would be income no
 * report explains. ?month=YYYY-MM, default this month.
 */
router.get("/fees", authorizePermission(PERMISSIONS.BOOKINGS_REFUND), async (req, res) => {
  try {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || "")) ? String(req.query.month) : salonDate().slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    const rows = await Appointment.find(
      { feeKept: { $gt: 0 }, feeKeptAt: { $gte: salonInstant(`${month}-01`, "00:00"), $lt: salonInstant(`${next}-01`, "00:00") } },
      { ref: 1, name: 1, contact: 1, status: 1, startAt: 1, feeKept: 1, feeKeptAt: 1, "deposit.amount": 1, "deposit.kind": 1, cancelledBy: 1 }
    )
      .sort({ feeKeptAt: -1 })
      .limit(500)
      .lean();
    return res.json({
      month,
      total: rows.reduce((s, a) => s + a.feeKept, 0),
      count: rows.length,
      rows: rows.map((a) => ({ _id: a._id, ref: a.ref, name: a.name, contact: a.contact, kind: a.status === "no_show" ? "no_show" : "cancelled", startAt: a.startAt, keptAt: a.feeKeptAt, paid: a.deposit?.amount || 0, kept: a.feeKept })),
    });
  } catch (err) {
    console.error("[bookings] fees error:", err);
    return res.status(500).json({ error: "Failed to load fees" });
  }
});

// The switch for automatic salon-side refunds (D45). Same permission as sending a refund.
router.put("/refund-settings", authorizePermission(PERMISSIONS.BOOKINGS_REFUND), [body("autoRefundSalonSide").isBoolean({ strict: true })], async (req, res) => {
  if (firstError(req, res)) return;
  try {
    const before = (await SiteSettings.getSingleton()).autoRefundSalonSide !== false;
    await SiteSettings.updateOne({ key: "default" }, { $set: { autoRefundSalonSide: req.body.autoRefundSalonSide } });
    if (before !== req.body.autoRefundSalonSide) {
      await audit.record({ action: "booking.refund_setting_changed", req, target: { name: "Automatic refunds" }, meta: { from: before, to: req.body.autoRefundSalonSide } });
    }
    return res.json({ autoRefundSalonSide: req.body.autoRefundSalonSide });
  } catch (err) {
    console.error("[bookings] refund settings error:", err);
    return res.status(500).json({ error: "Failed to save" });
  }
});

router.post("/:id/refund/send", validateId, authorizePermission(PERMISSIONS.BOOKINGS_REFUND), async (req, res) => {
  try {
    const out = await booking.sendRefund(req.params.id);
    if (!out.ok && out.error === "CONFLICT") return res.status(409).json({ error: "This refund is already sent or being sent." });
    const appt = out.appt;
    await audit.record({
      action: out.ok ? "booking.refund_sent" : "booking.refund_failed",
      req,
      target: { name: appt?.name ?? null },
      meta: { appointmentId: req.params.id, ref: appt?.ref, amount: appt?.refund?.amount, razorpayRefundId: appt?.refund?.razorpayRefundId ?? null, error: out.message ?? null },
    });
    if (!out.ok) return res.status(502).json({ error: `Razorpay refused the refund: ${out.message}. It stays in the list; try again later.` });
    return res.json({ booking: toStaffView(appt), refund: appt.refund });
  } catch (err) {
    return sendBookingError(res, err, "send the refund");
  }
});

router.post(
  "/:id/refund/adjust",
  validateId,
  authorizePermission(PERMISSIONS.BOOKINGS_REFUND),
  [body("amount").isInt({ min: 0 }).withMessage("Enter the amount to refund").toInt(), body("reason").isString().trim().isLength({ min: 2, max: 200 }).withMessage("Say why")],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const out = await booking.adjustRefund(req.params.id, { amount: req.body.amount, reason: req.body.reason.trim() });
      if (!out.ok && out.error === "VALIDATION") return res.status(400).json({ error: out.message });
      if (!out.ok) return conflict(res, req.params.id);
      await audit.record({
        action: "booking.refund_waived",
        req,
        target: { name: out.appt.name },
        meta: { appointmentId: req.params.id, ref: out.appt.ref, from: out.before, to: req.body.amount, reason: req.body.reason.trim() },
      });
      return res.json({ booking: toStaffView(out.appt), refund: out.appt.refund });
    } catch (err) {
      return sendBookingError(res, err, "change the refund");
    }
  }
);

module.exports = router;
module.exports.toStaffView = toStaffView;
