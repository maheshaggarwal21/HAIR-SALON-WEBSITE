/**
 * @file ownerArtistDashboard.js
 * @description Owner-accessible view of any artist's dashboard data.
 *
 * Mounted at /api/owner/artist-dashboard in index.js.
 * Protected by: authenticate → authorize("owner")
 *
 * All endpoints require an :artistId param. The owner can view any artist's
 * dashboard data without being that artist.
 *
 * Endpoints:
 *   GET /:artistId/profile       — Artist profile
 *   GET /:artistId/summary       — KPI summary
 *   GET /:artistId/services      — Services breakdown
 *   GET /:artistId/daily-trend   — Daily revenue trend
 */

const express = require("express");
const connectDB = require("../db");
const Artist = require("../models/Artist");
const Visit = require("../models/Visit");
const validateId = require("../middleware/validateId");
const { authorizePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// ── Ensure DB on every request ──────────────────────────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[owner-artist-dashboard] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ── Resolve the Artist record from :artistId param ──────────────────────────
router.param("artistId", async (req, res, next, id) => {
  try {
    // Validate ObjectId format
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: "Invalid artist ID format" });
    }
    const artist = await Artist.findById(id);
    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }
    req.artistRecord = artist;
    next();
  } catch (err) {
    console.error("[owner-artist-dashboard] Artist lookup error:", err);
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
// 1. GET /:artistId/profile
// ────────────────────────────────────────────────────
router.get("/:artistId/profile", authorizePermission(PERMISSIONS.ARTIST_DASHBOARD_VIEW), async (req, res) => {
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
    console.error("[owner-artist-dashboard] Profile error:", err);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

// ────────────────────────────────────────────────────
// 2. GET /:artistId/summary
// ────────────────────────────────────────────────────
router.get("/:artistId/summary", authorizePermission(PERMISSIONS.ARTIST_DASHBOARD_VIEW), async (req, res) => {
  try {
    const artistName = req.artistRecord.name;
    const commissionPct = req.artistRecord.commission || 0;
    const match = { ...dateFilter(req.query), artist: artistName };

    const visits = await Visit.find(match);

    const totalRevenue = visits.reduce((sum, v) => sum + (v.finalTotal || 0), 0);
    const totalVisits = visits.length;
    const uniqueCustomers = new Set(visits.map((v) => v.contact)).size;
    const totalHours = visits.reduce((s, v) => s + calcHours(v.startTime, v.endTime), 0);
    const totalServices = visits.reduce((s, v) => s + (v.services?.length || 0), 0);
    const commissionEarned = Math.round(totalRevenue * (commissionPct / 100) * 100) / 100;
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
    console.error("[owner-artist-dashboard] Summary error:", err);
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// ────────────────────────────────────────────────────
// 3. GET /:artistId/services
// ────────────────────────────────────────────────────
router.get("/:artistId/services", authorizePermission(PERMISSIONS.ARTIST_DASHBOARD_VIEW), async (req, res) => {
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
    console.error("[owner-artist-dashboard] Services error:", err);
    return res.status(500).json({ error: "Failed to fetch services data" });
  }
});

// ────────────────────────────────────────────────────
// 4. GET /:artistId/daily-trend
// ────────────────────────────────────────────────────
router.get("/:artistId/daily-trend", authorizePermission(PERMISSIONS.ARTIST_DASHBOARD_VIEW), async (req, res) => {
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
    console.error("[owner-artist-dashboard] Daily trend error:", err);
    return res.status(500).json({ error: "Failed to fetch daily trend" });
  }
});

module.exports = router;
