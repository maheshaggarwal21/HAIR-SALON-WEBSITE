/**
 * @file utm.js
 * @description Which ad brought a customer: the first-touch tags the customer site
 * remembers (utm_source / medium / campaign / content, Meta's fbclid, and an ad id
 * from `utm_id` or `ad_id`) cleaned for saving. Shared by the paid booking form and
 * the offer-request form, so both record attribution the same way.
 */

const UTM_FIELDS = ["source", "medium", "campaign", "content", "fbclid", "adId"];

/** Strings only, trimmed and cut to the schema's length (fbclid is long); anything else is dropped. null when nothing is left. */
function cleanUtm(utm) {
  if (!utm || typeof utm !== "object" || Array.isArray(utm)) return null;
  const out = {};
  for (const k of UTM_FIELDS) {
    if (typeof utm[k] === "string" && utm[k].trim()) out[k] = utm[k].trim().slice(0, k === "fbclid" ? 255 : 100);
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { UTM_FIELDS, cleanUtm };
