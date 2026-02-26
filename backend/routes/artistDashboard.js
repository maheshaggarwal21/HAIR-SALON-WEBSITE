/**
 * @file artistDashboard.js
 * @description Artist's personal dashboard API endpoints.
 *
 * Mounted at /api/artist-dashboard in index.js.
 * Protected by: authenticate → authorize("artist")
 *
 * All queries filter by the logged-in artist's name (from the Artist record
 * linked to the session userId) so artists can only see their own data.
 *
 * Endpoints:
 *   GET /profile       — Artist profile with commission info
 *   GET /summary       — KPI summary (earnings, commission, customers, services)
 *   GET /services      — Services breakdown for the artist
 *   GET /daily-trend   — Daily revenue trend for charting
 */

const express = require("express");
const connectDB = require("../db");
const Artist = require("../models/Artist");
const Visit = require("../models/Visit");

const router = express.Router();

// ── Ensure DB on every request ──────────────────────────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[artist-dashboard] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ── Resolve the Artist record from the session userId ───────────────────────
router.use(async (req, res, next) => {
  try {
    const artist = await Artist.findOne({ userId: req.session.userId });
    if (!artist) {
      return res.status(404).json({ error: "Artist profile not found. Contact the owner." });
    }
    req.artistRecord = artist;
    next();
  } catch (err) {
    console.error("[artist-dashboard] Artist lookup error:", err);
    return res.status(500).json({ error: "Failed to load artist profile" });
  }
});

// ── Helper: build date filter from query params ─────────────────────────────
function dateFilter(query) {
  const filter = {};
  const now = new Date();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  let from;
  if (query.from && dateRe.test(query.from)) {
    const [y, m, d] = query.from.split("-").map(Number);
    from = new Date(y, m - 1, d, 0, 0, 0, 0);
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  let to;
  if (query.to && dateRe.test(query.to)) {
    const [y, m, d] = query.to.split("-").map(Number);
    to = new Date(y, m - 1, d, 23, 59, 59, 999);
  } else {
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  }

  filter.date = { $gte: from, $lte: to };
  return filter;
}

function calcHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return Math.max(diff / 60, 0);
}

// ────────────────────────────────────────────────────
// 1. GET /profile — Artist profile + commission info
// ────────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  try {
    const a = req.artistRecord;
    return res.json({
      _id: a._id,
      name: a.name,
      phone: a.phone,
      email: a.email,
      registrationId: a.registrationId,
      commission: a.commission,
      photo: a.photo,
      isActive: a.isActive,
      createdAt: a.createdAt,
    });
  } catch (err) {
    console.error("[artist-dashboard] Profile error:", err);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

// ────────────────────────────────────────────────────
// 2. GET /summary — KPIs: total revenue, commission earned,
//    customers served, services done, hours worked
// ────────────────────────────────────────────────────
router.get("/summary", async (req, res) => {
  try {
    const artistName = req.artistRecord.name;
    const commissionPct = req.artistRecord.commission || 0;
    const match = { ...dateFilter(req.query), artist: artistName };

    const visits = await Visit.find(match);

    const totalRevenue = visits.reduce((sum, v) => sum + (v.finalTotal || 0), 0);
    const totalVisits = visits.length;
    const uniqueCustomers = new Set(visits.map((v) => v.contact)).size;
    const totalHours = visits.reduce((s, v) => s + calcHours(v.startTime, v.endTime), 0);

    // Count total services performed
    const totalServices = visits.reduce((s, v) => s + (v.services?.length || 0), 0);

    // Commission earned
    const commissionEarned = Math.round(totalRevenue * (commissionPct / 100) * 100) / 100;

    // Average ticket size
    const avgTicket = totalVisits > 0 ? Math.round((totalRevenue / totalVisits) * 100) / 100 : 0;

    return res.json({
      totalRevenue,
      commissionPct,
      commissionEarned,
      totalVisits,
      uniqueCustomers,
      totalServices,
      hoursWorked: Math.round(totalHours * 10) / 10,
      avgTicket,
      from: match.date.$gte,
      to: match.date.$lte,
    });
  } catch (err) {
    console.error("[artist-dashboard] Summary error:", err);
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// ────────────────────────────────────────────────────
// 3. GET /services — Services breakdown for this artist
// ────────────────────────────────────────────────────
router.get("/services", async (req, res) => {
  try {
    const artistName = req.artistRecord.name;
    const match = { ...dateFilter(req.query), artist: artistName };

    const result = await Visit.aggregate([
      { $match: match },
      { $unwind: "$services" },
      {
        $group: {
          _id: "$services.name",
          count: { $sum: 1 },
          revenue: { $sum: "$services.price" },
        },
      },
      { $sort: { count: -1 } },
      {
        $project: {
          _id: 0,
          service: "$_id",
          count: 1,
          revenue: 1,
        },
      },
    ]);

    return res.json(result);
  } catch (err) {
    console.error("[artist-dashboard] Services error:", err);
    return res.status(500).json({ error: "Failed to fetch services data" });
  }
});

// ────────────────────────────────────────────────────
// 4. GET /daily-trend — Daily revenue + commission for charting
// ────────────────────────────────────────────────────
router.get("/daily-trend", async (req, res) => {
  try {
    const artistName = req.artistRecord.name;
    const commissionPct = req.artistRecord.commission || 0;
    const match = { ...dateFilter(req.query), artist: artistName };

    const result = await Visit.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$date" },
          },
          revenue: { $sum: "$finalTotal" },
          visits: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: "$_id",
          revenue: 1,
          commission: {
            $round: [{ $multiply: ["$revenue", commissionPct / 100] }, 2],
          },
          visits: 1,
        },
      },
    ]);

    return res.json(result);
  } catch (err) {
    console.error("[artist-dashboard] Daily trend error:", err);
    return res.status(500).json({ error: "Failed to fetch daily trend" });
  }
});

// ────────────────────────────────────────────────────
// 5. GET /time-performance — Extra time vs expected for this artist
//
// HOW IT WORKS:
//   For each visit, we compare actual duration (endTime - startTime) against
//   expected duration (sum of service.duration snapshots).
//
//   A visit is "schedulable" only if every service in it has a duration
//   snapshot (duration !== null). This excludes older pre-Phase-3 visits.
//
//   Tolerance: ±10 minutes. Only time BEYOND that threshold counts as extra.
//     diff > +10 → over by (diff - 10) mins  → positive (bad)
//     diff < -10 → early by (|diff| - 10) mins → negative (good)
//     |diff| ≤ 10 → within tolerance → 0
//
//   totalExtraMins is the NET sum across all schedulable visits.
//   ─ Positive total: artist consistently runs over → needs improvement.
//   ─ Negative total: artist consistently finishes early → efficient!
// ────────────────────────────────────────────────────
router.get("/time-performance", async (req, res) => {
  try {
    const artistName = req.artistRecord.name;
    const match = { ...dateFilter(req.query), artist: artistName };

    const visits = await Visit.find(match).sort({ date: 1 });

    const perVisit = [];
    let totalExtraMins = 0;
    let schedulableVisits = 0;
    let nonSchedulableVisits = 0;

    visits.forEach((v) => {
      // Actual duration from stored time strings
      const actualMins = calcHours(v.startTime, v.endTime) * 60;

      // Check if ALL services have a duration snapshot
      const allHaveDuration =
        v.services.length > 0 &&
        v.services.every((s) => s.duration !== null && s.duration !== undefined);

      if (!allHaveDuration) {
        nonSchedulableVisits++;
        return; // skip this visit from time calculations
      }

      schedulableVisits++;
      const expectedMins = v.services.reduce((sum, s) => sum + (s.duration || 0), 0);
      const diff = actualMins - expectedMins;

      // Apply ±10 min tolerance — only count excess beyond threshold
      let extraMins = 0;
      if (diff > 10) extraMins = diff - 10;        // ran over
      else if (diff < -10) extraMins = diff + 10;  // finished early (negative)

      totalExtraMins += extraMins;

      perVisit.push({
        date: v.date,
        actualMins: Math.round(actualMins),
        expectedMins,
        extraMins: Math.round(extraMins),
      });
    });

    return res.json({
      schedulableVisits,
      nonSchedulableVisits,
      totalExtraMins: Math.round(totalExtraMins),
      perVisit,
    });
  } catch (err) {
    console.error("[artist-dashboard] Time performance error:", err);
    return res.status(500).json({ error: "Failed to fetch time performance" });
  }
});

module.exports = router;
