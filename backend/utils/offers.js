/**
 * @file offers.js
 * @description Cheaper prices while an offer runs (CONTROL_FLOW_AND_DATA_LOGIC.md
 * D59, CLAUDE.md "Prices shown to customers").
 *
 * An offer (Campaign) can carry cheaper prices for single services and bundles
 * of services. This file is the ONE place that turns "what is on offer today"
 * into prices, so the page, the quote, the deposit, the booking snapshot and
 * the refund all read the same number:
 *
 *   - applyOffer(service, offers)  → a copy of the service whose `publicPrice`
 *     IS the offer price, with `regularPrice` (the normal website price that is
 *     shown crossed out) and `offerEndsOn` added. Everything downstream that
 *     already reads `publicPrice` — quote.js, the Appointment snapshot, checkout
 *     — needs no change.
 *   - liveBundles(offers)          → bundles in the shape of config/packages.js,
 *     so they book through the existing package path (D20).
 *
 * Honesty: a crossed-out price exists ONLY inside a Campaign's real start and
 * end dates, and only while the offer price is genuinely below the normal one.
 * If the normal price is later lowered to or below the offer price, the offer
 * is ignored rather than shown as a fake discount.
 *
 * Staff booking paths (walk-ins, phone bookings, Visit Entry) do not call this:
 * the desk keeps its own prices. Offers are for what the website sells.
 */

const crypto = require("crypto");
const Campaign = require("../models/Campaign");
const Service = require("../models/Service");
const { salonDate } = require("./time");

const TTL_MS = 20_000;
let memo = { day: null, at: 0, value: null };

class OfferError extends Error {}

/** Live offers for an IST date: price per service and bundles. Cached for 20 s per instance. */
async function liveOffers(today = salonDate()) {
  if (memo.value && memo.day === today && Date.now() - memo.at < TTL_MS) return memo.value;
  const list = await Campaign.find(
    { active: true, startDate: { $lte: today }, endDate: { $gte: today } },
    { servicePrices: 1, bundles: 1, startDate: 1, endDate: 1 }
  )
    .sort({ sortOrder: 1, startDate: 1 })
    .lean();

  const prices = new Map(); // serviceId → { price, endsOn }
  const bundles = [];
  for (const c of list) {
    for (const sp of c.servicePrices || []) {
      const key = String(sp.serviceId);
      const have = prices.get(key);
      if (!have || sp.price < have.price) prices.set(key, { price: sp.price, endsOn: c.endDate });
    }
    for (const b of c.bundles || []) bundles.push({ ...b, serviceIds: b.serviceIds.map(String), validFrom: c.startDate, validTo: c.endDate });
  }
  const value = { prices, bundles };
  memo = { day: today, at: Date.now(), value };
  return value;
}

function clearOffersCache() {
  memo = { day: null, at: 0, value: null };
}

/** The service with its offer price, or the same service when nothing applies. */
function applyOffer(service, offers, exempt = null) {
  const id = String(service._id);
  if (exempt?.has(id)) return service;
  const hit = offers.prices.get(id);
  if (!hit || service.publicPrice == null || !(hit.price < service.publicPrice)) return service;
  return { ...service, regularPrice: service.publicPrice, publicPrice: hit.price, offerEndsOn: hit.endsOn };
}

const applyOffers = (services, offers, exempt = null) => services.map((s) => applyOffer(s, offers, exempt));

/** Whole-number percent off, for "20% off". */
const percentOff = (regular, price) => (regular > 0 && price < regular ? Math.round((1 - price / regular) * 100) : 0);

// ─── Saving an offer's prices (staff routes) ─────────────────────────────────

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "bundle";

/**
 * Check what the owner typed against the real menu and return the clean lines.
 * Throws OfferError with a plain-words message the form shows.
 *
 * @param {{servicePrices?: any[], bundles?: any[]}} input
 * @param {{slug: string}[]} existingBundles  this offer's saved bundles, so a bundle keeps its URL
 */
async function prepareOfferLines(input, existingBundles = []) {
  const servicePrices = input.servicePrices;
  const bundles = input.bundles;
  const ids = new Set();
  for (const sp of servicePrices || []) ids.add(String(sp.serviceId));
  for (const b of bundles || []) for (const id of b.serviceIds || []) ids.add(String(id));
  const docs = ids.size ? await Service.find({ _id: { $in: [...ids] }, isActive: true, publicPrice: { $ne: null } }, { name: 1, publicName: 1, publicPrice: 1 }).lean() : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const nameOf = (d) => d.publicName || d.name;
  const need = (id) => {
    const d = byId.get(String(id));
    if (!d) throw new OfferError("One of the services is not on the website menu any more. Remove it and try again.");
    return d;
  };

  let cleanPrices;
  if (servicePrices) {
    const seen = new Set();
    cleanPrices = servicePrices.map((sp) => {
      const d = need(sp.serviceId);
      const key = String(sp.serviceId);
      if (seen.has(key)) throw new OfferError(`${nameOf(d)} is listed twice.`);
      seen.add(key);
      if (!(sp.price < d.publicPrice)) throw new OfferError(`${nameOf(d)}: the offer price must be below its normal price of ₹${d.publicPrice}.`);
      return { serviceId: d._id, price: sp.price };
    });
  }

  let cleanBundles;
  if (bundles) {
    const taken = new Set(existingBundles.map((b) => b.slug));
    cleanBundles = bundles.map((b) => {
      const unique = [...new Set(b.serviceIds.map(String))];
      if (unique.length < 2) throw new OfferError(`${b.name}: pick at least two different services.`);
      const total = unique.reduce((sum, id) => sum + need(id).publicPrice, 0);
      if (!(b.price < total)) throw new OfferError(`${b.name}: the bundle price must be below the ₹${total} the services cost separately.`);
      let slug = b.slug && existingBundles.some((e) => e.slug === b.slug) ? b.slug : null;
      while (!slug) {
        const candidate = `${slugify(b.name)}-${crypto.randomBytes(2).toString("hex")}`;
        if (!taken.has(candidate)) slug = candidate;
      }
      taken.add(slug);
      return { slug, name: b.name, description: b.description || null, audience: b.audience || "unisex", serviceIds: unique, price: b.price };
    });
  }
  return { servicePrices: cleanPrices, bundles: cleanBundles };
}

module.exports = { liveOffers, clearOffersCache, applyOffer, applyOffers, percentOff, prepareOfferLines, OfferError };
