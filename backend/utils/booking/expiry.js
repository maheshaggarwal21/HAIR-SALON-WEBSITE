/**
 * @file utils/booking/expiry.js
 * @description Cron: give back time held by unpaid bookings, and ask Razorpay before letting go (§16).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const mongoose = require("mongoose");
const Appointment = require("../../models/Appointment");
const SlotLock = require("../../models/SlotLock");
const payments = require("../payments");
const { confirmPayment } = require("./payment");
const { releaseBySalon } = require("./salon");

 // ~6 months (§4.2)
/** A hold is only given away this long after it lapses: checkout may still be finishing. */
const EXPIRY_GRACE_MS = 2 * 60 * 1000;

// ─── Expiry (cron, §16) ──────────────────────────────────────────────────────

/** Close an unpaid booking and give its time back. Conditional on still being unpaid. */
async function releaseUnpaid(id, now, to, reason) {
  const session = await mongoose.startSession();
  try {
    let done = false;
    await session.withTransaction(async () => {
      const res = await Appointment.updateOne(
        { _id: id, status: "pending_payment", "deposit.status": { $in: ["pending", "none"] } },
        {
          $set: { status: to, holdExpiresAt: null, ...(to === "cancelled" ? { cancelledAt: now, cancelledBy: "system", cancelReason: reason } : {}) },
          $push: { statusHistory: { from: "pending_payment", to, at: now, by: "system", reason } },
        },
        { session }
      );
      done = res.modifiedCount === 1;
      if (done) await SlotLock.deleteMany({ appointmentId: id }, { session });
    });
    return done;
  } finally {
    await session.endSession();
  }
}

/**
 * Unpaid holds past `holdExpiresAt` (+ grace) → expired. Before giving a slot
 * away, ask Razorpay whether the order was in fact paid (a slow webhook): if
 * so, confirm it instead. Requests whose approval window passed → expired with
 * a full refund queued (§3: salon side). Idempotent.
 */
async function expireBookings(now = new Date()) {
  const out = { holdsExpired: 0, paidLate: 0, requestsExpired: 0 };
  const due = await Appointment.find(
    { status: "pending_payment", holdExpiresAt: { $lte: new Date(now.getTime() - EXPIRY_GRACE_MS) } },
    { _id: 1, "deposit.razorpayOrderId": 1 }
  )
    .limit(50)
    .lean();
  for (const a of due) {
    const orderId = a.deposit?.razorpayOrderId;
    if (orderId && payments.isConfigured()) {
      try {
        const [p] = await payments.capturedPayments(orderId);
        if (p) {
          await confirmPayment({ orderId, paymentId: p.id, amount: p.amount / 100, now });
          out.paidLate += 1;
          continue;
        }
      } catch (err) {
        // Can't tell whether it was paid: keep the hold and look again next tick.
        console.error(`[booking] Razorpay check for ${orderId} failed:`, err.message);
        continue;
      }
    }
    if (await releaseUnpaid(a._id, now, "expired", "hold_expired")) out.holdsExpired += 1;
  }

  const lapsed = await Appointment.find({ status: "requested", requestExpiresAt: { $ne: null, $lte: now } }, { _id: 1 }).limit(50).lean();
  for (const a of lapsed) {
    const r = await releaseBySalon(a._id, { from: "requested", to: "expired", reason: "request_not_answered", by: "system", now });
    if (r.ok) out.requestsExpired += 1;
  }
  return out;
}

module.exports = { releaseUnpaid, expireBookings };
