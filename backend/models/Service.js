/**
 * @file Service.js
 * @description Mongoose model for salon services.
 *
 * Each service has a name, price, and optional category (e.g. "Haircut",
 * "Hair Colour"). Categories are derived from the distinct values of the
 * `category` field — no separate model needed.
 *
 * Only the owner can create / update / delete services.
 * Soft-delete via `isActive: false` keeps historical visit references intact.
 *
 * ── Two layers: internal and public ───────────────────────────────────────────
 * The fields above the "Public layer" divider are the staff app's catalogue and
 * are unchanged. Everything below it exists for the customer website
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §2.1) and is inert until the owner opts a
 * service in with `showOnWebsite`.
 *
 * `price` is the internal LIST price; desk billing currently applies 50% off it.
 * `publicPrice` is what a customer actually pays and the only price the website
 * may show. They are separate fields, not a ratio computed on the fly, because
 * the owner sets exceptions per service — and the website must never display a
 * permanent "50% off" strike-through (see CLAUDE.md, "Prices shown to customers").
 *
 * Variants ("Smoothening (Women) Short / Medium / Long") stay separate services
 * grouped by `variantGroup`, so every booked item is still a real serviceId and
 * Visits, analytics and artist attribution keep working unchanged (decision D8).
 */

const mongoose = require("mongoose");

/** Normalised menu sections for the website (migration M4 maps `category` onto these). */
const DISPLAY_CATEGORIES = Object.freeze([
  "Hair",
  "Colour",
  "Treatments",
  "Skin",
  "Waxing",
  "Threading",
  "Hands & feet",
  "Makeup",
  "Grooming",
]);

const AUDIENCES = Object.freeze(["her", "him", "unisex"]);

/**
 * instant      — confirmed immediately if a slot is free (needs durationMinutes)
 * request      — customer asks, salon approves (chemical, bridal, consultation)
 * walkin_only  — listed on the site but not bookable online (e.g. barbers)
 * hidden       — not bookable online at all. The safe default for every
 *                existing service until the owner decides otherwise.
 */
const BOOKING_MODES = Object.freeze(["instant", "request", "walkin_only", "hidden"]);

const serviceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Service name is required"],
      trim: true,
      unique: true,
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [0, "Price cannot be negative"],
    },
    category: {
      type: String,
      trim: true,
      default: "",
    },
    // Expected duration of this service in minutes.
    // Optional — null means "no duration set yet".
    // Used to calculate artist time performance (actual vs expected).
    durationMinutes: {
      type: Number,
      min: [1, "Duration must be at least 1 minute"],
      default: null,
    },
    /**
     * False while durationMinutes is the one-hour placeholder (D11); true once
     * the owner types a real time in Service Management. Online booking uses
     * durationMinutes either way. Artist time-performance only uses CONFIRMED
     * times — a guessed hour would make a 15-minute threading look 45 minutes
     * fast and inflate that artist's productivity score (routes/visits.js).
     */
    durationConfirmed: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    // ── Public layer (customer website) ──────────────────────────────────────

    /** Whole rupees the customer pays. Null until migration M3 / owner sets it. */
    publicPrice: { type: Number, min: [0, "Public price cannot be negative"], default: null },
    /** Curated menu. Typos and catch-alls like "Any item" never get this. */
    showOnWebsite: { type: Boolean, default: false },
    /**
     * URL key. Deliberately has NO default: the unique index is sparse, which
     * only skips documents where the field is absent. A `null` default would
     * give every un-slugged service the same value and the index would reject
     * all but one of them.
     */
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase words joined by hyphens"],
    },
    /** Clean customer-facing name, e.g. "Smoothening" for "Smoothening (Women) Medium". */
    publicName: { type: String, trim: true, default: null },
    // `null` is listed explicitly: Mongoose's enum validator otherwise rejects it.
    audience: { type: String, enum: [...AUDIENCES, null], default: null },
    displayCategory: { type: String, enum: [...DISPLAY_CATEGORIES, null], default: null },
    variantGroup: { type: String, trim: true, default: null },
    variantLabel: { type: String, trim: true, default: null },
    /** Other real services offered as add-ons — they bill as normal line items. */
    addOnIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Service" }],
    shortDescription: { type: String, trim: true, default: null },
    description: { type: String, trim: true, default: null },
    images: [{ type: String, trim: true }],
    /** Cleanup time after the service; blocks the artist but is not billed. */
    bufferMinutes: { type: Number, min: 0, default: 0 },
    bookingMode: { type: String, enum: BOOKING_MODES, default: "hidden" },
    /** Forces request mode regardless of bookingMode — see effectiveBookingMode(). */
    requiresConsultation: { type: Boolean, default: false },
    /** Colour services. Checked against Customer.patchTestDoneAt by the engine. */
    requiresPatchTest: { type: Boolean, default: false },
    depositAmount: { type: Number, min: 0, default: 0 },
    /** Facial bed, pedicure station, makeup chair … (Resource model, Phase 2). */
    resourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Resource" }],
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    seo: {
      title: { type: String, trim: true, default: null },
      description: { type: String, trim: true, default: null },
    },
  },
  { timestamps: true }
);

/**
 * Instant booking computes slots from duration, so it cannot exist without one.
 *
 * Runs on document save/validate only. Mongoose does not run document hooks for
 * findByIdAndUpdate, so any route that edits bookingMode or durationMinutes via
 * an update query must call `Service.assertBookable(merged)` itself.
 */
serviceSchema.pre("validate", function () {
  const problem = bookabilityProblem(this);
  if (problem) this.invalidate("bookingMode", problem);
});

function bookabilityProblem(svc) {
  if (svc.bookingMode === "instant" && !(svc.durationMinutes > 0)) {
    return "Instant booking needs durationMinutes";
  }
  return null;
}

serviceSchema.statics.assertBookable = function (svc) {
  const problem = bookabilityProblem(svc);
  if (problem) throw new Error(problem);
};

/** The mode the booking engine must actually use. Consultation always means request. */
serviceSchema.methods.effectiveBookingMode = function () {
  if (this.bookingMode === "instant" && this.requiresConsultation) return "request";
  return this.bookingMode;
};

/**
 * Owner rule (13 Oct 2026): the website price is half the list price, rounded
 * to whole rupees. Service Management keeps publicPrice on this rule when the
 * list price changes, unless the owner has set a different public price.
 */
const PUBLIC_PRICE_RATIO = 0.5;
serviceSchema.statics.defaultPublicPrice = function (price) {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  return Math.round(price * PUBLIC_PRICE_RATIO);
};

/**
 * Owner rule (13 Oct 2026): until real times are entered, a service is assumed
 * to take at least an hour. New services start at this and the owner edits it.
 */
const DEFAULT_DURATION_MINUTES = 60;

/**
 * The expected duration a new Visit snapshots for artist time-performance.
 * Only an owner-confirmed time; an estimate or no time gives null, which
 * excludes the visit from time-performance instead of skewing it. Works on
 * lean docs, where an old document may not have durationConfirmed at all.
 */
serviceSchema.statics.performanceDuration = function (svc) {
  return svc?.durationConfirmed === true && svc.durationMinutes > 0 ? svc.durationMinutes : null;
};

/** Index for quick lookups in the form-data and management endpoints. */
serviceSchema.index({ isActive: 1, category: 1, name: 1 });
serviceSchema.index({ slug: 1 }, { unique: true, sparse: true });
/** Public menu: GET /api/public/services?for=her|him */
serviceSchema.index({ showOnWebsite: 1, audience: 1, sortOrder: 1 });

module.exports = mongoose.model("Service", serviceSchema);
module.exports.DISPLAY_CATEGORIES = DISPLAY_CATEGORIES;
module.exports.AUDIENCES = AUDIENCES;
module.exports.BOOKING_MODES = BOOKING_MODES;
module.exports.PUBLIC_PRICE_RATIO = PUBLIC_PRICE_RATIO;
module.exports.DEFAULT_DURATION_MINUTES = DEFAULT_DURATION_MINUTES;
