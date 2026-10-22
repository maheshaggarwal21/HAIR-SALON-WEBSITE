/**
 * @file discounts.js
 * @description The owner's discount summary (D60, part B).
 *
 * There is no cap on discounts — the desk can give any percentage — so this is
 * the control: who gave how much, how often, and which ones were unusually large.
 *
 *   GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD   per-staff table + flagged list
 *   GET /settings                                 { reviewPercent }
 *   PUT /settings   { reviewPercent }             owner only; audited
 *
 * "Visits" are counted by the day they were ENTERED (Visit.createdAt, IST), the
 * same day the DiscountLog row carries, so discounted ÷ total compares like with like.
 * Staff are matched by name (Visit.filledBy is a name; a " (recovered payment)"
 * suffix is stripped).
 *
 * Highlight, never block: a row above the review percent is only marked.
 */

const express = require("express");
const connectDB = require("../db");
const Visit = require("../models/Visit");
const DiscountLog = require("../models/DiscountLog");
const SiteSettings = require("../models/SiteSettings");
const { authorize, authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const audit = require("../utils/audit");
const { salonDate, addDays, isValidDate, salonInstant } = require("../utils/time");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[discounts] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});
router.use(authorizePermission(PERMISSIONS.DISCOUNTS_VIEW));

const MAX_DAYS = 93;
const FLAGGED_LIMIT = 100;
// Paid visits, including drafts still waiting for their artist split: the discount is
// logged when the visit is created, so the denominator must count it from then too.
const PAID = { paymentStatus: "success" };

/** Resolve ?from&to (default: the last 7 days incl. today) or return an error string. */
function range(q) {
  const to = q.to ? String(q.to) : salonDate();
  const from = q.from ? String(q.from) : addDays(to, -6);
  if (!isValidDate(from) || !isValidDate(to)) return { error: "from and to must be YYYY-MM-DD" };
  if (from > to) return { error: "from must not be after to" };
  if ((new Date(to) - new Date(from)) / 86_400_000 > MAX_DAYS) return { error: `Pick at most ${MAX_DAYS} days` };
  return { from, to };
}

const baseName = (n) => String(n || "Unknown").replace(/ \(recovered payment\)$/, "");

async function reviewPercent() {
  const s = await SiteSettings.getSingleton();
  return s.discountReviewPercent ?? 30;
}

router.get("/summary", async (req, res) => {
  try {
    const r = range(req.query);
    if (r.error) return res.status(400).json({ error: r.error });
    const threshold = await reviewPercent();

    const startAt = salonInstant(r.from, "00:00");
    const endAt = salonInstant(addDays(r.to, 1), "00:00");

    const [logRows, visitRows, flagged] = await Promise.all([
      DiscountLog.aggregate([
        { $match: { day: { $gte: r.from, $lte: r.to } } },
        {
          $group: {
            _id: "$staffName",
            created: { $sum: { $cond: [{ $eq: ["$kind", "created"] }, 1, 0] } },
            edits: { $sum: { $cond: [{ $eq: ["$kind", "edited"] }, 1, 0] } },
            // Edits restate the visit's discount, so only creations add to the rupee total.
            totalAmount: { $sum: { $cond: [{ $eq: ["$kind", "created"] }, "$amount", 0] } },
            highestPercent: { $max: "$percent" },
            aboveThreshold: {
              $sum: { $cond: [{ $and: [{ $eq: ["$kind", "created"] }, { $gt: ["$percent", threshold] }] }, 1, 0] },
            },
          },
        },
      ]),
      Visit.aggregate([
        { $match: { ...PAID, createdAt: { $gte: startAt, $lt: endAt } } },
        { $group: { _id: "$filledBy", visits: { $sum: 1 } } },
      ]),
      DiscountLog.find({ day: { $gte: r.from, $lte: r.to }, percent: { $gt: threshold } })
        .sort({ createdAt: -1 })
        .limit(FLAGGED_LIMIT)
        .lean(),
    ]);

    const staff = new Map();
    const row = (name) => {
      if (!staff.has(name)) {
        staff.set(name, { staffName: name, totalVisits: 0, discountedVisits: 0, edits: 0, totalAmount: 0, highestPercent: 0, aboveThreshold: 0 });
      }
      return staff.get(name);
    };
    for (const v of visitRows) row(baseName(v._id)).totalVisits += v.visits;
    for (const l of logRows) {
      const t = row(baseName(l._id));
      t.discountedVisits += l.created;
      t.edits += l.edits;
      t.totalAmount += l.totalAmount;
      t.highestPercent = Math.max(t.highestPercent, l.highestPercent);
      t.aboveThreshold += l.aboveThreshold;
    }

    const rows = [...staff.values()].sort((a, b) => b.totalAmount - a.totalAmount);
    res.json({
      from: r.from,
      to: r.to,
      reviewPercent: threshold,
      staff: rows,
      totals: {
        totalVisits: rows.reduce((n, x) => n + x.totalVisits, 0),
        discountedVisits: rows.reduce((n, x) => n + x.discountedVisits, 0),
        totalAmount: rows.reduce((n, x) => n + x.totalAmount, 0),
        highestPercent: rows.reduce((n, x) => Math.max(n, x.highestPercent), 0),
      },
      flagged: flagged.map((f) => ({
        id: f._id,
        visitId: f.visitId,
        kind: f.kind,
        day: f.day,
        at: f.createdAt,
        staffName: baseName(f.staffName),
        percent: f.percent,
        amount: f.amount,
        finalTotal: f.finalTotal,
        paymentMethod: f.paymentMethod,
        reason: f.reason,
      })),
      flaggedTruncated: flagged.length >= FLAGGED_LIMIT,
    });
  } catch (err) {
    console.error("[discounts] summary error:", err);
    res.status(500).json({ error: "Failed to load the discount summary" });
  }
});

router.get("/settings", async (_req, res) => {
  try {
    res.json({ reviewPercent: await reviewPercent() });
  } catch (err) {
    console.error("[discounts] settings error:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.put("/settings", authorize("owner"), async (req, res) => {
  try {
    const raw = req.body?.reviewPercent;
    const n = raw === null || raw === "" || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return res.status(400).json({ error: "Review percent must be between 0 and 100" });
    }
    const before = await reviewPercent();
    await SiteSettings.getSingleton();
    await SiteSettings.updateOne({ key: "default" }, { $set: { discountReviewPercent: n } });
    await audit.record({ action: "discount.threshold_changed", req, meta: { from: before, to: n } });
    res.json({ reviewPercent: n });
  } catch (err) {
    console.error("[discounts] settings save error:", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

module.exports = router;
