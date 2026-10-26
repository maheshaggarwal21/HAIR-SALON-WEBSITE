/**
 * @file routes/leads.js
 * @description The salon's list of leads, in the staff app under Bookings -> Leads.
 *
 *   GET   /          ?status=new|contacted|closed &q=&page=&limit=   newest first, with counts by status
 *   PATCH /:id       { status?, note? }                              who and when are kept; audited
 *
 * Reading needs `bookings.view`; changing a lead needs `bookings.manage` (the permissions that already run Website
 * requests). Leads are created by the public form only (routes/publicLeads.js); nothing here creates or deletes one.
 */
const express = require("express");
const mongoose = require("mongoose");
const { body, param, query, validationResult } = require("express-validator");
const connectDB = require("../db");
const Lead = require("../models/Lead");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const audit = require("../utils/audit");

const router = express.Router();
const STATUSES = ["new", "contacted", "closed"];

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[leads] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

const firstError = (req, res) => {
  const e = validationResult(req);
  if (e.isEmpty()) return false;
  res.status(400).json({ error: e.array()[0].msg });
  return true;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const view = (l) => ({
  id: String(l._id),
  name: l.name,
  phone: l.phone,
  query: l.query,
  status: l.status,
  note: l.note,
  handledBy: l.handledBy,
  handledAt: l.handledAt,
  source: l.source?.channel ?? null,
  offerSlug: l.source?.offerSlug ?? null,
  campaign: l.source?.campaign ?? null,
  createdAt: l.createdAt,
});

router.get(
  "/",
  authorizePermission(PERMISSIONS.BOOKINGS_VIEW),
  [
    query("status").optional().isIn(STATUSES).withMessage("status must be new, contacted or closed"),
    query("page").optional().isInt({ min: 1, max: 1000 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("q").optional().isString().isLength({ max: 100 }),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const page = req.query.page || 1;
      const limit = req.query.limit || 50;
      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      const q = String(req.query.q || "").trim();
      if (q) {
        const re = new RegExp(escapeRe(q), "i");
        filter.$or = [{ name: re }, { phone: re }, { query: re }];
      }
      const [rows, total, grouped] = await Promise.all([
        Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Lead.countDocuments(filter),
        Lead.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      ]);
      const counts = { new: 0, contacted: 0, closed: 0 };
      for (const g of grouped) if (g._id in counts) counts[g._id] = g.n;
      return res.json({ leads: rows.map(view), total, page, limit, counts });
    } catch (err) {
      console.error("[leads] list failed:", err);
      return res.status(500).json({ error: "Could not load leads" });
    }
  }
);

router.patch(
  "/:id",
  authorizePermission(PERMISSIONS.BOOKINGS_MANAGE),
  [
    param("id").custom((v) => mongoose.Types.ObjectId.isValid(v)).withMessage("Unknown lead"),
    body("status").optional().isIn(STATUSES).withMessage("status must be new, contacted or closed"),
    body("note").optional({ nullable: true }).isString().trim().isLength({ max: 300 }).withMessage("Keep the note under 300 characters"),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      const before = lead.status;
      if (req.body.status) lead.status = req.body.status;
      if (req.body.note !== undefined) lead.note = req.body.note || null;
      lead.handledBy = req.session?.name || "staff";
      lead.handledAt = new Date();
      await lead.save();
      await audit.record({ action: "lead.updated", req, target: { name: lead.name }, meta: { id: String(lead._id), from: before, to: lead.status, noted: req.body.note !== undefined } });
      return res.json({ lead: view(lead.toObject()) });
    } catch (err) {
      console.error("[leads] update failed:", err);
      return res.status(500).json({ error: "Could not save" });
    }
  }
);

module.exports = router;
