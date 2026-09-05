/**
 * @file routes/visits.js
 * @description Visit creation endpoint.
 *
 * POST /  – Create a new Visit document after successful Razorpay payment.
 *           Resolves service IDs to { name, price } from the Service model
 *           and computes billing totals server-side to prevent tampering.
 */

const express = require("express");
const mongoose = require("mongoose");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const Visit = require("../models/Visit");
const Service = require("../models/Service");
const Artist = require("../models/Artist");
const PaymentEvent = require("../models/PaymentEvent");
const { authorizePermission, getUserPermissions } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require('../constants/permissions');

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

// ─── Validation rules ────────────────────────────────────────────────────────
const createRules = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("contact")
    .trim()
    .matches(/^[6-9]\d{9}$/)
    .withMessage("Valid 10-digit Indian mobile required"),
  body("gender")
    .trim()
    .notEmpty()
    .isIn(["male", "female", "other", "prefer_not"])
    .withMessage("Gender is required"),
  body("date").notEmpty().withMessage("Date is required"),
  body("startTime")
    .trim()
    .notEmpty()
    .matches(/^\d{2}:\d{2}$/)
    .withMessage("Start time is required (HH:mm)"),
  body("endTime")
    .trim()
    .notEmpty()
    .matches(/^\d{2}:\d{2}$/)
    .withMessage("End time is required (HH:mm)"),
  body("artist").trim().notEmpty().withMessage("Artist is required"),
  body("serviceIds")
    .isArray({ min: 1 })
    .withMessage("At least one service is required"),
  body("serviceIds.*").isMongoId().withMessage("Invalid service ID"),
  body("paymentMethod")
    .optional()
    .isIn(["online", "cash", "card", "partial"])
    .withMessage("paymentMethod must be online, cash, card, or partial"),
  body("cashAmount")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("cashAmount must be >= 0"),
  body("onlineAmount")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("onlineAmount must be >= 0"),
  body("cardAmount")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("cardAmount must be >= 0"),
  body("razorpayPaymentId")
    .optional({ values: "null" })
    .trim(),
  body("discountPercent")
    .optional()
    .isFloat({ min: 0, max: 100 })
    .withMessage("Discount must be 0–100"),
];

// ─── POST / — create a visit ─────────────────────────────────────────────────
router.post("/", authorizePermission(PERMISSIONS.VISIT_CREATE), createRules, async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }

  try {
    await connectDB();
    const {
      name,
      contact,
      gender,
      date,
      startTime,
      endTime,
      artist,
      serviceType,
      serviceIds,
      discountPercent = 0,
      paymentMethod = "online",
      cashAmount = 0,
      razorpayPaymentId = null,
    } = req.body;

    // ── Resolve services from DB (authoritative prices) ───────────────────
    const { orderedServices, error } = await resolveRequestedServicesWithDuplicates(serviceIds);
    if (error) {
      return res.status(400).json({ error });
    }

    const services = orderedServices.map((s) => ({
      name: s.name,
      price: s.price,
      serviceId: s._id,
      // Snapshot the expected duration at visit creation time.
      // If this service has no durationMinutes set, store null — this visit
      // will be excluded from time-performance calculations (not penalised).
      duration: s.durationMinutes ?? null,
    }));

    // ── Compute billing server-side ───────────────────────────────────────
    const subtotal = services.reduce((sum, s) => sum + s.price, 0);
    const pct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
    const discountAmount = Math.round(subtotal * (pct / 100));
    const finalTotal = Math.max(0, subtotal - discountAmount);

    if (paymentMethod === "online" && !razorpayPaymentId) {
      return res.status(400).json({ error: "Razorpay Payment ID is required for online payment" });
    }
    if (paymentMethod === "partial" && !razorpayPaymentId) {
      return res.status(400).json({ error: "Razorpay Payment ID is required for partial payment" });
    }

    const amounts = derivePaymentAmounts({ paymentMethod, finalTotal, cashAmount });

    // ── Create visit document ─────────────────────────────────────────────
    const visit = await Visit.create({
      schemaVersion: 1,
      name,
      contact,
      gender,
      date: new Date(date),
      startTime,
      endTime,
      artist,
      serviceType: serviceType || undefined,
      services,
      // visitDurationMins is calculated on the frontend (endTime − startTime)
      // and sent with the form. Storing it avoids recalculating from strings.
      visitDurationMins: req.body.visitDurationMins != null ? Number(req.body.visitDurationMins) : null,
      filledBy: req.session.name || "Unknown",
      subtotal,
      discountPercent: pct,
      discountAmount,
      finalTotal,
      paymentMethod,
      cashAmount: amounts.cashAmount,
      cardAmount: amounts.cardAmount,
      onlineAmount: amounts.onlineAmount,
      paymentStatus: "success",
      razorpayPaymentId: razorpayPaymentId || null,
      assignmentStatus: "not_required",
      lockUntilAssigned: false,
      paymentConfirmedAt: new Date(),
      paymentSnapshot: {
        subtotal,
        discountPercent: pct,
        discountAmount,
        finalTotal,
        paymentMethod,
        cashAmount: amounts.cashAmount,
        cardAmount: amounts.cardAmount,
        onlineAmount: amounts.onlineAmount,
        razorpayPaymentId: razorpayPaymentId || null,
      },
    });

    return res.status(201).json({
      success: true,
      visitId: visit._id,
      finalTotal,
    });
  } catch (err) {
    console.error("[visits] Create error:", err);
    return res
      .status(500)
      .json({ error: "Failed to create visit", details: err.message });
  }
});

// ─── POST /v2 — create paid draft (assignment pending) ─────────────────────
router.post("/v2", authorizePermission(PERMISSIONS.VISIT_CREATE), async (req, res) => {
  try {
    await connectDB();

    const {
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
      duration: s.durationMinutes ?? null,
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

    if (paymentMethod === "online" && !effectivePaymentId) {
      return res.status(400).json({ error: "Razorpay Payment ID is required for online payment" });
    }
    if (paymentMethod === "partial" && !effectivePaymentId) {
      return res.status(400).json({ error: "Razorpay Payment ID is required for partial payment" });
    }

    const amounts = derivePaymentAmounts({ paymentMethod, finalTotal, cashAmount });

    const visit = await Visit.create({
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

// ─── GET /customers/search?phone=... ───────────────────────────────────────
router.get("/customers/search", authorizePermission(PERMISSIONS.VISIT_CREATE), async (req, res) => {
  try {
    await connectDB();

    const phoneRaw = String(req.query.phone || "").trim();
    if (!phoneRaw) return res.json({ customers: [] });
    if (!/^[0-9]{3,10}$/.test(phoneRaw)) {
      return res.status(400).json({ error: "phone query must be 3 to 10 digits" });
    }

    const phoneRegex = new RegExp(`^${escapeRegex(phoneRaw)}`);

    const visits = await Visit.find(
      {
        contact: { $regex: phoneRegex },
        paymentStatus: "success",
        $or: [
          { assignmentStatus: { $exists: false } },
          { assignmentStatus: "not_required" },
          { assignmentStatus: "completed" },
        ],
      },
      {
        name: 1,
        contact: 1,
        gender: 1,
        date: 1,
        createdAt: 1,
      }
    )
      .sort({ date: -1, createdAt: -1 })
      .limit(50)
      .lean();

    const latestByContact = new Map();
    for (const v of visits) {
      const key = String(v.contact || "");
      if (!latestByContact.has(key)) {
        latestByContact.set(key, {
          name: v.name,
          contact: v.contact,
          gender: v.gender,
          lastVisitDate: v.date,
          lastSeenAt: v.createdAt,
        });
      }
    }

    return res.json({ customers: [...latestByContact.values()].slice(0, 10) });
  } catch (err) {
    console.error("[visits] Customer search error:", err);
    return res.status(500).json({ error: "Failed to search customers" });
  }
});

// ─── GET /history — Paginated payment history ─────────────────────────────────
// Access: receptionist, manager, owner
// Query params:
//   from        YYYY-MM-DD  (default: start of this month)
//   to          YYYY-MM-DD  (default: today)
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

    const today = new Date();
    const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1);

    const fromRaw = req.query.from ? new Date(req.query.from) : defaultFrom;
    const toRaw = req.query.to ? new Date(req.query.to) : today;

    // Set time bounds to capture full days
    const from = new Date(fromRaw);
    from.setHours(0, 0, 0, 0);
    const to = new Date(toRaw);
    to.setHours(23, 59, 59, 999);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    }

    /**
     * `payments.today_only` clamps the range to the current day.
     *
     * Enforced HERE, not in the UI. Hiding the date buttons stops an honest
     * receptionist browsing last month's takings; it does nothing about someone
     * editing the `from=` parameter in the address bar. The server has to be
     * the thing that refuses, so the clamp is applied after parsing and before
     * the filter is built — every read below inherits it, including the summary
     * totals and the row count.
     *
     * The owner bypasses PBAC everywhere else, so it bypasses this too.
     */
    const permissions = await getUserPermissions(req.session.userId);
    const todayOnly =
      req.session.role !== "owner" &&
      permissions.includes(PERMISSIONS.PAYMENTS_TODAY_ONLY);

    if (todayOnly) {
      const now = new Date();
      // Mutate in place — `from`/`to` are const bindings to Date objects.
      from.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
      from.setHours(0, 0, 0, 0);
      to.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
      to.setHours(23, 59, 59, 999);
    }

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

    // Build filter
    const baseFilter = {
      date: { $gte: from, $lte: to },
      paymentStatus: "success",
      $or: [
        { assignmentStatus: { $exists: false } },
        { assignmentStatus: "not_required" },
        { assignmentStatus: "completed" },
      ],
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
      // Aggregate summary for the filtered range
      Visit.aggregate([
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
      summary: summary[0] || { totalRevenue: 0, totalCash: 0, totalCard: 0, totalOnline: 0, totalDiscount: 0, count: 0 },
      schemaCounts,
      // Lets the UI explain why the date filters are gone, instead of the page
      // looking broken to a receptionist who remembers them being there.
      restrictedToToday: todayOnly,
      range: { from, to },
    });
  } catch (err) {
    console.error("[visits] History error:", err);
    return res.status(500).json({ error: "Failed to fetch payment history" });
  }
});

module.exports = router;

