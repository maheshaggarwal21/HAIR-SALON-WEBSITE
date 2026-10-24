/**
 * @file website.js
 * @description Owner-side editing of what the customer website shows —
 * `/api/website/*` (CONTROL_FLOW_AND_DATA_LOGIC.md §15). Permission:
 * `website.manage` (owner only by default).
 *
 *   GET   /settings              full SiteSettings (staff view)
 *   PATCH /settings              contact, opening hours, holidays, request rules
 *   GET   /artists               every active artist with public fields (editor)
 *   PATCH /artists/:id/public    gender, level, onlineBookable, publicProfile.* (T1.2)
 *   PATCH /services/:id/public   website fields of one service
 *   GET   /services              every active service with its website fields (menu editor)
 *   GET|POST /reels, PATCH|DELETE /reels/:id   reels wall (T1.20)
 *   GET|POST /campaigns, PATCH|DELETE /campaigns/:id   website offers: bar + pop-up (CF D29)
 *   POST  /media/upload          Vercel Blob client-upload token (photos, video)
 *
 * Every change writes an AuditLog line with before → after (§15). Edits go
 * through doc.save() so model rules run — e.g. a service cannot be switched to
 * instant booking without a duration (Service pre-validate hook).
 *
 * Each write also pings the customer site's /api/revalidate (utils/revalidate.js)
 * so the edit shows within seconds (T1.24, CP2 "≤ 60s").
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const SiteSettings = require("../models/SiteSettings");
const Artist = require("../models/Artist");
const Service = require("../models/Service");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const validateId = require("../middleware/validateId");
const audit = require("../utils/audit");
const { isValidDate, TIME_RE, salonDate } = require("../utils/time");
const Reel = require("../models/Reel");
const Campaign = require("../models/Campaign");
const offers = require("../utils/offers");
const offerPages = require("../utils/offerPages");
const posterReader = require("../utils/posterReader");
const { matchLine } = require("../utils/posterMatch");
const { hit } = require("../middleware/mongoRateLimit");
const { PUBLIC_SERVICE_FILTER } = require("../utils/publicCatalogue");
const { revalidateSite } = require("../utils/revalidate");

const HTTPS_URL = { protocols: ["https"], require_protocol: true };
/** An https link, or a file shipped with the customer site (/images/…, /media/…). */
const siteOrHttps = (v) => typeof v === "string" && (/^https:\/\/\S+$/.test(v) || /^\/(images|media)\/[\w./-]+$/.test(v));
/** "" → null so a cleared field removes the media. */
const nullableUrl = (path) =>
  body(path)
    .optional({ nullable: true })
    .customSanitizer((v) => (v === "" ? null : v))
    .custom((v) => v === null || (typeof v === "string" && /^https:\/\/\S+$/.test(v) && v.length <= 1000))
    .withMessage("Use an https link");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[website] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});
router.use(authorizePermission(PERMISSIONS.WEBSITE_MANAGE));

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHONE_RE = /^[6-9]\d{9}$/;

function firstError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg, field: errors.array()[0].path });
  return true;
}

/** Shallow before/after of the dotted paths that changed. */
function diffPaths(beforeDoc, afterDoc, paths) {
  const get = (o, p) => p.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
  const out = {};
  for (const p of paths) {
    const a = JSON.stringify(get(beforeDoc, p) ?? null);
    const b = JSON.stringify(get(afterDoc, p) ?? null);
    if (a !== b) out[p] = { from: get(beforeDoc, p) ?? null, to: get(afterDoc, p) ?? null };
  }
  return out;
}

/** Copy only the listed dotted paths that are present in `src` onto a mongoose doc. */
function applyPaths(doc, src, paths) {
  for (const p of paths) {
    const value = p.split(".").reduce((v, k) => (v == null ? undefined : v[k]), src);
    if (value !== undefined) doc.set(p, value);
  }
}

function saveError(res, err) {
  if (err instanceof offers.OfferError) return res.status(400).json({ error: err.message });
  if (err?.code === 11000) return res.status(409).json({ error: "That URL name (slug) is already used" });
  if (err?.name === "ValidationError") {
    const first = Object.values(err.errors)[0];
    return res.status(400).json({ error: first?.message || "Invalid value", field: first?.path });
  }
  if (err?.message?.startsWith("Instant booking")) return res.status(400).json({ error: err.message });
  console.error("[website] save error:", err);
  return res.status(500).json({ error: "Failed to save" });
}

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_PATHS = [
  "contact.phone",
  "contact.whatsapp",
  "contact.address",
  "contact.mapUrl",
  "contact.mapEmbedUrl",
  "contact.instagram",
  "contact.placeId",
  ...SiteSettings.DAYS.map((d) => `openingHours.${d}`),
  "holidays",
  "requestWindows.morning",
  "requestWindows.afternoon",
  "requestWindows.evening",
  "horizonDays",
  "requestSlaMinutes",
  "maxActiveBookingsPerPhone",
  "contact.parkingNote",
  "media.heroVideoUrl",
  "media.heroPosterUrl",
  "media.forHerImage",
  "media.forHimImage",
  "media.salonImages",
  "media.heroSlides",
  "media.gallery",
  "transformations",
  "reviews.rating",
  "reviews.count",
  "reviews.url",
  "reviews.featured",
  "owner.name",
  "owner.title",
  "owner.bio",
  "owner.photo",
  "owner.visible",
];

const nullablePhone = (path) =>
  body(path)
    .optional({ nullable: true })
    .customSanitizer((v) => (v === "" ? null : v))
    .custom((v) => v === null || PHONE_RE.test(String(v)))
    .withMessage("Enter a 10-digit mobile number without +91");

const intervalList = (path) =>
  body(path)
    .optional()
    .isArray({ max: 3 })
    .custom((list) => list.every((i) => TIME_RE.test(i?.open) && TIME_RE.test(i?.close) && i.open < i.close))
    .withMessage("Opening hours must be HH:mm with open before close");

router.get("/settings", async (_req, res) => {
  try {
    const doc = await SiteSettings.getSingleton();
    // Show the starting review list until the owner saves their own (CF D27).
    const json = doc.toJSON();
    json.reviews = { ...(json.reviews || {}), featured: doc.featuredReviews() };
    // Show the starting owner text until the owner saves their own (CF D32).
    json.owner = doc.ownerProfile();
    // Show the starting gallery until the owner saves their own (CF D33).
    if (!Array.isArray(doc.media?.gallery)) json.media = { ...(json.media || {}), gallery: require("../config/gallery") };
    // …and the starting hero slider (CF D31), unless a single hero video is set.
    if (!Array.isArray(doc.media?.heroSlides) && !doc.media?.heroVideoUrl) json.media = { ...(json.media || {}), heroSlides: require("../config/heroSlides") };
    return res.json(json);
  } catch (err) {
    console.error("[website] settings error:", err);
    return res.status(500).json({ error: "Failed to load settings" });
  }
});

router.patch(
  "/settings",
  [
    nullablePhone("contact.phone"),
    nullablePhone("contact.whatsapp"),
    body("contact.address").optional().isString().trim().isLength({ max: 200 }),
    body("contact.mapUrl")
      .optional({ nullable: true })
      .customSanitizer((v) => (v === "" ? null : v))
      .custom((v) => v === null || /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/.test(v))
      .withMessage("Use a Google Maps link (https://maps.app.goo.gl/…)"),
    // Google's "Embed a map" gives a whole <iframe …>; keep only its src.
    body("contact.mapEmbedUrl")
      .optional({ nullable: true })
      .customSanitizer((v) => {
        if (typeof v !== "string") return v;
        const t = v.trim();
        if (t === "") return null;
        const m = t.match(/src=["']([^"']+)["']/i);
        return (m ? m[1] : t).replace(/&amp;/g, "&");
      })
      .custom((v) => v === null || /^https:\/\/(www\.google\.com\/maps\/embed\?pb=|maps\.google\.com\/maps\?[^<>"']*output=embed)/.test(v))
      .withMessage("Paste the code from Google Maps → Share → Embed a map"),
    body("contact.instagram")
      .optional({ nullable: true })
      .customSanitizer((v) => (v === "" ? null : typeof v === "string" ? v.replace(/^@/, "").trim() : v))
      .custom((v) => v === null || /^[A-Za-z0-9._]{1,30}$/.test(v))
      .withMessage("Instagram handle, without the @"),
    body("contact.placeId").optional({ nullable: true }).isString().isLength({ max: 200 }),
    ...SiteSettings.DAYS.map((d) => intervalList(`openingHours.${d}`)),
    body("holidays")
      .optional()
      .isArray({ max: 60 })
      .custom((list) => list.every(isValidDate))
      .withMessage("Holidays must be YYYY-MM-DD dates"),
    ...["morning", "afternoon", "evening"].map((w) =>
      body(`requestWindows.${w}`)
        .optional()
        .custom((v) => v && typeof v.label === "string" && TIME_RE.test(v.start) && TIME_RE.test(v.end) && v.start < v.end)
        .withMessage(`${w} window needs a label and HH:mm start before end`)
    ),
    body("horizonDays").optional().isInt({ min: 1, max: 120 }),
    body("requestSlaMinutes").optional().isInt({ min: 15, max: 24 * 60 }),
    body("maxActiveBookingsPerPhone").optional().isInt({ min: 1, max: 10 }),
    body("contact.parkingNote")
      .optional({ nullable: true })
      .customSanitizer((v) => (v === "" ? null : v))
      .custom((v) => v === null || (typeof v === "string" && v.length <= 140)),
    nullableUrl("media.heroVideoUrl"),
    nullableUrl("media.heroPosterUrl"),
    nullableUrl("media.forHerImage"),
    nullableUrl("media.forHimImage"),
    body("media.salonImages").optional().isArray({ max: 12 }),
    body("media.salonImages.*").isURL(HTTPS_URL),
    body("media.gallery").optional().isArray({ max: 12 }).withMessage("Up to 12 gallery photos"),
    body("media.gallery.*.url")
      .custom((v) => typeof v === "string" && (/^https:\/\/\S+$/.test(v) || /^\/images\/[\w./-]+$/.test(v)))
      .withMessage("Each gallery photo needs an https link"),
    body("media.gallery.*.caption").optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
    body("media.heroSlides").optional().isArray({ max: 10 }).withMessage("Up to 10 slides"),
    body("media.heroSlides.*.kind").isIn(["video", "image"]).withMessage("Each slide is a video or a photo"),
    body("media.heroSlides.*.url").custom(siteOrHttps).withMessage("Each slide needs an https link"),
    body("media.heroSlides.*.poster").optional({ nullable: true }).custom(siteOrHttps),
    body("media.heroSlides.*.alt").optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body("media.heroSlides.*.wideUrl").optional({ nullable: true }).custom(siteOrHttps),
    body("media.heroSlides.*.widePoster").optional({ nullable: true }).custom(siteOrHttps),
    body("transformations").optional().isArray({ max: 12 }),
    body("transformations.*.before").isURL(HTTPS_URL).withMessage("Before photo needs an https link"),
    body("transformations.*.after").isURL(HTTPS_URL).withMessage("After photo needs an https link"),
    body("transformations.*.caption").optional({ nullable: true }).isString().isLength({ max: 80 }),
    // A client's photo is published only with their recorded consent (CLAUDE.md, Privacy).
    body("transformations.*.consent").isBoolean({ strict: true }).withMessage("Record whether the client agreed to the photo"),
    // Google rating + selected reviews, copied from the salon's Google profile (CF D27).
    body("reviews.rating")
      .optional({ nullable: true })
      .customSanitizer((v) => (v === "" ? null : v))
      .custom((v) => v === null || (typeof v === "number" && v >= 1 && v <= 5))
      .withMessage("Rating is a number from 1 to 5, as shown on Google"),
    body("reviews.count")
      .optional({ nullable: true })
      .customSanitizer((v) => (v === "" ? null : v))
      .custom((v) => v === null || (Number.isInteger(v) && v >= 0))
      .withMessage("Review count is a whole number"),
    body("reviews.url")
      .optional({ nullable: true })
      .customSanitizer((v) => (v === "" ? null : v))
      .custom((v) => v === null || /^https:\/\/(www\.)?(google\.[a-z.]+\/|maps\.app\.goo\.gl|goo\.gl\/maps|g\.page)/.test(v))
      .withMessage("Use the link to the salon's Google page"),
    body("reviews.featured").optional().isArray({ max: 12 }),
    body("reviews.featured.*.author").isString().trim().isLength({ min: 1, max: 60 }).withMessage("Each review needs the reviewer's name"),
    body("reviews.featured.*.rating").isInt({ min: 1, max: 5 }).withMessage("Each review needs its star rating (1–5)"),
    body("reviews.featured.*.text").isString().trim().isLength({ min: 1, max: 600 }).withMessage("Each review needs its text (up to 600 characters)"),
    body("reviews.featured.*.service").optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
    body("reviews.featured.*.visible").optional().isBoolean({ strict: true }),
    // Meet the owner (CF D32).
    body("owner.name").optional({ nullable: true }).isString().trim().isLength({ max: 60 }),
    body("owner.title").optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
    body("owner.bio").optional({ nullable: true }).isString().trim().isLength({ max: 1200 }),
    body("owner.photo")
      .optional({ nullable: true })
      .customSanitizer((v) => (v === "" ? null : v))
      .custom((v) => v === null || /^https:\/\/\S+$/.test(v) || /^\/images\/[\w./-]+$/.test(v))
      .withMessage("Owner photo needs an https link"),
    body("owner.visible").optional().isBoolean({ strict: true }),
    body("forceHolidays").optional().isBoolean({ strict: true }),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const doc = await SiteSettings.getSingleton();
      const before = doc.toObject();

      // E23: a new holiday over existing bookings is shown to the owner first.
      // Saving anyway closes the day online; the bookings stay for reception
      // to move or cancel (never cancelled automatically).
      if (Array.isArray(req.body.holidays) && req.body.forceHolidays !== true) {
        const added = [...new Set(req.body.holidays)].filter((d) => !(before.holidays || []).includes(d));
        const { bookingsOverlapping } = require("../utils/booking");
        const { salonInstant, addDays } = require("../utils/time");
        const conflicts = [];
        for (const d of added) {
          const list = await bookingsOverlapping({ from: salonInstant(d, "00:00"), to: salonInstant(addDays(d, 1), "00:00") });
          conflicts.push(...list.map((c) => ({ ...c, date: d })));
        }
        if (conflicts.length) {
          return res.status(409).json({
            error: `${conflicts.length} booking${conflicts.length === 1 ? "" : "s"} on the new holiday${added.length === 1 ? "" : "s"}. Move them first, or save anyway.`,
            conflicts,
          });
        }
      }
      applyPaths(doc, req.body, SETTINGS_PATHS);
      if (Array.isArray(req.body.holidays)) doc.holidays = [...new Set(req.body.holidays)].sort();
      await doc.save();

      const changes = diffPaths(before, doc.toObject(), SETTINGS_PATHS);
      if (Object.keys(changes).length) {
        await audit.record({ action: "website.settings_changed", req, meta: { changes } });
        await revalidateSite(Object.keys(changes).some((k) => k.startsWith("reviews.")) ? ["site", "reviews"] : ["site"]);
      }
      return res.json(doc);
    } catch (err) {
      return saveError(res, err);
    }
  }
);

// ─── Artists (T1.2) ──────────────────────────────────────────────────────────

const ARTIST_PATHS = [
  "gender",
  "level",
  "onlineBookable",
  "publicProfile.slug",
  "publicProfile.displayName",
  "publicProfile.bio",
  "publicProfile.specialties",
  "publicProfile.photo",
  "publicProfile.portfolio",
  "publicProfile.instagram",
  "publicProfile.sortOrder",
  "publicProfile.visible",
];

/** Staff editor list. Includes name and photo, never commission or phone. */
router.get("/artists", async (_req, res) => {
  try {
    const artists = await Artist.find({ isActive: true }, { name: 1, photo: 1, ...Object.fromEntries(ARTIST_PATHS.map((p) => [p, 1])) })
      .sort({ name: 1 })
      .lean();
    return res.json(artists);
  } catch (err) {
    console.error("[website] artists error:", err);
    return res.status(500).json({ error: "Failed to load artists" });
  }
});

router.patch(
  "/artists/:id/public",
  validateId,
  [
    body("gender").optional({ nullable: true }).isIn([...Artist.GENDERS, null]),
    body("level").optional({ nullable: true }).isIn([...Artist.LEVELS, null]),
    body("onlineBookable").optional().isBoolean({ strict: true }),
    body("publicProfile.slug").optional().matches(SLUG_RE).withMessage("Slug: lowercase letters, numbers and hyphens"),
    body("publicProfile.displayName").optional({ nullable: true }).isString().trim().isLength({ max: 60 }),
    body("publicProfile.bio").optional({ nullable: true }).isString().trim().isLength({ max: 600 }),
    body("publicProfile.specialties").optional().isArray({ max: 8 }),
    body("publicProfile.specialties.*").isString().trim().isLength({ min: 1, max: 40 }),
    body("publicProfile.photo").optional({ nullable: true }).isURL({ protocols: ["https"], require_protocol: true }),
    body("publicProfile.portfolio").optional().isArray({ max: 24 }),
    body("publicProfile.portfolio.*").isURL({ protocols: ["https"], require_protocol: true }),
    body("publicProfile.instagram")
      .optional({ nullable: true })
      .customSanitizer((v) => (typeof v === "string" ? v.replace(/^@/, "").trim() || null : v))
      .custom((v) => v === null || /^[A-Za-z0-9._]{1,30}$/.test(v))
      .withMessage("Instagram handle, without the @"),
    body("publicProfile.sortOrder").optional().isInt({ min: 0, max: 999 }),
    // true / false, or null to go back to "shown while active".
    body("publicProfile.visible").optional({ nullable: true }).isBoolean({ strict: true }),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const artist = await Artist.findById(req.params.id);
      if (!artist) return res.status(404).json({ error: "Artist not found" });
      const before = artist.toObject();
      applyPaths(artist, req.body, ARTIST_PATHS);
      await artist.save();

      const changes = diffPaths(before, artist.toObject(), ARTIST_PATHS);
      if (Object.keys(changes).length) {
        await audit.record({
          action: "website.artist_profile_changed",
          req,
          target: { name: artist.name },
          meta: { artistId: String(artist._id), changes },
        });
        await revalidateSite(["artists"]);
      }
      return res.json(artist);
    } catch (err) {
      return saveError(res, err);
    }
  }
);

// ─── Services: website fields ────────────────────────────────────────────────

const SERVICE_PATHS = [
  "showOnWebsite",
  "slug",
  "publicName",
  "publicPrice",
  "audience",
  "displayCategory",
  "variantGroup",
  "variantLabel",
  "shortDescription",
  "description",
  "bookingMode",
  "requiresConsultation",
  "requiresPatchTest",
  "bufferMinutes",
  "featured",
  "sortOrder",
  "seo.title",
  "seo.description",
  "images",
];

router.patch(
  "/services/:id/public",
  validateId,
  [
    body("showOnWebsite").optional().isBoolean({ strict: true }),
    body("slug").optional().matches(SLUG_RE).withMessage("Slug: lowercase letters, numbers and hyphens"),
    body("publicName").optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
    body("publicPrice").optional({ nullable: true }).isInt({ min: 0 }).withMessage("Website price in whole rupees"),
    body("audience").optional({ nullable: true }).isIn([...Service.AUDIENCES, null]),
    body("displayCategory").optional({ nullable: true }).isIn([...Service.DISPLAY_CATEGORIES, null]),
    body("variantGroup").optional({ nullable: true }).custom((v) => v === null || SLUG_RE.test(v)),
    body("variantLabel").optional({ nullable: true }).isString().trim().isLength({ max: 30 }),
    body("shortDescription").optional({ nullable: true }).isString().trim().isLength({ max: 160 }),
    body("description").optional({ nullable: true }).isString().trim().isLength({ max: 4000 }),
    body("bookingMode").optional().isIn(Service.BOOKING_MODES),
    body("requiresConsultation").optional().isBoolean({ strict: true }),
    body("requiresPatchTest").optional().isBoolean({ strict: true }),
    body("bufferMinutes").optional().isInt({ min: 0, max: 120 }),
    body("featured").optional().isBoolean({ strict: true }),
    body("sortOrder").optional().isInt({ min: 0, max: 9999 }),
    body("seo.title").optional({ nullable: true }).isString().isLength({ max: 70 }),
    body("seo.description").optional({ nullable: true }).isString().isLength({ max: 160 }),
    // The owner's own photo(s) for this service (Vercel Blob). The first one
    // replaces the stock photo on the website (CF D30). [] goes back to stock.
    body("images").optional().isArray({ max: 4 }),
    body("images.*").isURL(HTTPS_URL).withMessage("Photo needs an https link"),
  ],
  async (req, res) => {
    if (firstError(req, res)) return;
    try {
      const service = await Service.findById(req.params.id);
      if (!service) return res.status(404).json({ error: "Service not found" });
      const before = service.toObject();
      applyPaths(service, req.body, SERVICE_PATHS);
      if (service.showOnWebsite && (service.publicPrice == null || !service.slug)) {
        return res.status(400).json({ error: "A service on the website needs a website price and a URL name (slug)" });
      }
      await service.save();

      const changes = diffPaths(before, service.toObject(), SERVICE_PATHS);
      if (Object.keys(changes).length) {
        await audit.record({
          action: "service.updated",
          req,
          target: { name: service.name },
          meta: { serviceId: String(service._id), changes, via: "website" },
        });
        await revalidateSite(["services", "packages"]);
      }
      return res.json(service);
    } catch (err) {
      return saveError(res, err);
    }
  }
);

/** Menu editor: every active service with the fields the editor shows. */
router.get("/services", async (_req, res) => {
  try {
    const services = await Service.find(
      { isActive: true },
      { name: 1, category: 1, price: 1, durationMinutes: 1, durationConfirmed: 1, ...Object.fromEntries(SERVICE_PATHS.map((p) => [p.split(".")[0], 1])) }
    )
      .sort({ displayCategory: 1, sortOrder: 1, name: 1 })
      .lean();
    return res.json(services);
  } catch (err) {
    console.error("[website] services error:", err);
    return res.status(500).json({ error: "Failed to load services" });
  }
});

// ─── Reels (T1.20) ───────────────────────────────────────────────────────────

const reelValidators = (partial) => [
  (partial ? body("mediaUrl").optional() : body("mediaUrl")).isURL(HTTPS_URL).withMessage("Video or photo needs an https link"),
  body("mediaType").optional().isIn(["video", "image"]),
  nullableUrl("thumbnailUrl"),
  nullableUrl("permalink"),
  body("caption").optional({ nullable: true }).isString().trim().isLength({ max: 300 }),
  body("visible").optional().isBoolean({ strict: true }),
  body("serviceId").optional({ nullable: true }).custom((v) => v === null || /^[a-f0-9]{24}$/i.test(v)),
  body("sortOrder").optional().isInt({ min: 0, max: 999 }),
];
const REEL_FIELDS = ["mediaUrl", "mediaType", "thumbnailUrl", "permalink", "caption", "visible", "serviceId", "sortOrder"];

router.get("/reels", async (_req, res) => {
  try {
    return res.json(await Reel.find({}).sort({ sortOrder: 1, postedAt: -1 }).lean());
  } catch (err) {
    console.error("[website] reels error:", err);
    return res.status(500).json({ error: "Failed to load reels" });
  }
});

router.post("/reels", reelValidators(false), async (req, res) => {
  if (firstError(req, res)) return;
  try {
    const reel = await Reel.create(Object.fromEntries(REEL_FIELDS.filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]])));
    await audit.record({ action: "website.reel_changed", req, meta: { reelId: String(reel._id), op: "created" } });
    await revalidateSite(["reels"]);
    return res.status(201).json(reel);
  } catch (err) {
    return saveError(res, err);
  }
});

router.patch("/reels/:id", validateId, reelValidators(true), async (req, res) => {
  if (firstError(req, res)) return;
  try {
    const reel = await Reel.findById(req.params.id);
    if (!reel) return res.status(404).json({ error: "Reel not found" });
    const before = reel.toObject();
    applyPaths(reel, req.body, REEL_FIELDS);
    await reel.save();
    const changes = diffPaths(before, reel.toObject(), REEL_FIELDS);
    if (Object.keys(changes).length) {
      await audit.record({ action: "website.reel_changed", req, meta: { reelId: String(reel._id), op: "updated", changes } });
      await revalidateSite(["reels"]);
    }
    return res.json(reel);
  } catch (err) {
    return saveError(res, err);
  }
});

router.delete("/reels/:id", validateId, async (req, res) => {
  try {
    const reel = await Reel.findByIdAndDelete(req.params.id);
    if (!reel) return res.status(404).json({ error: "Reel not found" });
    await audit.record({ action: "website.reel_changed", req, meta: { reelId: String(reel._id), op: "deleted", mediaUrl: reel.mediaUrl } });
    await revalidateSite(["reels"]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[website] reel delete error:", err);
    return res.status(500).json({ error: "Failed to delete reel" });
  }
});

// ─── Offers / campaigns (CF D29, T3.1 brought forward) ──────────────────────

/** Where an offer's button may point: a page on this site, or an https link. */
const SAFE_HREF = (v) => typeof v === "string" && (/^\/(?!\/)[^\s]*$/.test(v) || /^https:\/\/[^\s]+$/.test(v));

const campaignValidators = (partial) => {
  const req = (path) => (partial ? body(path).optional() : body(path));
  return [
    req("name").isString().trim().isLength({ min: 1, max: 80 }).withMessage("Give the offer a name"),
    req("startDate").custom(isValidDate).withMessage("Start date must be YYYY-MM-DD"),
    req("endDate").custom(isValidDate).withMessage("End date must be YYYY-MM-DD"),
    body("active").optional().isBoolean({ strict: true }),
    body("theme").optional().isIn(Campaign.THEMES),
    body("showBar").optional().isBoolean({ strict: true }),
    body("showPopup").optional().isBoolean({ strict: true }),
    body("content.eyebrow").optional({ nullable: true }).isString().trim().isLength({ max: 30 }),
    req("content.headline").isString().trim().isLength({ min: 1, max: 90 }).withMessage("The offer needs a headline"),
    body("content.body").optional({ nullable: true }).isString().trim().isLength({ max: 220 }),
    nullableUrl("content.image"),
    body("content.ctaLabel").optional({ nullable: true }).isString().trim().isLength({ max: 30 }),
    req("content.ctaHref").custom(SAFE_HREF).withMessage("Button link must be a page on the site (/offers/…) or an https link"),
    body("popup.delaySeconds").optional().isInt({ min: 5, max: 60 }).withMessage("Pop-up delay is 5–60 seconds"),
    body("popup.frequency").optional().isIn(Campaign.FREQUENCIES),
    body("sortOrder").optional().isInt({ min: 0, max: 999 }),
    // Cheaper prices that run on the offer's dates (D59). The amounts are checked
    // against the real menu prices in prepareOfferLines before anything is saved.
    body("servicePrices").optional().isArray({ max: 60 }).withMessage("Too many service prices"),
    body("servicePrices.*.serviceId").matches(/^[a-f0-9]{24}$/i).withMessage("Pick a service"),
    body("servicePrices.*.price").isInt({ min: 1, max: 100000 }).withMessage("Offer prices are whole rupees").toInt(),
    body("bundles").optional().isArray({ max: 10 }).withMessage("At most 10 bundles per offer"),
    body("bundles.*.name").isString().trim().isLength({ min: 1, max: 60 }).withMessage("Give each bundle a name"),
    body("bundles.*.description").optional({ nullable: true }).isString().trim().isLength({ max: 160 }),
    body("bundles.*.audience").optional().isIn(Campaign.AUDIENCES),
    body("bundles.*.slug").optional({ nullable: true }).matches(/^[a-z0-9-]{1,80}$/),
    body("bundles.*.serviceIds").isArray({ min: 2, max: 12 }).withMessage("A bundle needs 2 to 12 services"),
    body("bundles.*.serviceIds.*").matches(/^[a-f0-9]{24}$/i).withMessage("Pick a service"),
    body("bundles.*.price").isInt({ min: 1, max: 100000 }).withMessage("Bundle prices are whole rupees").toInt(),
    // The offer's landing page (D62). All optional; a page exists once it has an address (slug).
    body("page.slug")
      .optional({ nullable: true })
      .isString()
      .trim()
      .toLowerCase()
      .matches(/^[a-z0-9][a-z0-9-]{2,59}$/)
      .withMessage("The page address is 3 to 60 letters, numbers or dashes")
      .custom((v) => !offerPages.RESERVED_SLUGS.has(v))
      .withMessage("That page address is already used by the site"),
    body("page.headline").optional({ nullable: true }).isString().trim().isLength({ max: 90 }),
    body("page.offerText").optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body("page.price").optional({ nullable: true }).isInt({ min: 1, max: 1000000 }).withMessage("The page price is whole rupees").toInt(),
    body("page.priceNote").optional({ nullable: true }).isString().trim().isLength({ max: 60 }),
    nullableUrl("page.image"),
    body("page.images").optional().isArray({ max: 5 }).withMessage("At most 5 pictures on an offer page"),
    body("page.images.*").isString().matches(/^https:\/\/\S+$/).isLength({ max: 1000 }).withMessage("Use an https link"),
    body("page.reelId").optional({ nullable: true }).matches(/^[a-f0-9]{24}$/i).withMessage("Unknown reel"),
    body("page.serviceIds").optional().isArray({ max: 12 }).withMessage("At most 12 services on an offer page"),
    body("page.serviceIds.*").matches(/^[a-f0-9]{24}$/i).withMessage("Pick a service"),
  ];
};
const CAMPAIGN_PATHS = [
  "name",
  "startDate",
  "endDate",
  "active",
  "theme",
  "showBar",
  "showPopup",
  "content.eyebrow",
  "content.headline",
  "content.body",
  "content.image",
  "content.ctaLabel",
  "content.ctaHref",
  "popup.delaySeconds",
  "popup.frequency",
  "sortOrder",
  "servicePrices",
  "bundles",
  "page.slug",
  "page.headline",
  "page.offerText",
  "page.price",
  "page.priceNote",
  "page.image",
  "page.images",
  "page.reelId",
  "page.serviceIds",
];
/** Offer prices change what the site sells, so these tags go with the usual "campaigns". */
const OFFER_TAGS = ["campaigns", "services", "packages"];
const withStatus = (c, today) => ({ ...c.toObject(), status: c.statusOn(today) });

/** An offer page needs services to pre-select, and every one of them must be on the public menu. */
async function offerPageProblem(c) {
  if (!c.page?.slug) return null;
  const ids = (c.page.serviceIds || []).map(String);
  if (!ids.length) return "Pick at least one service for the offer page";
  const found = await Service.countDocuments({ ...PUBLIC_SERVICE_FILTER, _id: { $in: ids } });
  if (found !== new Set(ids).size) return "One of the offer page's services is not on the public menu";
  return null;
}

router.get("/campaigns", async (_req, res) => {
  try {
    const today = salonDate();
    const list = await Campaign.find({}).sort({ endDate: -1, sortOrder: 1 });
    return res.json(list.map((c) => withStatus(c, today)));
  } catch (err) {
    console.error("[website] campaigns error:", err);
    return res.status(500).json({ error: "Failed to load offers" });
  }
});

// ─── Read a poster (D63) ─────────────────────────────────────────────────────
/**
 * POST /campaigns/read-poster  { imageUrl }
 * Reads a picture of an offer poster and returns a DRAFT: each package with its price and its
 * lines, each line matched to the salon's own menu where that is clear. Saves nothing. The
 * owner checks and edits every line in the staff app before any bundle exists.
 * 20 reads per person per day (each is a paid AI call).
 */
router.post(
  "/campaigns/read-poster",
  [body("imageUrl").isString().matches(/^https:\/\/\S+$/).isLength({ max: 1000 }).withMessage("Upload the poster first")],
  async (req, res) => {
    if (firstError(req, res)) return;
    if (!posterReader.isConfigured()) {
      return res.status(503).json({ error: "Reading posters isn't set up yet. Ask your developer to add the OpenAI or Claude key. You can still type the bundles in." });
    }
    try {
      const who = String(req.session?.userId || "owner");
      const allowed = await hit({ name: "poster-read", id: who, windowMs: 24 * 60 * 60 * 1000, max: 20 });
      if (!allowed.allowed) return res.status(429).json({ error: "You've read 20 posters today. Try again tomorrow, or type the bundles in." });

      const draft = await posterReader.readPoster({ imageUrl: req.body.imageUrl });
      if (!draft.packages.length) {
        return res.status(422).json({ error: draft.notes[0] || "I couldn't find any packages on that picture. Try a clearer picture of the poster." });
      }
      const menu = await Service.find({ isActive: true, publicPrice: { $ne: null } }, { name: 1, publicName: 1, publicPrice: 1 }).lean();
      const packages = draft.packages.map((p) => {
        const lines = p.services.map((line) => matchLine(line, menu));
        const matched = lines.filter((l) => l.match);
        return { ...p, lines, separatelyTotal: matched.reduce((n, l) => n + l.match.price, 0) };
      });
      await audit.record({ action: "website.poster_read", req, meta: { packages: packages.length, lines: packages.reduce((n, p) => n + p.lines.length, 0) } });
      return res.json({ title: draft.title, notes: draft.notes, packages });
    } catch (err) {
      if (err instanceof posterReader.PosterReaderError) return res.status(err.status).json({ error: err.message });
      console.error("[website] read-poster error:", err);
      return res.status(500).json({ error: "Reading the poster didn't work. Type the bundles in instead." });
    }
  }
);

router.post("/campaigns", campaignValidators(false), async (req, res) => {
  if (firstError(req, res)) return;
  try {
    const c = new Campaign({});
    const lines = await offers.prepareOfferLines(req.body);
    applyPaths(c, { ...req.body, servicePrices: lines.servicePrices, bundles: lines.bundles }, CAMPAIGN_PATHS);
    const pageProblem = await offerPageProblem(c);
    if (pageProblem) return res.status(400).json({ error: pageProblem });
    await c.save();
    offers.clearOffersCache();
    await audit.record({ action: "website.campaign_changed", req, meta: { campaignId: String(c._id), op: "created", name: c.name } });
    await revalidateSite(OFFER_TAGS);
    return res.status(201).json(withStatus(c, salonDate()));
  } catch (err) {
    return saveError(res, err);
  }
});

router.patch("/campaigns/:id", validateId, campaignValidators(true), async (req, res) => {
  if (firstError(req, res)) return;
  try {
    const c = await Campaign.findById(req.params.id);
    if (!c) return res.status(404).json({ error: "Offer not found" });
    const before = c.toObject();
    const lines = await offers.prepareOfferLines(req.body, before.bundles);
    applyPaths(c, { ...req.body, servicePrices: lines.servicePrices, bundles: lines.bundles }, CAMPAIGN_PATHS);
    const pageProblem = await offerPageProblem(c);
    if (pageProblem) return res.status(400).json({ error: pageProblem });
    await c.save();
    offers.clearOffersCache();
    const changes = diffPaths(before, c.toObject(), CAMPAIGN_PATHS);
    if (Object.keys(changes).length) {
      await audit.record({ action: "website.campaign_changed", req, meta: { campaignId: String(c._id), op: "updated", changes } });
      await revalidateSite(OFFER_TAGS);
    }
    return res.json(withStatus(c, salonDate()));
  } catch (err) {
    return saveError(res, err);
  }
});

router.delete("/campaigns/:id", validateId, async (req, res) => {
  try {
    const c = await Campaign.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ error: "Offer not found" });
    offers.clearOffersCache();
    await audit.record({ action: "website.campaign_changed", req, meta: { campaignId: String(c._id), op: "deleted", name: c.name } });
    await revalidateSite(OFFER_TAGS);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[website] campaign delete error:", err);
    return res.status(500).json({ error: "Failed to delete offer" });
  }
});

// ─── Uploads (Vercel Blob client upload) ─────────────────────────────────────

/**
 * The staff browser uploads straight to Vercel Blob; this only hands out a
 * short-lived token for one file. Files never pass through the API (Vercel
 * functions accept ~4.5 MB bodies; a reel is bigger). Needs
 * BLOB_READ_WRITE_TOKEN (Vercel → Storage → Blob, free tier). Without it the
 * staff app falls back to pasting a link.
 */
const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "video/mp4", "video/webm"];
router.post("/media/upload", async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: "Uploads aren't set up yet. Paste a link instead." });
  }
  try {
    const { handleUpload } = require("@vercel/blob/client");
    const out = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^website\/[a-z0-9._/-]+$/i.test(pathname)) throw new Error("Bad file name");
        return {
          allowedContentTypes: UPLOAD_TYPES,
          maximumSizeInBytes: 60 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ by: String(req.session?.userId || "") }),
        };
      },
    });
    return res.json(out);
  } catch (err) {
    console.error("[website] upload token error:", err.message);
    return res.status(400).json({ error: err.message || "Upload failed" });
  }
});

module.exports = router;
