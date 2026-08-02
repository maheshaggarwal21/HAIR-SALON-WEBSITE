/**
 * @file routes/dataPipeline.js
 * @description Backend for the Data Pipeline tab.
 *
 * A single filtered dataset drives the summary cards, all four charts, the
 * visit table and both exports — so what you see on screen and what lands in
 * the Excel/PDF file can never disagree.
 *
 * Endpoints
 *   GET /            → summary + charts + paginated table for the current filters
 *   GET /options     → artist and customer pick-lists (deduplicated)
 *   GET /export      → the full filtered row set, unpaginated, for Excel/PDF
 *
 * This route is additive. It does not touch the Payments or Analytics routes.
 */

const express = require("express");
const connectDB = require("../db");
const Visit = require("../models/Visit");
const Artist = require("../models/Artist");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const { derivePaymentLines, describePaymentLines, buildMethodMatch } = require("../utils/paymentLines");
const { allocateServiceRevenues } = require("../utils/artistAttribution");

const router = express.Router();

/**
 * Visit-level `artist` is set to this literal when a V2 visit spans several
 * artists. It is a marker, not a person — 391 visits carrying 26% of revenue.
 * Artist figures are always computed per-service so this never becomes a bar.
 */
const MULTI_ARTIST_MARKER = "Multiple Artists";

/** Hard ceiling on rows scanned per request — a full year is ~4k. */
const MAX_SCAN = 20000;

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Local-timezone YYYY-MM-DD key (avoids UTC shifting a visit into the wrong day). */
function toDateKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Monday-anchored week key, used when a range is too wide to bucket daily. */
function toWeekKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return toDateKey(d);
}

function toMonthKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Gender buckets exposed by the filter. `other` and `prefer_not` both surface
 * as "Not specified" — historical rows are never backfilled.
 */
function genderBucket(gender) {
  const g = String(gender || "").toLowerCase();
  if (g === "male") return "male";
  if (g === "female") return "female";
  return "not_specified";
}

function buildGenderMatch(gender) {
  const key = String(gender || "").toLowerCase();
  if (key === "male") return { gender: "male" };
  if (key === "female") return { gender: "female" };
  if (key === "not_specified") {
    return { $or: [{ gender: { $nin: ["male", "female"] } }, { gender: { $exists: false } }] };
  }
  return null;
}

/**
 * Translate query params into a Mongo filter for finalised visits.
 *
 * All filters combine with AND. Clauses that each need their own `$or` are
 * collected into `$and` so they cannot clobber one another — the bug pattern
 * the Payments route works around by hand.
 */
function buildFilter(query) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const now = new Date();

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

  if (from > to) [from, to] = [to, from];

  const and = [
    // Only finalised visits: paid, and either legacy or with assignment done.
    {
      $or: [
        { assignmentStatus: { $exists: false } },
        { assignmentStatus: "not_required" },
        { assignmentStatus: "completed" },
      ],
    },
  ];

  const filter = {
    date: { $gte: from, $lte: to },
    paymentStatus: "success",
  };

  if (query.customer) {
    const customer = String(query.customer).trim().slice(0, 80);
    if (customer) filter.name = { $regex: escapeRegex(customer), $options: "i" };
  }

  if (query.artist) {
    const artist = String(query.artist).trim().slice(0, 80);
    if (artist) {
      // Match the per-service assignment (V2) or the visit-level name (legacy).
      const rx = { $regex: `^${escapeRegex(artist)}$`, $options: "i" };
      and.push({ $or: [{ artist: rx }, { "services.artistName": rx }] });
    }
  }

  const genderMatch = buildGenderMatch(query.gender);
  if (genderMatch) and.push(genderMatch);

  const methodMatch = buildMethodMatch(query.method);
  if (methodMatch) and.push(methodMatch);

  filter.$and = and;
  return { filter, from, to };
}

/**
 * Flatten a visit into the row shape the table, charts and exports all read.
 * Artist revenue is apportioned per service so a multi-artist visit credits
 * each artist with their own share of the DISCOUNTED total.
 */
function buildRow(visit, artistFilter) {
  const services = Array.isArray(visit.services) ? visit.services : [];
  const lines = derivePaymentLines(visit);
  const allocations = allocateServiceRevenues(services, visit.subtotal, visit.finalTotal);

  const perArtist = new Map();
  services.forEach((service, index) => {
    const name = String(service.artistName || "").trim() || String(visit.artist || "").trim();
    if (!name || name === MULTI_ARTIST_MARKER) return;
    const prev = perArtist.get(name) || { revenue: 0, services: 0, serviceNames: [] };
    prev.revenue += allocations[index] ?? 0;
    prev.services += 1;
    // Kept so the artist rollup can report which services each artist performed.
    prev.serviceNames.push({ name: service.name, revenue: allocations[index] ?? 0 });
    perArtist.set(name, prev);
  });

  // Legacy rows have no per-service artist — credit the visit-level name.
  if (perArtist.size === 0) {
    const legacy = String(visit.artist || "").trim();
    if (legacy && legacy !== MULTI_ARTIST_MARKER) {
      perArtist.set(legacy, {
        revenue: Math.round(Number(visit.finalTotal) || 0),
        services: services.length,
        serviceNames: services.map((s, i) => ({ name: s.name, revenue: allocations[i] ?? 0 })),
      });
    }
  }

  const artistNames = [...perArtist.keys()];

  return {
    id: String(visit._id),
    date: visit.date,
    name: visit.name,
    contact: visit.contact,
    gender: genderBucket(visit.gender),
    artists: artistNames,
    artistLabel: artistNames.length > 0 ? artistNames.join(", ") : String(visit.artist || "—"),
    perArtist: [...perArtist.entries()].map(([artist, v]) => ({ artist, ...v })),
    services: services.map((s) => ({ name: s.name, price: Number(s.price) || 0 })),
    serviceLabel: services.map((s) => s.name).join(", "),
    subtotal: Number(visit.subtotal) || 0,
    discountPercent: Number(visit.discountPercent) || 0,
    discountAmount: Number(visit.discountAmount) || 0,
    finalTotal: Number(visit.finalTotal) || 0,
    paymentLines: lines,
    isSplit: lines.length > 1,
    methodLabel: describePaymentLines(lines),
    filledBy: visit.filledBy || "",
    startTime: visit.startTime || null,
    endTime: visit.endTime || null,
    // When filtering by one artist, show what THAT artist earned on this visit.
    filteredArtistRevenue: artistFilter
      ? (perArtist.get(
          artistNames.find((n) => n.toLowerCase() === String(artistFilter).trim().toLowerCase())
        )?.revenue ?? null)
      : null,
  };
}

/**
 * Commission rate per artist, keyed by lower-cased name.
 *
 * Keyed by name rather than id because ~10% of visits are legacy rows that only
 * ever stored the artist's name. A name with no Artist record (e.g. "Dilpreet")
 * is simply absent, and reports a null rate rather than a misleading ₹0.
 */
async function loadCommissionRates() {
  const artists = await Artist.find({}, { name: 1, commission: 1 }).lean();
  const map = new Map();
  for (const a of artists) {
    const key = String(a.name || "").trim().toLowerCase();
    if (key) map.set(key, Number(a.commission) || 0);
  }
  return map;
}

/** Fetch and normalise every visit matching the filters. */
async function loadRows(query) {
  const { filter, from, to } = buildFilter(query);

  const visits = await Visit.find(filter)
    .sort({ date: -1, createdAt: -1 })
    .limit(MAX_SCAN)
    .select(
      "name contact gender artist services subtotal discountPercent discountAmount finalTotal " +
        "paymentMethod cashAmount cardAmount onlineAmount filledBy date startTime endTime createdAt schemaVersion"
    )
    .lean();

  const artistFilter = query.artist ? String(query.artist).trim() : "";
  return { rows: visits.map((v) => buildRow(v, artistFilter)), from, to, truncated: visits.length >= MAX_SCAN };
}

/**
 * Summary cards, including a per-method breakdown summed from line items.
 *
 * When an artist filter is active, `attributedRevenue` is also returned: the
 * share of revenue that artist personally earned, as opposed to `totalRevenue`,
 * which is the full value of every visit they took part in. On a visit handled
 * by two artists the two figures legitimately differ, so both are surfaced
 * rather than leaving the larger number to be misread as that artist's earnings.
 */
function buildSummary(rows, artistFilter = "") {
  const byMethod = { cash: 0, card: 0, online: 0 };
  const customers = new Set();
  let revenue = 0;
  let discount = 0;
  let splitVisits = 0;
  let splitRevenue = 0;
  let attributed = 0;
  let hasAttribution = false;

  for (const row of rows) {
    revenue += row.finalTotal;
    discount += row.discountAmount;
    if (row.contact) customers.add(row.contact);
    if (artistFilter && row.filteredArtistRevenue !== null) {
      attributed += row.filteredArtistRevenue;
      hasAttribution = true;
    }
    // Sum the individual LINE amounts, so a split contributes to each method
    // it actually used rather than being tagged wholesale.
    for (const line of row.paymentLines) {
      byMethod[line.method] = (byMethod[line.method] || 0) + line.amount;
    }
    if (row.isSplit) {
      splitVisits += 1;
      splitRevenue += row.finalTotal;
    }
  }

  const visits = rows.length;
  return {
    totalRevenue: Math.round(revenue),
    totalVisits: visits,
    uniqueCustomers: customers.size,
    avgTicket: visits > 0 ? Math.round(revenue / visits) : 0,
    totalDiscount: Math.round(discount),
    cash: Math.round(byMethod.cash),
    card: Math.round(byMethod.card),
    online: Math.round(byMethod.online),
    splitVisits,
    splitRevenue: Math.round(splitRevenue),
    attributedRevenue: hasAttribution ? Math.round(attributed) : null,
    attributedTo: hasAttribution ? artistFilter : null,
  };
}

/**
 * Revenue over time. Buckets by day for ranges ≤ 31 days, by week up to ~6
 * months, by month beyond that — so a wide range stays readable.
 */
function buildRevenueSeries(rows, from, to) {
  const spanDays = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const granularity = spanDays <= 31 ? "day" : spanDays <= 190 ? "week" : "month";
  const keyOf = granularity === "day" ? toDateKey : granularity === "week" ? toWeekKey : toMonthKey;

  const buckets = new Map();
  for (const row of rows) {
    const key = keyOf(row.date);
    if (!key) continue;
    const entry = buckets.get(key) || { period: key, revenue: 0, visits: 0 };
    entry.revenue += row.finalTotal;
    entry.visits += 1;
    buckets.set(key, entry);
  }

  return {
    granularity,
    series: [...buckets.values()]
      .map((b) => ({ ...b, revenue: Math.round(b.revenue) }))
      .sort((a, b) => a.period.localeCompare(b.period)),
  };
}

/** Donut data: rupees collected per method, plus split visit count. */
function buildMethodMix(rows) {
  const totals = { cash: 0, card: 0, online: 0 };
  for (const row of rows) {
    for (const line of row.paymentLines) {
      totals[line.method] = (totals[line.method] || 0) + line.amount;
    }
  }
  return Object.entries(totals)
    .map(([method, amount]) => ({ method, amount: Math.round(amount) }))
    .filter((d) => d.amount > 0);
}

/** Top-N service names by count, as a compact "Beard Trim ×12, Haircut ×4" label. */
function topServiceLabel(counts, limit = 4) {
  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  const head = sorted.slice(0, limit).map(([name, v]) => `${name} ×${v.count}`);
  const rest = sorted.length - head.length;
  return head.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

/**
 * Bar data + artist rollup: revenue, visits, services and commission owed.
 *
 * `commissionEarned` is what the artist is due — their attributed revenue times
 * their commission rate from the Artist record. Artists on 0% (and legacy names
 * with no Artist record at all) report 0 with a null rate, so a blank column
 * reads as "no rate configured" rather than "earned nothing".
 */
function buildArtistPerformance(rows, commissionByName = new Map()) {
  const byArtist = new Map();
  for (const row of rows) {
    for (const entry of row.perArtist) {
      const acc = byArtist.get(entry.artist) || {
        artist: entry.artist,
        revenue: 0,
        visitIds: new Set(),
        services: 0,
        customers: new Set(),
        serviceCounts: new Map(),
      };
      acc.revenue += entry.revenue;
      acc.services += entry.services;
      acc.visitIds.add(row.id);
      if (row.contact) acc.customers.add(row.contact);
      for (const svc of entry.serviceNames || []) {
        const key = svc.name || "Unnamed";
        const prev = acc.serviceCounts.get(key) || { count: 0, revenue: 0 };
        prev.count += 1;
        prev.revenue += svc.revenue || 0;
        acc.serviceCounts.set(key, prev);
      }
      byArtist.set(entry.artist, acc);
    }
  }

  return [...byArtist.values()]
    .map((a) => {
      const revenue = Math.round(a.revenue);
      const pct = commissionByName.has(a.artist.toLowerCase())
        ? Number(commissionByName.get(a.artist.toLowerCase()))
        : null;
      return {
        artist: a.artist,
        revenue,
        visits: a.visitIds.size,
        services: a.services,
        uniqueCustomers: a.customers.size,
        avgPerVisit: a.visitIds.size > 0 ? Math.round(revenue / a.visitIds.size) : 0,
        commissionPct: pct,
        commissionEarned: pct != null ? Math.round((revenue * pct) / 100) : null,
        topServices: topServiceLabel(a.serviceCounts),
        serviceBreakdown: [...a.serviceCounts.entries()]
          .map(([name, v]) => ({ name, count: v.count, revenue: Math.round(v.revenue) }))
          .sort((x, y) => y.revenue - x.revenue),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * Per-customer rollup: what each client has spent across the filtered range,
 * and which services they took. One row per contact — never repeated.
 */
function buildCustomerSummary(rows) {
  const byContact = new Map();

  for (const row of rows) {
    const key = row.contact || row.name;
    if (!key) continue;
    const acc = byContact.get(key) || {
      contact: row.contact,
      name: row.name,
      gender: row.gender,
      visits: 0,
      totalSpent: 0,
      totalDiscount: 0,
      firstVisit: row.date,
      lastVisit: row.date,
      serviceCounts: new Map(),
      artists: new Set(),
      methods: new Set(),
    };

    acc.visits += 1;
    acc.totalSpent += row.finalTotal;
    acc.totalDiscount += row.discountAmount;
    if (new Date(row.date) > new Date(acc.lastVisit)) {
      acc.lastVisit = row.date;
      acc.name = row.name;      // most recent spelling of the name
      acc.gender = row.gender;  // gender is per-visit; take the latest
    }
    if (new Date(row.date) < new Date(acc.firstVisit)) acc.firstVisit = row.date;
    for (const svc of row.services) {
      const prev = acc.serviceCounts.get(svc.name) || { count: 0 };
      prev.count += 1;
      acc.serviceCounts.set(svc.name, prev);
    }
    row.artists.forEach((a) => acc.artists.add(a));
    row.paymentLines.forEach((l) => acc.methods.add(l.method));
    byContact.set(key, acc);
  }

  return [...byContact.values()]
    .map((c) => ({
      id: c.contact || c.name,
      contact: c.contact,
      name: c.name,
      gender: c.gender,
      visits: c.visits,
      totalSpent: Math.round(c.totalSpent),
      totalDiscount: Math.round(c.totalDiscount),
      avgTicket: c.visits > 0 ? Math.round(c.totalSpent / c.visits) : 0,
      firstVisit: c.firstVisit,
      lastVisit: c.lastVisit,
      serviceCount: [...c.serviceCounts.values()].reduce((s, v) => s + v.count, 0),
      topServices: topServiceLabel(c.serviceCounts),
      serviceBreakdown: [...c.serviceCounts.entries()]
        .map(([name, v]) => ({ name, count: v.count }))
        .sort((x, y) => y.count - x.count),
      artists: [...c.artists],
      artistLabel: [...c.artists].join(", ") || "—",
      methods: [...c.methods],
      methodLabel: [...c.methods].map((m) => m[0].toUpperCase() + m.slice(1)).join(", ") || "—",
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent);
}

/**
 * Per-service rollup: how often each service sold and what it brought in.
 * Revenue is the discount-apportioned share, so the column sums to total revenue.
 */
function buildServiceSummary(rows) {
  const byService = new Map();

  for (const row of rows) {
    // Re-apportion this visit's discounted total across its service lines.
    const prices = row.services.map((s) => s.price);
    const sub = prices.reduce((a, b) => a + b, 0);
    row.services.forEach((svc, i) => {
      const key = svc.name || "Unnamed";
      const share = sub > 0 ? (prices[i] / sub) * row.finalTotal : row.finalTotal / (row.services.length || 1);
      const acc = byService.get(key) || {
        service: key,
        count: 0,
        revenue: 0,
        customers: new Set(),
        artists: new Set(),
        listPrice: 0,
      };
      acc.count += 1;
      acc.revenue += share;
      acc.listPrice += svc.price;
      if (row.contact) acc.customers.add(row.contact);
      row.artists.forEach((a) => acc.artists.add(a));
      byService.set(key, acc);
    });
  }

  return [...byService.values()]
    .map((s) => ({
      service: s.service,
      count: s.count,
      revenue: Math.round(s.revenue),
      listRevenue: Math.round(s.listPrice),
      avgPrice: s.count > 0 ? Math.round(s.listPrice / s.count) : 0,
      uniqueCustomers: s.customers.size,
      artistCount: s.artists.size,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/** Donut data: gender split, counted by unique customer and by visit. */
function buildGenderSplit(rows) {
  const byVisit = { male: 0, female: 0, not_specified: 0 };
  const latestByContact = new Map();

  // rows arrive newest-first, so the first sighting of a contact is their latest.
  for (const row of rows) {
    byVisit[row.gender] = (byVisit[row.gender] || 0) + 1;
    if (row.contact && !latestByContact.has(row.contact)) {
      latestByContact.set(row.contact, row.gender);
    }
  }

  const byCustomer = { male: 0, female: 0, not_specified: 0 };
  for (const gender of latestByContact.values()) {
    byCustomer[gender] = (byCustomer[gender] || 0) + 1;
  }

  const total = rows.length;
  const specified = byVisit.male + byVisit.female;
  return {
    byVisit: Object.entries(byVisit).map(([gender, count]) => ({ gender, count })),
    byCustomer: Object.entries(byCustomer).map(([gender, count]) => ({ gender, count })),
    fillRate: total > 0 ? Math.round((specified / total) * 1000) / 10 : 0,
  };
}

// ─── GET / — everything the tab needs for the current filters ────────────────
router.get("/", authorizePermission(PERMISSIONS.DATAPIPELINE_VIEW), async (req, res) => {
  try {
    await connectDB();

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const groupBy = ["visit", "customer", "artist", "service"].includes(
      String(req.query.groupBy || "").toLowerCase()
    )
      ? String(req.query.groupBy).toLowerCase()
      : "visit";

    const [{ rows, from, to, truncated }, commissionByName] = await Promise.all([
      loadRows(req.query),
      loadCommissionRates(),
    ]);

    const artistFilter = req.query.artist ? String(req.query.artist).trim() : "";
    const summary = buildSummary(rows, artistFilter);
    const revenueSeries = buildRevenueSeries(rows, from, to);
    const methodMix = buildMethodMix(rows);
    const artistPerformance = buildArtistPerformance(rows, commissionByName);
    const genderSplit = buildGenderSplit(rows);
    const customerSummary = buildCustomerSummary(rows);
    const serviceSummary = buildServiceSummary(rows);

    // The table pivots between raw visits and three rollups, all derived from
    // the same filtered row set so every view reconciles to the same totals.
    const tableRows =
      groupBy === "customer"
        ? customerSummary
        : groupBy === "artist"
          ? artistPerformance
          : groupBy === "service"
            ? serviceSummary
            : rows;

    const total = tableRows.length;
    const start = (page - 1) * limit;

    return res.json({
      summary,
      revenueSeries,
      methodMix,
      artistPerformance,
      genderSplit,
      customerSummary,
      serviceSummary,
      totals: {
        customers: customerSummary.length,
        artists: artistPerformance.length,
        services: serviceSummary.length,
        visits: rows.length,
        commissionOwed: artistPerformance.reduce((s, a) => s + (a.commissionEarned || 0), 0),
      },
      rows: tableRows.slice(start, start + limit),
      groupBy,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      range: { from: toDateKey(from), to: toDateKey(to) },
      truncated,
    });
  } catch (err) {
    console.error("[dataPipeline] Query error:", err);
    return res.status(500).json({ error: "Failed to load data pipeline" });
  }
});

// ─── GET /options — pick-lists for the filter bar ────────────────────────────
router.get("/options", authorizePermission(PERMISSIONS.DATAPIPELINE_VIEW), async (req, res) => {
  try {
    await connectDB();

    // Artist names are sourced from the visits themselves, not the Artist
    // collection, so legacy free-text names still appear and stay filterable.
    const [visitArtists, serviceArtists] = await Promise.all([
      Visit.distinct("artist", { paymentStatus: "success" }),
      Visit.distinct("services.artistName", { paymentStatus: "success" }),
    ]);

    const artists = [...new Set([...visitArtists, ...serviceArtists])]
      .map((a) => String(a || "").trim())
      .filter((a) => a && a !== MULTI_ARTIST_MARKER)
      .sort((a, b) => a.localeCompare(b));

    // One entry per customer — deduplicated on contact, newest name wins.
    const customerAgg = await Visit.aggregate([
      { $match: { paymentStatus: "success" } },
      { $sort: { date: -1, createdAt: -1 } },
      {
        $group: {
          _id: "$contact",
          name: { $first: "$name" },
          visits: { $sum: 1 },
          lastVisit: { $first: "$date" },
        },
      },
      { $sort: { visits: -1 } },
      { $limit: 5000 },
    ]);

    const customers = customerAgg.map((c) => ({
      contact: c._id,
      name: c.name,
      visits: c.visits,
      lastVisit: c.lastVisit,
    }));

    return res.json({ artists, customers });
  } catch (err) {
    console.error("[dataPipeline] Options error:", err);
    return res.status(500).json({ error: "Failed to load filter options" });
  }
});

// ─── GET /export — full filtered set, unpaginated ────────────────────────────
router.get("/export", authorizePermission(PERMISSIONS.DATAPIPELINE_VIEW), async (req, res) => {
  try {
    await connectDB();
    const [{ rows, from, to, truncated }, commissionByName] = await Promise.all([
      loadRows(req.query),
      loadCommissionRates(),
    ]);

    const artistPerformance = buildArtistPerformance(rows, commissionByName);
    const customerSummary = buildCustomerSummary(rows);
    const serviceSummary = buildServiceSummary(rows);

    return res.json({
      summary: buildSummary(rows, req.query.artist ? String(req.query.artist).trim() : ""),
      artistPerformance,
      customerSummary,
      serviceSummary,
      methodMix: buildMethodMix(rows),
      genderSplit: buildGenderSplit(rows),
      revenueSeries: buildRevenueSeries(rows, from, to),
      totals: {
        customers: customerSummary.length,
        artists: artistPerformance.length,
        services: serviceSummary.length,
        visits: rows.length,
        commissionOwed: artistPerformance.reduce((s, a) => s + (a.commissionEarned || 0), 0),
      },
      rows,
      range: { from: toDateKey(from), to: toDateKey(to) },
      truncated,
    });
  } catch (err) {
    console.error("[dataPipeline] Export error:", err);
    return res.status(500).json({ error: "Failed to build export" });
  }
});

module.exports = router;
