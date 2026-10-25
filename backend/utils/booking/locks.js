/**
 * @file utils/booking/locks.js
 * @description SlotLock documents: build them, convert hold to firm, and read duplicate-key errors.
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const { BLOCK_MS, blocksFor, addWorkingMinutes } = require("../time");


// ─── Locks ───────────────────────────────────────────────────────────────────

/** Every SlotLock a booking owns, rebuilt from its item snapshots. */
function lockDocsFor(appt, { state, expiresAt }, unitFor = () => 0) {
  const docs = [];
  for (const g of appt.guests) {
    for (const i of g.items) {
      if (!i.startAt || !i.artistId) continue;
      const start = new Date(i.startAt).getTime();
      const end = start + blocksFor((i.durationMin || 0) + (i.bufferMin || 0));
      for (let b = start; b < end; b += BLOCK_MS) {
        const base = { appointmentId: appt._id, blockStart: new Date(b), state, ...(expiresAt ? { expiresAt } : {}) };
        docs.push({ ...base, kind: "artist", artistId: i.artistId, resourceUnit: 0 });
        for (const rid of i.resourceIds || []) docs.push({ ...base, kind: "resource", artistId: rid, resourceUnit: unitFor(i, rid) });
      }
    }
  }
  return docs;
}

/** Blocks of expired holds inside a booking's window: dead, but TTL may not have run yet (E19). */
function expiredHoldsFilter(appt, now) {
  return {
    state: "hold",
    expiresAt: { $lte: now },
    blockStart: { $gte: new Date(appt.startAt), $lt: new Date(appt.endAt) },
  };
}

/** Which unique key a duplicate-key error hit, across insertMany / create shapes. */
function duplicateKey(err) {
  const e = err?.writeErrors?.[0]?.err || err?.writeErrors?.[0] || err;
  if (err?.code !== 11000 && e?.code !== 11000) return null;
  const pattern = err.keyPattern || e.keyPattern || {};
  if ("blockStart" in pattern) return "slot";
  if ("ref" in pattern) return "ref";
  if ("phone" in pattern) return "phone";
  const msg = String(err.message || e.errmsg || "");
  if (msg.includes("blockStart")) return "slot";
  if (msg.includes("ref_")) return "ref";
  if (msg.includes("phone")) return "phone";
  return "other";
}

/** Lock state + appointment fields once a booking stops waiting for money. */
function settledState(appt, settings, now) {
  if (appt.mode === "request") {
    const sla = addWorkingMinutes(settings, now, settings.requestSlaMinutes) || new Date(now.getTime() + settings.requestSlaMinutes * 60_000);
    // Never hold past the appointment itself.
    const requestExpiresAt = new Date(Math.min(sla.getTime(), new Date(appt.startAt).getTime()));
    return { status: "requested", lock: { state: "hold", expiresAt: requestExpiresAt }, requestExpiresAt };
  }
  return { status: "confirmed", lock: { state: "firm", expiresAt: null }, requestExpiresAt: null };
}

function lockUpdate(lock) {
  return lock.expiresAt
    ? { $set: { state: lock.state, expiresAt: lock.expiresAt } }
    : { $set: { state: lock.state }, $unset: { expiresAt: "" } };
}

// ─── Front desk (T2.14–T2.17) ────────────────────────────────────────────────

const FIRM = { state: "firm", expiresAt: null };

module.exports = { settledState, expiredHoldsFilter, lockDocsFor, duplicateKey, lockUpdate, FIRM };
