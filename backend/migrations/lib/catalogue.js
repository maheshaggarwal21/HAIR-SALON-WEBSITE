/**
 * @file migrations/lib/catalogue.js
 * @description Pure rules that PROPOSE the public layer for existing services
 * (migrations M2, M3, M4 and the T0.3 catalogue export).
 *
 * No I/O in here, so every rule is unit-tested (test/catalogue-rules.test.js).
 *
 * ── These are proposals, not decisions ────────────────────────────────────────
 * The owner signs off the public catalogue (T0.3). These rules exist to give
 * them a sheet that is 90% right so the review takes minutes, not to decide on
 * their behalf. Anything a rule cannot place confidently comes back null or
 * flagged rather than guessed — a wrong guess on a price list is worse than a
 * blank the owner has to fill.
 *
 * Live catalogue as of 13 Oct 2026: 182 services in four internal categories
 * (Hair 66, Body 51, Skin 50, Makeup 13) plus 2 rows filed under lowercase
 * "hair". The internal categories are too coarse for the website — "Skin" holds
 * facials, threading and face waxing together — so M4 reads the service NAME,
 * not just the category.
 */

const { DISPLAY_CATEGORIES, PUBLIC_PRICE_RATIO, DEFAULT_DURATION_MINUTES } = require("../../models/Service");

/** M3. Desk billing is list price − 50%; the website shows what is actually paid. */
function proposePublicPrice(price, ratio = PUBLIC_PRICE_RATIO) {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  return Math.round(price * ratio);
}

/** M4 part 1. "hair " → "Hair", "hands & FEET" → "Hands & Feet". */
function normaliseCategory(category) {
  const trimmed = String(category ?? "").trim().replace(/\s+/g, " ");
  return trimmed.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * M4 part 2. Ordered rules: the first match wins, so specific rules sit above
 * general ones (beard colour is Grooming, not Colour; bleach on hands is Skin,
 * not Hands & feet).
 */
const DISPLAY_RULES = [
  [/^any item$/i, null],                                                    // catch-all, never public
  [/make-?up|draping|dress up/i, "Makeup"],
  [/beard|moustache/i, "Grooming"],
  [/thread/i, "Threading"],
  [/\bwax\b/i, "Waxing"],
  [/bleach|facial|clean-?up|d-?tan|de[- ]?tan|mask|hydra|glow|polish|scrub|wrap|dermasyl|sensi-age|blanch|ginger|jamaican|papaya/i, "Skin"],
  [/manicure|pedicure|foot massage/i, "Hands & feet"],
  [/colou?r|highlight|balayage|root touch/i, "Colour"],
  [/keratin|smoothening|botox|nano ?plast|silk therapy|straight therapy|perm|olaplex|\bspa\b|split ends/i, "Treatments"],
];

function proposeDisplayCategory(name, category) {
  for (const [re, display] of DISPLAY_RULES) {
    if (re.test(name)) return display;
  }
  // Nothing specific matched: fall back on the internal category.
  const cat = normaliseCategory(category);
  if (cat === "Hair") return "Hair";
  if (cat === "Makeup") return "Makeup";
  if (cat === "Skin") return "Skin";
  return null; // "Body" with no specific match — owner decides
}

/**
 * Audience from the name. "women" is tested before "men" only for readability:
 * `\bmen\b` cannot match inside "women" because there is no word boundary
 * between the "o" and the "m".
 */
function proposeAudience(name) {
  if (/\bbride\b.*\bgroom\b|\bgroom\b.*\bbride\b/i.test(name)) return { audience: "unisex", reason: "name" };
  if (/\b(women|female|girls?|bridal|bride)\b/i.test(name)) return { audience: "her", reason: "name" };
  if (/\b(men|male|boys?)\b/i.test(name)) return { audience: "him", reason: "name" };
  if (/make-?up|draping|saree|hairdo|bikini/i.test(name)) return { audience: "her", reason: "service type" };
  if (/beard|moustache/i.test(name)) return { audience: "him", reason: "service type" };
  return { audience: "unisex", reason: "default" };
}

/** "Keratin (Women) Long" → { variantGroup: "keratin-women", variantLabel: "Long" }. */
function proposeVariant(name) {
  const m = /^(.*?)\s*\(?\b(Short|Medium|Long)\b\)?\s*$/i.exec(String(name).trim());
  if (!m || !m[1]) return { variantGroup: null, variantLabel: null };
  const label = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  return { variantGroup: slugify(m[1]), variantLabel: label };
}

/** Clean customer-facing name: drop gender tags and length variants, tidy spacing. */
function proposePublicName(name) {
  return String(name)
    .replace(/\(\s*(women|men|female|male)\s*\)/gi, "")
    .replace(/\b(female|male)\b/gi, "")
    .replace(/\(?\b(short|medium|long)\b\)?\s*$/i, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Key that collapses spelling noise, used to spot near-duplicate services. */
function duplicateKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b(women|men|female|male)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Things the owner should look at before anything goes public. Returns one
 * array of flag strings per service, aligned with `services`.
 */
const OUTLIER_MULTIPLE = 10;

function flagServices(services) {
  const proposals = services.map((s) => proposeDisplayCategory(s.name, s.category));

  // Price outliers: > 10× the median of the same display category. Catches
  // "Side Locks (Thread)" at ₹4,000 among threading prices of ₹60–₹400 (40×).
  // 5× was tried first and also flagged full-body wax and Hydra Facial, which
  // are legitimately expensive — noise that would train the owner to skim.
  const byDisplay = new Map();
  services.forEach((s, i) => {
    const d = proposals[i];
    if (!d) return;
    if (!byDisplay.has(d)) byDisplay.set(d, []);
    byDisplay.get(d).push(s.price);
  });
  const medianByDisplay = new Map([...byDisplay].map(([d, prices]) => [d, median(prices)]));

  // Near-duplicates: same name once spelling noise and gender tags are removed,
  // EXCEPT a her/him pair — "Hair spa (women)" and "Hair spa (men)" are two
  // real services, not a duplicate. "Head Massage" vs "Head Massage (Men)" is
  // still flagged: the owner should say who the untagged one is for.
  const audiences = services.map((s) => proposeAudience(s.name).audience);
  const byKey = new Map();
  services.forEach((s, i) => {
    const k = duplicateKey(s.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const isOppositePair = (a, b) => (a === "her" && b === "him") || (a === "him" && b === "her");
  const duplicateOf = (i) =>
    byKey
      .get(duplicateKey(services[i].name))
      .filter((j) => j !== i && !isOppositePair(audiences[i], audiences[j]))
      .map((j) => services[j].name);

  return services.map((s, i) => {
    const flags = [];
    const d = proposals[i];
    if (/^any item$/i.test(s.name.trim())) flags.push("catch-all: never show on website");
    if (!d) flags.push("no display category: owner to choose");
    if (s.category !== normaliseCategory(s.category)) flags.push(`category "${s.category}" not normalised`);
    if (d && s.price > OUTLIER_MULTIPLE * medianByDisplay.get(d)) {
      flags.push(`price outlier: ₹${s.price} vs ${d} median ₹${medianByDisplay.get(d)}`);
    }
    const dups = duplicateOf(i);
    if (dups.length) flags.push(`possible duplicate of: ${dups.join("; ")}`);
    if (/accessor|beeds|beads/i.test(s.name)) flags.push("product/accessory: probably not a bookable service");
    if (s.isActive === false) flags.push("inactive");
    return flags;
  });
}

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * M2. Median of observed durations, rounded UP to 5 minutes, only with enough
 * samples to mean something. Zero/negative and absurd (> 10 h) durations are
 * data-entry mistakes and are dropped before the median is taken.
 */
const MIN_DURATION_SAMPLES = 5;
function proposeDuration(samples) {
  const clean = samples.filter((m) => Number.isFinite(m) && m > 0 && m <= 600);
  if (clean.length < MIN_DURATION_SAMPLES) return { durationMinutes: null, samples: clean.length };
  return { durationMinutes: Math.ceil(median(clean) / 5) * 5, samples: clean.length };
}

/**
 * Owner decision, 13 Oct 2026: until real times are entered, every service is
 * assumed to take AT LEAST one hour (DEFAULT_DURATION_MINUTES, Service.js).
 * Services with enough visit data keep their median when it is longer;
 * everything else gets the hour. This is a placeholder, not a measurement — the
 * owner corrects it per service in Service Management, and M2 never overwrites
 * a duration that is already set.
 */
function assumeDuration(samples) {
  const { durationMinutes: measured, samples: n } = proposeDuration(samples);
  const durationMinutes = Math.max(DEFAULT_DURATION_MINUTES, measured ?? 0);
  const source = measured == null ? "default" : measured > DEFAULT_DURATION_MINUTES ? "visits" : "floor";
  return { durationMinutes, measured, samples: n, source };
}

module.exports = {
  DISPLAY_CATEGORIES,
  MIN_DURATION_SAMPLES,
  DEFAULT_DURATION_MINUTES,
  proposePublicPrice,
  normaliseCategory,
  proposeDisplayCategory,
  proposeAudience,
  proposeVariant,
  proposePublicName,
  slugify,
  duplicateKey,
  flagServices,
  proposeDuration,
  assumeDuration,
  median,
};
