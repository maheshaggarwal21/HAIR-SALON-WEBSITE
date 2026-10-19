/**
 * @file artistSkills.js
 * @description Staff screen "Artist skills" (CF D35): which artist may be
 * booked for which services, by gender and per artist.
 *
 *   GET   /                     rules + artists + the service tree to tick
 *   PATCH /defaults/:gender     the rule for all female / male / other artists
 *   PATCH /:id                  one artist: follow the gender rule, or their own
 *
 * The service tree is every ACTIVE service (on the website or not), grouped
 * into menu sections → sub-groups (the same cards as the website menu) →
 * services, so the owner ticks a whole section, a sub-group or one service.
 * Rules only decide who can be booked online (Phase 2 engine); they change no
 * price, Visit or service data. Every change is audited.
 */

const express = require("express");
const { body, param, validationResult } = require("express-validator");
const connectDB = require("../db");
const Artist = require("../models/Artist");
const Service = require("../models/Service");
const SiteSettings = require("../models/SiteSettings");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const validateId = require("../middleware/validateId");
const audit = require("../utils/audit");
const { GENDER_KEYS, normaliseRule, effectiveRule, serviceKeys, ruleAllows } = require("../utils/skills");
const { groupBySlug, norm } = require("../config/menuGroups");
const { DISPLAY_CATEGORIES } = require("../models/Service");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[artist-skills] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

function firstError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg, field: errors.array()[0].path });
  return true;
}

const OID = /^[a-f0-9]{24}$/i;
const SLUG = /^[a-z0-9-]{1,120}$/;
const ruleValidators = (prefix) => [
  body(`${prefix}.all`).isBoolean({ strict: true }).withMessage("Say whether all services are allowed"),
  body(`${prefix}.categories`).optional().isArray({ max: 20 }),
  body(`${prefix}.categories.*`).isIn(DISPLAY_CATEGORIES).withMessage("Unknown menu section"),
  body(`${prefix}.groups`).optional().isArray({ max: 200 }),
  body(`${prefix}.groups.*`).matches(SLUG).withMessage("Unknown sub-group"),
  body(`${prefix}.services`).optional().isArray({ max: 500 }),
  body(`${prefix}.services.*`).matches(OID).withMessage("Unknown service"),
];

/** Sections → sub-groups → services, from every active service. */
async function serviceTree() {
  const services = await Service.find({ isActive: true }, { name: 1, publicName: 1, displayCategory: 1, category: 1, variantGroup: 1, variantLabel: 1, audience: 1, sortOrder: 1 })
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  const sections = new Map();
  for (const s of services) {
    const k = serviceKeys(s);
    const cat = k.category || "Other";
    if (!sections.has(cat)) sections.set(cat, new Map());
    const groups = sections.get(cat);
    if (!groups.has(k.group)) {
      const cfg = groupBySlug(k.group);
      groups.set(k.group, { slug: k.group, title: cfg?.title || s.publicName || s.name, services: [] });
    }
    // "Keratin" + "Short" reads as one name; a full website name ("Upper lip wax") is used as it is.
    const withLabel = s.publicName && s.variantLabel && !norm(s.publicName).includes(norm(s.variantLabel));
    groups.get(k.group).services.push({ _id: String(s._id), name: withLabel ? `${s.publicName} ${s.variantLabel}` : s.publicName || s.name, audience: s.audience ?? null });
  }
  const order = (c) => (DISPLAY_CATEGORIES.indexOf(c) === -1 ? 99 : DISPLAY_CATEGORIES.indexOf(c));
  return [...sections.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([category, groups]) => ({ category, groups: [...groups.values()] }));
}

/** How many of `total` services a rule allows (for the summary line). */
function allowedCount(rule, tree) {
  let n = 0;
  for (const sec of tree) for (const g of sec.groups) for (const s of g.services) if (ruleAllows(rule, { id: s._id, category: sec.category, group: g.slug })) n++;
  return n;
}

const artistView = (a, defaults, tree) => {
  const rule = effectiveRule(a, defaults);
  return {
    _id: String(a._id),
    name: a.publicProfile?.displayName || a.name,
    gender: a.gender ?? null,
    isActive: a.isActive !== false,
    skillMode: a.skillMode || "inherit",
    rule: a.skillMode === "custom" ? rule : null,
    allowed: allowedCount(rule, tree),
  };
};

router.get("/", authorizePermission(PERMISSIONS.ARTISTS_VIEW), async (_req, res) => {
  try {
    const [settings, artists, tree] = await Promise.all([
      SiteSettings.getSingleton(),
      Artist.find({ isActive: true }, { name: 1, gender: 1, isActive: 1, skillMode: 1, skillAll: 1, skillCategories: 1, skillGroups: 1, skills: 1, "publicProfile.displayName": 1 })
        .sort({ name: 1 })
        .lean(),
      serviceTree(),
    ]);
    const defaults = Object.fromEntries(GENDER_KEYS.map((g) => [g, normaliseRule(settings.artistSkillDefaults?.[g])]));
    const total = tree.reduce((n, sec) => n + sec.groups.reduce((m, g) => m + g.services.length, 0), 0);
    return res.json({
      defaults,
      defaultsAllowed: Object.fromEntries(GENDER_KEYS.map((g) => [g, allowedCount(defaults[g], tree)])),
      artists: artists.map((a) => artistView(a, defaults, tree)),
      tree,
      totalServices: total,
    });
  } catch (err) {
    console.error("[artist-skills] load error:", err);
    return res.status(500).json({ error: "Failed to load artist skills" });
  }
});

router.patch(
  "/defaults/:gender",
  authorizePermission(PERMISSIONS.ARTISTS_CRUD),
  [param("gender").isIn(GENDER_KEYS), ...ruleValidators("rule")],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const settings = await SiteSettings.getSingleton();
      const g = req.params.gender;
      const before = normaliseRule(settings.artistSkillDefaults?.[g]);
      const rule = normaliseRule(req.body.rule);
      settings.set(`artistSkillDefaults.${g}`, rule);
      await settings.save();
      await audit.record({ action: "artist.skills_default_changed", req, meta: { gender: g, from: before, to: rule } });
      return res.json({ gender: g, rule });
    } catch (err) {
      console.error("[artist-skills] default save error:", err);
      return res.status(500).json({ error: "Failed to save" });
    }
  }
);

router.patch(
  "/:id",
  validateId,
  authorizePermission(PERMISSIONS.ARTISTS_CRUD),
  [body("mode").isIn(["inherit", "custom"]).withMessage("Mode is inherit or custom"), body("rule").optional({ nullable: true }), ...ruleValidators("rule").map((v) => v.optional())],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const a = await Artist.findById(req.params.id);
      if (!a) return res.status(404).json({ error: "Artist not found" });
      const before = { mode: a.skillMode, all: a.skillAll, categories: a.skillCategories, groups: a.skillGroups, services: a.skills.map(String) };
      a.skillMode = req.body.mode;
      if (req.body.mode === "custom") {
        const r = normaliseRule(req.body.rule || { all: false });
        a.skillAll = r.all;
        a.skillCategories = r.categories;
        a.skillGroups = r.groups;
        a.skills = r.services;
      }
      await a.save();
      await audit.record({
        action: "artist.skills_changed",
        req,
        meta: { artistId: String(a._id), from: before, to: { mode: a.skillMode, all: a.skillAll, categories: a.skillCategories, groups: a.skillGroups, services: a.skills.map(String) } },
      });
      return res.json({ ok: true, skillMode: a.skillMode });
    } catch (err) {
      console.error("[artist-skills] artist save error:", err);
      return res.status(500).json({ error: "Failed to save" });
    }
  }
);

module.exports = router;
