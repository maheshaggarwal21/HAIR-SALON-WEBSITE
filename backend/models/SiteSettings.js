/**
 * @file SiteSettings.js
 * @description Singleton of salon-wide settings the website and booking rules
 * read (CONTROL_FLOW_AND_DATA_LOGIC.md §2.2, T1.5).
 *
 * One document, `key: "default"`. `SiteSettings.getSingleton()` creates it on first use
 * with the defaults below, so there is no separate seed step to forget on a new
 * deployment — and because creation is an upsert with $setOnInsert, two cold
 * serverless instances racing on first use still end up with one document and
 * never overwrite anything the owner has saved.
 *
 * ── Defaults come from the owner's answers (T0.2, 14 Oct 2026) ─────────────────
 * Open 09:00–21:00, closed Tuesdays (CF §24 Q6/K2); one number for WhatsApp and
 * calls; address "near Sunrise Hotel"; the salon's Google Maps place; Instagram
 * handle. The owner changes any of it in Website Settings without a deploy.
 * Any contact field set back to empty hides that button on the website.
 */

const mongoose = require("mongoose");
const { TIME_RE } = require("../utils/time");

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const intervalSchema = new mongoose.Schema(
  {
    open: { type: String, required: true, match: TIME_RE },
    close: { type: String, required: true, match: TIME_RE },
  },
  { _id: false }
);

const windowSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    start: { type: String, required: true, match: TIME_RE },
    end: { type: String, required: true, match: TIME_RE },
  },
  { _id: false }
);

/** Owner, 14 Oct 2026: 9 am – 9 pm, weekly off on Tuesday. */
const CLOSED_DAYS = ["tue"];
const openingHoursDefinition = Object.fromEntries(
  DAYS.map((d) => [
    d,
    { type: [intervalSchema], default: () => (CLOSED_DAYS.includes(d) ? [] : [{ open: "09:00", close: "21:00" }]) },
  ])
);

/** A skills rule (utils/skills.js): all, or any of these sections / sub-groups / services. */
const skillRuleSchema = new mongoose.Schema(
  {
    all: { type: Boolean, default: true },
    categories: { type: [String], default: [] },
    groups: { type: [String], default: [] },
    services: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { _id: false }
);

const siteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true, immutable: true },
    timezone: { type: String, default: "Asia/Kolkata", immutable: true },

    /** IST wall clock. An empty array means closed that weekday. */
    openingHours: openingHoursDefinition,
    /** "YYYY-MM-DD" dates the salon is closed. */
    holidays: { type: [String], default: [] },
    specialHours: {
      type: [
        new mongoose.Schema(
          { date: { type: String, required: true }, open: String, close: String },
          { _id: false }
        ),
      ],
      default: [],
    },

    /**
     * Phase 1 request windows. Shown on the request form and used by staff to
     * pick a time inside what the customer asked for.
     */
    requestWindows: {
      morning: { type: windowSchema, default: () => ({ label: "Morning", start: "09:00", end: "12:00" }) },
      afternoon: { type: windowSchema, default: () => ({ label: "Afternoon", start: "12:00", end: "16:00" }) },
      evening: { type: windowSchema, default: () => ({ label: "Evening", start: "16:00", end: "21:00" }) },
    },

    // Booking rules (§2.2). Phase 1 uses horizonDays, requestSlaMinutes and
    // maxActiveBookingsPerPhone; the rest wait for the slot engine.
    slotMinutes: { type: Number, default: 15 },
    minLeadMinutes: { type: Number, default: 120 },
    horizonDays: { type: Number, default: 30, min: 1, max: 120 },
    holdMinutes: { type: Number, default: 10 },
    requestSlaMinutes: { type: Number, default: 120 },
    /** Free cancel / move until this many hours before the start (D47). */
    cancellationCutoffHours: { type: Number, default: 24 },
    maxActiveBookingsPerPhone: { type: Number, default: 3, min: 1 },
    maxGuests: { type: Number, default: 4 },
    maxOnlineReschedules: { type: Number, default: 2 },
    noShowGraceMinutes: { type: Number, default: 15 },
    deposit: {
      // The deposit amount is the cancellation fee (D47); only extras live here.
      peakDates: { type: [String], default: [] },
      peakDayAmount: { type: Number, default: 200 },
      repeatNoShowAmount: { type: Number, default: 200 },
      repeatNoShowThreshold: { type: Number, default: 2 },
    },
    /**
     * D47: kept on a late customer cancellation or no-show, and taken up front as the
     * deposit. A percentage of the bill, rounded to `cancellationFeeRoundTo`, at least
     * `cancellationFeeMin`, never more than the bill.
     */
    cancellationFeePercent: { type: Number, default: 30, min: 0, max: 100 },
    cancellationFeeMin: { type: Number, default: 100, min: 0 },
    cancellationFeeRoundTo: { type: Number, default: 10, min: 0 },
    /**
     * Refunds caused by the SALON (we cancel, decline, a request expires, money
     * arrives after a hold ended) are sent automatically: the customer did
     * nothing wrong and the amount is the full payment. Customer cancellations
     * and no-shows always wait for the owner (the fee may be waived). Off =
     * everything waits for the owner.
     */
    autoRefundSalonSide: { type: Boolean, default: true },
    policyVersion: { type: String, default: "2026-10-v1" },

    contact: {
      /** 10-digit numbers, no +91. */
      phone: { type: String, default: "9814830307", match: /^[6-9]\d{9}$/ },
      whatsapp: { type: String, default: "9814830307", match: /^[6-9]\d{9}$/ },
      address: { type: String, default: "Green Park Colony, near Sunrise Hotel, Sirhind–Patiala Rd, Patiala" },
      /** Pin the owner sent on 19 Oct 2026 (replaces the 14 Oct share link). */
      mapUrl: { type: String, default: "https://www.google.com/maps?q=30.366743,76.402412" },
      /**
       * The map shown in "Visit us" (an iframe src; null = no map). Default pins
       * the salon's Google listing coordinates. The owner can replace it with
       * Google Maps → Share → Embed a map (the whole <iframe> code is accepted).
       */
      mapEmbedUrl: { type: String, default: "https://maps.google.com/maps?q=30.366743,76.402412&z=17&output=embed" },
      placeId: { type: String, default: null },
      instagram: { type: String, default: "theexpertssalonpatiala" },
      /** Optional line under the address, e.g. "Free parking in front". */
      parkingNote: { type: String, default: null, maxlength: 140 },
    },

    /**
     * Website media (DS §6.1). All optional: a section whose media is missing
     * is laid out without it — never filled with stock photos (DS §3.4).
     * URLs are Vercel Blob uploads from the staff app, or any https link.
     */
    media: {
      heroVideoUrl: { type: String, default: null },   // 720p MP4, ≤ 1.5 MB (DS §9)
      heroPosterUrl: { type: String, default: null },
      forHerImage: { type: String, default: null },
      forHimImage: { type: String, default: null },
      salonImages: { type: [String], default: [] },     // ladies' area, chairs (Visit us)
      /**
       * Hero slider (CF D31): the salon's own short videos and photos, played
       * in this order on the home page. Each video plays to its end, each photo
       * shows for 5 s, then the next one; visitors can also step through.
       * Never saved (undefined): the single `heroVideoUrl` above if set, else
       * the starting slides in config/heroSlides.js (files shipped with the
       * customer site). Saved: the owner's list (Vercel Blob uploads or site
       * files); [] hides the slider.
       */
      /**
       * "See us in action" gallery (CF D33): photos with a short caption, shown
       * as a carousel. Undefined until the owner saves a list, so the public site
       * can fall back to config/gallery.js; [] hides the section.
       */
      gallery: {
        type: [
          new mongoose.Schema(
            {
              url: { type: String, required: true },
              caption: { type: String, default: null, trim: true, maxlength: 80 },
            },
            { _id: false }
          ),
        ],
        default: undefined,
      },
      heroSlides: {
        type: [
          new mongoose.Schema(
            {
              kind: { type: String, enum: ["video", "image"], required: true },
              url: { type: String, required: true },
              poster: { type: String, default: null }, // first frame for videos
              alt: { type: String, default: null, trim: true, maxlength: 120 },
              // Optional landscape (16:9) version for wide screens; phones keep `url`.
              wideUrl: { type: String, default: null },
              widePoster: { type: String, default: null },
            },
            { _id: false }
          ),
        ],
        default: undefined, // undefined = never saved → config/heroSlides.js
      },
    },
    /** Before/after pairs (DS §6.1 §5). Only pairs with recorded consent are public. */
    transformations: {
      type: [
        new mongoose.Schema(
          {
            before: { type: String, required: true },
            after: { type: String, required: true },
            caption: { type: String, default: null, maxlength: 80 },
            consent: { type: Boolean, required: true },
          },
          { _id: true }
        ),
      ],
      default: [],
    },

    /**
     * Google rating and selected reviews, entered by the owner (CF D27). Used
     * while the Places API feed (ReviewCache) is off; a live Google rating
     * always wins. `featured` is left undefined until the first save, so the
     * public API can fall back to config/featuredReviews.js; an empty array
     * means "show no reviews".
     */
    reviews: {
      // Owner's figures (14 Oct 2026): "4.5+" rating, "1000+" reviews. Stored
      // as the floors and always shown as floors ("4.5 ★", "1,000+").
      rating: { type: Number, default: 4.5, min: 1, max: 5 },
      count: { type: Number, default: 1000, min: 0 },
      url: { type: String, default: "https://maps.app.goo.gl/3crtqx58iqAG4S568" }, // the salon's Google listing
      featured: {
        type: [
          new mongoose.Schema(
            {
              author: { type: String, required: true, trim: true, maxlength: 60 },
              rating: { type: Number, required: true, min: 1, max: 5 },
              text: { type: String, required: true, trim: true, maxlength: 600 },
              service: { type: String, default: null, trim: true, maxlength: 80 },
              visible: { type: Boolean, default: true },
            },
            { _id: true }
          ),
        ],
        default: undefined,
      },
    },

    /**
     * "Meet the owner" on the home page (CF D32). Each field falls back to
     * config/ownerProfile.js until the owner saves their own.
     */
    owner: {
      name: { type: String, default: null, trim: true, maxlength: 60 },
      title: { type: String, default: null, trim: true, maxlength: 80 },
      bio: { type: String, default: null, trim: true, maxlength: 1200 },
      photo: { type: String, default: null },
      visible: { type: Boolean, default: true },
    },

    /**
     * Which services artists may be booked for, by gender (CF D35). An artist
     * follows their gender's rule unless they have their own (Artist.skillMode).
     * Every gender starts with "all services".
     */
    artistSkillDefaults: {
      female: { type: skillRuleSchema, default: () => ({ all: true }) },
      male: { type: skillRuleSchema, default: () => ({ all: true }) },
      other: { type: skillRuleSchema, default: () => ({ all: true }) },
    },

    /** Website price = round(list × ratio). Mirrors Service.PUBLIC_PRICE_RATIO (D12). */
    publicPriceRatio: { type: Number, default: 0.5, min: 0, max: 1 },

    /**
     * A desk discount ABOVE this percentage is highlighted in the owner's discount
     * summary (D60). It never blocks a sale — there is no cap on discounts.
     */
    discountReviewPercent: { type: Number, default: 30, min: 0, max: 100 },
  },
  { timestamps: true, minimize: false }
);

/** The one settings document, created with defaults on first use. */
siteSettingsSchema.statics.getSingleton = async function () {
  return this.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
};

/** What GET /api/public/site may show. Everything else stays server-side. */
siteSettingsSchema.methods.toPublic = function () {
  return {
    timezone: this.timezone,
    openingHours: Object.fromEntries(DAYS.map((d) => [d, this.openingHours?.[d] ?? []])),
    holidays: this.holidays,
    specialHours: this.specialHours,
    requestWindows: this.requestWindows,
    horizonDays: this.horizonDays,
    requestSlaMinutes: this.requestSlaMinutes,
    policyVersion: this.policyVersion,
    contact: {
      phone: this.contact?.phone ?? null,
      whatsapp: this.contact?.whatsapp ?? null,
      address: this.contact?.address ?? null,
      mapUrl: this.contact?.mapUrl ?? null,
      mapEmbedUrl: this.contact?.mapEmbedUrl ?? null,
      instagram: this.contact?.instagram ?? null,
      parkingNote: this.contact?.parkingNote ?? null,
    },
    media: {
      heroVideoUrl: this.media?.heroVideoUrl ?? null,
      heroPosterUrl: this.media?.heroPosterUrl ?? null,
      forHerImage: this.media?.forHerImage ?? null,
      forHimImage: this.media?.forHimImage ?? null,
      salonImages: this.media?.salonImages ?? [],
      gallery: (Array.isArray(this.media?.gallery) ? this.media.gallery : require("../config/gallery")).map((g) => ({
        url: g.url,
        caption: g.caption ?? null,
      })),
      heroSlides: (Array.isArray(this.media?.heroSlides)
        ? this.media.heroSlides
        : this.media?.heroVideoUrl
          ? [{ kind: "video", url: this.media.heroVideoUrl, poster: this.media.heroPosterUrl ?? null, alt: null }]
          : require("../config/heroSlides")
      ).map((s) => ({
        kind: s.kind,
        url: s.url,
        poster: s.poster ?? null,
        alt: s.alt ?? null,
        wideUrl: s.wideUrl ?? null,
        widePoster: s.widePoster ?? null,
      })),
    },
    owner: (() => {
      const o = this.ownerProfile();
      return o.visible ? { name: o.name, title: o.title, bio: o.bio, photo: o.photo } : null;
    })(),
    // Consent is required to publish a client's photo (CLAUDE.md, Privacy).
    transformations: (this.transformations || [])
      .filter((t) => t.consent === true)
      .map((t) => ({ id: String(t._id), before: t.before, after: t.after, caption: t.caption ?? null })),
  };
};

/** "Meet the owner" content in effect: saved fields over the starting draft (CF D32). */
siteSettingsSchema.methods.ownerProfile = function () {
  const base = require("../config/ownerProfile");
  const o = this.owner || {};
  return {
    name: o.name || base.name,
    title: o.title || base.title,
    bio: o.bio || base.bio,
    photo: o.photo || base.photo,
    visible: o.visible !== false,
  };
};

/** "Naman Toor" → "Naman T.": the website never shows a customer's full name. */
function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || "Guest";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** The featured list in effect: the owner's saved list, else the starting list. */
siteSettingsSchema.methods.featuredReviews = function () {
  const saved = this.reviews?.featured;
  if (Array.isArray(saved)) return saved.map((r) => (typeof r.toObject === "function" ? r.toObject() : r));
  return require("../config/featuredReviews").map((r) => ({ ...r, visible: true }));
};

/**
 * Owner-entered rating + visible featured reviews, in public shape (CF D27).
 * Rating is null unless both the score and the count are set.
 */
siteSettingsSchema.methods.manualReviewsPublic = function () {
  const r = this.reviews || {};
  const rating = r.rating && r.count != null ? { value: r.rating, count: r.count, mapsUri: r.url ?? null } : null;
  const reviews = this.featuredReviews()
    .filter((x) => x.visible !== false)
    .slice(0, 12)
    .map((x) => ({ author: shortName(x.author), rating: x.rating, text: x.text, service: x.service ?? null }));
  return { rating, reviews };
};

module.exports = mongoose.model("SiteSettings", siteSettingsSchema);
module.exports.shortName = shortName;
module.exports.DAYS = DAYS;
