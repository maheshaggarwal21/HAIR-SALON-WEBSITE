/**
 * @file publicStats.js
 * @description Numbers the website may boast about, computed from real records
 * (CF D28). Nothing here is typed in by hand, so the site can never overstate.
 *
 * clientsServed = distinct phone numbers (last 10 digits) across paid Visits.
 * The exact figure stays on the server: the public value is rounded DOWN to a
 * "nice" step and shown with a "+", e.g. 1,284 → 1,000+.
 */

const Visit = require("../models/Visit");

/** Round down to a friendly step: 37 → 30, 126 → 100, 1,284 → 1,000, 12,400 → 12,000. */
function floorNice(n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = n < 100 ? 10 : n < 1000 ? 50 : n < 10000 ? 500 : 1000;
  return Math.floor(n / step) * step;
}

/** Below this the stat isn't shown at all: "30+ clients" undersells the salon. */
const MIN_CLIENTS_TO_SHOW = 100;

async function clientsServed() {
  const contacts = await Visit.distinct("contact", { paymentStatus: "success" });
  const phones = new Set();
  for (const c of contacts) {
    const digits = String(c || "").replace(/\D/g, "");
    if (digits.length >= 10) phones.add(digits.slice(-10));
  }
  const nice = floorNice(phones.size);
  return nice >= MIN_CLIENTS_TO_SHOW ? nice : null;
}

module.exports = { clientsServed, floorNice, MIN_CLIENTS_TO_SHOW };
