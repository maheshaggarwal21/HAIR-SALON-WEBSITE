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
const Visit = require("../models/Visit");
const Service = require("../models/Service");

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
router.post("/", createRules, async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) {
    return res.status(400).json({ errors: errs.array() });
  }

  try {
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

module.exports = router;
