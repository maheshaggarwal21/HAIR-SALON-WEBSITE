/**
 * @file migrations/m2-durations.js
 * @description M2 (T0.5) — seed `Service.durationMinutes`.
 *
 *   npm run migrate:m2              # dry run (default)
 *   npm run migrate:m2 -- --apply
 *
 * Rule (owner decision, 13 Oct 2026 — CF §20): every service is assumed to take
 * AT LEAST one hour until the owner enters real times. Where visits give a
 * trustworthy measurement (median of ≥ 5 `Visit.services[].actualDurationMins`,
 * rounded up to 5 min) and it is longer than an hour, the measurement is used
 * instead. The report says which rule produced each number ("default", "floor",
 * "visits") so the owner knows which ones are guesses.
 *
 * The hour is a placeholder for booking, not a measurement. Every time written
 * here is `durationConfirmed: false`; the owner confirms it per service in the
 * staff app (Service Management → Edit → Duration), and the customer site reads
 * whatever is saved there.
 *
 * No effect on artist time-performance: visits only snapshot CONFIRMED times
 * (routes/visits.js), so these estimates never reach the productivity score.
 * Even the two measured medians stay unconfirmed — the owner owns the number.
 *
 * Only fills empty durations; a duration the owner set in Service Management
 * is never replaced.
 */

const Service = require("../models/Service");
const Visit = require("../models/Visit");
const { assumeDuration, DEFAULT_DURATION_MINUTES } = require("./lib/catalogue");
const { main } = require("./lib/runner");

main({
  id: "M2",
  title: `Seed Service.durationMinutes (at least ${DEFAULT_DURATION_MINUTES} min; longer measured medians kept)`,
  plan: async () => {
    const [services, samples] = await Promise.all([
      Service.find({}).sort({ category: 1, name: 1 }).lean(),
      Visit.aggregate([
        { $unwind: "$services" },
        {
          $match: {
            "services.serviceId": { $ne: null },
            "services.actualDurationMins": { $ne: null },
          },
        },
        { $group: { _id: "$services.serviceId", mins: { $push: "$services.actualDurationMins" } } },
      ]),
    ]);
    const minsByService = new Map(samples.map((r) => [String(r._id), r.mins]));

    const changes = [];
    const bySource = { default: 0, floor: 0, visits: 0 };
    for (const s of services) {
      if (s.durationMinutes != null) continue;
      const { durationMinutes, measured, samples: n, source } = assumeDuration(
        minsByService.get(String(s._id)) || []
      );
      bySource[source] += 1;
      changes.push({
        filter: { _id: s._id, durationMinutes: null },
        update: { $set: { durationMinutes, durationConfirmed: false } },
        summary: { name: s.name, category: s.category, durationMinutes, source, measured, samples: n },
      });
    }

    return {
      model: Service,
      changes,
      report: {
        totalServices: services.length,
        alreadySet: services.length - changes.length,
        bySource,
      },
    };
  },
});
