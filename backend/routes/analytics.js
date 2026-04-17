/**
 * @file analytics.js
 * @description Express router providing salon analytics endpoints.
 *
 * All routes are prefixed with /api/analytics (mounted in index.js).
 * A middleware ensures MongoDB is connected before handling any request,
 * which is critical for Vercel’s serverless cold-start model.
 *
 * Endpoints:
 *   GET /summary           — KPI summary (revenue, visits, customers, avg ticket)
 *   GET /top-services      — Services ranked by frequency & revenue
 *   GET /employees         — Employee leaderboard sorted by revenue
 *   GET /employee/:name    — Deep-dive stats for one employee
 *   GET /repeat-customers  — New vs returning customer breakdown
 *   GET /export            — Download all visits as .xlsx
 */

const express = require("express");
const XLSX = require("xlsx");
const Visit = require("../models/Visit");
const connectDB = require("../db");
const { authorizePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/permissions');
const {
  buildFinalizedVisitFilter,
  buildArtistRows,
  buildServiceBreakdown,
} = require("../utils/artistAttribution");

const router = express.Router();

// ─── Middleware: ensure DB connection on every request ─────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[analytics] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a finalized-visit analytics filter.
 * - Excludes pending assignment drafts
 * - Supports optional schema filter: all|legacy|v2
 */
function analyticsFilter(query) {
  return buildFinalizedVisitFilter(query);
}

function buildEmployeeLeaderboard(rows) {
  const map = {};

  rows.forEach((row) => {
    const key = row.artist;
    if (!map[key]) {
      map[key] = {
        name: key,
        visitIds: new Set(),
        contacts: new Set(),
        revenue: 0,
        totalMins: 0,
        penaltyMins: 0,
        bonusMins: 0,
        totalExtraMins: 0,
        schedulableVisits: 0,
      };
    }

    const a = map[key];
    a.visitIds.add(row.visitId);
    if (row.contact) a.contacts.add(row.contact);
    a.revenue += Number(row.revenue) || 0;
    a.totalMins += Math.max(Number(row.actualMins) || 0, 0);

    if (row.expectedMins !== null && row.expectedMins !== undefined && row.actualMins > 0) {
      a.schedulableVisits += 1;
      const diff = row.actualMins - row.expectedMins;
      if (diff > 10) {
        a.penaltyMins += diff - 10;
        a.totalExtraMins += diff - 10;
      } else if (diff < -10) {
        a.bonusMins += Math.abs(diff) - 10;
        a.totalExtraMins += diff + 10;
      }
    }
  });

  return Object.values(map)
    .map((e) => {
      const actualHours = e.totalMins / 60;
      let effectiveHours = actualHours;

      if (e.schedulableVisits > 0) {
        effectiveHours = actualHours + (e.penaltyMins / 60) - (e.bonusMins / 60);
      }

      effectiveHours = Math.max(effectiveHours, 0.01);
      const revenue = Math.round(e.revenue);
      const productivityScore = revenue / effectiveHours;

      return {
        name: e.name,
        customersServed: e.visitIds.size,
        uniqueCustomers: e.contacts.size,
        revenue,
        hoursWorked: Math.round(actualHours * 10) / 10,
        revenuePerHour: Math.round(revenue / effectiveHours),
        totalExtraMins: Math.round(e.totalExtraMins),
        schedulableVisits: e.schedulableVisits,
        productivityScore: Math.round(productivityScore),
      };
    })
    .sort((a, b) => b.productivityScore - a.productivityScore)
    .map((e, i) => ({ rank: i + 1, ...e }));
}

// ────────────────────────────────────────────────────
// 1. GET /api/analytics/summary
//    Returns: totalRevenue, totalVisits, uniqueCustomers, avgTicket
// ────────────────────────────────────────────────────
router.get("/summary", authorizePermission(PERMISSIONS.ANALYTICS_VIEW), async (req, res) => {
  try {
    const match = analyticsFilter(req.query);
    const visits = await Visit.find(match).lean();

    const totalRevenue = visits.reduce((sum, v) => sum + (v.finalTotal || 0), 0);
    const totalVisits = visits.length;
    const uniqueCustomers = new Set(visits.map((v) => v.contact)).size;
    const avgTicket = totalVisits > 0 ? Math.round(totalRevenue / totalVisits) : 0;

    res.json({
      totalRevenue,
      totalVisits,
      uniqueCustomers,
      avgTicket,
      from: match.date.$gte,
      to: match.date.$lte,
    });
  } catch (err) {
    console.error("Summary error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to fetch summary", details: err.message });
  }
});

// ────────────────────────────────────────────────────
// 2. GET /api/analytics/top-services
//    Returns: services ranked by frequency + revenue
// ────────────────────────────────────────────────────
router.get("/top-services", authorizePermission(PERMISSIONS.ANALYTICS_VIEW), async (req, res) => {
  try {
    const match = analyticsFilter(req.query);
    const visits = await Visit.find(match).lean();
    const rows = buildArtistRows(visits);
    const result = buildServiceBreakdown(rows);

    res.json(result);
  } catch (err) {
    console.error("Top services error:", err);
    res.status(500).json({ error: "Failed to fetch top services" });
  }
});

// ────────────────────────────────────────────────────
// 3. GET /api/analytics/employees
//    Returns: leaderboard ranked by PRODUCTIVITY SCORE
//
//    PRODUCTIVITY SCORE = revenue ÷ effectiveHours
//    where:
//      effectiveHours = actualHours + (penaltyMins/60) − (bonusMins/60)
//      penaltyMins = total overtime beyond +10 min tolerance
//      bonusMins   = total time saved beyond −10 min tolerance
//
//    For artists with no duration data (all pre-Phase-3 visits):
//      effectiveHours = actualHours  (fallback, no penalty/bonus)
//
//    Also returns revenuePerHour (based on effectiveHours if data exists,
//    else actualHours) and totalExtraMins (net over/under).
// ────────────────────────────────────────────────────
router.get("/employees", authorizePermission(PERMISSIONS.ANALYTICS_VIEW), async (req, res) => {
  try {
    const match = analyticsFilter(req.query);
    const visits = await Visit.find(match).lean();
    const rows = buildArtistRows(visits);
    const leaderboard = buildEmployeeLeaderboard(rows);

    res.json(leaderboard);
  } catch (err) {
    console.error("Employees error:", err);
    res.status(500).json({ error: "Failed to fetch employee data" });
  }
});

// ────────────────────────────────────────────────────
// 4. GET /api/analytics/employee/:name
//    Returns: individual employee deep dive
// ────────────────────────────────────────────────────
router.get("/employee/:name", authorizePermission(PERMISSIONS.ANALYTICS_VIEW), async (req, res) => {
  try {
    const match = analyticsFilter(req.query);
    const artistName = req.params.name;

    const allVisits = await Visit.find(match).lean();
    const allRows = buildArtistRows(allVisits);
    const artistRows = allRows.filter((r) => r.artist === artistName);
    const leaderboard = buildEmployeeLeaderboard(allRows);
    const artistEntry = leaderboard.find((e) => e.name === artistName);

    if (!artistEntry || artistRows.length === 0) {
      return res.json({
        name: artistName,
        customersServed: 0,
        uniqueCustomers: 0,
        revenue: 0,
        hoursWorked: 0,
        avgRevenuePerVisit: 0,
        topServices: [],
        rank: 0,
        totalArtists: 0,
      });
    }

    const revenue = artistRows.reduce((sum, r) => sum + (Number(r.revenue) || 0), 0);
    const totalHours = artistRows.reduce((sum, r) => sum + ((Number(r.actualMins) || 0) / 60), 0);
    const uniqueCustomers = new Set(artistRows.map((r) => r.contact).filter(Boolean)).size;
    const uniqueVisits = new Set(artistRows.map((r) => r.visitId)).size;

    const svcMap = {};
    artistRows.forEach((row) => {
      row.services.forEach((s) => {
        if (!svcMap[s.name]) svcMap[s.name] = { count: 0, revenue: 0 };
        svcMap[s.name].count += 1;
        svcMap[s.name].revenue += Number(s.revenue) || Number(s.price) || 0;
      });
    });
    const topServices = Object.entries(svcMap)
      .map(([name, d]) => ({ service: name, count: d.count, revenue: d.revenue }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const rank = artistEntry.rank;
    const totalArtists = leaderboard.length;

    res.json({
      name: artistName,
      customersServed: uniqueVisits,
      uniqueCustomers,
      revenue: Math.round(revenue),
      hoursWorked: Math.round(totalHours * 10) / 10,
      avgRevenuePerVisit: uniqueVisits > 0 ? Math.round(revenue / uniqueVisits) : 0,
      topServices,
      rank,
      totalArtists,
      totalExtraMins: artistEntry.totalExtraMins,
      schedulableVisits: artistEntry.schedulableVisits,
      revenuePerHour: artistEntry.revenuePerHour,
    });
  } catch (err) {
    console.error("Employee detail error:", err);
    res.status(500).json({ error: "Failed to fetch employee details" });
  }
});

// ────────────────────────────────────────────────────
// 5. GET /api/analytics/repeat-customers
//    Returns: new vs returning count + repeat rate %
// ────────────────────────────────────────────────────
router.get("/repeat-customers", authorizePermission(PERMISSIONS.ANALYTICS_VIEW), async (req, res) => {
  try {
    const match = analyticsFilter(req.query);

    const result = await Visit.aggregate([
      { $match: match },
      { $group: { _id: "$contact", visits: { $sum: 1 }, name: { $first: "$name" } } },
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          repeatCustomers: { $sum: { $cond: [{ $gt: ["$visits", 1] }, 1, 0] } },
          newCustomers: { $sum: { $cond: [{ $eq: ["$visits", 1] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          totalCustomers: 1,
          repeatCustomers: 1,
          newCustomers: 1,
          repeatRate: {
            $cond: [
              { $gt: ["$totalCustomers", 0] },
              { $round: [{ $multiply: [{ $divide: ["$repeatCustomers", "$totalCustomers"] }, 100] }, 1] },
              0,
            ],
          },
        },
      },
    ]);

    res.json(result[0] || { totalCustomers: 0, repeatCustomers: 0, newCustomers: 0, repeatRate: 0 });
  } catch (err) {
    console.error("Repeat customers error:", err);
    res.status(500).json({ error: "Failed to fetch repeat customer data" });
  }
});

// ────────────────────────────────────────────────────
// 6. GET /api/analytics/export
//    Returns: .xlsx file download
// ────────────────────────────────────────────────────
router.get("/export", authorizePermission(PERMISSIONS.ANALYTICS_VIEW), async (req, res) => {
  try {
    const match = analyticsFilter(req.query);
    const visits = await Visit.find(match).sort({ date: -1 }).lean();

    // Flatten for Excel
    const rows = visits.map((v) => ({
      Date: v.date ? new Date(v.date).toLocaleDateString("en-IN") : "",
      Name: v.name,
      Contact: v.contact,
      Gender: v.gender,
      "Start Time": v.startTime,
      "End Time": v.endTime,
      Artist: v.artist,
      "Service Type": v.serviceType,
      Services: (v.services || []).map((s) => s.name).join(", "),
      "Filled By": v.filledBy,
      Subtotal: v.subtotal,
      "Discount (%)": v.discountPercent,
      "Discount (₹)": v.discountAmount,
      "Final Total": v.finalTotal,
      "Payment Method": v.paymentMethod || "online",
      "Cash Amount": Number(v.cashAmount) || 0,
      "Card Amount": Number(v.cardAmount) || 0,
      "Online Amount": Number(v.onlineAmount) || 0,
      "Schema Version": Number(v.schemaVersion) || 1,
      "Assignment Status": v.assignmentStatus || "not_required",
      "Payment Status": v.paymentStatus,
      "Payment ID": v.razorpayPaymentId || "",
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    // Auto-width columns
    if (rows.length > 0) {
      const colWidths = Object.keys(rows[0]).map((key) => ({
        wch: Math.max(key.length, ...rows.map((r) => String(r[key] || "").length)) + 2,
      }));
      ws["!cols"] = colWidths;
    }

    XLSX.utils.book_append_sheet(wb, ws, "Salon Visits");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", "attachment; filename=salon-visits.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Failed to export data" });
  }
});

// Health check for the analytics sub-router
router.get("/health", (_req, res) =>
  res.json({ status: "analytics ok" })
);

module.exports = router;
