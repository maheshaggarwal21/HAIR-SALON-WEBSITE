/**
 * @file skills.js
 * @description Which services an artist may be booked for (CF D35).
 *
 * A rule is { all, categories, groups, services }:
 *   - all:        every service (the default for now: the owner wants every
 *                 artist able to do everything until he narrows it down);
 *   - categories: whole menu sections ("Threading", "Makeup");
 *   - groups:     menu sub-groups / cards (config/menuGroups.js slugs, or a
 *                 service's own variantGroup, e.g. "keratin-women");
 *   - services:   single services by id.
 * A service is allowed if ANY of these match.
 *
 * Two levels, so the owner sets a few rules instead of 14 artists × 180
 * services:
 *   1. a default per gender (SiteSettings.artistSkillDefaults.female / male /
 *      other), used by every artist who follows it;
 *   2. an artist's own rule (Artist.skillMode = "custom"), which replaces the
 *      gender default for that artist.
 * An artist with no gender set follows the "other" default.
 */

const { cardSlugFor } = require("./publicCatalogue");
const { groupBySlug } = require("../config/menuGroups");

const ALL = Object.freeze({ all: true, categories: [], groups: [], services: [] });
const GENDER_KEYS = ["female", "male", "other"];

/** A clean rule from anything stored (missing → allow all). */
function normaliseRule(r) {
  if (!r) return { ...ALL };
  return {
    all: r.all !== false,
    categories: [...new Set((r.categories || []).map(String))],
    groups: [...new Set((r.groups || []).map(String))],
    services: [...new Set((r.services || []).map(String))],
  };
}

/** The rule that applies to this artist: their own, or their gender's default. */
function effectiveRule(artist, defaults = {}) {
  if (artist?.skillMode === "custom") {
    return normaliseRule({
      all: artist.skillAll === true,
      categories: artist.skillCategories,
      groups: artist.skillGroups,
      services: artist.skills,
    });
  }
  const key = GENDER_KEYS.includes(artist?.gender) ? artist.gender : "other";
  return normaliseRule(defaults?.[key]);
}

/**
 * The menu section and sub-group a service belongs to (what rules match on) —
 * the same as the website menu, so a group's own section wins (Eyebrows is in
 * the Threading card, so "Threading" covers it).
 */
function serviceKeys(service) {
  const group = cardSlugFor(service);
  return {
    id: String(service._id),
    category: groupBySlug(group)?.category || service.displayCategory || service.category || null,
    group,
  };
}

/** Does this rule allow this service? `keys` from serviceKeys(). */
function ruleAllows(rule, keys) {
  if (rule.all) return true;
  return (
    rule.services.includes(keys.id) ||
    (keys.category != null && rule.categories.includes(keys.category)) ||
    (keys.group != null && rule.groups.includes(keys.group))
  );
}

/** Engine-ready form of a rule (Sets, for the slot search). */
function ruleSets(rule) {
  return {
    skillAll: rule.all,
    skills: new Set(rule.services),
    skillCategories: new Set(rule.categories),
    skillGroups: new Set(rule.groups),
  };
}

module.exports = { ALL, GENDER_KEYS, normaliseRule, effectiveRule, serviceKeys, ruleAllows, ruleSets };
