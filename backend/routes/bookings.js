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
 * Phase 1 confirmation sets a time but takes no slot locks: the slot engine and
 * its SlotLock rows arrive in Phase 2 (T2.2, T2.7). Until then the receptionist
 * checks the artist's day by hand, exactly as for a phone booking today.
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
const { isValidDate, salonInstant, TIME_RE } = require("../utils/time");
const { DEFAULT_DURATION_MINUTES } = require("../models/Service");

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
    createdAt: a.createdAt,
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
    body("date").custom(isValidDate).withMessage("Pick a date"),
    body("time").matches(TIME_RE).withMessage("Pick a time"),
    body("artistId").optional({ nullable: true }).isMongoId().withMessage("Unknown artist"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const appt = await Appointment.findById(req.params.id);
      if (!appt) return res.status(404).json({ error: "Booking not found" });
      if (appt.status !== "requested") return conflict(res, appt._id);

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
      const endAt = new Date(cursor);
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
    [body("reason").optional({ nullable: true }).isString().trim().isLength({ max: 300 })],
    async (req, res) => {
      if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "Reason is too long" });
      try {
        const reason = req.body.reason?.trim() || null;
        const now = new Date();
        const set = { status: to };
        if (to === "cancelled") Object.assign(set, { cancelledAt: now, cancelledBy: "salon", cancelReason: reason });

        const updated = await Appointment.findOneAndUpdate(
          { _id: req.params.id, status: from },
          { $set: set, $push: { statusHistory: { from, to, at: now, reason, ...actor(req) } } },
          { returnDocument: "after" }
        ).lean();
        if (!updated) return conflict(res, req.params.id);

        await audit.record({
          action: auditAction,
          req,
          target: { name: updated.name },
          meta: { appointmentId: String(updated._id), ref: updated.ref, reason },
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
router.post("/:id/cancel", ...statusChange({ from: "confirmed", to: "cancelled", action: "cancel", auditAction: "booking.cancelled" }));

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

module.exports = router;
module.exports.toStaffView = toStaffView;
