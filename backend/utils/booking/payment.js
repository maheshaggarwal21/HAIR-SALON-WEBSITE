/**
 * @file utils/booking/payment.js
 * @description Money for a booking arrived (webhook or browser), including a wrong amount and a late payment (§5.3, E4, E4b).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const Appointment = require("../../models/Appointment");
const SlotLock = require("../../models/SlotLock");
const { alertBooking } = require("../bookingAlerts");
const { notify } = require("../notify");
const SiteSettings = require("../../models/SiteSettings");
const mongoose = require("mongoose");
const { autoRefund } = require("./refunds");
const { duplicateKey, expiredHoldsFilter, lockDocsFor, lockUpdate, settledState } = require("./locks");
const { afterSettled } = require("./messages");

// ─── Payment (§5.3) ──────────────────────────────────────────────────────────

/**
 * Money for a booking arrived (webhook or browser). Idempotent.
 * @param {object} p
 * @param {string} p.orderId
 * @param {string} p.paymentId
 * @param {number} [p.amount]    rupees, as captured
 * @returns {Promise<{outcome: "confirmed"|"requested"|"already"|"refund_queued"|"unknown_order"|"amount_mismatch", appt?: object}>}
 */
async function confirmPayment({ orderId, paymentId, amount = null, now = new Date() }) {
  const first = await Appointment.findOne({ "deposit.razorpayOrderId": orderId }).lean();
  if (!first) return { outcome: "unknown_order" };
  if (first.deposit.status !== "pending") return { outcome: "already", appt: first };
  if (amount != null && Math.round(amount) !== first.deposit.amount) {
    console.error(`[booking] ${first.ref}: paid ₹${amount}, expected ₹${first.deposit.amount}`);
    // Audit #4: money that matches no booking is not kept and re-checked forever. Cancel by system and queue a
    // refund of what Razorpay actually captured, the same as a payment that arrives after the hold expired.
    // Conditional on the deposit still being pending, so a repeat of this call (webhook retry, the 15-minute
    // tick) finds it already handled ("already") and refunds nothing twice.
    const captured = Math.round(amount * 100) / 100;
    const cancelled = await Appointment.findOneAndUpdate(
      { _id: first._id, "deposit.status": "pending" },
      [
        {
          $set: {
            "deposit.status": "paid",
            "deposit.paidAt": now,
            "deposit.razorpayPaymentId": paymentId,
            "deposit.amount": captured, // what was actually received, so "refunded in full" reads true
            holdExpiresAt: null,
            status: "cancelled",
            cancelledAt: { $ifNull: ["$cancelledAt", now] },
            cancelledBy: { $ifNull: ["$cancelledBy", "system"] },
            cancelReason: { $ifNull: ["$cancelReason", "payment_amount_mismatch"] },
            refund: { amount: captured, status: "pending", reason: "system_payment_mismatch", requestedAt: now, razorpayRefundId: null, processedAt: null, attempts: 0, error: null },
            statusHistory: { $concatArrays: ["$statusHistory", [{ from: "$status", to: "cancelled", at: now, by: "system", byUserId: null, reason: "payment_amount_mismatch" }]] },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true }
    ).lean();
    if (!cancelled) return { outcome: "already", appt: first };
    await SlotLock.deleteMany({ appointmentId: first._id });
    await alertBooking(first, "payment_mismatch");
    const sent = await autoRefund(cancelled);
    if (!sent?.ok) {
      await notify({ key: `${first._id}:payment_mismatch`, type: "booking_refund", to: first.contact, appointmentId: first._id, params: { name: first.name, ref: first.ref, amount: captured } });
    }
    return { outcome: "amount_mismatch", appt: sent?.ok ? sent.appt : cancelled };
  }

  const settings = (await SiteSettings.getSingleton()).toObject();
  const settled = settledState(first, settings, now);
  const paid = { "deposit.status": "paid", "deposit.paidAt": now, "deposit.razorpayPaymentId": paymentId, holdExpiresAt: null };
  let outcome = null;
  let updated = null;

  const session = await mongoose.startSession();
  try {
    try {
      await session.withTransaction(async () => {
        outcome = null;
        const appt = await Appointment.findOne({ _id: first._id, "deposit.status": "pending" }, null, { session }).lean();
        if (!appt) {
          outcome = "already";
          return;
        }
        // Cancelled for another reason before the money landed: refund it all.
        if (!["pending_payment", "expired"].includes(appt.status)) {
          throw Object.assign(new Error("not payable"), { notPayable: true });
        }
        const expected = lockDocsFor(appt, settled.lock);
        const own = await SlotLock.countDocuments({ appointmentId: appt._id }, { session });
        if (own === expected.length) {
          await SlotLock.updateMany({ appointmentId: appt._id }, lockUpdate(settled.lock), { session });
        } else {
          // The hold lapsed (E3): take the same blocks back if they're still free.
          await SlotLock.deleteMany({ appointmentId: appt._id }, { session });
          await SlotLock.deleteMany(expiredHoldsFilter(appt, now), { session });
          await SlotLock.insertMany(expected, { session, ordered: true });
        }
        updated = await Appointment.findOneAndUpdate(
          { _id: appt._id, "deposit.status": "pending" },
          {
            $set: { ...paid, status: settled.status, requestExpiresAt: settled.requestExpiresAt },
            $push: { statusHistory: { from: appt.status, to: settled.status, at: now, by: "system", reason: "payment_received" } },
          },
          { returnDocument: "after", session }
        );
        outcome = settled.status;
      });
    } catch (err) {
      if (duplicateKey(err) !== "slot" && !err.notPayable) throw err;
      // E4: paid, but the time has gone (or the booking was already closed).
      // Cancel by system with everything in the refund queue; tell the owner.
      updated = await Appointment.findOneAndUpdate(
        { _id: first._id, "deposit.status": "pending" },
        [
          {
            $set: {
              ...paid,
              status: "cancelled",
              cancelledAt: { $ifNull: ["$cancelledAt", now] },
              cancelledBy: { $ifNull: ["$cancelledBy", "system"] },
              cancelReason: { $ifNull: ["$cancelReason", "paid_after_hold_expired"] },
              refund: {
                amount: first.deposit.amount,
                status: "pending",
                reason: "paid_after_hold_expired",
                requestedAt: now,
                razorpayRefundId: null,
                processedAt: null,
                attempts: 0,
                error: null,
              },
              statusHistory: {
                $concatArrays: [
                  "$statusHistory",
                  [{ from: "$status", to: "cancelled", at: now, by: "system", byUserId: null, reason: "paid_after_hold_expired" }],
                ],
              },
            },
          },
        ],
        { returnDocument: "after", updatePipeline: true }
      ).lean();
      outcome = updated ? "refund_queued" : "already";
    }
  } finally {
    await session.endSession();
  }

  if (outcome === "refund_queued") {
    await SlotLock.deleteMany({ appointmentId: first._id });
    await alertBooking(updated, "paid_after_hold_expired");
    // Sent at once when automatic; the customer then hears "refund sent" from sendRefund,
    // otherwise they are told it is on its way.
    const sent = await autoRefund(updated);
    if (sent?.ok) updated = sent.appt;
    else {
      await notify({
        key: `${first._id}:paid_after_expiry`,
        type: "booking_refund",
        to: first.contact,
        appointmentId: first._id,
        params: { name: first.name, ref: first.ref, amount: first.deposit.amount },
      });
    }
  } else if (outcome === "confirmed" || outcome === "requested") {
    await afterSettled(updated, settings);
  }
  return { outcome, appt: updated || first };
}

module.exports = { confirmPayment };
