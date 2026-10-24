/**
 * @file public.js
 * @description The customer website's API — `/api/public/*`
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §14, T1.7). No login, no cookies.
 *
 * Phase 1 surface:
 *   GET  /site               settings subset: hours, request windows, contact
 *   GET  /services?for=      public menu, variants grouped into cards
 *   GET  /services/:slug     one card with description + SEO
 *   GET  /artists            active artists the owner hasn't hidden (K6)
 *   GET  /artists/:slug
 *   GET  /packages           live static packages (config/packages.js)
 *   GET  /reels              visible reels (T1.20)
 *   GET  /reviews            Google rating + reviews, cached daily (T1.21)
 *   GET  /campaigns          offers live now or starting within 7 days (CF D29)
 *   POST /requests           request-lite booking (§6.1): Turnstile + Mongo limits
 *   + routes/publicBooking.js: /availability, /quote, /otp/*, /appointments (Phase 2)
 *
 * ── Mounted BEFORE the session and the global limiter (index.js) ─────────────
 * Public visitors have no session, so express-session never runs for them and
 * never sets a cookie on the customer domain (CLAUDE.md, "Do not expose staff
 * routes, sessions or cookies"). The global in-memory limiter is sized for a
 * salon where every device shares one IP; public routes carry their own
 * Mongo-backed limits instead (§14, T1.6).
 *
 * ── What a response may contain ──────────────────────────────────────────────
 * Only the shapes in utils/publicCatalogue.js and SiteSettings.toPublic(). Never
 * list prices, commission, staff phones, internal notes or another customer's
 * data. test/public-api.test.js asserts this on every route.
 *
 * ── Request-lite honesty ─────────────────────────────────────────────────────
 * POST /requests creates a REQUEST. It does not check availability and holds no
 * slot, so nothing it returns may say "booked" or "confirmed" (§6.1, CP1).
 */

const express = require("express");
const { body, query, param, validationResult } = require("express-validator");
const connectDB = require("../db");
const Service = require("../models/Service");
const Artist = require("../models/Artist");
const Customer = require("../models/Customer");
const Appointment = require("../models/Appointment");
const SiteSettings = require("../models/SiteSettings");
const Reel = require("../models/Reel");
const ReviewCache = require("../models/ReviewCache");
const Campaign = require("../models/Campaign");
const { clientsServed } = require("../utils/publicStats");
const packages = require("../config/packages");
const { liveOffers, applyOffers } = require("../utils/offers");
const { groupBySlug } = require("../config/menuGroups");
const { PUBLIC_SERVICE_FILTER, PUBLIC_ARTIST_FILTER, audienceFilter, serviceCards, cardSlugFor, publicArtist, assignPublicSlugs } =
  require("../utils/publicCatalogue");
const { mongoRateLimit, hit } = require("../middleware/mongoRateLimit");
const { verifyTurnstile } = require("../utils/turnstile");
const { alertNewRequest } = require("../utils/bookingAlerts");
const { clientIp } = require("../utils/audit");
const metaCapi = require("../utils/metaCapi");
const { salonDate, isValidDate, daysBetween, salonInstant, weekdayKey, addDays } = require("../utils/time");

const router = express.Router();

const MAX_ITEMS = 8;
const HOUR = 60 * 60 * 1000;

// ── Ensure DB on every request (Vercel cold start) ──────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[public] DB error:", err.message);
    res.status(503).json({ error: "UNAVAILABLE", message: "Try again in a moment." });
  }
});

/** Reads: generous per-IP limit, enough for a page that loads several feeds. */
const readLimit = mongoRateLimit({ name: "public-read", windowMs: 60_000, max: 120 });

/**
 * Short shared-cache window so Vercel's edge absorbs bursts (an ad going live)
 * while an owner edit still reaches the site within a minute or two.
 */
function cacheFor(res, seconds) {
  res.set("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`);
}

function sendValidation(res, errors) {
  return res.status(400).json({
    error: "VALIDATION",
    message: errors[0]?.msg || "Check the details and try again.",
    fields: errors.map((e) => e.path),
  });
}

// ─── GET /site ───────────────────────────────────────────────────────────────
router.get("/site", readLimit, async (_req, res) => {
  try {
    const [settings, reviews, clients, anyOnline] = await Promise.all([
      SiteSettings.getSingleton(),
      ReviewCache.findOne({ key: "google" }, { rating: 1, count: 1, mapsUri: 1 }).lean(),
      clientsServed(),
      Artist.exists({ isActive: true, onlineBookable: true }),
    ]);
    cacheFor(res, 60);
    // Phase 2 (T2.22): the website offers live booking only when an artist is
    // switched on AND payments and WhatsApp codes can actually work; otherwise
    // it stays on request-lite. Switching every artist off is the rollback (CP4).
    const payments = require("../utils/payments");
    const whatsapp = require("../utils/whatsapp");
    const canSendCodes = whatsapp.isConfigured() && Boolean(whatsapp.templateFor("otp"));
    const onlineBooking = {
      enabled: Boolean(anyOnline) && payments.isConfigured() && (canSendCodes || process.env.NODE_ENV !== "production"),
      maxGuests: settings.maxGuests,
      holdMinutes: settings.holdMinutes,
      cancellationFeePercent: settings.cancellationFeePercent ?? 30,
      cancellationFeeMin: settings.cancellationFeeMin ?? 100,
      noticeHours: settings.cancellationCutoffHours ?? 24,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
    };
    return res.json({
      ...settings.toPublic(),
      onlineBooking,
      // Live from Google when the Places feed runs; otherwise the figures the
      // owner copied from the salon's Google profile (CF D27). Never invented.
      rating: reviews?.rating
        ? { value: reviews.rating, count: reviews.count, mapsUri: reviews.mapsUri, source: "Google" }
        : (() => {
            const manual = settings.manualReviewsPublic().rating;
            return manual ? { ...manual, source: "Google" } : null;
          })(),
      // Counted from paid Visits and rounded down, never typed in (CF D28).
      stats: { clientsServed: clients },
    });
  } catch (err) {
    console.error("[public] site error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ─── GET /services ───────────────────────────────────────────────────────────
router.get(
  "/services",
  readLimit,
  [query("for").optional().isIn(["her", "him"]).withMessage("for must be her or him")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendValidation(res, errors.array());
    try {
      const services = await Service.find({ ...PUBLIC_SERVICE_FILTER, ...audienceFilter(req.query.for) }).lean();
      cacheFor(res, 60);
      return res.json({ services: serviceCards(applyOffers(services, await liveOffers())) });
    } catch (err) {
      console.error("[public] services error:", err);
      return res.status(500).json({ error: "SERVER_ERROR" });
    }
  }
);

// ─── GET /services/:slug ─────────────────────────────────────────────────────
router.get(
  "/services/:slug",
  readLimit,
  [param("slug").matches(/^[a-z0-9-]{1,120}$/)],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(404).json({ error: "NOT_FOUND" });
    try {
      const { slug } = req.params;
      const hitDoc = await Service.findOne({
        ...PUBLIC_SERVICE_FILTER,
        $or: [{ slug }, { variantGroup: slug }],
      }).lean();

      let members;
      if (hitDoc?.variantGroup) {
        members = await Service.find({ ...PUBLIC_SERVICE_FILTER, variantGroup: hitDoc.variantGroup }).lean();
      } else {
        // A website menu group (D34): by its own slug, or by any member's old URL.
        const groupSlug = hitDoc ? cardSlugFor(hitDoc) : groupBySlug(slug) ? slug : null;
        if (groupSlug && groupBySlug(groupSlug)) {
          const all = await Service.find({ ...PUBLIC_SERVICE_FILTER, variantGroup: null }).lean();
          members = all.filter((s) => cardSlugFor(s) === groupSlug);
        } else {
          members = hitDoc ? [hitDoc] : [];
        }
      }
      if (!members.length) return res.status(404).json({ error: "NOT_FOUND" });
      cacheFor(res, 60);
      return res.json({ service: serviceCards(applyOffers(members, await liveOffers()), { detail: true })[0] });
    } catch (err) {
      console.error("[public] service detail error:", err);
      return res.status(500).json({ error: "SERVER_ERROR" });
    }
  }
);

// ─── GET /artists ────────────────────────────────────────────────────────────

/**
 * Every artist the website lists, each with its URL key. The salon has a
 * handful of artists, so loading them all and matching a slug in memory is
 * simpler than storing a slug for each one.
 */
async function loadPublicArtists() {
  const artists = await Artist.find(PUBLIC_ARTIST_FILTER).sort({ "publicProfile.sortOrder": 1, name: 1 }).lean();
  const slugs = assignPublicSlugs(artists);
  return artists.map((a) => ({ doc: a, slug: slugs.get(String(a._id)) }));
}

router.get("/artists", readLimit, async (_req, res) => {
  try {
    const artists = await loadPublicArtists();
    cacheFor(res, 60);
    return res.json({ artists: artists.map((a) => publicArtist(a.doc, a.slug)) });
  } catch (err) {
    console.error("[public] artists error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

router.get(
  "/artists/:slug",
  readLimit,
  [param("slug").matches(/^[a-z0-9-]{1,80}$/)],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(404).json({ error: "NOT_FOUND" });
    try {
      const match = (await loadPublicArtists()).find((a) => a.slug === req.params.slug);
      if (!match) return res.status(404).json({ error: "NOT_FOUND" });
      cacheFor(res, 60);
      return res.json({ artist: publicArtist(match.doc, match.slug) });
    } catch (err) {
      console.error("[public] artist detail error:", err);
      return res.status(500).json({ error: "SERVER_ERROR" });
    }
  }
);

// ─── GET /packages ───────────────────────────────────────────────────────────

/**
 * Live packages with their items resolved against the public menu. Prices come
 * from config/packages.js (owner-approved) — never computed from a request.
 */
/**
 * A package item must be active, have a website price and not be walk-in only.
 * It need not be on the menu by itself, so `showOnWebsite` and the default
 * `bookingMode: "hidden"` don't exclude it (config/packages.js).
 */
const PACKAGE_ITEM_FILTER = Object.freeze({
  isActive: true,
  publicPrice: { $ne: null },
  bookingMode: { $nin: ["walkin_only"] },
});

function isLive(p, today) {
  if (p.draft) return false;
  if (p.validFrom && today < p.validFrom) return false;
  if (p.validTo && today > p.validTo) return false;
  return true;
}

async function livePackages(today = salonDate()) {
  const live = packages.filter((p) => isLive(p, today));
  // Bundles the owner built inside a live offer (D59) book through the same path.
  const offers = await liveOffers(today);
  const ids = [...new Set([...live.flatMap((p) => p.serviceIds), ...offers.bundles.flatMap((b) => b.serviceIds)].map(String))];
  if (!ids.length) return [];
  const services = await Service.find({ ...PACKAGE_ITEM_FILTER, _id: { $in: ids } }).lean();
  const byId = new Map(services.map((s) => [String(s._id), s]));

  const out = [];
  const entries = [
    ...live.map((p) => ({ ...p, price: p.packagePrice })),
    ...offers.bundles.map((b) => ({ slug: b.slug, name: b.name, description: b.description, audience: b.audience, image: null, price: b.price, serviceIds: b.serviceIds, validFrom: b.validFrom, validTo: b.validTo, fromOffer: true })),
  ];
  for (const p of entries) {
    const items = p.serviceIds.map((id) => byId.get(String(id)));
    if (items.some((s) => !s)) {
      console.warn(`[public] package ${p.slug} names a service that is inactive or has no website price — hidden`);
      continue;
    }
    // A bundle that no longer costs less than its parts is not an offer: leave it out.
    if (p.fromOffer && !(p.price < items.reduce((sum, s) => sum + s.publicPrice, 0))) continue;
    out.push({
      slug: p.slug,
      name: p.name,
      description: p.description ?? null,
      audience: p.audience ?? null,
      image: p.image ?? null,
      price: p.price,
      validFrom: p.validFrom ?? null,
      validTo: p.validTo ?? null,
      items: items.map((s) => ({ id: String(s._id), name: s.publicName || s.name, price: s.publicPrice })),
    });
  }
  return out;
}

router.get("/packages", readLimit, async (_req, res) => {
  try {
    cacheFor(res, 60);
    return res.json({ packages: await livePackages() });
  } catch (err) {
    console.error("[public] packages error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ─── GET /reels, /reviews ────────────────────────────────────────────────────
// ─── GET /campaigns (CF D29) ────────────────────────────────────────────────
/**
 * Offers that are live now or start within the next 7 days (IST). Upcoming
 * ones are included so a cached page can switch the offer on at midnight IST
 * by itself: the site checks the dates again in the browser before showing
 * anything. Paused and ended offers never leave the server.
 */
router.get("/campaigns", readLimit, async (_req, res) => {
  try {
    const today = salonDate();
    const list = await Campaign.find({ active: true, endDate: { $gte: today }, startDate: { $lte: addDays(today, 7) } })
      .sort({ sortOrder: 1, startDate: 1 })
      .limit(5);
    cacheFor(res, 60);
    return res.json({ today, campaigns: list.map((c) => c.toPublic()) });
  } catch (err) {
    console.error("[public] campaigns error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

router.get("/reels", readLimit, async (_req, res) => {
  try {
    const reels = await Reel.find({ visible: true }).sort({ sortOrder: 1, postedAt: -1 }).limit(12).lean();
    const serviceIds = reels.map((r) => r.serviceId).filter(Boolean);
    const services = serviceIds.length
      ? await Service.find({ ...PUBLIC_SERVICE_FILTER, _id: { $in: serviceIds } }, { slug: 1, variantGroup: 1, publicName: 1, name: 1 }).lean()
      : [];
    const byId = new Map(services.map((s) => [String(s._id), s]));
    cacheFor(res, 60);
    return res.json({
      reels: reels.map((r) => {
        const s = r.serviceId ? byId.get(String(r.serviceId)) : null;
        return {
          id: String(r._id),
          mediaType: r.mediaType,
          mediaUrl: r.mediaUrl,
          thumbnailUrl: r.thumbnailUrl ?? null,
          permalink: r.permalink ?? null,
          caption: r.caption ?? null,
          // "Book this look" — only when the tagged service is on the menu.
          service: s ? { slug: cardSlugFor(s), name: s.publicName || s.name, optionId: String(s._id) } : null,
        };
      }),
    });
  } catch (err) {
    console.error("[public] reels error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

router.get("/reviews", readLimit, async (_req, res) => {
  try {
    const [doc, settings] = await Promise.all([ReviewCache.findOne({ key: "google" }).lean(), SiteSettings.getSingleton()]);
    cacheFor(res, 300);
    if (!doc?.rating) {
      // Places feed off: the owner's rating + selected reviews (CF D27). Marked
      // `curated` so the site labels them "selected", never "latest".
      const manual = settings.manualReviewsPublic();
      if (!manual.rating && !manual.reviews.length) return res.json({ rating: null, count: null, reviews: [], attribution: null });
      return res.json({
        rating: manual.rating?.value ?? null,
        count: manual.rating?.count ?? null,
        mapsUri: manual.rating?.mapsUri ?? null,
        reviews: manual.reviews.map((r) => ({ ...r, authorUri: null, profilePhoto: null, relativeTime: null })),
        attribution: "Selected from our Google reviews",
        curated: true,
      });
    }
    return res.json({
      rating: doc.rating,
      count: doc.count,
      mapsUri: doc.mapsUri ?? null,
      // As Google returns them: no editing, no filtering by rating (§13).
      reviews: (doc.reviews || []).slice(0, 6).map((r) => ({
        author: r.author,
        authorUri: r.authorUri ?? null,
        profilePhoto: r.profilePhoto ?? null,
        rating: r.rating,
        text: r.text,
        relativeTime: r.relativeTime,
      })),
      attribution: "Reviews from Google",
      fetchedAt: doc.fetchedAt,
    });
  } catch (err) {
    console.error("[public] reviews error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// ─── POST /requests — request-lite (§6.1) ────────────────────────────────────

const REQUEST_FIELDS = new Set([
  "services",
  "packageSlug",
  "date",
  "window",
  "for",
  "artistSlug",
  "name",
  "phone",
  "notes",
  "utm",
  "whatsappOptIn",
  "turnstileToken",
]);
const UTM_FIELDS = ["source", "medium", "campaign", "content", "fbclid"];

/** §18: public endpoints reject unknown fields rather than ignoring them. */
function rejectUnknownFields(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "VALIDATION", message: "Send the request as JSON." });
  }
  const unknown = Object.keys(body).filter((k) => !REQUEST_FIELDS.has(k));
  const badUtm =
    body.utm && typeof body.utm === "object" ? Object.keys(body.utm).filter((k) => !UTM_FIELDS.includes(k)) : [];
  if (unknown.length || badUtm.length) {
    return res.status(400).json({ error: "VALIDATION", message: "Unexpected fields.", fields: [...unknown, ...badUtm] });
  }
  return next();
}

/**
 * 10 requests per IP per hour. A family on one phone sending a few is normal;
 * CP1's "20 rapid requests from one IP" is not.
 */
const requestIpLimit = mongoRateLimit({ name: "request-ip", windowMs: HOUR, max: 10 });

const requestValidators = [
  body("services")
    .optional()
    .isArray({ max: MAX_ITEMS })
    .withMessage(`Choose up to ${MAX_ITEMS} services.`),
  body("services.*").isMongoId().withMessage("Unknown service."),
  body("packageSlug").optional({ nullable: true }).isString().matches(/^[a-z0-9-]{1,80}$/),
  body("date").custom(isValidDate).withMessage("Choose a date."),
  body("window").isIn(Appointment.WINDOWS).withMessage("Choose a time of day."),
  body("for").isIn(["her", "him"]).withMessage("Choose who the visit is for."),
  body("artistSlug").optional({ nullable: true }).isString().matches(/^[a-z0-9-]{1,80}$/),
  body("name")
    .isString()
    .trim()
    .isLength({ min: 2, max: 60 })
    .withMessage("Enter your name.")
    .matches(/^[\p{L}\p{M} .'-]+$/u)
    .withMessage("Enter your name using letters only."),
  body("phone")
    .customSanitizer((v) => Customer.normalisePhone(v))
    .custom((v) => v !== null)
    .withMessage("Enter a 10-digit mobile number."),
  body("notes").optional({ nullable: true }).isString().trim().isLength({ max: 300 }).withMessage("Keep the note under 300 characters."),
  body("utm").optional({ nullable: true }).isObject(),
  body("utm.*").optional({ nullable: true }).isString().isLength({ max: 255 }),
  body("whatsappOptIn").optional().isBoolean({ strict: true }),
  body("turnstileToken").optional({ nullable: true }).isString(),
];

function cleanUtm(utm) {
  if (!utm || typeof utm !== "object") return null;
  const out = {};
  for (const k of UTM_FIELDS) {
    if (typeof utm[k] === "string" && utm[k].trim()) out[k] = utm[k].trim().slice(0, k === "fbclid" ? 255 : 100);
  }
  return Object.keys(out).length ? out : null;
}

/** Is the salon open on `date`, and has the chosen window not already passed today? */
function dateProblem(settings, date, window, now = new Date()) {
  const today = salonDate(now);
  const ahead = daysBetween(today, date);
  if (ahead < 0) return "That date has passed.";
  if (ahead > settings.horizonDays) return `Choose a date within the next ${settings.horizonDays} days.`;
  if (settings.holidays.includes(date)) return "The salon is closed that day.";
  if (!(settings.openingHours?.[weekdayKey(date)] || []).length) return "The salon is closed that day.";
  if (ahead === 0) {
    const end = salonInstant(date, settings.requestWindows[window].end);
    if (end && end <= now) return "That time of day has passed. Choose a later window or another day.";
  }
  return null;
}

async function createWithUniqueRef(doc) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await Appointment.create({ ...doc, ref: Appointment.generateRef() });
    } catch (err) {
      if (err?.code === 11000 && err?.keyPattern?.ref) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a booking reference");
}

router.post("/requests", rejectUnknownFields, requestIpLimit, requestValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidation(res, errors.array());

  const b = req.body;
  const serviceIds = [...new Set(b.services || [])];
  if (!serviceIds.length && !b.packageSlug) {
    return res.status(400).json({ error: "VALIDATION", message: "Choose at least one service.", fields: ["services"] });
  }

  try {
    // Bots first: Turnstile before any further database work.
    const ts = await verifyTurnstile(b.turnstileToken, clientIp(req));
    if (!ts.ok) {
      return res.status(400).json({ error: "TURNSTILE_FAILED", message: "Couldn't verify you're human. Try again." });
    }

    // 5 requests per phone per day, across every instance and IP.
    const phoneHit = await hit({ name: "request-phone", id: b.phone, windowMs: 24 * HOUR, max: 5 });
    if (!phoneHit.allowed) {
      return res.status(429).json({ error: "LIMIT_REACHED", message: "You've sent several requests today. We'll be in touch." });
    }

    const settings = await SiteSettings.getSingleton();
    const problem = dateProblem(settings, b.date, b.window);
    if (problem) return res.status(400).json({ error: "OUTSIDE_HOURS", message: problem, fields: ["date"] });

    // ── Services: server-side prices only ─────────────────────────────────
    let pkg = null;
    if (b.packageSlug) {
      pkg = (await livePackages()).find((p) => p.slug === b.packageSlug);
      if (!pkg) return res.status(400).json({ error: "PACKAGE_UNAVAILABLE", message: "That package isn't available any more." });
    }
    // MAX_ITEMS limits what the customer adds; a package's own items don't count.
    const pkgIds = pkg ? pkg.items.map((i) => i.id) : [];
    const extraIds = serviceIds.filter((id) => !pkgIds.includes(id));
    const wantedIds = [...pkgIds, ...extraIds];
    const [menuServices, packageServices] = await Promise.all([
      Service.find({ ...PUBLIC_SERVICE_FILTER, _id: { $in: extraIds } }).lean(),
      pkgIds.length ? Service.find({ ...PACKAGE_ITEM_FILTER, _id: { $in: pkgIds } }).lean() : [],
    ]);
    // Single-service offer prices apply to what the customer added; a package's own items keep theirs (D59).
    const byId = new Map([...applyOffers(menuServices, await liveOffers()), ...packageServices].map((s) => [String(s._id), s]));
    if (wantedIds.some((id) => !byId.has(id))) {
      return res.status(400).json({ error: "SERVICE_UNAVAILABLE", message: "One of those services isn't available online. Refresh and try again." });
    }
    if (wantedIds.some((id) => byId.get(id).bookingMode === "walkin_only")) {
      return res.status(400).json({ error: "SERVICE_UNAVAILABLE", message: "One of those services is walk-in only." });
    }

    const items = wantedIds.map((id) => {
      const s = byId.get(id);
      return {
        serviceId: s._id,
        name: s.publicName || s.name,
        publicPrice: s.publicPrice,
        listPrice: s.price,
        durationMin: s.durationMinutes ?? null,
        bufferMin: s.bufferMinutes ?? 0,
      };
    });
    const subtotal = items.reduce((sum, i) => sum + i.publicPrice, 0);
    // A package is a fixed price for its items; anything added on top bills at
    // its own public price. The discount is derived, never sent by the browser.
    const pkgItemsTotal = pkg ? pkg.items.reduce((sum, i) => sum + i.price, 0) : 0;
    const discount = pkg ? Math.max(0, pkgItemsTotal - pkg.price) : 0;
    const total = subtotal - discount;

    // ── Artist preference (a wish, not an assignment) ─────────────────────
    let preferred = null;
    if (b.artistSlug) {
      preferred = (await loadPublicArtists()).find((a) => a.slug === b.artistSlug)?.doc ?? null;
    }

    // ── One active booking cap per phone (E11) ────────────────────────────
    const today = salonDate();
    const active = await Appointment.countDocuments({
      contact: b.phone,
      status: { $in: ["pending_payment", "requested", "confirmed"] },
      $or: [{ startAt: { $gte: new Date() } }, { startAt: null, "requestedWindow.date": { $gte: today } }],
    });
    if (active >= settings.maxActiveBookingsPerPhone) {
      return res.status(409).json({
        error: "LIMIT_REACHED",
        message: "You already have requests with us. We'll call you to sort them out.",
      });
    }

    // ── Customer record ───────────────────────────────────────────────────
    const now = new Date();
    const utm = cleanUtm(b.utm);
    const gender = b.for === "her" ? "female" : "male";
    const set = { name: b.name };
    if (b.whatsappOptIn === true) {
      // Opt-in is only ever recorded when ticked; an unticked box never
      // withdraws consent given earlier (that is an explicit opt-out).
      Object.assign(set, {
        "marketing.whatsappOptIn": true,
        "marketing.at": now,
        "marketing.source": "web_request",
      });
    }
    const customer = await Customer.findOneAndUpdate(
      { phone: b.phone },
      {
        $set: set,
        $setOnInsert: { createdFrom: "web", gender, firstTouch: { utm, at: utm ? now : null } },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true }
    );

    const appt = await createWithUniqueRef({
      mode: "request",
      status: "requested",
      customerId: customer._id,
      contact: b.phone,
      name: b.name,
      guests: [{ guestKey: "g1", name: b.name, gender, customerId: customer._id, items }],
      requestedWindow: { date: b.date, window: b.window },
      preferredArtistId: preferred?._id ?? null,
      preferredArtistName: preferred ? preferred.publicProfile?.displayName || preferred.name : null,
      pricing: { subtotal, discount, total, packageId: null },
      deposit: { required: false, amount: 0, status: "none" },
      source: { channel: "web", utm, promoCode: null, pixel: metaCapi.fromRequest(req) },
      policyVersion: settings.policyVersion,
      notes: b.notes?.trim() || null,
      statusHistory: [{ from: null, to: "requested", at: now, by: "customer" }],
    });

    // Before responding: on Vercel, work after the response may never run. Neither call throws.
    await Promise.all([alertNewRequest(appt), metaCapi.send("Lead", appt, { ip: clientIp(req) })]);

    return res.status(201).json({
      ref: appt.ref,
      status: "requested",
      requestedWindow: appt.requestedWindow,
      items: items.map((i) => ({ name: i.name, price: i.publicPrice })),
      packageName: pkg?.name ?? null,
      total,
      slaMinutes: settings.requestSlaMinutes,
    });
  } catch (err) {
    console.error("[public] request error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Something went wrong. Try again, or message us on WhatsApp." });
  }
});

// ─── Phase 2: slot engine (T2.5–T2.8) ───────────────────────────────────────
// Shares this router's connectDB middleware and its early mount (D16).
router.use(require("./publicBooking"));
// Offer landing pages and WhatsApp-ad requests (D62). Unpaid requests; the paid booking above is unchanged.
router.use(require("./publicOfferPages"));
router.use(require("./publicWaRequest"));

module.exports = router;
module.exports.dateProblem = dateProblem;
module.exports.livePackages = livePackages;
module.exports.loadPublicArtists = loadPublicArtists;
