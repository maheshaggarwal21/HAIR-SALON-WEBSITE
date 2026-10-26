/**
 * @file migrations/lib/emergencyDuration.js
 * @description M9 (emergency, 26 Oct 2026) — let customers book instead of only sending requests.
 *
 * Found on the live data: online booking was ON, but every active website service had `bookingMode: "request"`, and most had
 * no duration, so a customer could only send a request and never book a slot. This gives every active website service the
 * standard one-hour estimate (D11: `durationMinutes` 60 with `durationConfirmed` left false, i.e. an ESTIMATE the owner edits
 * later in the staff app) and switches the ordinary ones to `instant`.
 *
 * Kept request-only (CLAUDE.md: "Request booking: used for chemical, bridal and consultation services"): Makeup, Treatments and
 * Colour, and "Root touchup". They take hours; a one-hour instant slot would double-book an artist. They still get the one-hour
 * estimate. The owner can switch any single service to instant in the staff app.
 *
 * Guarantees: only ACTIVE services shown on the website; nothing already set is overwritten (an existing duration, confirmed or
 * not, is kept; services already `instant` or `hidden` keep their mode); prices, visits and artists are untouched; every change is
 * guarded so an owner edit made after planning wins; running it twice changes nothing. The report lists each service before and
 * after, which is also the way back.
 */

const Service = require("../../models/Service");

const STANDARD_MINUTES = 60;
const STAY_REQUEST_CATEGORIES = new Set(["Makeup", "Treatments", "Colour"]);
const STAY_REQUEST_NAME = /root\s*touch/i;

const shape = (s) => ({ bookingMode: s.bookingMode ?? null, durationMinutes: s.durationMinutes ?? null, durationConfirmed: s.durationConfirmed === true });

async function planEmergencyDuration() {
  const services = await Service.find({ isActive: { $ne: false }, showOnWebsite: true }).sort({ displayCategory: 1, name: 1 }).lean();
  const changes = [];
  let toInstant = 0;
  let stayRequest = 0;
  for (const s of services) {
    const needsDuration = !(s.durationMinutes > 0);
    const keepRequest = STAY_REQUEST_CATEGORIES.has(s.displayCategory) || STAY_REQUEST_NAME.test(s.name || "");
    const makeInstant = !keepRequest && s.bookingMode === "request";
    if (keepRequest && s.bookingMode === "request") stayRequest += 1;
    if (!needsDuration && !makeInstant) continue;

    const set = {};
    if (needsDuration) set.durationMinutes = STANDARD_MINUTES;
    if (makeInstant) set.bookingMode = "instant";
    if (makeInstant) toInstant += 1;

    changes.push({
      // Guarded: if the owner set a time or changed the mode since planning, this service is skipped (a rerun picks it up).
      filter: {
        _id: s._id,
        ...(needsDuration ? { $or: [{ durationMinutes: null }, { durationMinutes: { $exists: false } }, { durationMinutes: 0 }] } : { durationMinutes: { $gt: 0 } }),
        ...(makeInstant ? { bookingMode: "request" } : {}),
      },
      update: { $set: set },
      summary: { name: s.name, category: s.displayCategory ?? null, before: shape(s), after: { ...shape(s), ...set } },
    });
  }
  return {
    model: Service,
    changes,
    report: { websiteServices: services.length, switchedToInstant: toInstant, keptRequestOnly: stayRequest, standardMinutes: STANDARD_MINUTES },
  };
}

module.exports = { planEmergencyDuration, STANDARD_MINUTES, STAY_REQUEST_CATEGORIES };
