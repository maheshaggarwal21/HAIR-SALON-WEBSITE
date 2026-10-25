/**
 * @file routes/visits.js
 * @description Visits: create (POST /v2), assignment, the booking bill, history and customer lookup.
 *
 * POST /v2 – Create a Visit after a Razorpay (or counter, or cash) payment. Service ids are
 *            resolved to names and prices from the Service model and the totals are computed
 *            here, never taken from the browser.
 *
 * (The old POST / "create visit" route was removed: nothing called it and it did not check
 * the payment id the way v2 does. Audit #11.)
 */

const express = require("express");
const mongoose = require("mongoose");
const connectDB = require("../db");
const Visit = require("../models/Visit");
const Service = require("../models/Service");
const Artist = require("../models/Artist");
const PaymentEvent = require("../models/PaymentEvent");
const { authorizePermission, getUserPermissions } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require('../constants/permissions');
const { salonDate, isValidDate, addDays } = require("../utils/time");
const counter = require("../utils/counter");
const paymentIdCheck = require("../utils/paymentIdCheck");

const router = express.Router();

/**
 * ── Ensure DB on every request (Vercel cold-start) ──────────────────────────
 *
 * Every other router has had this; this one connected inside each handler
 * instead, and that ordering was a live bug.
 *
 * authorizePermission() runs BEFORE the handler and reads the user's
 * permissions from Mongo. On a cold container the connection did not exist
 * yet, so that read buffered until it timed out and threw — surfacing to staff
 * as "Internal server error during permission check" on the customer lookup,
 * the assignment page and the record-payment button, intermittently, depending
 * on whether the container happened to be warm.
 *
 * It never affected the owner: authorizePermission short-circuits on
 * role === "owner" and never touches the database, so the bug was invisible
 * from the account most likely to be testing.
 *
 * The per-handler connectDB() calls below are now redundant but harmless —
 * connectDB is an idempotent singleton.
 */
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[visits] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

function toMins(t) {
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(":").map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A visit that counts: paid, and either a legacy row or a V2 row whose artist
 * assignment is finished. A paid V2 draft still waiting for assignment is not
 * history yet.
 */
const SETTLED_VISIT = {
  paymentStatus: "success",
  $or: [
    { assignmentStatus: { $exists: false } },
    { assignmentStatus: "not_required" },
    { assignmentStatus: "completed" },
  ],
};

/** The reply for a visit that already exists (same shape as the duplicate-payment answer). */
function visitReplay(existing) {
  return {
    success: true,
    duplicate: true,
    visitId: existing._id,
    finalTotal: existing.finalTotal,
    assignmentStatus: existing.assignmentStatus,
    lockUntilAssigned: existing.lockUntilAssigned,
    services: (existing.services || []).map((s) => ({
      serviceEntryId: s._id,
      serviceId: s.serviceId,
      serviceName: s.name,
      servicePrice: s.price,
    })),
  };
}

function derivePaymentAmounts({ paymentMethod, finalTotal, cashAmount = 0 }) {
  const total = Math.round(Number(finalTotal) || 0);
  const cash = Math.round(Number(cashAmount) || 0);

  if (paymentMethod === "cash") {
    return { cashAmount: total, cardAmount: 0, onlineAmount: 0 };
  }
  if (paymentMethod === "card") {
    return { cashAmount: 0, cardAmount: total, onlineAmount: 0 };
  }
  if (paymentMethod === "partial") {
    if (cash <= 0 || cash >= total) {
      throw new Error("Cash amount must be between Rs1 and total minus Rs1 for partial payment");
    }
    return { cashAmount: cash, cardAmount: 0, onlineAmount: total - cash };
  }

  return { cashAmount: 0, cardAmount: 0, onlineAmount: total };
}

async function resolveRequestedServicesWithDuplicates(serviceIds) {
  const requestedIds = serviceIds.map((id) => String(id));
  const uniqueIds = [...new Set(requestedIds)];

  const serviceDocs = await Service.find({
    _id: { $in: uniqueIds },
    isActive: true,
  }).lean();

  if (serviceDocs.length === 0) {
    return { error: "No valid active services found" };
  }

  const serviceById = new Map(serviceDocs.map((doc) => [String(doc._id), doc]));
  const missingService = requestedIds.find((id) => !serviceById.has(id));
  if (missingService) {
    return { error: "One or more selected services are invalid or inactive" };
  }

  const orderedServices = requestedIds.map((id) => serviceById.get(id));
  return { orderedServices };
}

// ─── POST /v2 — create paid draft (assignment pending) ─────────────────────
// ─── Online bookings at checkout (CF §8, T2.16) ─────────────────────────────

const { appointmentBill, appointmentBuckets, CheckoutError } = require("../utils/checkout");
const Appointment = require("../models/Appointment");

/**
 * GET /appointment-bill/:id?serviceIds=a,b — what Visit Entry shows for a
 * booking: prefill (name, phone, gender, services, artists, times) and the
 * server's bill with the deposit taken off. Recomputed whenever staff add or
 * remove a service, so the screen and the charge always agree.
 */
router.get("/appointment-bill/:id", authorizePermission(PERMISSIONS.VISIT_CREATE), async (req, res) => {
  try {
    const ids = req.query.serviceIds ? String(req.query.serviceIds).split(",").filter(Boolean) : null;
    const bill = await appointmentBill({ appointmentId: req.params.id, serviceIds: ids });
    const a = bill.appt;
    return res.json({
      appointment: {
        _id: a._id,
        ref: a.ref,
        status: a.status,
        name: a.name,
        contact: a.contact,
        gender: a.guests?.[0]?.gender || null,
        startAt: a.startAt,
        channel: a.source?.channel || null,
        bookedServiceIds: a.guests.flatMap((g) => g.items.map((i) => String(i.serviceId))),
      },
      services: bill.services,
      removed: bill.removed,
      subtotal: bill.subtotal,
      discountAmount: bill.discountAmount,
      discountReason: bill.discountReason,
      finalTotal: bill.finalTotal,
      depositPaid: bill.depositPaid,
      depositApplied: bill.depositApplied,
      depositExcess: bill.depositExcess,
      remainder: bill.remainder,
    });
  } catch (err) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
    console.error("[visits] appointment bill error:", err);
    return res.status(500).json({ error: "Failed to load the booking" });
  }
});

/**
 * The payment-id check for a booking at checkout (audit #1, D70). The online money the desk collected is
 * what is left after the deposit and any cash/card part, i.e. `buckets.onlineAmount - bill.depositApplied`;
 * it is worked out here from the same two functions the transaction below uses, so the two cannot disagree.
 * Only the cases where the transaction would store a desk payment id are checked. Never throws: if the
 * booking cannot be read, the transaction below gives the real answer (a CheckoutError) or the save
 * goes on and the check is recorded as "check_failed".
 */
async function checkBookingPayment({ req, appointmentId, serviceIds, paymentMethod, cashAmount, razorpayPaymentId, date }) {
  const none = { refusal: null, done: async () => {} };
  try {
    if (!razorpayPaymentId || !["online", "partial"].includes(paymentMethod)) return none;
    let bill;
    let buckets;
    try {
      bill = await appointmentBill({ appointmentId, serviceIds });
      if (!(bill.remainder > 0)) return none;
      buckets = appointmentBuckets(bill, { paymentMethod, cashAmount });
    } catch (err) {
      if (err instanceof CheckoutError) return none; // the transaction below will say the same thing
      return await paymentIdCheck.begin({ req, paymentId: razorpayPaymentId, expectedPaise: NaN });
    }
    return await paymentIdCheck.begin({
      req,
      paymentId: razorpayPaymentId,
      expectedPaise: (buckets.onlineAmount - bill.depositApplied) * 100,
      name: bill.appt.name,
      date,
      ref: bill.appt.ref,
    });
  } catch (err) {
    console.error("[visits] payment id check skipped:", err.message);
    return none;
  }
}

/**
 * The duplicate replay in /v2 hands back the first visit when a payment id is reused. If the reusing sale is
 * a different sale (its total or its services differ from that visit's), that is worth a record: a second
 * customer's sale was just swallowed by the first. Compare only; nothing is written to a visit.
 */
async function noteReplayedSale({ req, existing, paymentId, serviceIds, discountPercent, paymentMethod, cashAmount }) {
  const { orderedServices, error } = await resolveRequestedServicesWithDuplicates(serviceIds);
  if (error) return; // cannot be priced: nothing to compare, and the caller's answer is unchanged
  const subtotal = orderedServices.reduce((sum, s) => sum + s.price, 0);
  const pct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const requestedTotal = Math.max(0, subtotal - Math.round(subtotal * (pct / 100)));
  const ids = (list) => list.map(String).sort().join(",");
  const sameServices = ids(orderedServices.map((s) => s._id)) === ids((existing.services || []).map((s) => s.serviceId));
  if (sameServices && requestedTotal === Math.round(existing.finalTotal)) return;
  let expectedPaise = null;
  try {
    expectedPaise = derivePaymentAmounts({ paymentMethod, finalTotal: requestedTotal, cashAmount }).onlineAmount * 100;
  } catch {
    /* an invalid cash part: leave the expected amount out */
  }
  await paymentIdCheck.recordReplay({ req, paymentId, existing, requestedTotal, expectedPaise });
}

/**
 * POST /v2 with `appointmentId`: the visit for a booking. One transaction:
 * the Visit is written AND the booking becomes `completed` with `visitId`
 * and `deposit.status = applied`. If anything fails, neither happens.
 * Example C / E16: a deposit bigger than the bill queues the excess as a refund.
 */
async function createAppointmentVisit(req, res) {
  const { appointmentId, serviceIds, paymentMethod = "online", cashAmount = 0, razorpayPaymentId = null, gender, date, serviceType, lockUntilAssigned = true } = req.body;
  if (!["online", "cash", "card", "partial"].includes(paymentMethod)) return res.status(400).json({ error: "Invalid payment method" });

  // Retried after success (lost response)? Same answer, nothing new written.
  const already = await Visit.findOne({ appointmentId }).lean();
  if (already) {
    return res.status(200).json({
      success: true,
      duplicate: true,
      visitId: already._id,
      finalTotal: already.finalTotal,
      assignmentStatus: already.assignmentStatus,
      lockUntilAssigned: already.lockUntilAssigned,
      services: already.services.map((s) => ({ serviceEntryId: s._id, serviceId: s.serviceId, serviceName: s.name, servicePrice: s.price })),
    });
  }

  // Audit #1 (D70): ask whether the desk payment id belongs to this sale. Outside the transaction: it may
  // call Razorpay, and it must never be able to hold up or break the save.
  const idCheck = await checkBookingPayment({ req, appointmentId, serviceIds, paymentMethod, cashAmount, razorpayPaymentId, date });
  if (idCheck.refusal) return res.status(idCheck.refusal.status).json(idCheck.refusal.body);

  const session = await mongoose.startSession();
  let visit;
  let bill;
  try {
    await session.withTransaction(async () => {
      bill = await appointmentBill({ appointmentId, serviceIds, session });
      const buckets = appointmentBuckets(bill, { paymentMethod, cashAmount });
      if (bill.remainder > 0 && ["online", "partial"].includes(paymentMethod) && !razorpayPaymentId) {
        throw new CheckoutError("Razorpay Payment ID is required for the online part");
      }
      if (razorpayPaymentId && (await Visit.exists({ razorpayPaymentId }).session(session))) {
        throw new CheckoutError("That payment is already on another visit", 409);
      }
      const a = bill.appt;
      const g = String(gender || a.guests?.[0]?.gender || "").trim();
      if (!["male", "female", "other", "prefer_not"].includes(g)) throw new CheckoutError("Gender is required");
      const onlineMoney = bill.remainder > 0 && ["online", "partial"].includes(paymentMethod) ? razorpayPaymentId : null;

      const services = bill.services.map((x) => ({
        serviceId: x.serviceId,
        name: x.name,
        price: x.price,
        listPrice: x.listPrice,
        duration: x.duration,
        // Prefilled from the booking; staff confirm or change them in the assignment step.
        artistId: x.artistId,
        artistName: x.artistName,
        startTime: x.startTime,
        endTime: x.endTime,
        actualDurationMins: null,
        ...(x.guestName ? { guestName: x.guestName } : {}),
      }));

      [visit] = await Visit.create(
        [
          {
            schemaVersion: 2,
            name: a.name,
            contact: a.contact,
            gender: g,
            date: date ? new Date(date) : new Date(),
            serviceType: serviceType || undefined,
            services,
            filledBy: req.session.name || "Unknown",
            subtotal: bill.subtotal,
            discountPercent: 0,
            discountAmount: bill.discountAmount,
            discountReason: bill.discountReason,
            finalTotal: bill.finalTotal,
            paymentMethod: buckets.paymentMethod,
            cashAmount: buckets.cashAmount,
            cardAmount: buckets.cardAmount,
            onlineAmount: buckets.onlineAmount,
            paymentStatus: "success",
            razorpayPaymentId: onlineMoney,
            appointmentId: a._id,
            depositAmount: bill.depositApplied,
            depositPaymentId: bill.depositApplied ? bill.depositPaymentId : null,
            assignmentStatus: "pending",
            lockUntilAssigned: !!lockUntilAssigned,
            paymentConfirmedAt: new Date(),
            paymentSnapshot: {
              subtotal: bill.subtotal,
              discountPercent: 0,
              discountAmount: bill.discountAmount,
              finalTotal: bill.finalTotal,
              paymentMethod: buckets.paymentMethod,
              cashAmount: buckets.cashAmount,
              cardAmount: buckets.cardAmount,
              onlineAmount: buckets.onlineAmount,
              razorpayPaymentId: onlineMoney,
            },
          },
        ],
        { session }
      );

      const now = new Date();
      const set = { status: "completed", visitId: visit._id };
      if (bill.depositPaid > 0) set["deposit.status"] = "applied";
      if (bill.depositExcess > 0) {
        set.refund = { amount: bill.depositExcess, status: "pending", reason: "deposit_exceeds_bill", requestedAt: now, razorpayRefundId: null, processedAt: null, attempts: 0, error: null, claimedAt: null };
      }
      const done = await Appointment.updateOne(
        { _id: a._id, status: a.status, visitId: null },
        { $set: set, $push: { statusHistory: { from: a.status, to: "completed", at: now, by: req.session.name || "staff", byUserId: req.session.userId || null, reason: "visit" } } },
        { session }
      );
      if (done.modifiedCount !== 1) throw new CheckoutError("This booking changed while billing — reload and try again", 409);
      if (a.customerId) {
        const Customer = require("../models/Customer");
        await Customer.updateOne({ _id: a.customerId }, { $inc: { "stats.visits": 1 }, $set: { "stats.lastVisitAt": now } }, { session });
      }
    });
  } catch (err) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
    if (err?.code === 11000) return res.status(409).json({ error: "This booking has already been billed" });
    console.error("[visits] appointment visit error:", err);
    return res.status(500).json({ error: "Failed to create the visit", details: err.message });
  } finally {
    await session.endSession();
  }

  if (visit.razorpayPaymentId) {
    try {
      await PaymentEvent.updateOne(
        { razorpayPaymentId: visit.razorpayPaymentId },
        { $set: { reconcileStatus: "matched", reconciledVisitId: visit._id, reconciledAt: new Date() } }
      );
    } catch (err) {
      console.error("[visits] payment event reconcile failed:", visit.razorpayPaymentId, err.message);
    }
  }
  await idCheck.done(visit._id);

  return res.status(201).json({
    success: true,
    visitId: visit._id,
    finalTotal: visit.finalTotal,
    depositApplied: bill.depositApplied,
    depositExcess: bill.depositExcess,
    assignmentStatus: visit.assignmentStatus,
    lockUntilAssigned: visit.lockUntilAssigned,
    services: visit.services.map((s) => ({ serviceEntryId: s._id, serviceId: s.serviceId, serviceName: s.name, servicePrice: s.price })),
  });
}

router.post("/v2", authorizePermission(PERMISSIONS.VISIT_CREATE), async (req, res) => {
  try {
    await connectDB();
    if (req.body?.appointmentId) return await createAppointmentVisit(req, res);

    // `let`: for a counter QR sale (D60) the money fields are replaced from the server's own session below.
    let {
      name,
      contact,
      gender,
      date,
      serviceType,
      serviceIds,
      discountPercent = 0,
      paymentMethod = "online",
      cashAmount = 0,
      razorpayPaymentId = null,
      recoveredPaymentId = null,
      lockUntilAssigned = true,
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!contact || !/^[6-9]\d{9}$/.test(String(contact).trim())) {
      return res.status(400).json({ error: "Valid 10-digit Indian mobile required" });
    }
    if (!["male", "female", "other", "prefer_not"].includes(String(gender || "").trim())) {
      return res.status(400).json({ error: "Gender is required" });
    }
    if (!date) {
      return res.status(400).json({ error: "Date is required" });
    }
    /**
     * Paid at the counter by UPI QR (D60). The browser sends only the session id: the
     * services, discount, cash part and payment id come from the server's own session,
     * which Razorpay's webhook (or QR status) marked paid. A browser-supplied
     * razorpayPaymentId is ignored here, so it cannot be used to claim someone else's payment.
     * The payment id may still be missing (the QR flips to paid ~3 s before the webhook
     * carries the id): the visit is then saved "reference pending" and filled in later.
     */
    let counterSale = null;
    if (req.body.counterSessionId) {
      if (recoveredPaymentId) return res.status(400).json({ error: "A counter payment cannot be combined with a recovered payment" });
      const loaded = await counter.loadSaleForVisit({
        sessionId: req.body.counterSessionId,
        user: { id: req.session.userId, role: req.session.role },
      });
      if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });
      if (loaded.existingVisit) return res.status(200).json(visitReplay(loaded.existingVisit));
      counterSale = loaded;
      ({ serviceIds, discountPercent, paymentMethod, cashAmount, razorpayPaymentId } = loaded.sale);
    }

    if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
      return res.status(400).json({ error: "At least one service is required" });
    }
    if (!["online", "cash", "card", "partial"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Invalid payment method" });
    }
    if (!serviceIds.every((id) => mongoose.Types.ObjectId.isValid(String(id)))) {
      return res.status(400).json({ error: "Invalid service ID in serviceIds" });
    }

    /**
     * Recovery mode: attach this visit to money Razorpay already took.
     *
     * Used when staff fill in a payment that reached Razorpay but never became a
     * visit — the Checkout-said-failure-but-took-the-money case. The payment id
     * arrives from a link the client controls, so it is checked against our own
     * webhook record rather than trusted: an id that no webhook ever reported, or
     * one that was not captured, must not be able to conjure revenue into the
     * books. Only `PaymentEvent` can vouch for it.
     */
    let effectivePaymentId = razorpayPaymentId;
    if (recoveredPaymentId) {
      const event = await PaymentEvent.findOne({
        razorpayPaymentId: String(recoveredPaymentId).trim(),
      }).lean();

      if (!event) {
        return res.status(400).json({
          error: "Unknown payment reference — no captured payment matches this id",
        });
      }
      if (event.status !== "captured") {
        return res.status(400).json({
          error: `That payment is "${event.status}", not captured — no money was collected`,
        });
      }
      effectivePaymentId = event.razorpayPaymentId;
    }

    /**
     * One payment, one visit — always.
     *
     * Two independent paths now reach this route after a payment succeeds:
     * Checkout's own `handler`, and the order-status poller that covers the case
     * where Checkout fails to notice its own success. Both are also wrapped in
     * retries, so a request that succeeded but whose response was lost gets sent
     * again. Without this guard any of those could bill one customer once and
     * write the visit twice, inflating the day's revenue.
     *
     * Returning the existing visit (rather than an error) is what makes the
     * callers safe to retry: they get the same visitId either way and carry on
     * to assignment as if theirs was the call that created it.
     */
    if (effectivePaymentId) {
      const existing = await Visit.findOne({ razorpayPaymentId: effectivePaymentId }).lean();
      if (existing) {
        // Audit #1 addition (D70): a DIFFERENT sale reusing this id is only noted; the caller gets the same answer.
        if (!counterSale) await paymentIdCheck.observe(() => noteReplayedSale({ req, existing, paymentId: effectivePaymentId, serviceIds, discountPercent, paymentMethod, cashAmount }));
        return res.status(200).json({
          success: true,
          duplicate: true,
          visitId: existing._id,
          finalTotal: existing.finalTotal,
          assignmentStatus: existing.assignmentStatus,
          lockUntilAssigned: existing.lockUntilAssigned,
          services: (existing.services || []).map((s) => ({
            serviceEntryId: s._id,
            serviceId: s.serviceId,
            serviceName: s.name,
            servicePrice: s.price,
          })),
        });
      }
    }

    const { orderedServices, error } = await resolveRequestedServicesWithDuplicates(serviceIds);
    if (error) {
      return res.status(400).json({ error });
    }

    const services = orderedServices.map((s) => ({
      serviceId: s._id,
      name: s.name,
      price: s.price,
      // Confirmed times only — see the note in the cash-visit handler above.
      duration: Service.performanceDuration(s),
      artistId: null,
      artistName: null,
      startTime: null,
      endTime: null,
      actualDurationMins: null,
    }));

    const subtotal = services.reduce((sum, s) => sum + s.price, 0);
    const pct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
    const discountAmount = Math.round(subtotal * (pct / 100));
    const finalTotal = Math.max(0, subtotal - discountAmount);

    // The customer paid the session's price. If the menu changed in the last few minutes the
    // visit would not match the money, so stop and send the desk to the recovery list instead.
    if (counterSale && Math.round(finalTotal) !== counterSale.sale.finalTotal) {
      return res.status(409).json({
        error: "A price changed while the customer was paying, so this sale cannot be saved automatically. The payment is safe: record it from Payments → Unreconciled.",
      });
    }

    if (paymentMethod === "online" && !effectivePaymentId && !counterSale) {
      return res.status(400).json({ error: "Razorpay Payment ID is required for online payment" });
    }
    if (paymentMethod === "partial" && !effectivePaymentId && !counterSale) {
      return res.status(400).json({ error: "Razorpay Payment ID is required for partial payment" });
    }

    const amounts = derivePaymentAmounts({ paymentMethod, finalTotal, cashAmount });

    // Audit #1 (D70): does this payment id belong to this sale? An observer: it records, and refuses only in
    // "enforce" mode and only when the payment is clearly wrong. A counter QR sale carries the server's own id.
    const idCheck = counterSale
      ? { refusal: null, done: async () => {} }
      : await paymentIdCheck.begin({ req, paymentId: effectivePaymentId, expectedPaise: amounts.onlineAmount * 100, name: String(name).trim(), date: new Date(date) });
    if (idCheck.refusal) return res.status(idCheck.refusal.status).json(idCheck.refusal.body);

    let visit;
    try {
    visit = await Visit.create({
      schemaVersion: 2,
      name: String(name).trim(),
      contact: String(contact).trim(),
      gender: String(gender).trim(),
      date: new Date(date),
      startTime: null,
      endTime: null,
      artist: null,
      serviceType: serviceType || undefined,
      services,
      visitDurationMins: null,
      // Recovered rows are stamped so a reconstructed visit is never mistaken for
      // one captured live at the desk — it was filled in from memory, after the fact.
      filledBy: recoveredPaymentId
        ? `${req.session.name || "Unknown"} (recovered payment)`
        : req.session.name || "Unknown",
      subtotal,
      discountPercent: pct,
      discountAmount,
      finalTotal,
      paymentMethod,
      cashAmount: amounts.cashAmount,
      cardAmount: amounts.cardAmount,
      onlineAmount: amounts.onlineAmount,
      paymentStatus: "success",
      razorpayPaymentId: effectivePaymentId || null,
      assignmentStatus: "pending",
      lockUntilAssigned: !!lockUntilAssigned,
      paymentConfirmedAt: new Date(),
      counterSessionId: counterSale ? counterSale.session._id : null,
      referencePending: !!counterSale && !effectivePaymentId,
      paymentSnapshot: {
        subtotal,
        discountPercent: pct,
        discountAmount,
        finalTotal,
        paymentMethod,
        cashAmount: amounts.cashAmount,
        cardAmount: amounts.cardAmount,
        onlineAmount: amounts.onlineAmount,
        razorpayPaymentId: effectivePaymentId || null,
      },
    });
    } catch (err) {
      // A double click or a retry on a counter sale: the database refuses a second visit for
      // one session, and the answer is the first visit.
      if (counterSale && err?.code === 11000) {
        const first = await Visit.findOne({ counterSessionId: counterSale.session._id }).lean();
        if (first) return res.status(200).json(visitReplay(first));
      }
      throw err;
    }
    if (counterSale) await counter.attachVisit(counterSale.session._id, visit._id);

    /**
     * Close the loop on the webhook's record of this payment.
     *
     * The webhook fires within a second of capture — before this visit exists —
     * so it can only ever file the payment as "unmatched" and nothing used to
     * revisit that. The result was 30 unmatched payment events of which 29 had a
     * perfectly good visit: an alarm that cried wolf so consistently that the one
     * genuinely lost payment (₹150, 7 Aug) was indistinguishable from the noise.
     *
     * Marking it here is what makes "unmatched" mean "money we cannot account
     * for". Failure to update must not fail the visit — the visit is the record
     * that matters, and the sweep in GET /api/payments/unreconciled will catch up.
     */
    if (effectivePaymentId) {
      try {
        await PaymentEvent.updateOne(
          { razorpayPaymentId: effectivePaymentId },
          {
            $set: {
              reconcileStatus: "matched",
              reconciledVisitId: visit._id,
              reconciledAt: new Date(),
              ...(recoveredPaymentId
                ? { note: `Recorded from the unreconciled list by ${req.session.name || "staff"}` }
                : {}),
            },
          }
        );
      } catch (err) {
        console.error("[visits] payment event reconcile failed:", effectivePaymentId, err.message);
      }
    }
    await idCheck.done(visit._id);

    return res.status(201).json({
      success: true,
      visitId: visit._id,
      finalTotal,
      assignmentStatus: visit.assignmentStatus,
      lockUntilAssigned: visit.lockUntilAssigned,
      services: visit.services.map((s) => ({
        serviceEntryId: s._id,
        serviceId: s.serviceId,
        serviceName: s.name,
        servicePrice: s.price,
      })),
    });
  } catch (err) {
    console.error("[visits] V2 create error:", err);
    return res.status(500).json({ error: "Failed to create V2 visit", details: err.message });
  }
});

// ─── GET /:id/assignment-draft — fetch assignment payload for locked draft ──
router.get("/:id/assignment-draft", authorizePermission(PERMISSIONS.VISIT_CREATE), async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid visit ID" });
    }

    const visit = await Visit.findById(id).lean();
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    if (visit.schemaVersion !== 2) {
      return res.status(400).json({ error: "Assignment draft is only available for V2 visits" });
    }

    return res.json({
      visitId: String(visit._id),
      name: visit.name,
      contact: visit.contact,
      date: visit.date,
      gender: visit.gender,
      paymentMethod: visit.paymentMethod || visit.paymentSnapshot?.paymentMethod || "online",
      subtotal: Number(visit.paymentSnapshot?.subtotal ?? visit.subtotal ?? 0),
      discountPercent: Number(visit.paymentSnapshot?.discountPercent ?? visit.discountPercent ?? 0),
      discountAmount: Number(visit.paymentSnapshot?.discountAmount ?? visit.discountAmount ?? 0),
      finalTotal: Number(visit.paymentSnapshot?.finalTotal ?? visit.finalTotal ?? 0),
      cashAmount: Number(visit.paymentSnapshot?.cashAmount ?? visit.cashAmount ?? 0),
      cardAmount: Number(visit.paymentSnapshot?.cardAmount ?? visit.cardAmount ?? 0),
      onlineAmount: Number(visit.paymentSnapshot?.onlineAmount ?? visit.onlineAmount ?? 0),
      services: (visit.services || []).map((s) => ({
        serviceEntryId: String(s._id),
        serviceId: String(s.serviceId),
        serviceName: s.name,
        servicePrice: s.price,
        artistId: s.artistId ? String(s.artistId) : null,
        startTime: s.startTime || null,
        endTime: s.endTime || null,
        guestName: s.guestName || null,
      })),
      assignmentStatus: visit.assignmentStatus || "not_required",
      lockUntilAssigned: !!visit.lockUntilAssigned,
    });
  } catch (err) {
    console.error("[visits] Assignment draft fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch assignment draft", details: err.message });
  }
});

// ─── POST /:id/confirm-assignment — strict all-row save ────────────────────
router.post("/:id/confirm-assignment", authorizePermission(PERMISSIONS.VISIT_CREATE), async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid visit ID" });
    }

    const visit = await Visit.findById(id);
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    if (visit.schemaVersion !== 2) {
      return res.status(400).json({ error: "Assignment confirmation is only supported for V2 visits" });
    }
    if (visit.paymentStatus !== "success") {
      return res.status(400).json({ error: "Payment must be successful before assignment confirmation" });
    }
    if (visit.assignmentStatus === "completed") {
      return res.status(409).json({ error: "Assignment already confirmed" });
    }

    const assignments = Array.isArray(req.body.assignments) ? req.body.assignments : null;
    if (!assignments || assignments.length === 0) {
      return res.status(400).json({ error: "assignments array is required" });
    }
    if (assignments.length !== visit.services.length) {
      return res.status(400).json({ error: "All service rows must be assigned. Partial save is not allowed." });
    }

    const byServiceEntryId = new Map();
    for (const a of assignments) {
      const key = String(a.serviceEntryId || "").trim();
      if (!key) {
        return res.status(400).json({ error: "serviceEntryId is required for every assignment row" });
      }
      if (byServiceEntryId.has(key)) {
        return res.status(400).json({ error: "Duplicate serviceEntryId in assignments" });
      }
      byServiceEntryId.set(key, a);
    }

    const artistIds = [];
    for (const a of assignments) {
      if (!a.artistId || !mongoose.Types.ObjectId.isValid(String(a.artistId))) {
        return res.status(400).json({ error: "Every assignment row must have a valid artistId" });
      }
      if (!a.startTime || !a.endTime) {
        return res.status(400).json({ error: "Every assignment row must include startTime and endTime" });
      }

      const start = toMins(String(a.startTime));
      const end = toMins(String(a.endTime));
      if (start === null || end === null || end <= start) {
        return res.status(400).json({ error: "Invalid time range in assignment rows" });
      }

      artistIds.push(String(a.artistId));
    }

    const artists = await Artist.find({ _id: { $in: artistIds }, isActive: true }, { name: 1 }).lean();
    const artistNameById = new Map(artists.map((a) => [String(a._id), a.name]));
    if (artistNameById.size !== new Set(artistIds).size) {
      return res.status(400).json({ error: "One or more selected artists are invalid or inactive" });
    }

    let minStart = null;
    let maxEnd = null;
    const uniqueArtistNames = new Set();

    for (const svc of visit.services) {
      const row = byServiceEntryId.get(String(svc._id));
      if (!row) {
        return res.status(400).json({ error: "All service rows must be assigned. Missing row for a service entry." });
      }

      const rowArtistId = String(row.artistId);
      const rowArtistName = artistNameById.get(rowArtistId);
      const start = toMins(String(row.startTime));
      const end = toMins(String(row.endTime));

      svc.artistId = new mongoose.Types.ObjectId(rowArtistId);
      svc.artistName = rowArtistName;
      svc.startTime = String(row.startTime);
      svc.endTime = String(row.endTime);
      svc.actualDurationMins = end - start;

      uniqueArtistNames.add(rowArtistName);
      minStart = minStart === null ? start : Math.min(minStart, start);
      maxEnd = maxEnd === null ? end : Math.max(maxEnd, end);
    }

    visit.startTime = `${String(Math.floor(minStart / 60)).padStart(2, "0")}:${String(minStart % 60).padStart(2, "0")}`;
    visit.endTime = `${String(Math.floor(maxEnd / 60)).padStart(2, "0")}:${String(maxEnd % 60).padStart(2, "0")}`;
    visit.visitDurationMins = Math.max(0, maxEnd - minStart);
    visit.artist = uniqueArtistNames.size === 1 ? [...uniqueArtistNames][0] : "Multiple Artists";
    visit.assignmentStatus = "completed";
    visit.lockUntilAssigned = false;
    visit.assignmentConfirmedAt = new Date();

    await visit.save();

    return res.json({
      success: true,
      visitId: visit._id,
      assignmentStatus: visit.assignmentStatus,
      lockUntilAssigned: visit.lockUntilAssigned,
    });
  } catch (err) {
    console.error("[visits] Confirm assignment error:", err);
    return res.status(500).json({ error: "Failed to confirm assignment", details: err.message });
  }
});

// ─── GET /customers/search?phone=… | ?name=… ─────────────────────────────────
/**
 * Find a returning customer by the start of their phone number OR by name.
 *
 * Name search exists because the owner asked for it (14 Oct 2026): regulars
 * get tired of reading their number out on every visit, so the desk types
 * "rahul sh" and picks the right Rahul from the list. Each word typed must
 * start a word in the name, so "raj" finds "Raj Kumar" and "Kumar Raj" but
 * not "Neeraj".
 *
 * One row per phone number (a person), newest visit first, at most 10. Same
 * name on two numbers = two rows, which is how the desk tells them apart.
 *
 * Reads Visits, not Customer: Visits are the record of who actually came in,
 * and the Customer backfill (M1) is not guaranteed to have run on every
 * database. Returns no money — visit count and dates only.
 *
 * Open to visit.create (the visit form) and payments.view (Payment History).
 */
router.get(
  "/customers/search",
  authorizePermission([PERMISSIONS.VISIT_CREATE, PERMISSIONS.PAYMENTS_VIEW]),
  async (req, res) => {
    try {
      await connectDB();

      const phoneRaw = String(req.query.phone || "").trim();
      const nameRaw = String(req.query.name || "").trim().replace(/\s+/g, " ");

      let match;
      if (phoneRaw) {
        if (!/^[0-9]{3,10}$/.test(phoneRaw)) {
          return res.status(400).json({ error: "phone query must be 3 to 10 digits" });
        }
        match = { contact: { $regex: new RegExp(`^${escapeRegex(phoneRaw)}`) } };
      } else if (nameRaw) {
        if (nameRaw.replace(/ /g, "").length < 2 || nameRaw.length > 60) {
          return res.status(400).json({ error: "name query must be 2 to 60 characters" });
        }
        const words = nameRaw.split(" ").slice(0, 4);
        match = {
          $and: words.map((w) => ({
            name: { $regex: `(^|\\s)${escapeRegex(w)}`, $options: "i" },
          })),
        };
      } else {
        return res.json({ customers: [] });
      }

      const rows = await Visit.aggregate([
        { $match: { ...SETTLED_VISIT, ...match } },
        { $sort: { date: -1, createdAt: -1 } },
        {
          $group: {
            _id: "$contact",
            // Newest visit wins: the name and gender the desk last recorded.
            name: { $first: "$name" },
            gender: { $first: "$gender" },
            lastVisitDate: { $first: "$date" },
            lastSeenAt: { $first: "$createdAt" },
            firstVisitDate: { $last: "$date" },
            visitCount: { $sum: 1 },
          },
        },
        { $sort: { lastVisitDate: -1, lastSeenAt: -1 } },
        { $limit: 10 },
      ]);

      return res.json({
        customers: rows.map(({ _id, ...rest }) => ({ contact: _id, ...rest })),
      });
    } catch (err) {
      console.error("[visits] Customer search error:", err);
      return res.status(500).json({ error: "Failed to search customers" });
    }
  }
);

// ─── GET /history — Paginated payment history ─────────────────────────────────
// Access: receptionist, manager, owner
// Query params:
//   from        YYYY-MM-DD  (default: start of this month, IST)
//   to          YYYY-MM-DD  (default: today, IST)
//   contact     string      (optional: ONE customer's full history, all dates —
//                            from/to are ignored. Exact stored phone number.)
//   customer    string      (optional, case-insensitive customer name filter)
//   artist      string      (optional, case-insensitive artist name filter)
//   method      online|cash|card|partial (optional payment method filter)
//   schema      all|legacy|v2 (optional schema filter)
//   includeDetails true|false (optional, default true)
//   page        number      (default: 1)
//   limit       number      (default: 50, max: 200)
router.get("/history", authorizePermission(PERMISSIONS.PAYMENTS_VIEW), async (req, res) => {
  try {
    await connectDB();

    /**
     * Calendar days, in IST.
     *
     * The visit form stores `date` as the IST calendar day at UTC midnight
     * ("2026-10-14" → 2026-10-14T00:00Z), so a day's visits are exactly
     * [D 00:00Z, D 23:59:59.999Z]. This used to be built with setHours() in the
     * server's own timezone, which only lined up because Vercel runs in UTC —
     * and "today" itself came from the UTC clock, i.e. yesterday in Patiala
     * until 05:30 IST.
     */
    const today = salonDate();
    const fromKey = req.query.from ? String(req.query.from) : `${today.slice(0, 7)}-01`;
    const toKey = req.query.to ? String(req.query.to) : today;
    if (!isValidDate(fromKey) || !isValidDate(toKey)) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    }

    const contact = req.query.contact ? String(req.query.contact).trim() : "";
    if (contact.length > 20) {
      return res.status(400).json({ error: "Contact filter is too long" });
    }

    /**
     * `payments.today_only` — the front-desk view (owner, 14 Oct 2026, D39):
     *
     *   1. Dates are clamped to TODAY AND YESTERDAY. Yesterday was added so the
     *      desk can answer "I paid yesterday" without calling the owner.
     *   2. One customer's history (`contact`) is NOT clamped: the desk can see
     *      everything that person has paid since their first visit. It is one
     *      exact phone number at a time, found through the name/phone lookup,
     *      so it cannot be widened into browsing the whole book.
     *   3. Revenue totals for today and yesterday ARE shown (owner, 16 Oct
     *      2026 — the desk wanted the day's takings). They can only ever cover
     *      that two-day window because `from`/`to` are clamped above. A single
     *      customer's history (`contact`) has NO totals: that view spans every
     *      date, so a sum there would be the salon's lifetime figure for one
     *      person, and the desk only needs the rows.
     *
     * Enforced HERE, not in the UI. Hiding the date buttons stops an honest
     * receptionist browsing last month's takings; it does nothing about someone
     * editing the `from=` parameter in the address bar.
     *
     * The key keeps its old name so accounts that already hold it get the new
     * behaviour without anyone re-ticking a box.
     *
     * The owner bypasses PBAC everywhere else, so it bypasses this too.
     */
    const permissions = await getUserPermissions(req.session.userId);
    const restricted =
      req.session.role !== "owner" &&
      permissions.includes(PERMISSIONS.PAYMENTS_TODAY_ONLY);

    const deskWindow = restricted ? { from: addDays(today, -1), to: today } : null;
    const from = deskWindow && fromKey < deskWindow.from ? deskWindow.from : fromKey;
    const to = deskWindow && toKey > deskWindow.to ? deskWindow.to : toKey;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const includeDetails = String(req.query.includeDetails || "true").toLowerCase() === "true";

    const schema = String(req.query.schema || "all").toLowerCase();
    if (!["all", "legacy", "v2"].includes(schema)) {
      return res.status(400).json({ error: "Invalid schema filter. Use all, legacy, or v2." });
    }

    const method = req.query.method ? String(req.query.method).toLowerCase() : "";
    if (method && !["online", "cash", "card", "partial"].includes(method)) {
      return res.status(400).json({ error: "Invalid payment method filter." });
    }

    // Build filter. A customer's history spans every date; anything else is a
    // day range ($gte > $lte simply matches nothing, which is the right answer
    // for a range that falls wholly outside the restricted window).
    const baseFilter = contact
      ? { ...SETTLED_VISIT, contact }
      : {
          ...SETTLED_VISIT,
          date: {
            $gte: new Date(`${from}T00:00:00.000Z`),
            $lte: new Date(`${to}T23:59:59.999Z`),
          },
        };

    const filter = { ...baseFilter };

    if (schema === "legacy") {
      filter.schemaVersion = 1;
    } else if (schema === "v2") {
      filter.schemaVersion = 2;
    }

    if (req.query.customer) {
      const customer = String(req.query.customer).trim();
      if (customer.length > 80) {
        return res.status(400).json({ error: "Customer filter is too long" });
      }
      filter.name = { $regex: escapeRegex(customer), $options: "i" };
    }
    if (req.query.artist) {
      const artist = String(req.query.artist).trim();
      if (artist.length > 80) {
        return res.status(400).json({ error: "Artist filter is too long" });
      }
      // Search both visit-level artist (legacy) and per-service artistName (V2)
      const artistRegex = { $regex: escapeRegex(artist), $options: "i" };
      const existingOr = filter.$or;
      delete filter.$or;
      filter.$and = [
        { $or: existingOr },
        { $or: [{ artist: artistRegex }, { "services.artistName": artistRegex }] },
      ];
    }
    if (method) {
      filter.paymentMethod = method;
    }

    // Build a schema-agnostic filter for schema breakdown cards in the UI.
    const schemaCountsFilter = { ...filter };
    delete schemaCountsFilter.schemaVersion;

    const selectFields = includeDetails
      ? "name contact artist services subtotal discountPercent discountAmount finalTotal paymentMethod cashAmount cardAmount onlineAmount razorpayPaymentId paymentStatus assignmentStatus filledBy date startTime endTime createdAt schemaVersion"
      : "name contact artist subtotal discountPercent discountAmount finalTotal paymentMethod cashAmount cardAmount onlineAmount razorpayPaymentId paymentStatus assignmentStatus filledBy date createdAt schemaVersion";

    /**
     * All four reads are independent, so they go out together. The page row
     * fetch and the count were already parallel, but the two aggregations then
     * ran one after the other, making the endpoint as slow as the sum of three
     * round trips to Atlas rather than the slowest one.
     */
    const [visits, total, summary, schemaCountsAgg] = await Promise.all([
      Visit.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(selectFields)
        .lean(),
      Visit.countDocuments(filter),
      // Aggregate summary for the filtered range. For the front-desk view the
      // range is already clamped to today + yesterday; a one-customer history
      // gets none — see `restricted` above.
      restricted && contact ? Promise.resolve(null) : Visit.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$finalTotal" },
            totalCash: { $sum: "$cashAmount" },
            totalCard: { $sum: "$cardAmount" },
            totalOnline: { $sum: "$onlineAmount" },
            totalDiscount: { $sum: "$discountAmount" },
            count: { $sum: 1 },
          },
        },
      ]),
      Visit.aggregate([
        { $match: schemaCountsFilter },
        {
          $group: {
            _id: "$schemaVersion",
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    /**
     * Accumulate, do not assign.
     *
     * $group returns THREE buckets on the live data, not two: schemaVersion 2
     * (4,102), schemaVersion 1 (9), and documents predating the field entirely
     * where _id is null (369). Both of the latter are "legacy", and the old
     * `schemaCounts.legacy = row.count` made them overwrite each other — so the
     * card reported either 9 or 369 depending on the order Mongo happened to
     * return the groups in, and never the true 378. The legacy + v2 total also
     * failed to match the row count above it.
     */
    const schemaCounts = { legacy: 0, v2: 0 };
    schemaCountsAgg.forEach((row) => {
      if (Number(row._id) === 2) {
        schemaCounts.v2 += row.count;
      } else {
        schemaCounts.legacy += row.count;
      }
    });

    return res.json({
      visits,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      summary: restricted && contact
        ? null
        : summary[0] || { totalRevenue: 0, totalCash: 0, totalCard: 0, totalOnline: 0, totalDiscount: 0, count: 0 },
      schemaCounts,
      // Lets the UI explain why most date filters are gone, instead of the page
      // looking broken to a receptionist who remembers them being there.
      restricted,
      window: deskWindow,
      range: contact ? null : { from, to },
    });
  } catch (err) {
    console.error("[visits] History error:", err);
    return res.status(500).json({ error: "Failed to fetch payment history" });
  }
});

module.exports = router;

