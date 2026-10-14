/**
 * @file publicCatalogue.js
 * @description The ONLY shapes in which services and artists leave the API on
 * public routes (CF §14). Pure functions over lean documents, so the "public
 * fields only" rule is unit-tested rather than trusted to every route.
 *
 * What never appears here: list price (`price`), commission, staff phone or
 * email, registration ID, internal category, isActive flags, timestamps.
 * Adding a field to a public shape is a deliberate edit to this file.
 *
 * ── Durations ────────────────────────────────────────────────────────────────
 * A duration is shown only when the owner has CONFIRMED it (D14). The one-hour
 * estimate is fine for blocking an artist's calendar but would be a false
 * statement on a public price list ("Eyebrows — 60 min").
 */

const { DISPLAY_CATEGORIES } = require("../models/Service");

/** Mongo filter for services the public menu may contain. */
const PUBLIC_SERVICE_FILTER = Object.freeze({
  showOnWebsite: true,
  isActive: true,
  publicPrice: { $ne: null },
  bookingMode: { $ne: "hidden" },
});

/** her → her + unisex, him → him + unisex, anything else → everything. */
function audienceFilter(forParam) {
  if (forParam === "her") return { audience: { $in: ["her", "unisex"] } };
  if (forParam === "him") return { audience: { $in: ["him", "unisex"] } };
  return {};
}

function effectiveMode(s) {
  if (s.bookingMode === "instant" && s.requiresConsultation) return "request";
  return s.bookingMode;
}

function publicOption(s) {
  return {
    id: String(s._id),
    slug: s.slug ?? null,
    label: s.variantLabel ?? null,
    price: s.publicPrice,
    durationMinutes: s.durationConfirmed === true ? s.durationMinutes ?? null : null,
    bookingMode: effectiveMode(s),
  };
}

const byOrder = (a, b) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.publicPrice ?? 0) - (b.publicPrice ?? 0);

/**
 * Group variant services ("Smoothening Short / Medium / Long") into one card
 * with options. Each option is still a real serviceId, so a request books real
 * services and Visits/analytics stay unchanged (D8).
 */
function serviceCards(services, { detail = false } = {}) {
  const groups = new Map();
  for (const s of [...services].sort(byOrder)) {
    const key = s.variantGroup ? `g:${s.variantGroup}` : `s:${s._id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const cards = [];
  for (const members of groups.values()) {
    const lead = members[0];
    const options = members.map(publicOption);
    const card = {
      slug: lead.variantGroup || lead.slug || String(lead._id),
      name: lead.publicName || lead.name,
      displayCategory: lead.displayCategory ?? null,
      audience: lead.audience ?? null,
      shortDescription: lead.shortDescription ?? null,
      images: lead.images ?? [],
      featured: members.some((m) => m.featured),
      sortOrder: lead.sortOrder ?? 0,
      requiresConsultation: members.some((m) => m.requiresConsultation),
      requiresPatchTest: members.some((m) => m.requiresPatchTest),
      fromPrice: Math.min(...options.map((o) => o.price)),
      options,
    };
    if (detail) {
      card.description = lead.description ?? null;
      card.seo = { title: lead.seo?.title ?? null, description: lead.seo?.description ?? null };
    }
    cards.push(card);
  }

  const catIndex = (c) => {
    const i = DISPLAY_CATEGORIES.indexOf(c.displayCategory);
    return i === -1 ? DISPLAY_CATEGORIES.length : i;
  };
  return cards.sort((a, b) => catIndex(a) - catIndex(b) || a.sortOrder - b.sortOrder || a.fromPrice - b.fromPrice);
}

/**
 * Mongo filter for artists the website may show: every active artist unless the
 * owner has hidden them (Artist.publicProfile.visible === false). `$ne: false`
 * also matches artists that have no publicProfile at all.
 */
const PUBLIC_ARTIST_FILTER = Object.freeze({
  isActive: true,
  "publicProfile.visible": { $ne: false },
});

function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Give every listed artist a stable URL key without the owner having to type
 * one: the stored slug if set, otherwise their (display) name. A name two
 * artists share gets the last 4 characters of the id appended, so URLs stay
 * unique and don't change when someone else is added. Stored slugs claim their
 * value first. Returns a Map of artist id → slug.
 */
function assignPublicSlugs(artists) {
  const out = new Map();
  const taken = new Set();
  const ordered = [...artists].sort(
    (a, b) => Number(Boolean(b.publicProfile?.slug)) - Number(Boolean(a.publicProfile?.slug)) || String(a._id).localeCompare(String(b._id))
  );
  for (const a of ordered) {
    const id = String(a._id);
    let slug = a.publicProfile?.slug || slugify(a.publicProfile?.displayName || a.name) || `artist-${id.slice(-4)}`;
    if (taken.has(slug)) slug = `${slug}-${id.slice(-4)}`;
    taken.add(slug);
    out.set(id, slug);
  }
  return out;
}

function publicArtist(a, slug = a.publicProfile?.slug ?? null) {
  const p = a.publicProfile || {};
  return {
    id: String(a._id),
    slug,
    name: p.displayName || a.name,
    level: a.level ?? null,
    gender: a.gender ?? null,
    bio: p.bio ?? null,
    specialties: p.specialties ?? [],
    photo: p.photo ?? null,
    portfolio: p.portfolio ?? [],
    instagram: p.instagram ?? null,
    sortOrder: p.sortOrder ?? 0,
    onlineBookable: a.onlineBookable === true,
  };
}

module.exports = {
  PUBLIC_SERVICE_FILTER,
  PUBLIC_ARTIST_FILTER,
  assignPublicSlugs,
  slugify,
  audienceFilter,
  serviceCards,
  publicArtist,
};
