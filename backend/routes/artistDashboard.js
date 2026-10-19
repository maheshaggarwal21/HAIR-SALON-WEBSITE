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
 *   GET /my-day        — This artist's own bookings for one day (day sheet)
 */

const express = require("express");
const connectDB = require("../db");
const Artist = require("../models/Artist");
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

// ────────────────────────────────────────────────────
// GET /my-day?date=YYYY-MM-DD — the artist's day sheet (T2.14 follow-up, D55)
//
// Each artist sees only THEIR OWN chair for the day: who is booked, for what,
// from when to when, and anything the client wrote. No phone numbers, prices or
// deposits — an artist does not need them to do the service, and the front desk
// already owns that conversation. Unpaid holds and requests nobody has approved
// are left out: they are not firm bookings and would only send an artist to
// wait for someone who may never come.
//
// Reads the same board the front desk uses, so the two can never disagree.
// ────────────────────────────────────────────────────
const { isValidDate, salonDate, addDays, daysBetween } = require("../utils/time");
const FIRM = ["confirmed", "checked_in", "completed", "no_show"];

router.get("/my-day", async (req, res) => {
  try {
    const today = salonDate();
    const date = req.query.date ? String(req.query.date) : today;
    if (!isValidDate(date)) return res.status(400).json({ error: "Pick a valid date" });
    const offset = daysBetween(today, date);
    if (offset < -7 || offset > 21) return res.status(400).json({ error: "Pick a day from the last week to three weeks ahead" });

    const { dayBoard } = require("../utils/board");
    const board = await dayBoard(date);
    const mine = board.artists.find((a) => String(a._id) === String(req.artistRecord._id));
    if (!mine) return res.json({ date, today, closed: board.closed, working: [], leave: [], blocked: [], items: [] });

    return res.json({
      date,
      today,
      now: board.now,
      closed: board.closed,
      working: mine.working,
      leave: mine.leave.map((l) => ({ start: l.start, end: l.end, reason: l.reason })),
      blocked: mine.blocked,
      items: mine.items
        .filter((i) => FIRM.includes(i.status))
        .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
        .map((i) => ({
          ref: i.ref,
          status: i.status,
          name: i.name,
          service: i.service,
          startAt: i.startAt,
          endAt: i.endAt,
          notes: i.notes || null,
        })),
    });
  } catch (err) {
    console.error("[artist-dashboard] my-day error:", err);
    return res.status(500).json({ error: "Failed to load your day" });
  }
});

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
    const { artistRows, from, to } = await fetchArtistScopedRows(req.query, artistName);
    const summary = buildArtistDashboardSummary(artistRows, commissionPct);

    return res.json({
      ...summary,
      from,
      to,
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
    const { artistRows } = await fetchArtistScopedRows(req.query, artistName);
    const result = buildServiceBreakdown(artistRows);

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
    const { artistRows } = await fetchArtistScopedRows(req.query, artistName);
    const result = buildDailyTrend(artistRows, commissionPct);

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
    const { artistRows } = await fetchArtistScopedRows(req.query, artistName);
    const result = buildTimePerformanceFromRows(artistRows);
    return res.json(result);
  } catch (err) {
    console.error("[artist-dashboard] Time performance error:", err);
    return res.status(500).json({ error: "Failed to fetch time performance" });
  }
});

module.exports = router;
