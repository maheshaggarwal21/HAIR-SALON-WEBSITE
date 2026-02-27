/**
 * @file routes/visits.js
 * @description Visit creation endpoint.
 *
 * POST /  – Create a new Visit document after successful Razorpay payment.
 *           Resolves service IDs to { name, price } from the Service model
 *           and computes billing totals server-side to prevent tampering.
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const Visit = require("../models/Visit");
const Service = require("../models/Service");
const { authenticate, authorize, authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// ─── Validation rules ────────────────────────────────────────────────────────
const createRules = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("contact")
    .trim()
    .matches(/^[6-9]\d{9}$/)
    .withMessage("Valid 10-digit Indian mobile required"),
  body("age").trim().notEmpty().withMessage("Age is required"),
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
    .isIn(["online", "cash", "partial"])
    .withMessage("paymentMethod must be online, cash, or partial"),
  body("cashAmount")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("cashAmount must be >= 0"),
  body("onlineAmount")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("onlineAmount must be >= 0"),
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
      age,
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
      onlineAmount = 0,
      razorpayPaymentId = null,
    } = req.body;

    // ── Resolve services from DB (authoritative prices) ───────────────────
    const serviceDocs = await Service.find({
      _id: { $in: serviceIds },
      isActive: true,
    }).lean();

    if (serviceDocs.length === 0) {
      return res.status(400).json({ error: "No valid active services found" });
    }

    const services = serviceDocs.map((s) => ({
      name: s.name,
      price: s.price,
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

    // ── Validate payment method constraints ──────────────────────────────
    // For "online" mode: razorpayPaymentId is required
    if (paymentMethod === "online" && !razorpayPaymentId) {
      return res.status(400).json({ error: "Razorpay Payment ID is required for online payment" });
    }
    // For "partial" mode: razorpayPaymentId is required + cashAmount must be valid
    if (paymentMethod === "partial") {
      if (!razorpayPaymentId) {
        return res.status(400).json({ error: "Razorpay Payment ID is required for partial payment" });
      }
      if (!cashAmount || cashAmount <= 0 || cashAmount >= finalTotal) {
        return res.status(400).json({ error: "Cash amount must be between ₹1 and total minus ₹1 for partial payment" });
      }
    }

    // ── Derive cash / online split amounts ───────────────────────────────
    // Always re-derive from finalTotal to ensure cash + online = finalTotal exactly.
    // For partial: trust the cashAmount sent from frontend (already validated above).
    let derivedCash = 0;
    let derivedOnline = 0;
    if (paymentMethod === "cash") {
      derivedCash = finalTotal;
      derivedOnline = 0;
    } else if (paymentMethod === "partial") {
      derivedCash = Math.round(Number(cashAmount));
      derivedOnline = Math.round(finalTotal - derivedCash);
    } else {
      // "online" — entire bill paid online
      derivedCash = 0;
      derivedOnline = finalTotal;
    }

    // ── Create visit document ─────────────────────────────────────────────
    const visit = await Visit.create({
      name,
      contact,
      age,
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
      cashAmount: derivedCash,
      onlineAmount: derivedOnline,
      paymentStatus: "success",
      razorpayPaymentId: razorpayPaymentId || null,
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

// ─── GET /history — Paginated payment history ─────────────────────────────────
// Access: receptionist, manager, owner
// Query params:
//   from        YYYY-MM-DD  (default: start of this month)
//   to          YYYY-MM-DD  (default: today)
//   customer    string      (optional, case-insensitive customer name filter)
//   artist      string      (optional, case-insensitive artist name filter)
//   method      online|cash|partial (optional payment method filter)
//   page        number      (default: 1)
//   limit       number      (default: 50, max: 200)
router.get("/history", authorize("receptionist", "manager", "owner", "artist"), authorizePermission(PERMISSIONS.PAYMENTS_VIEW), async (req, res) => {
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

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    // Build filter
    const filter = { date: { $gte: from, $lte: to } };
    if (req.query.customer) {
      filter.name = { $regex: req.query.customer.trim(), $options: "i" };
    }
    if (req.query.artist) {
      filter.artist = { $regex: req.query.artist.trim(), $options: "i" };
    }
    if (req.query.method && ["online", "cash", "partial"].includes(req.query.method)) {
      filter.paymentMethod = req.query.method;
    }

    const [visits, total] = await Promise.all([
      Visit.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("name contact artist services subtotal discountPercent discountAmount finalTotal paymentMethod cashAmount onlineAmount razorpayPaymentId paymentStatus filledBy date startTime endTime createdAt")
        .lean(),
      Visit.countDocuments(filter),
    ]);

    // Aggregate summary for the filtered range
    const summary = await Visit.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$finalTotal" },
          totalCash: { $sum: "$cashAmount" },
          totalOnline: { $sum: "$onlineAmount" },
          totalDiscount: { $sum: "$discountAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    return res.json({
      visits,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      summary: summary[0] || { totalRevenue: 0, totalCash: 0, totalOnline: 0, totalDiscount: 0, count: 0 },
    });
  } catch (err) {
    console.error("[visits] History error:", err);
    return res.status(500).json({ error: "Failed to fetch payment history" });
  }
});

module.exports = router;

