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
const { groupFor, norm } = require("../config/menuGroups");

/**
 * Which card a service belongs to: its own variant group in the database wins;
 * otherwise a website menu group (config/menuGroups.js, CF D34); otherwise it is
 * its own card.
 */
function cardKeyFor(s) {
  if (s.variantGroup) return { key: `g:${s.variantGroup}`, slug: s.variantGroup, cfg: null };
  const hit = groupFor(s);
  if (hit) return { key: `c:${hit.group.slug}`, slug: hit.group.slug, cfg: hit };
  return { key: `s:${s._id}`, slug: s.slug || String(s._id), cfg: null };
}

/** The public URL key of the card a service is shown on. */
const cardSlugFor = (s) => cardKeyFor(s).slug;

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

function publicOption(s, label = s.variantLabel ?? null) {
  return {
    id: String(s._id),
    slug: s.slug ?? null,
    label,
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
 * services and Visits/analytics stay unchanged (D8). Menu groups from
 * config/menuGroups.js (D34) join look-alike services the same way.
 */
function serviceCards(services, { detail = false } = {}) {
  const groups = new Map();
  for (const s of [...services].sort(byOrder)) {
    const k = cardKeyFor(s);
    if (!groups.has(k.key)) groups.set(k.key, { slug: k.slug, cfg: k.cfg?.group ?? null, members: [] });
    groups.get(k.key).members.push({ s, cfg: k.cfg });
  }

  const cards = [];
  for (const { slug, cfg, members: entries } of groups.values()) {
    // Config groups list options in the order written there (Mini → Classic → Premium…).
    if (cfg) entries.sort((a, b) => a.cfg.order - b.cfg.order);
    const members = entries.map((e) => e.s);
    const lead = members[0];
    const options = entries.map((e) => publicOption(e.s, e.s.variantLabel ?? e.cfg?.label ?? null));
    // Same label twice (a men's and a women's version at different prices, both on
    // the detail page): say which is which.
    const seen = new Map();
    options.forEach((o) => seen.set(o.label, (seen.get(o.label) || 0) + 1));
    options.forEach((o, i) => {
      const who = { her: "women", him: "men" }[members[i].audience];
      if (o.label && seen.get(o.label) > 1 && who && !/\((men|women)\)$/.test(o.label)) o.label = `${o.label} (${who})`;
    });
    // A one-option config group keeps the service's own name ("Haircut" with just
    // "Creative cut" would read oddly on the "For him" tab).
    const single = cfg && members.length === 1 && !cfg.keepTitle;
    const card = {
      slug: single ? lead.slug || String(lead._id) : slug,
      name: cfg && !single ? cfg.title : lead.publicName || lead.name,
      displayCategory: (cfg && cfg.category) || lead.displayCategory || null,
      audience: lead.audience ?? null,
      shortDescription: cfg && !single ? null : lead.shortDescription ?? null,
      images: members.find((m) => m.images?.length)?.images ?? [],
      featured: members.some((m) => m.featured),
      sortOrder: lead.sortOrder ?? 0,
      requiresConsultation: members.some((m) => m.requiresConsultation),
      requiresPatchTest: members.some((m) => m.requiresPatchTest),
      fromPrice: Math.min(...options.map((o) => o.price)),
      // "many": options can be combined (threading areas); "one": alternatives (D34).
      pick: cfg && !single && cfg.pick === "many" ? "many" : "one",
      options,
    };
    if (detail) {
      card.description = lead.description ?? null;
      card.seo = { title: lead.seo?.title ?? null, description: lead.seo?.description ?? null };
    }
    cards.push(card);
  }

  // Everyone tab (no audience filter): a women's and a men's card with the same
  // name (Keratin S/M/L for her, Keratin for him) become one card whose options
  // say who they are for. Each option is still its own service and price.
  const merged = [];
  const byName = new Map();
  for (const c of cards) {
    const k = `${c.displayCategory}|${norm(c.name)}`;
    const first = byName.get(k);
    if (!first) {
      byName.set(k, c);
      merged.push(c);
      continue;
    }
    if (first.audience === c.audience) {
      merged.push(c);
      continue;
    }
    const tag = (card) => (o) => {
      const who = { her: "women", him: "men" }[card.audience];
      if (!who || /\((men|women)\)$/.test(o.label ?? "")) return o;
      return { ...o, label: o.label ? `${o.label} (${who})` : who[0].toUpperCase() + who.slice(1) };
    };
    // Women's options first, then men's.
    const [a, b] = first.audience === "him" ? [c, first] : [first, c];
    first.options = [...a.options.map(tag(a)), ...b.options.map(tag(b))];
    first.audience = "unisex";
    first.fromPrice = Math.min(first.fromPrice, c.fromPrice);
    first.featured = first.featured || c.featured;
    first.requiresConsultation = first.requiresConsultation || c.requiresConsultation;
    first.requiresPatchTest = first.requiresPatchTest || c.requiresPatchTest;
    if (!first.images.length) first.images = c.images;
    first.pick = "one";
  }
  cards.length = 0;
  cards.push(...merged);

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
  cardSlugFor,
  publicArtist,
};
