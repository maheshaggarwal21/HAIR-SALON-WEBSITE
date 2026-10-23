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

/** Addresses that are already pages or routes on the site. */
const RESERVED_SLUGS = new Set(["now", "karva-chauth", "api", "new", "edit"]);

const withPage = { active: true, "page.slug": { $type: "string" } };

/** The page shown at /offers/now, or null. */
async function findNow(today = salonDate()) {
  const rows = await Campaign.find({ ...withPage, startDate: { $lte: today }, endDate: { $gte: today } }).lean();
  rows.sort((a, b) => a.endDate.localeCompare(b.endDate) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || new Date(a.createdAt) - new Date(b.createdAt));
  return rows[0] ?? null;
}

/** The page at /offers/<slug> (active offers only), or null. */
const findBySlug = (slug) => (typeof slug === "string" ? Campaign.findOne({ ...withPage, "page.slug": slug }).lean() : null);

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
    image: p.image || c.content?.image || null,
    reel: reel ? { mediaType: reel.mediaType, mediaUrl: reel.mediaUrl, thumbnailUrl: reel.thumbnailUrl ?? null } : null,
    startDate: c.startDate,
    endDate: c.endDate,
    // Order the owner chose; services no longer on the menu drop out quietly.
    services: (p.serviceIds || []).map((id) => byId.get(String(id))).filter(Boolean).map((s) => ({ id: String(s._id), name: s.publicName || s.name })),
  };
}

module.exports = { RESERVED_SLUGS, findNow, findBySlug, stateOn, toPublic };
