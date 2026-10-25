/**
 * @file utils/booking/conflicts.js
 * @description Which bookings overlap a time (E8, E23).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const Appointment = require("../../models/Appointment");
const mongoose = require("mongoose");


/** Which bookings own the given artist blocks (for "who is in the way?"). */
async function ownersOf(locks) {
  const ids = [...new Set(locks.filter((l) => l.appointmentId).map((l) => String(l.appointmentId)))];
  const appts = ids.length ? await Appointment.find({ _id: { $in: ids } }, { ref: 1, name: 1, status: 1, startAt: 1 }).lean() : [];
  const blocked = locks.some((l) => !l.appointmentId);
  return [...appts.map((a) => ({ _id: a._id, ref: a.ref, name: a.name, status: a.status, startAt: a.startAt })), ...(blocked ? [{ ref: null, name: "Blocked time", status: "blocked" }] : [])];
}

// ─── Conflicts (E8, E23) ─────────────────────────────────────────────────────

/** Statuses that occupy an artist's time. */
const OCCUPYING = ["pending_payment", "requested", "confirmed", "checked_in"];

/**
 * Bookings and walk-ins with an item overlapping [from, to), optionally for
 * one artist. Used to warn before leave or a holiday is saved over them.
 * @returns {Promise<{_id, ref, name, contact, status, startAt, items: {name, artistName, startAt, endAt}[]}[]>}
 */
async function bookingsOverlapping({ from, to, artistId = null }) {
  const itemMatch = { startAt: { $lt: to }, endAt: { $gt: from }, ...(artistId ? { artistId: new mongoose.Types.ObjectId(String(artistId)) } : {}) };
  const rows = await Appointment.find(
    { status: { $in: OCCUPYING }, guests: { $elemMatch: { items: { $elemMatch: itemMatch } } } },
    { ref: 1, name: 1, contact: 1, status: 1, startAt: 1, guests: 1 }
  )
    .sort({ startAt: 1 })
    .limit(100)
    .lean();
  return rows.map((a) => ({
    _id: a._id,
    ref: a.ref,
    name: a.name,
    contact: a.contact,
    status: a.status,
    startAt: a.startAt,
    items: a.guests
      .flatMap((g) => g.items)
      .filter((i) => i.startAt < to && i.endAt > from && (!artistId || String(i.artistId) === String(artistId)))
      .map((i) => ({ name: i.name, artistName: i.artistName, startAt: i.startAt, endAt: i.endAt })),
  }));
}

module.exports = { ownersOf, bookingsOverlapping, OCCUPYING };
