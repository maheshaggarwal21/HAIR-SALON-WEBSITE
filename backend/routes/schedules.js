/**
 * @file schedules.js
 * @description Staff screen "Online booking" — `/api/schedules/*`
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §2.1, §15, T2.1, T2.18, T2.22).
 *
 *   GET    /                  artists with their switches + leave from today on
 *   PATCH  /artists/:id       onlineBookable, onlineShare, weekly hours, breaks
 *   POST   /time-off          leave / blocked time (warns about bookings first, E8)
 *   DELETE /time-off/:id      remove leave
 *
 * Reading needs `bookings.view` (reception plans the day with it); changing
 * needs `schedules.manage`. Owner bypasses PBAC.
 *
 * ── The switches ─────────────────────────────────────────────────────────────
 * `onlineBookable` is the per-artist master switch (T2.22): off = the website
 * never offers this artist's time; existing bookings stay valid. Rollback for
 * the whole engine is "switch everyone off" (CP4).
 * `onlineShare` caps how much of a day can be sold online (Q4), so walk-ins
 * always find someone free.
 * `weekly` null = the salon's hours (D36). A day set to [] = day off.
 *
 * ── Leave over bookings (E8, D48) ────────────────────────────────────────────
 * Leave is saved at once. Bookings the artist had in that time are moved to a
 * free artist for the same time, automatically; a customer who NAMED the artist
 * gets a WhatsApp saying who they have instead and why (the leave's reason), one
 * who chose "any available" doesn't. A booking nobody can take is left as it
 * is and listed in the response and in a Telegram alert, for reception to move
 * or cancel by hand. Nothing is ever cancelled automatically (a customer is
 * involved).
 *
 * TimeOff rows are planning data, not history, so deleting one is allowed
 * (unlike Appointments). Every change is audited.
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const Artist = require("../models/Artist");
const TimeOff = require("../models/TimeOff");
const SiteSettings = require("../models/SiteSettings");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const validateId = require("../middleware/validateId");
const audit = require("../utils/audit");
const { bookingsOverlapping, reassignForLeave } = require("../utils/booking");
const { alertReassigned } = require("../utils/bookingAlerts");
const { isValidDate, salonInstant, salonDate, addDays, TIME_RE } = require("../utils/time");

const router = express.Router();
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[schedules] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

function firstError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg, field: errors.array()[0].path });
  return true;
}

const artistView = (a) => ({
  _id: a._id,
  name: a.name,
  displayName: a.publicProfile?.displayName || null,
  gender: a.gender,
  onlineBookable: Boolean(a.onlineBookable),
  onlineShare: a.onlineShare ?? 100,
  weekly: a.schedule?.weekly ?? null,
  breaks: (a.schedule?.breaks || []).map((b) => ({ day: b.day, start: b.start, end: b.end })),
});

// ─── GET / ───────────────────────────────────────────────────────────────────
router.get("/", authorizePermission(PERMISSIONS.BOOKINGS_VIEW), async (_req, res) => {
  try {
    const today = salonInstant(salonDate(), "00:00");
    const [artists, timeOff, settings] = await Promise.all([
      Artist.find({ isActive: true }).sort({ name: 1 }).lean(),
      TimeOff.find({ endAt: { $gt: today } }).sort({ startAt: 1 }).limit(300).lean(),
      SiteSettings.getSingleton(),
    ]);
    const names = new Map(artists.map((a) => [String(a._id), a.name]));
    return res.json({
      artists: artists.map(artistView),
      timeOff: timeOff.map((t) => ({
        _id: t._id,
        artistId: t.artistId,
        artistName: names.get(String(t.artistId)) || "Former artist",
        startAt: t.startAt,
        endAt: t.endAt,
        reason: t.reason,
      })),
      openingHours: settings.openingHours,
    });
  } catch (err) {
    console.error("[schedules] list error:", err);
    return res.status(500).json({ error: "Failed to load schedules" });
  }
});

// ─── PATCH /artists/:id ──────────────────────────────────────────────────────
function validWeekly(v) {
  if (v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("Weekly hours must be per day");
  for (const [day, list] of Object.entries(v)) {
    if (!DAYS.includes(day)) throw new Error(`Unknown day ${day}`);
    if (!Array.isArray(list) || list.length > 3) throw new Error("Up to 3 working periods a day");
    for (const p of list) {
      if (!TIME_RE.test(p?.start || "") || !TIME_RE.test(p?.end || "") || p.end <= p.start) {
        throw new Error("Each working period needs a start before its end");
      }
    }
  }
  return true;
}

router.patch(
  "/artists/:id",
  validateId,
  authorizePermission(PERMISSIONS.SCHEDULES_MANAGE),
  [
    body("onlineBookable").optional().isBoolean({ strict: true }),
    body("onlineShare").optional().isInt({ min: 0, max: 100 }).withMessage("Online share is 0–100%").toInt(),
    body("weekly").optional({ nullable: false }).custom(validWeekly),
    body("breaks").optional().isArray({ max: 14 }),
    body("breaks.*.day").isIn([...DAYS, "all"]).withMessage("Unknown day"),
    body("breaks.*.start").matches(TIME_RE).withMessage("Break start like 14:00"),
    body("breaks.*.end").matches(TIME_RE).withMessage("Break end like 14:30"),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const before = await Artist.findOne({ _id: req.params.id, isActive: true }).lean();
      if (!before) return res.status(404).json({ error: "Artist not found" });
      const set = {};
      if (req.body.onlineBookable !== undefined) set.onlineBookable = req.body.onlineBookable;
      if (req.body.onlineShare !== undefined) set.onlineShare = req.body.onlineShare;
      if (req.body.weekly !== undefined) set["schedule.weekly"] = req.body.weekly;
      if (req.body.breaks !== undefined) {
        if (req.body.breaks.some((b) => b.end <= b.start)) return res.status(400).json({ error: "A break must end after it starts" });
        set["schedule.breaks"] = req.body.breaks.map((b) => ({ day: b.day, start: b.start, end: b.end }));
      }
      if (!Object.keys(set).length) return res.status(400).json({ error: "Nothing to change" });

      const after = await Artist.findByIdAndUpdate(req.params.id, { $set: set }, { returnDocument: "after", runValidators: true }).lean();
      const was = artistView(before);
      const now = artistView(after);
      const changed = Object.fromEntries(
        Object.keys(now).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k])).map((k) => [k, { from: was[k], to: now[k] }])
      );
      if (Object.keys(changed).length) {
        await audit.record({ action: "artist.schedule_changed", req, target: { name: after.name }, meta: { artistId: String(after._id), changed } });
        // The website's "Book online" switch follows whether any artist is online
        // ("site"), and the sheet's artist list carries each artist's switch ("artists").
        if (changed.onlineBookable) await require("../utils/revalidate").revalidateSite(["site", "artists"]);
      }
      return res.json({ artist: now });
    } catch (err) {
      console.error("[schedules] update error:", err);
      return res.status(500).json({ error: "Failed to save" });
    }
  }
);

// ─── POST /time-off ──────────────────────────────────────────────────────────
/**
 * Body: { artistId, startDate, endDate, startTime?, endTime?, reason? }
 * Returns { timeOff, moved: [...], flagged: [...] }.
 * Whole days when the times are left out: startDate 00:00 → endDate+1 00:00 IST.
 */
router.post(
  "/time-off",
  authorizePermission(PERMISSIONS.SCHEDULES_MANAGE),
  [
    body("artistId").isMongoId().withMessage("Pick an artist"),
    body("startDate").custom(isValidDate).withMessage("Pick a start date"),
    body("endDate").custom(isValidDate).withMessage("Pick an end date"),
    body("startTime").optional({ nullable: true, checkFalsy: true }).matches(TIME_RE).withMessage("Start time like 14:00"),
    body("endTime").optional({ nullable: true, checkFalsy: true }).matches(TIME_RE).withMessage("End time like 18:00"),
    body("reason").optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const b = req.body;
      const artist = await Artist.findOne({ _id: b.artistId, isActive: true }, { name: 1 }).lean();
      if (!artist) return res.status(400).json({ error: "That artist is not active" });
      const startAt = salonInstant(b.startDate, b.startTime || "00:00");
      const endAt = b.endTime ? salonInstant(b.endDate, b.endTime) : salonInstant(addDays(b.endDate, 1), "00:00");
      if (!(endAt > startAt)) return res.status(400).json({ error: "Leave must end after it starts" });
      if (endAt - startAt > 62 * 24 * 3600e3) return res.status(400).json({ error: "Add leave in blocks of up to 2 months" });

      const row = await TimeOff.create({ artistId: artist._id, startAt, endAt, reason: b.reason?.trim() || null, createdBy: req.session?.userId || null });
      // Saved first: the engine then sees the artist as away when it looks for a replacement.
      const { moved, flagged } = await bookingsOverlapping({ from: startAt, to: endAt, artistId: artist._id }).then((c) =>
        c.length
          ? reassignForLeave({ artistId: artist._id, from: startAt, to: endAt, reason: row.reason, by: req.session?.name || "staff", byUserId: req.session?.userId || null })
          : { moved: [], flagged: [] }
      );
      await audit.record({
        action: "artist.time_off_added",
        req,
        target: { name: artist.name },
        meta: { timeOffId: String(row._id), artistId: String(artist._id), startAt, endAt, reason: row.reason, moved: moved.map((m) => m.ref), needsAttention: flagged.map((f) => f.ref) },
      });

      await alertReassigned({ artistName: artist.name, why: row.reason, moved, flagged });
      return res.status(201).json({ timeOff: { _id: row._id, artistId: row.artistId, artistName: artist.name, startAt, endAt, reason: row.reason }, moved, flagged });
    } catch (err) {
      console.error("[schedules] time-off error:", err);
      return res.status(500).json({ error: "Failed to save leave" });
    }
  }
);

// ─── DELETE /time-off/:id ────────────────────────────────────────────────────
router.delete("/time-off/:id", validateId, authorizePermission(PERMISSIONS.SCHEDULES_MANAGE), async (req, res) => {
  try {
    const row = await TimeOff.findByIdAndDelete(req.params.id).lean();
    if (!row) return res.status(404).json({ error: "Leave not found" });
    const artist = await Artist.findById(row.artistId, { name: 1 }).lean();
    await audit.record({
      action: "artist.time_off_removed",
      req,
      target: { name: artist?.name ?? null },
      meta: { timeOffId: String(row._id), artistId: String(row.artistId), startAt: row.startAt, endAt: row.endAt, reason: row.reason },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[schedules] time-off delete error:", err);
    return res.status(500).json({ error: "Failed to remove leave" });
  }
});

module.exports = router;
