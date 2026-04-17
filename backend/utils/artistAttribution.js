/**
 * @file artistAttribution.js
 * @description Shared helpers for artist-level attribution across analytics routes.
 *
 * This module keeps legacy (schemaVersion 1) and V2 (per-service assignment)
 * semantics aligned so central analytics and artist dashboards compute from the
 * same normalized row model.
 */

function buildDateRangeFilter(query) {
  const filter = {};
  const now = new Date();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  let from;
  if (query?.from && dateRe.test(query.from)) {
    const [y, m, d] = query.from.split("-").map(Number);
    from = new Date(y, m - 1, d, 0, 0, 0, 0);
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  let to;
  if (query?.to && dateRe.test(query.to)) {
    const [y, m, d] = query.to.split("-").map(Number);
    to = new Date(y, m - 1, d, 23, 59, 59, 999);
  } else {
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  }

  filter.date = { $gte: from, $lte: to };
  return filter;
}

function buildFinalizedVisitFilter(query) {
  const filter = buildDateRangeFilter(query);
  const schema = String(query?.schema || "all").toLowerCase();

  if (schema === "legacy") filter.schemaVersion = 1;
  if (schema === "v2") filter.schemaVersion = 2;

  filter.paymentStatus = "success";
  filter.$or = [
    { assignmentStatus: { $exists: false } },
    { assignmentStatus: "not_required" },
    { assignmentStatus: "completed" },
  ];

  return filter;
}

function buildArtistScopedVisitFilter(query, artistName) {
  const normalizedName = String(artistName || "").trim();
  const baseFilter = buildFinalizedVisitFilter(query);
  const assignmentStatusClause = Array.isArray(baseFilter.$or) ? baseFilter.$or : [];
  delete baseFilter.$or;

  const match = {
    ...baseFilter,
    $and: [
      { $or: assignmentStatusClause },
      {
        $or: [
          { artist: normalizedName },
          { "services.artistName": normalizedName },
        ],
      },
    ],
  };

  return {
    match,
    from: baseFilter.date.$gte,
    to: baseFilter.date.$lte,
  };
}

function calcHours(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = String(startTime).split(":").map(Number);
  const [eh, em] = String(endTime).split(":").map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return Math.max(diff / 60, 0);
}

function toMins(timeText) {
  if (!timeText || !/^\d{2}:\d{2}$/.test(String(timeText))) return null;
  const [h, m] = String(timeText).split(":").map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return (h * 60) + m;
}

function allocateServiceRevenues(services, subtotal, finalTotal) {
  const serviceList = Array.isArray(services) ? services : [];
  if (serviceList.length === 0) return [];

  const total = Math.max(0, Math.round(Number(finalTotal) || 0));
  if (total === 0) return serviceList.map(() => 0);

  const sub = Number(subtotal) || serviceList.reduce((sum, s) => sum + Math.max(0, Number(s?.price) || 0), 0);

  // If subtotal is unusable, evenly spread total to preserve exact sum.
  if (sub <= 0) {
    const evenBase = Math.floor(total / serviceList.length);
    let remainder = total - (evenBase * serviceList.length);
    return serviceList.map((_s, index) => {
      if (remainder > 0) {
        remainder -= 1;
        return evenBase + 1;
      }
      return evenBase;
    });
  }

  const weighted = serviceList.map((service, index) => {
    const price = Math.max(0, Number(service?.price) || 0);
    const raw = (price / sub) * total;
    const base = Math.floor(raw);
    return {
      index,
      base,
      fraction: raw - base,
    };
  });

  let used = weighted.reduce((sum, item) => sum + item.base, 0);
  let remainder = Math.max(0, total - used);

  weighted.sort((a, b) => {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    return a.index - b.index;
  });

  let cursor = 0;
  while (remainder > 0 && weighted.length > 0) {
    weighted[cursor % weighted.length].base += 1;
    remainder -= 1;
    cursor += 1;
  }

  const allocations = new Array(serviceList.length).fill(0);
  weighted.forEach((item) => {
    allocations[item.index] = item.base;
  });

  used = allocations.reduce((sum, amount) => sum + amount, 0);
  if (used !== total && allocations.length > 0) {
    allocations[allocations.length - 1] += (total - used);
  }

  return allocations;
}

function buildArtistRows(visits) {
  const rows = [];

  for (const visit of visits || []) {
    const visitId = String(visit._id || "");
    const visitDate = visit.date ? new Date(visit.date) : null;
    const services = Array.isArray(visit.services) ? visit.services : [];
    const subtotal = Number(visit.subtotal) || services.reduce((sum, s) => sum + (Number(s?.price) || 0), 0);
    const finalTotal = Math.max(0, Math.round(Number(visit.finalTotal) || 0));
    const allocatedRevenues = allocateServiceRevenues(services, subtotal, finalTotal);

    if (visit.schemaVersion === 2) {
      for (let index = 0; index < services.length; index += 1) {
        const service = services[index];
        const artistName = String(service.artistName || "").trim();
        if (!artistName) continue;

        const startMins = toMins(service.startTime);
        const endMins = toMins(service.endTime);
        const timedDiff = startMins !== null && endMins !== null && endMins > startMins
          ? endMins - startMins
          : null;

        const actualMins = Number.isFinite(Number(service.actualDurationMins)) && Number(service.actualDurationMins) > 0
          ? Number(service.actualDurationMins)
          : (timedDiff || 0);

        const expectedMins = Number.isFinite(Number(service.duration)) && Number(service.duration) > 0
          ? Number(service.duration)
          : null;

        const servicePrice = Number(service.price) || 0;
  const netRevenue = allocatedRevenues[index] ?? 0;

        rows.push({
          visitId,
          visitDate,
          artist: artistName,
          contact: visit.contact || "",
          revenue: netRevenue,
          actualMins,
          expectedMins,
          services: [
            {
              name: service.name || "",
              price: servicePrice,
              revenue: netRevenue,
            },
          ],
        });
      }
      continue;
    }

    const legacyArtist = String(visit.artist || "").trim();
    if (!legacyArtist) continue;

    const actualMins = Number.isFinite(Number(visit.visitDurationMins)) && Number(visit.visitDurationMins) > 0
      ? Number(visit.visitDurationMins)
      : Math.round(calcHours(visit.startTime, visit.endTime) * 60);

    const allHaveDuration = services.length > 0 && services.every((s) => s.duration !== null && s.duration !== undefined);
    const expectedMins = allHaveDuration
      ? services.reduce((sum, s) => sum + (Number(s.duration) || 0), 0)
      : null;

    rows.push({
      visitId,
      visitDate,
      artist: legacyArtist,
      contact: visit.contact || "",
      revenue: finalTotal,
      actualMins,
      expectedMins,
      services: services.map((service, index) => {
        const servicePrice = Number(service.price) || 0;
        return {
          name: service.name || "",
          price: servicePrice,
          revenue: allocatedRevenues[index] ?? 0,
        };
      }),
    });
  }

  return rows;
}

function filterRowsForArtistName(rows, artistName) {
  const key = String(artistName || "").trim().toLowerCase();
  if (!key) return [];
  return (rows || []).filter((row) => String(row.artist || "").trim().toLowerCase() === key);
}

function buildServiceBreakdown(rows) {
  const map = {};

  (rows || []).forEach((row) => {
    const services = Array.isArray(row.services) ? row.services : [];
    services.forEach((service) => {
      const name = String(service.name || "").trim() || "Unnamed Service";
      if (!map[name]) {
        map[name] = { service: name, count: 0, revenue: 0 };
      }
      map[name].count += 1;
      map[name].revenue += Number(service.revenue ?? service.price) || 0;
    });
  });

  return Object.values(map)
    .map((entry) => ({ ...entry, revenue: Math.round(entry.revenue) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.revenue - a.revenue;
    });
}

function buildArtistDashboardSummary(rows, commissionPct = 0) {
  const visitIds = new Set();
  const contacts = new Set();
  let totalRevenue = 0;
  let totalMins = 0;
  let totalServices = 0;

  (rows || []).forEach((row) => {
    if (row.visitId) visitIds.add(row.visitId);
    if (row.contact) contacts.add(row.contact);

    totalRevenue += Number(row.revenue) || 0;
    totalMins += Math.max(Number(row.actualMins) || 0, 0);

    const services = Array.isArray(row.services) ? row.services : [];
    totalServices += services.length;
  });

  const revenue = Math.round(totalRevenue);
  const totalVisits = visitIds.size;
  const hoursWorked = Math.round((totalMins / 60) * 10) / 10;
  const commissionEarned = Math.round(revenue * (Number(commissionPct) || 0)) / 100;
  const avgTicket = totalVisits > 0 ? Math.round((revenue / totalVisits) * 100) / 100 : 0;

  return {
    totalRevenue: revenue,
    commissionPct: Number(commissionPct) || 0,
    commissionEarned,
    totalVisits,
    uniqueCustomers: contacts.size,
    totalServices,
    hoursWorked,
    avgTicket,
  };
}

function toLocalDateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDailyTrend(rows, commissionPct = 0) {
  const byDate = {};
  const pct = Number(commissionPct) || 0;

  (rows || []).forEach((row) => {
    const dateKey = toLocalDateKey(row.visitDate);
    if (!dateKey) return;

    if (!byDate[dateKey]) {
      byDate[dateKey] = {
        date: dateKey,
        revenue: 0,
        visitIds: new Set(),
      };
    }

    byDate[dateKey].revenue += Number(row.revenue) || 0;
    if (row.visitId) byDate[dateKey].visitIds.add(row.visitId);
  });

  return Object.values(byDate)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((entry) => {
      const revenue = Math.round(entry.revenue);
      return {
        date: entry.date,
        revenue,
        commission: Math.round(revenue * pct) / 100,
        visits: entry.visitIds.size,
      };
    });
}

function buildTimePerformanceFromRows(rows) {
  const byVisit = new Map();

  (rows || []).forEach((row) => {
    const key = String(row.visitId || "").trim();
    if (!key) return;

    if (!byVisit.has(key)) {
      byVisit.set(key, {
        date: row.visitDate || null,
        actualMins: 0,
        expectedMins: 0,
        hasExpectedGap: false,
        hasTimedData: false,
      });
    }

    const entry = byVisit.get(key);
    if (!entry.date && row.visitDate) entry.date = row.visitDate;

    const actual = Math.max(Number(row.actualMins) || 0, 0);
    entry.actualMins += actual;
    if (actual > 0) entry.hasTimedData = true;

    const expected = Number(row.expectedMins);
    if (!Number.isFinite(expected) || expected <= 0) {
      entry.hasExpectedGap = true;
    } else {
      entry.expectedMins += expected;
    }
  });

  let totalExtraMins = 0;
  let schedulableVisits = 0;
  let nonSchedulableVisits = 0;
  const perVisit = [];

  byVisit.forEach((entry) => {
    const actualMins = Math.round(entry.actualMins);
    const expectedMins = Math.round(entry.expectedMins);

    if (!entry.hasTimedData || entry.hasExpectedGap) {
      nonSchedulableVisits += 1;
      return;
    }

    schedulableVisits += 1;

    const diff = actualMins - expectedMins;
    let extraMins = 0;
    if (diff > 10) extraMins = diff - 10;
    else if (diff < -10) extraMins = diff + 10;

    totalExtraMins += extraMins;

    perVisit.push({
      date: entry.date,
      actualMins,
      expectedMins,
      extraMins: Math.round(extraMins),
    });
  });

  perVisit.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());

  return {
    schedulableVisits,
    nonSchedulableVisits,
    totalExtraMins: Math.round(totalExtraMins),
    perVisit,
  };
}

module.exports = {
  buildDateRangeFilter,
  buildFinalizedVisitFilter,
  buildArtistScopedVisitFilter,
  buildArtistRows,
  filterRowsForArtistName,
  buildServiceBreakdown,
  buildArtistDashboardSummary,
  buildDailyTrend,
  buildTimePerformanceFromRows,
};
