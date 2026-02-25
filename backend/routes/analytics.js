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
 * Build a Mongoose `{ date: { $gte, $lte } }` filter from query params.
 * Dates are parsed as local timezone to avoid off-by-one day issues.
 *
 * @param {object} query — Express req.query with optional `from` / `to` (YYYY-MM-DD)
 * @returns {object} Mongoose filter
 */
function dateFilter(query) {
  const filter = {};
  const now = new Date();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  let from;
  if (query.from && dateRe.test(query.from)) {
    const [y, m, d] = query.from.split("-").map(Number);
    from = new Date(y, m - 1, d, 0, 0, 0, 0); // local midnight start-of-day
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  let to;
  if (query.to && dateRe.test(query.to)) {
    const [y, m, d] = query.to.split("-").map(Number);
    to = new Date(y, m - 1, d, 23, 59, 59, 999); // local end-of-day
  } else {
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  }

  filter.date = { $gte: from, $lte: to };
  return filter;
}

/**
 * Calculate hours worked from "HH:mm" time strings.
 * @param {string} startTime — e.g. "09:30"
 * @param {string} endTime   — e.g. "11:00"
 * @returns {number} Duration in decimal hours (never negative)
 */
function calcHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return Math.max(diff / 60, 0);
}

// ────────────────────────────────────────────────────
// 1. GET /api/analytics/summary
//    Returns: totalRevenue, totalVisits, uniqueCustomers, avgTicket
// ────────────────────────────────────────────────────
router.get("/summary", async (req, res) => {
  try {
    const match = dateFilter(req.query);
    const visits = await Visit.find(match);

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
router.get("/top-services", async (req, res) => {
  try {
    const match = dateFilter(req.query);

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

    res.json(result);
  } catch (err) {
    console.error("Top services error:", err);
    res.status(500).json({ error: "Failed to fetch top services" });
  }
});

// ────────────────────────────────────────────────────
// 3. GET /api/analytics/employees
//    Returns: leaderboard — rank, name, customers, revenue, hours
// ────────────────────────────────────────────────────
router.get("/employees", async (req, res) => {
  try {
    const match = dateFilter(req.query);
    const visits = await Visit.find(match);

    // Group by artist
    const map = {};
    visits.forEach((v) => {
      const key = v.artist;
      if (!map[key]) {
        map[key] = { name: key, customers: 0, revenue: 0, totalHours: 0, contacts: new Set() };
      }
      map[key].customers += 1;
      map[key].revenue += v.finalTotal || 0;
      map[key].totalHours += calcHours(v.startTime, v.endTime);
      map[key].contacts.add(v.contact);
    });

    const leaderboard = Object.values(map)
      .map((e) => ({
        name: e.name,
        customersServed: e.customers,
        uniqueCustomers: e.contacts.size,
        revenue: Math.round(e.revenue),
        hoursWorked: Math.round(e.totalHours * 10) / 10,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .map((e, i) => ({ rank: i + 1, ...e }));

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
router.get("/employee/:name", async (req, res) => {
  try {
    const match = dateFilter(req.query);
    const artistName = req.params.name;

    // All visits in range
    const allVisits = await Visit.find(match);
    // This artist's visits
    const artistVisits = allVisits.filter((v) => v.artist === artistName);

    if (artistVisits.length === 0) {
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

    // Artist stats
    const revenue = artistVisits.reduce((s, v) => s + (v.finalTotal || 0), 0);
    const totalHours = artistVisits.reduce((s, v) => s + calcHours(v.startTime, v.endTime), 0);
    const uniqueCustomers = new Set(artistVisits.map((v) => v.contact)).size;

    // Top services for this artist
    const svcMap = {};
    artistVisits.forEach((v) => {
      v.services.forEach((s) => {
        if (!svcMap[s.name]) svcMap[s.name] = { count: 0, revenue: 0 };
        svcMap[s.name].count += 1;
        svcMap[s.name].revenue += s.price;
      });
    });
    const topServices = Object.entries(svcMap)
      .map(([name, d]) => ({ service: name, count: d.count, revenue: d.revenue }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Rank vs peers (by revenue)
    const peerMap = {};
    allVisits.forEach((v) => {
      if (!peerMap[v.artist]) peerMap[v.artist] = 0;
      peerMap[v.artist] += v.finalTotal || 0;
    });
    const sorted = Object.entries(peerMap).sort((a, b) => b[1] - a[1]);
    const rank = sorted.findIndex(([name]) => name === artistName) + 1;
    const totalArtists = sorted.length;

    res.json({
      name: artistName,
      customersServed: artistVisits.length,
      uniqueCustomers,
      revenue: Math.round(revenue),
      hoursWorked: Math.round(totalHours * 10) / 10,
      avgRevenuePerVisit: Math.round(revenue / artistVisits.length),
      topServices,
      rank,
      totalArtists,
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
router.get("/repeat-customers", async (req, res) => {
  try {
    const match = dateFilter(req.query);

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
router.get("/export", async (req, res) => {
  try {
    const match = dateFilter(req.query);
    const visits = await Visit.find(match).sort({ date: -1 }).lean();

    // Flatten for Excel
    const rows = visits.map((v) => ({
      Date: v.date ? new Date(v.date).toLocaleDateString("en-IN") : "",
      Name: v.name,
      Contact: v.contact,
      Age: v.age,
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
      "Online Amount": Number(v.onlineAmount) || 0,
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
