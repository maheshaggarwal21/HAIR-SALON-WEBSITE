/**
 * @file utils/booking/salon.js
 * @description Salon side: decline or cancel, free the time, queue the refund (§3, §6).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const SiteSettings = require("../../models/SiteSettings");
const mongoose = require("mongoose");
const Appointment = require("../../models/Appointment");
const { refundFor } = require("../quote");
const SlotLock = require("../../models/SlotLock");
const Customer = require("../../models/Customer");
const { notify } = require("../notify");
const { autoRefund } = require("./refunds");

/**
 * Close a booking: decline, cancel, expire or no-show. In one transaction the
 * status changes (conditional on the status staff saw), the locks go (the time
 * is sellable at once) and any money owed back is queued.
 *
 *   side "salon" / "system" → everything paid comes back (D18);
 *   side "customer"         → the cancellation fee is kept: refund = paid − min(paid, fee),
 *                             unless the owner has set a free-cancellation window.
 * Works for request-lite requests too (no locks, nothing paid).
 *
 * @returns {Promise<{ok: true, appt} | {ok: false, error: "CONFLICT"}>}
 */
async function closeBooking(id, { from, to, side = "salon", reason = null, by = "staff", byUserId = null, now = new Date(), notifyCustomer = true }) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  const fromList = [].concat(from);
  const session = await mongoose.startSession();
  let updated = null;
  let prior = null;
  try {
    await session.withTransaction(async () => {
      updated = null;
      const appt = await Appointment.findOne({ _id: id, status: { $in: fromList } }, null, { session }).lean();
      if (!appt) return;
      prior = appt.status;
      const { refund, kept } = side === "customer" ? refundFor(appt, "customer", settings, now) : refundFor(appt, "salon", settings, now);
      const set = { status: to };
      if (to === "cancelled") Object.assign(set, { cancelledAt: now, cancelledBy: side, cancelReason: reason });
      if (kept > 0) {
        set["deposit.status"] = refund > 0 ? "paid" : "forfeited";
        set.feeKept = kept;
        set.feeKeptAt = now;
      }
      if (refund > 0) {
        set.refund = {
          amount: refund,
          status: "pending",
          reason: `${side}_${to}`,
          requestedAt: now,
          razorpayRefundId: null,
          processedAt: null,
          attempts: 0,
          error: null,
          claimedAt: null,
        };
      }
      updated = await Appointment.findOneAndUpdate(
        { _id: id, status: appt.status },
        { $set: set, $push: { statusHistory: { from: appt.status, to, at: now, by, byUserId, reason } } },
        { returnDocument: "after", session }
      );
      if (updated) await SlotLock.deleteMany({ appointmentId: id }, { session });
    });
  } finally {
    await session.endSession();
  }
  if (!updated) return { ok: false, error: "CONFLICT" };

  if (to === "no_show" && updated.customerId) {
    await Customer.updateOne({ _id: updated.customerId }, { $inc: { "stats.noShows": 1 } });
  }

  // Engine and phone bookings get a WhatsApp; request-lite ones are handled by phone as before.
  const engineBooking = updated.startAt && (updated.deposit?.amount || updated.requestExpiresAt || updated.source?.channel !== "web");
  // A WhatsApp-ad request (D62) has no time held yet, but the customer asked on WhatsApp, so a decline is answered there.
  const waDeclined = updated.source?.channel === "wa_ad" && to === "declined";
  // An unpaid WhatsApp-ad request that is cancelled (by the salon or by the customer) has nothing to refund either.
  const waCancelled = updated.source?.channel === "wa_ad" && to === "cancelled" && !(updated.deposit?.amount > 0);
  if (notifyCustomer && (engineBooking || waDeclined) && updated.source?.channel !== "walkin" && ["cancelled", "declined", "expired"].includes(to)) {
    await notify({
      key: `${updated._id}:${to}`,
      // A declined WhatsApp-ad request (D62) is unpaid, so it gets its own wording with no refund line.
      type: to === "cancelled" ? (waCancelled ? "request_cancelled" : "booking_cancelled") : waDeclined ? "request_declined" : "booking_declined",
      to: updated.contact,
      appointmentId: updated._id,
      params: { name: updated.name, ref: updated.ref, refund: updated.refund?.amount || 0 },
    });
  }
  const auto = await autoRefund(updated);
  return { ok: true, appt: auto?.appt || updated, from: prior };
}

/** Salon-side decline / cancel / expire: everything paid comes back. */
function releaseBySalon(id, opts) {
  return closeBooking(id, { ...opts, side: opts.by === "system" ? "system" : "salon" });
}

module.exports = { releaseBySalon, closeBooking };
