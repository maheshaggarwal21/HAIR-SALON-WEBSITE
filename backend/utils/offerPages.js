/**
 * @file offerPages.js
 * @description Offer landing pages (D62): which offer is "now", and what the public may see.
 *
 * A page belongs to a Campaign (the existing Offers section) and uses its dates and its
 * active switch, in India time. `/offers/now` shows the page of the offer whose dates
 * contain today; if two overlap, the one that ENDS SOONER wins (then the owner's sort
 * order, then the older one), so a short flash offer is not hidden behind a long one.
 *
 * Nothing here changes a price. The page's price is words for the customer; the
 * receptionist applies any discount by hand when the visit is billed.
 */

const Campaign = require("../models/Campaign");
const Service = require("../models/Service");
const Reel = require("../models/Reel");
const { PUBLIC_SERVICE_FILTER } = require("./publicCatalogue");
const { salonDate } = require("./time");
const { matchLine } = require("./posterMatch");
const { OfferError } = require("./offers");

/** Addresses that are already pages or routes on the site. */
const RESERVED_SLUGS = new Set(["now", "api", "new", "edit"]);

const withPage = { active: true, "page.slug": { $type: "string" } };

/** The page shown at /offers/now, or null. */
async function findNow(today = salonDate()) {
  const rows = await Campaign.find({ ...withPage, startDate: { $lte: today }, endDate: { $gte: today } }).lean();
  rows.sort((a, b) => a.endDate.localeCompare(b.endDate) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || new Date(a.createdAt) - new Date(b.createdAt));
  return rows[0] ?? null;
}

/** The page at /offers/<slug> (active offers only), or null. */
const findBySlug = (slug) => (typeof slug === "string" ? Campaign.findOne({ ...withPage, "page.slug": slug }).lean() : null);

const slugifyName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "package";

/**
 * Clean the packages the owner typed (or the poster reader drafted), D64.
 *  - names, one whole-rupee price, the services as listed (duplicates and blanks dropped);
 *  - a stable address (slug) per package, kept when the package already existed;
 *  - `serviceIds`: only the lines the SERVER recognises on the service list (a clear name match),
 *    so a booking can appear on the Today board. Anything else stays as printed text. A browser
 *    can never set these.
 * No rule ties the price to the menu: poster packages include services that are not on it.
 * @param {any[]} input
 * @param {{slug: string}[]} existing  this offer's saved packages, so addresses stay put
 */
async function preparePackages(input, existing = []) {
  if (!Array.isArray(input)) return undefined;
  const menu = await Service.find({ isActive: true }, { name: 1, publicName: 1, publicPrice: 1 }).lean();
  const kept = new Set(existing.map((p) => p.slug));
  const used = new Set();
  return input.map((p) => {
    const name = String(p?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) throw new OfferError("Give each package a name.");
    const price = Number(p?.price);
    if (!Number.isInteger(price) || price < 1 || price > 1_000_000) throw new OfferError(`${name}: enter the package price in whole rupees.`);
    const seen = new Set();
    const services = (Array.isArray(p?.services) ? p.services : [])
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 80))
      .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
    if (!services.length) throw new OfferError(`${name}: list at least one service.`);
    if (services.length > 30) throw new OfferError(`${name}: at most 30 services.`);
    let slug = p?.slug && kept.has(p.slug) && !used.has(p.slug) ? p.slug : null;
    for (let n = 1; !slug; n++) {
      const candidate = `${slugifyName(name)}${n > 1 ? `-${n}` : ""}`;
      if (!used.has(candidate) && !kept.has(candidate)) slug = candidate;
    }
    used.add(slug);
    const serviceIds = [...new Set(services.map((line) => matchLine(line, menu).match?.serviceId).filter(Boolean))];
    const mins = Math.round(Number(p?.durationMinutes) || 120);
    return { slug, name, price, services, durationMinutes: Math.min(480, Math.max(15, mins)), serviceIds };
  });
}

/** "live" while today is inside the dates, "scheduled" before, "ended" after. */
function stateOn(c, today = salonDate()) {
  if (today < c.startDate) return "scheduled";
  if (today > c.endDate) return "ended";
  return "live";
}

/** What a browser may see of an offer page. No ids of staff, no internal name. */
async function toPublic(c, today = salonDate()) {
  const p = c.page || {};
  const [services, reel] = await Promise.all([
    p.serviceIds?.length
      ? Service.find({ ...PUBLIC_SERVICE_FILTER, _id: { $in: p.serviceIds } }, { name: 1, publicName: 1, publicPrice: 1, bookingMode: 1 }).lean()
      : [],
    p.reelId ? Reel.findOne({ _id: p.reelId, visible: true }, { mediaType: 1, mediaUrl: 1, thumbnailUrl: 1 }).lean() : null,
  ]);
  const byId = new Map(services.map((s) => [String(s._id), s]));
  return {
    slug: p.slug,
    state: stateOn(c, today),
    theme: c.theme,
    eyebrow: c.content?.eyebrow ?? null,
    headline: p.headline || c.content?.headline,
    offerText: p.offerText ?? null,
    price: p.price ?? null,
    priceNote: p.priceNote ?? null,
    // The slideshow (D63): the owner's pictures in order; older offers fall back to their one picture or the pop-up poster.
    images: (p.images?.length ? p.images : [p.image || c.content?.image].filter(Boolean)).slice(0, 5),
    image: p.images?.[0] || p.image || c.content?.image || null,
    reel: reel ? { mediaType: reel.mediaType, mediaUrl: reel.mediaUrl, thumbnailUrl: reel.thumbnailUrl ?? null } : null,
    startDate: c.startDate,
    endDate: c.endDate,
    // Order the owner chose; services no longer on the menu drop out quietly.
    // The poster's packages (D64): name, ONE price, the service names and how long it takes. No ids, no per-service prices.
    packages: (p.packages || []).map((k) => ({ slug: k.slug, name: k.name, price: k.price, services: k.services, durationMinutes: k.durationMinutes ?? 120 })),
    services: (p.serviceIds || []).map((id) => byId.get(String(id))).filter(Boolean).map((s) => ({ id: String(s._id), name: s.publicName || s.name })),
  };
}

module.exports = { RESERVED_SLUGS, findNow, findBySlug, stateOn, toPublic, preparePackages };
