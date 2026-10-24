/**
 * @file board.js
 * @description The Today board's data for one IST date (CF §7, T2.14).
 *
 * One row per active artist, with:
 *   - working intervals that day (weekly hours ∩ opening hours − breaks − leave),
 *     the same calculation the engine uses, so a gap on the board is a gap online;
 *   - leave and blocked time as greyed ranges;
 *   - every booking item on that artist: online bookings, requests holding
 *     time, phone/desk bookings, walk-ins, completed and no-show visits.
 * Cancelled, declined and expired bookings hold no time and are left out.
 *
 * Plus a "needs attention" list: requests to approve (engine requests with a
 * held time, and request-lite requests for that day) and walk-ins forced over
 * a booking (E2) that still need moving.
 *
 * Staff-only data (phones, notes) — served behind bookings.view.
 */

const Artist = require("../models/Artist");
const Appointment = require("../models/Appointment");
const SlotLock = require("../models/SlotLock");
const TimeOff = require("../models/TimeOff");
const SiteSettings = require("../models/SiteSettings");
const { artistIntervals } = require("./availabilityLoader");
const { openingIntervals, salonInstant, addDays, BLOCK_MS } = require("./time");

const SHOWN = ["pending_payment", "requested", "confirmed", "checked_in", "completed", "no_show"];

/** Consecutive 15-min blocks → ranges. */
function toRanges(blockMs) {
  const sorted = [...blockMs].sort((a, b) => a - b);
  const out = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === b) last.end = b + BLOCK_MS;
    else out.push({ start: b, end: b + BLOCK_MS });
  }
  return out;
}

async function dayBoard(date, now = new Date()) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  const dayStart = salonInstant(date, "00:00");
  const dayEnd = salonInstant(addDays(date, 1), "00:00");
  const opening = openingIntervals(settings, date);

  const [artists, timeOffs, appts, blocks, lite] = await Promise.all([
    Artist.find({ isActive: true }).sort({ name: 1 }).lean(),
    TimeOff.find({ startAt: { $lt: dayEnd }, endAt: { $gt: dayStart } }).lean(),
    Appointment.find({ status: { $in: SHOWN }, startAt: { $lt: dayEnd }, endAt: { $gt: dayStart } }).sort({ startAt: 1 }).lean(),
    SlotLock.find({ kind: "artist", appointmentId: null, blockStart: { $gte: dayStart, $lt: dayEnd } }).lean(),
    Appointment.find({ status: "requested", startAt: null, "requestedWindow.date": date }, { ref: 1, name: 1, contact: 1, requestedWindow: 1, createdAt: 1 }).lean(),
  ]);

  // An artist who has left but still has bookings that day (nobody was free to take them)
  // must stay on the board, or those customers would vanish from it (D51).
  const present = new Set(artists.map((a) => String(a._id)));
  const strandedIds = [...new Set(appts.flatMap((ap) => ap.guests.flatMap((g) => g.items.map((i) => String(i.artistId || "")))))].filter((id) => id && !present.has(id));
  const found = strandedIds.length ? await Artist.find({ _id: { $in: strandedIds } }).lean() : [];
  const foundIds = new Set(found.map((a) => String(a._id)));
  const nameOf = (id) => appts.flatMap((ap) => ap.guests.flatMap((g) => g.items)).find((i) => String(i.artistId) === id)?.artistName || "Former artist";
  const gone = [...found.map((a) => ({ ...a, isActive: false })), ...strandedIds.filter((id) => !foundIds.has(id)).map((id) => ({ _id: id, name: nameOf(id), isActive: false }))];
  const rows = [...artists, ...gone].map((a) => {
    const id = String(a._id);
    const mine = timeOffs.filter((t) => String(t.artistId) === id);
    const items = [];
    for (const ap of appts) {
      for (const [gi, g] of ap.guests.entries()) {
        for (const i of g.items) {
          if (String(i.artistId) !== id || !i.startAt) continue;
          items.push({
            appointmentId: ap._id,
            ref: ap.ref,
            status: ap.status,
            mode: ap.mode,
            channel: ap.source?.channel || null,
            // One row per person (D67): a second person with no name of their own is not shown as the booker.
            name: g.name || (gi === 0 ? ap.name : `${ap.name} (guest ${gi + 1})`),
            guestKey: g.guestKey,
            guestName: g.name || null,
            groupSize: ap.guests.length,
            groupMode: ap.groupMode || "parallel",
            artistName: i.artistName || null,
            contact: ap.contact,
            service: i.name,
            price: i.publicPrice,
            startAt: i.startAt,
            endAt: i.endAt,
            // The artist is busy until the buffer (cleanup) ends.
            busyUntil: new Date(new Date(i.startAt).getTime() + Math.ceil(((i.durationMin || 0) + (i.bufferMin || 0)) / 15) * BLOCK_MS),
            lockConflict: Boolean(ap.lockConflict),
            deposit: ap.deposit?.amount ? { kind: ap.deposit.kind, amount: ap.deposit.amount, status: ap.deposit.status } : null,
            notes: ap.notes,
            internalNote: ap.internalNote,
            requestExpiresAt: ap.requestExpiresAt,
            holdExpiresAt: ap.holdExpiresAt,
            checkedInAt: ap.checkedInAt,
            finishedAt: ap.finishedAt,
            visitId: ap.visitId,
          });
        }
      }
    }
    const blockNotes = new Map();
    const myBlocks = blocks.filter((b) => String(b.artistId) === id);
    for (const b of myBlocks) blockNotes.set(new Date(b.blockStart).getTime(), b.note || null);
    return {
      _id: a._id,
      name: a.name,
      onlineBookable: Boolean(a.onlineBookable),
      inactive: a.isActive === false,
      working: artistIntervals(a, opening, date, mine).map((w) => ({ start: new Date(w.start), end: new Date(w.end) })),
      leave: mine.map((t) => ({ _id: t._id, start: t.startAt, end: t.endAt, reason: t.reason })),
      blocked: toRanges(myBlocks.map((b) => new Date(b.blockStart).getTime())).map((r) => ({
        start: new Date(r.start),
        end: new Date(r.end),
        note: blockNotes.get(r.start) || null,
      })),
      items,
    };
  });

  const attention = [
    ...appts
      .filter((a) => a.status === "requested")
      .map((a) => ({ kind: "approve", appointmentId: a._id, ref: a.ref, name: a.name, contact: a.contact, startAt: a.startAt, requestExpiresAt: a.requestExpiresAt })),
    ...appts
      .filter((a) => a.lockConflict && ["checked_in", "confirmed"].includes(a.status))
      .map((a) => ({ kind: "conflict", appointmentId: a._id, ref: a.ref, name: a.name, contact: a.contact, startAt: a.startAt })),
    ...lite.map((a) => ({ kind: "request", appointmentId: a._id, ref: a.ref, name: a.name, contact: a.contact, window: a.requestedWindow?.window })),
  ];

  return {
    date,
    now,
    opening: opening.map((o) => ({ start: new Date(o.start), end: new Date(o.end) })),
    closed: opening.length === 0,
    artists: rows,
    attention,
    noShowGraceMinutes: settings.noShowGraceMinutes ?? 15,
  };
}

module.exports = { dayBoard, toRanges };
