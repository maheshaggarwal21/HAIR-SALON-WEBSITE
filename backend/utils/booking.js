/**
 * @file booking.js
 * @description The booking engine's write side: create, pay, expire, approve,
 * decline and cancel (CONTROL_FLOW_AND_DATA_LOGIC.md §3, §5, §6, T2.7, T2.8).
 *
 * The read side — which start times are free — is the pure engine in
 * utils/availability.js, fed by utils/availabilityLoader.js. Everything here
 * that changes who owns an artist's time runs inside a MongoDB transaction
 * that inserts, converts or deletes SlotLock rows. The UNIQUE index on
 * SlotLock is the only thing that decides a race (D4, CLAUDE.md): this file
 * never asks "is it free?" and then writes; it writes and lets the index say no.
 *
 * ── Create (§5.1) ────────────────────────────────────────────────────────────
 *   1. per-phone limits: open bookings (E11) and overlapping times (E12);
 *   2. re-run the engine for the requested start only → 409 SLOT_TAKEN with
 *      the three nearest free times when it no longer fits (E1);
 *   3. price from the server's quote; the browser only says "full"/"deposit";
 *   4. TRANSACTION: delete expired holds in the window (TTL lag, E19) →
 *      insert every SlotLock (duplicate key = someone else won → SLOT_TAKEN) →
 *      upsert the Customer → create the Appointment;
 *   5. after commit: Razorpay order (or, for a ₹0 booking, confirm at once).
 *
 * Every online booking is paid online (D18), so a new booking is
 * `pending_payment` with HOLD locks that expire after `holdMinutes`. The
 * Customer upsert sits inside the transaction (the spec lists it after the
 * commit) so a failed booking never leaves a half-made customer behind and the
 * Appointment can carry `customerId` from its first write.
 *
 * ── Payment (§5.3, webhook first) ────────────────────────────────────────────
 * confirmPayment() is called by the Razorpay webhook AND by the browser's
 * verify-payment call; whichever comes second changes nothing (E5). If the
 * hold lapsed before the money arrived it tries to take the same blocks back
 * (E3); if someone else has them, the booking is cancelled by the system with
 * the full amount in the refund queue and the owner is alerted (E4). Money is
 * never kept silently.
 *
 * ── Salon side (§3, §6) ──────────────────────────────────────────────────────
 * approveRequest() turns a request's hold locks firm; releaseBySalon() declines
 * or cancels, deletes the locks so the time is sellable again, and queues a
 * FULL refund of anything paid (D18: salon-side = everything back). Refunds
 * are queued (`refund.status = "pending"`), never fired from here; the owner's
 * refund screen (T2.17) sends them, so a failed Razorpay call can't strand
 * money (E24).
 *
 * Messages and alerts are sent after the commit but BEFORE the route replies
 * (Vercel freezes the instance after the response). They never throw.
 */

/**
 * This file used to hold the whole engine (2,182 lines). It is now a list of what lives where, and every name
 * it ever exported is still exported from here, so `require("../utils/booking")` is unchanged for every caller.
 *
 *   booking/selection.js  what is bookable          booking/refunds.js    sending and adjusting refunds
 *   booking/locks.js      SlotLock documents        booking/salon.js      decline / cancel by the salon
 *   booking/messages.js   after a booking settles   booking/frontdesk.js  walk-ins, move, check-in, no-show
 *   booking/create.js     create a booking          booking/requests.js   requests, plans, group bookings
 *   booking/payment.js    money arrived             booking/manage.js     the customer's manage link
 *   booking/expiry.js     give back unpaid time     booking/conflicts.js  overlapping bookings
 *   booking/reminders.js  24h and 2h reminders
 */

const { bookingsOverlapping, OCCUPYING } = require("./booking/conflicts");
const { prepareSelection, findSlots, publicSlot, PATCH_TEST_VALID_MS } = require("./booking/selection");
const { createBooking } = require("./booking/create");
const { confirmPayment } = require("./booking/payment");
const { expireBookings, releaseUnpaid } = require("./booking/expiry");
const { sendReminders } = require("./booking/reminders");
const { approveRequest, confirmRequestAtTime, suggestArtistsForRequest, planRequestTime, applyGroupPlan, groupModeOf } = require("./booking/requests");
const { changeGuestArtist, createWalkin, moveBooking, checkIn, reassignForLeave, finish, markNoShow, blockTime, unblockTime } = require("./booking/frontdesk");
const { releaseBySalon, closeBooking } = require("./booking/salon");
const { retryAutoRefunds, sendRefund, adjustRefund } = require("./booking/refunds");
const { findByManageToken, manageRules, cancelByCustomer, rescheduleBooking, icsFor } = require("./booking/manage");
const { lockDocsFor } = require("./booking/locks");
const { manageUrl } = require("./booking/messages");
const { BookingError } = require("./availabilityLoader");

module.exports = {
  bookingsOverlapping,
  OCCUPYING,
  prepareSelection,
  findSlots,
  createBooking,
  confirmPayment,
  expireBookings,
  sendReminders,
  approveRequest,
  confirmRequestAtTime,
  suggestArtistsForRequest,
  planRequestTime,
  applyGroupPlan,
  changeGuestArtist,
  groupModeOf,
  releaseBySalon,
  closeBooking,
  createWalkin,
  moveBooking,
  checkIn,
  reassignForLeave,
  retryAutoRefunds,
  finish,
  markNoShow,
  blockTime,
  unblockTime,
  sendRefund,
  adjustRefund,
  findByManageToken,
  manageRules,
  cancelByCustomer,
  rescheduleBooking,
  icsFor,
  releaseUnpaid,
  lockDocsFor,
  manageUrl,
  publicSlot,
  BookingError,
  PATCH_TEST_VALID_MS,
};
