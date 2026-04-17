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
const { authorizePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/permissions');
const {
  buildServiceBreakdown,
  buildArtistDashboardSummary,
  buildDailyTrend,
  buildTimePerformanceFromRows,
} = require("../utils/artistAttribution");
const { fetchArtistScopedRows } = require("../utils/artistDashboardData");

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
    const { artistRows, from, to } = await fetchArtistScopedRows(req.query, artistName);
    const summary = buildArtistDashboardSummary(artistRows, commissionPct);

    return res.json({
      ...summary,
      from,
      to,
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
    const { artistRows } = await fetchArtistScopedRows(req.query, artistName);
    const result = buildServiceBreakdown(artistRows);

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
    const { artistRows } = await fetchArtistScopedRows(req.query, artistName);
    const result = buildDailyTrend(artistRows, commissionPct);

    return res.json(result);
  } catch (err) {
    console.error("[owner-artist-dashboard] Daily trend error:", err);
    return res.status(500).json({ error: "Failed to fetch daily trend" });
  }
});

// ────────────────────────────────────────────────────
// 5. GET /:artistId/time-performance
// ────────────────────────────────────────────────────
router.get("/:artistId/time-performance", authorizePermission(PERMISSIONS.ARTIST_DASHBOARD_VIEW), async (req, res) => {
  try {
    const artistName = req.artistRecord.name;
    const { artistRows } = await fetchArtistScopedRows(req.query, artistName);
    const result = buildTimePerformanceFromRows(artistRows);
    return res.json(result);
  } catch (err) {
    console.error("[owner-artist-dashboard] Time performance error:", err);
    return res.status(500).json({ error: "Failed to fetch time performance" });
  }
});

module.exports = router;
