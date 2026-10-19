/**
 * @file checkout.js
 * @description The bill for a booking when the customer is in the chair
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §8, T2.16). Used by three callers so they
 * can never disagree about money:
 *   - GET  /api/visits/appointment-bill/:id   what Visit Entry shows
 *   - POST /api/create-order {appointmentId}  what Razorpay is asked to charge
 *   - POST /api/visits/v2 {appointmentId}     what the Visit records
 *
 * Prices:
 *   - services that were booked keep their SNAPSHOT public price (E6) — an
 *     owner price change after booking never touches this customer;
 *   - services added at the desk (E15) bill at their website price
 *     (`publicPrice`, else half the list price, D12) — the same price the
 *     customer would have seen online; no blanket desk discount on top;
 *   - a package discount from the booking is applied as an absolute amount,
 *     capped at the bill (`discountReason: "package"`).
 *
 * Money already received:
 *   - a paid deposit (or full payment, D18) is deducted: remainder = total − deposit;
 *   - if the deposit is MORE than the bill (Example C, E16) only the bill is
 *     taken from it and the excess is queued as a refund on the booking —
 *     never left unexplained.
 *
 * The browser sends only service ids and how the remainder is paid.
 */

const mongoose = require("mongoose");
const Appointment = require("../models/Appointment");
const Service = require("../models/Service");
const { SALON_TZ } = require("./time");

class CheckoutError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const hhmm = (d) =>
  d ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: SALON_TZ }).format(new Date(d)) : null;

/**
 * What the assignment step is prefilled with. The planned times are NOT used:
 * a visit that "finished exactly on plan" every time would make every artist
 * look perfectly on time. Start = check-in, end = the Finished tap; each
 * booked service is placed inside that real span in proportion to its planned
 * slot (guests who run in parallel stay in parallel). No Finished tap → blank,
 * and staff type the times as before.
 */
function actualClock(appt) {
  const from = appt.checkedInAt && new Date(appt.checkedInAt).getTime();
  const to = appt.finishedAt && new Date(appt.finishedAt).getTime();
  const plannedFrom = appt.startAt && new Date(appt.startAt).getTime();
  const plannedTo = appt.endAt && new Date(appt.endAt).getTime();
  if (!(from && to && to > from && plannedFrom && plannedTo > plannedFrom)) return () => ({ startTime: null, endTime: null });
  const scale = (to - from) / (plannedTo - plannedFrom);
  const at = (t) => from + (new Date(t).getTime() - plannedFrom) * scale;
  return (i) => ({ startTime: hhmm(at(i.startAt)), endTime: hhmm(at(i.endAt)) });
}

const deskPrice = (s) => (s.publicPrice != null ? s.publicPrice : Math.round((s.price || 0) * 0.5));

/**
 * @param {object} o
 * @param {string} o.appointmentId
 * @param {string[]} [o.serviceIds]  what is actually being billed; defaults to what was booked
 * @param {object} [o.session]       mongoose session when called inside a transaction
 */
async function appointmentBill({ appointmentId, serviceIds = null, session = null }) {
  if (!mongoose.Types.ObjectId.isValid(String(appointmentId))) throw new CheckoutError("Unknown booking");
  const appt = await Appointment.findById(appointmentId, null, { session }).lean();
  if (!appt) throw new CheckoutError("Booking not found", 404);
  if (appt.visitId) throw new CheckoutError("This booking has already been billed", 409);
  if (!["confirmed", "checked_in"].includes(appt.status)) throw new CheckoutError(`This booking is ${appt.status.replace("_", " ")} — it can't be billed`, 409);

  const booked = appt.guests.flatMap((g) => g.items.map((i) => ({ ...i, guestName: g.name })));
  const ids = (serviceIds && serviceIds.length ? serviceIds : booked.map((i) => String(i.serviceId))).map(String);
  if (!ids.every((id) => mongoose.Types.ObjectId.isValid(id))) throw new CheckoutError("Invalid service");

  const extraIds = [...new Set(ids)];
  const docs = await Service.find({ _id: { $in: extraIds }, isActive: true }, null, { session }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const actual = actualClock(appt);
  const unused = [...booked];
  const services = ids.map((id) => {
    const at = unused.findIndex((i) => String(i.serviceId) === id);
    if (at >= 0) {
      const i = unused.splice(at, 1)[0];
      const doc = byId.get(id);
      return {
        serviceId: i.serviceId,
        name: doc?.name || i.name,
        price: i.publicPrice,
        listPrice: i.listPrice ?? null,
        duration: doc ? Service.performanceDuration(doc) : null,
        artistId: i.artistId || null,
        artistName: i.artistName || null,
        ...actual(i),
        booked: true,
      };
    }
    const doc = byId.get(id);
    if (!doc) throw new CheckoutError("One of the services is inactive or unknown");
    return {
      serviceId: doc._id,
      name: doc.name,
      price: deskPrice(doc),
      listPrice: doc.price ?? null,
      duration: Service.performanceDuration(doc),
      artistId: null,
      artistName: null,
      startTime: null,
      endTime: null,
      booked: false,
    };
  });
  if (!services.length) throw new CheckoutError("At least one service is required");

  const subtotal = services.reduce((s, x) => s + x.price, 0);
  const discountAmount = Math.min(subtotal, appt.pricing?.discount || 0);
  const finalTotal = subtotal - discountAmount;
  const depositPaid = appt.deposit?.status === "paid" ? appt.deposit.amount || 0 : 0;
  const depositApplied = Math.min(depositPaid, finalTotal);

  return {
    appt,
    services,
    removed: unused.map((i) => ({ serviceId: i.serviceId, name: i.name, price: i.publicPrice })),
    subtotal,
    discountAmount,
    discountReason: discountAmount > 0 ? "package" : null,
    finalTotal,
    depositPaid,
    depositApplied,
    depositExcess: depositPaid - depositApplied,
    depositPaymentId: depositPaid ? appt.deposit.razorpayPaymentId || null : null,
    remainder: finalTotal - depositApplied,
  };
}

/**
 * Payment buckets for an appointment visit. The remainder is split exactly as
 * the desk always has (cash / card / online / partial = cash + online); the
 * deposit is then added to onlineAmount, because it arrived online (§8).
 * Throws unless cash + card + online === finalTotal (CLAUDE.md invariant).
 */
function appointmentBuckets(bill, { paymentMethod, cashAmount = 0 }) {
  const r = bill.remainder;
  let b;
  if (r === 0) b = { cashAmount: 0, cardAmount: 0, onlineAmount: 0 };
  else if (paymentMethod === "cash") b = { cashAmount: r, cardAmount: 0, onlineAmount: 0 };
  else if (paymentMethod === "card") b = { cashAmount: 0, cardAmount: r, onlineAmount: 0 };
  else if (paymentMethod === "partial") {
    const cash = Math.round(Number(cashAmount) || 0);
    if (cash <= 0 || cash >= r) throw new CheckoutError("Cash must be between ₹1 and the amount due minus ₹1");
    b = { cashAmount: cash, cardAmount: 0, onlineAmount: r - cash };
  } else b = { cashAmount: 0, cardAmount: 0, onlineAmount: r };
  b.onlineAmount += bill.depositApplied;

  // How the visit reads in Payment History: all online, or cash/card + online.
  let method = paymentMethod;
  if (r === 0) method = "online";
  else if (bill.depositApplied > 0 && paymentMethod === "cash") method = "partial";

  if (b.cashAmount + b.cardAmount + b.onlineAmount !== bill.finalTotal) {
    throw new CheckoutError("Payment split does not add up to the bill", 500);
  }
  return { ...b, paymentMethod: method };
}

module.exports = { appointmentBill, appointmentBuckets, CheckoutError };
