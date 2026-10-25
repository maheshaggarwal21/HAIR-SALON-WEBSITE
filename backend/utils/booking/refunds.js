/**
 * @file utils/booking/refunds.js
 * @description Refunds: automatic sending, retries, the sender (never twice, E24) and the owner's adjustments.
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const SiteSettings = require("../../models/SiteSettings");
const Appointment = require("../../models/Appointment");
const payments = require("../payments");
const { notify } = require("../notify");
const { alertBooking } = require("../bookingAlerts");


/**
 * Refunds that need no judgement: the salon (or the system) ended the booking,
 * so the whole payment goes back. These are sent at once; customer
 * cancellations and no-shows stay in the queue for the owner (D45).
 */
const AUTO_REFUND_REASON = /^(salon_|system_)|^paid_after_hold_expired$/;

const AUTO_REFUND_MAX_ATTEMPTS = 3;

async function autoRefund(appt) {
  if (!appt || appt.refund?.status !== "pending" || !AUTO_REFUND_REASON.test(appt.refund.reason || "")) return null;
  const settings = (await SiteSettings.getSingleton()).toObject();
  if (settings.autoRefundSalonSide === false) return null;
  try {
    return await sendRefund(appt._id);
  } catch (err) {
    console.error("[booking] auto refund crashed:", err.message); // stays queued; the tick retries
    return null;
  }
}

/** Cron: try again on automatic refunds that failed or were interrupted (a few times, then the owner decides). */
async function retryAutoRefunds(now = new Date()) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  if (settings.autoRefundSalonSide === false) return 0;
  const rows = await Appointment.find(
    {
      "refund.status": { $in: ["pending", "failed", "processing"] },
      "refund.reason": AUTO_REFUND_REASON,
      "refund.attempts": { $lt: AUTO_REFUND_MAX_ATTEMPTS },
      "refund.requestedAt": { $lt: new Date(now.getTime() - 5 * 60_000) },
    },
    { _id: 1 }
  ).limit(25).lean();
  let sent = 0;
  for (const r of rows) {
    const out = await sendRefund(r._id, { now });
    if (out.ok) sent++;
  }
  return sent;
}

// ─── Refunds (T2.17, E24) ────────────────────────────────────────────────────

const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Send a queued refund through Razorpay. The claim (pending/failed →
 * processing) is a conditional update, so a double tap or two staff can't
 * refund twice. On failure the refund goes back to "failed" with the error,
 * stays in the queue, and the owner is alerted (E24).
 */
async function sendRefund(id, { now = new Date() } = {}) {
  const claimed = await Appointment.findOneAndUpdate(
    {
      _id: id,
      "refund.amount": { $gt: 0 },
      $or: [{ "refund.status": { $in: ["pending", "failed"] } }, { "refund.status": "processing", "refund.claimedAt": { $lt: new Date(now.getTime() - CLAIM_STALE_MS) } }],
    },
    { $set: { "refund.status": "processing", "refund.claimedAt": now }, $inc: { "refund.attempts": 1 } },
    { returnDocument: "after" }
  ).lean();
  if (!claimed) return { ok: false, error: "CONFLICT" };
  const paymentId = claimed.deposit?.razorpayPaymentId;
  try {
    if (!paymentId) throw new Error("No Razorpay payment on this booking — refund by hand and mark it");
    // Audit #5: on a RETRY (an earlier attempt may have reached Razorpay even though its reply was lost), adopt a
    // refund Razorpay already holds for this payment, amount and booking instead of sending a second one. If the
    // list cannot be read, this throws and the refund stays queued as failed: never a double refund.
    const earlier = claimed.refund.attempts > 1 ? await payments.findRefund(paymentId, claimed.refund.amount, claimed.ref) : null;
    const r = earlier || (await payments.refund(paymentId, claimed.refund.amount, { ref: claimed.ref, reason: claimed.refund.reason || "" }));
    const full = claimed.refund.amount >= (claimed.deposit.amount || 0);
    const updated = await Appointment.findOneAndUpdate(
      { _id: id, "refund.status": "processing" },
      {
        $set: {
          "refund.status": "processed",
          "refund.razorpayRefundId": r.id,
          "refund.processedAt": now,
          "refund.error": null,
          "refund.claimedAt": null,
          "deposit.status": full ? "refunded" : "partially_refunded",
        },
      },
      { returnDocument: "after" }
    ).lean();
    // Tell the customer the money has actually left (the cancel message only said it would).
    await notify({
      key: `${id}:refund_sent:${r.id}`,
      type: "booking_refund",
      to: claimed.contact,
      appointmentId: claimed._id,
      params: { name: claimed.name, ref: claimed.ref, amount: claimed.refund.amount },
    });
    return { ok: true, appt: updated };
  } catch (err) {
    const message = err?.error?.description || err.message || "Refund failed";
    const updated = await Appointment.findOneAndUpdate(
      { _id: id, "refund.status": "processing" },
      { $set: { "refund.status": "failed", "refund.error": message, "refund.claimedAt": null } },
      { returnDocument: "after" }
    ).lean();
    await alertBooking(updated || claimed, "refund_failed");
    return { ok: false, error: "REFUND_FAILED", message, appt: updated };
  }
}

/**
 * Owner changes what goes back before it is sent: waive the cancellation fee
 * (refund all of it) or record that nothing goes back (amount 0, e.g. moved
 * to a new date by agreement). Never more than was paid.
 */
async function adjustRefund(id, { amount, reason = null }) {
  const appt = await Appointment.findOne({ _id: id, "refund.status": { $in: ["pending", "failed", "none"] }, "deposit.status": { $in: ["paid", "forfeited"] } }).lean();
  if (!appt) return { ok: false, error: "CONFLICT" };
  const paid = appt.deposit.amount || 0;
  if (!(amount >= 0 && amount <= paid)) return { ok: false, error: "VALIDATION", message: `Refund between ₹0 and ₹${paid}.` };
  const set =
    amount === 0
      ? { "refund.amount": 0, "refund.status": "none", "refund.reason": reason, "deposit.status": "forfeited" }
      : { "refund.amount": amount, "refund.status": "pending", "refund.reason": reason || appt.refund?.reason || "owner", "refund.requestedAt": appt.refund?.requestedAt || new Date(), "deposit.status": "paid" };
  set.feeKept = paid - amount; // what stays with the salon after this change (0 = fee waived)
  set.feeKeptAt = appt.feeKeptAt || new Date();
  const updated = await Appointment.findOneAndUpdate({ _id: id, "refund.status": appt.refund?.status ?? "none" }, { $set: set }, { returnDocument: "after" }).lean();
  return updated ? { ok: true, appt: updated, before: appt.refund?.amount || 0 } : { ok: false, error: "CONFLICT" };
}

module.exports = { autoRefund, retryAutoRefunds, sendRefund, adjustRefund };
