/**
 * @file Campaign.js
 * @description A time-boxed website offer (CF §3 Campaign, T3.1 brought forward
 * on 14 Oct 2026, CF D29): a highlighted bar at the top of every page and an
 * optional pop-up with a small poster, shown only while the offer runs.
 *
 * WHY dates are IST calendar strings: the owner thinks "Karva Chauth runs 15–29
 * Oct", and the salon runs on Patiala time (CLAUDE.md, Time). `startDate` and
 * `endDate` are inclusive `YYYY-MM-DD` in Asia/Kolkata, compared as strings
 * against today's IST date, on the server and again in the visitor's browser,
 * so an offer appears and disappears on the right day even from a cached page.
 *
 * Honesty (CLAUDE.md): a campaign always has real start and end dates. The
 * site shows the real end date and never invents a countdown or "only N left".
 *
 * Prices (D59): an offer may also carry cheaper prices for single services
 * (`servicePrices`) and bundles (`bundles`) that run on the same dates. While
 * it is live the website shows the cheaper price with the usual price crossed
 * out and the % off; the same cheaper price is what the booking engine charges,
 * so a quote, a deposit and a refund can never disagree with the page. Outside
 * the dates nothing changes. See utils/offers.js.
 *
 * Status is derived, never stored: scheduled / live / ended / paused.
 */

const mongoose = require("mongoose");

const THEMES = ["festive", "rose", "emerald", "midnight"];
const FREQUENCIES = ["session", "day"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUDIENCES = ["her", "him", "unisex"];
const wholeRupees = { validator: Number.isInteger, message: "Prices are whole rupees" };

/** A cheaper price for one service while the offer runs (must be below its website price). */
const servicePriceSchema = new mongoose.Schema(
  {
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
    price: { type: Number, required: true, min: 1, validate: wholeRupees },
  },
  { _id: false }
);

/** Several services sold together at one price while the offer runs. */
const bundleSchema = new mongoose.Schema(
  {
    /** URL-safe, unique across offers; generated on save, never sent by a browser. */
    slug: { type: String, required: true, match: /^[a-z0-9-]{1,80}$/ },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 160, default: null },
    audience: { type: String, enum: AUDIENCES, default: "unisex" },
    serviceIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Service" }],
      validate: { validator: (v) => v.length >= 2 && v.length <= 12, message: "A bundle needs 2 to 12 services" },
    },
    price: { type: Number, required: true, min: 1, validate: wholeRupees },
  },
  { _id: false }
);

/**
 * A package on an offer page (D64), as printed on the poster: a name, ONE total price, and the
 * services listed under it by name. No per-service prices, and no rule tying the price to the
 * menu: some poster services are not on the menu at all. The price is shown and recorded with a
 * request; reception gives it at billing. `serviceIds` are only the lines the server recognised
 * on the menu (set on save, never by a browser) so a booking can show up on the Today board.
 */
const pagePackageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, match: /^[a-z0-9-]{1,40}$/ },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    price: { type: Number, required: true, min: 1, max: 1000000, validate: wholeRupees },
    /** The services under it, as printed (the owner can edit the wording). */
    services: { type: [{ type: String, trim: true, maxlength: 80 }], validate: { validator: (v) => v.length >= 1 && v.length <= 30, message: "A package lists 1 to 30 services" } },
    /** How long it takes in all; sets the earliest closing-time check and the booking's end. */
    durationMinutes: { type: Number, default: 120, min: 15, max: 480 },
    serviceIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Service" }], default: [] },
  },
  { _id: false }
);

const campaignSchema = new mongoose.Schema(
  {
    /** Internal name for the staff list, e.g. "Karva Chauth 2026". */
    name: { type: String, required: true, trim: true, maxlength: 80 },
    startDate: { type: String, required: true, match: DATE_RE },
    endDate: { type: String, required: true, match: DATE_RE },
    /** Owner's on/off switch, so an offer can be paused without deleting it. */
    active: { type: Boolean, default: true },
    /** Colour set for the bar and pop-up (globals.css `--offer-*`). */
    theme: { type: String, enum: THEMES, default: "festive" },
    showBar: { type: Boolean, default: true },
    showPopup: { type: Boolean, default: true },
    content: {
      eyebrow: { type: String, trim: true, maxlength: 30, default: null }, // "Festive offer"
      headline: { type: String, required: true, trim: true, maxlength: 90 },
      body: { type: String, trim: true, maxlength: 220, default: null },
      /** Small poster for the pop-up (Vercel Blob or any https link). */
      image: { type: String, default: null },
      ctaLabel: { type: String, trim: true, maxlength: 30, default: "See the offer" },
      /** A page on this site ("/offers/now" or an offer's own page) or an https link. */
      ctaHref: { type: String, trim: true, maxlength: 300, required: true },
    },
    popup: {
      /** DS §5 Popup: never blocks the first 5 seconds. */
      delaySeconds: { type: Number, min: 5, max: 60, default: 6 },
      /** At most once per visit ("session") or once per day. */
      frequency: { type: String, enum: FREQUENCIES, default: "day" },
    },
    servicePrices: { type: [servicePriceSchema], default: [] },
    bundles: { type: [bundleSchema], default: [] },
    /** Lower shows first when two offers overlap. */
    sortOrder: { type: Number, default: 0 },
    /**
     * Optional landing page for this offer (D62): /offers/<slug>, and /offers/now while the
     * offer's own dates contain today (IST). Shares the offer's start and end dates and its
     * active switch; has its own words, picture and the services the booking form pre-selects.
     * The price here is shown, never applied: reception gives any discount by hand.
     */
    page: {
      slug: { type: String, default: null, match: /^[a-z0-9][a-z0-9-]{2,59}$/ },
      headline: { type: String, trim: true, maxlength: 90, default: null },
      offerText: { type: String, trim: true, maxlength: 500, default: null },
      /** Whole rupees, display only. */
      price: { type: Number, default: null, min: 1, max: 1000000, validate: { validator: (v) => v == null || Number.isInteger(v), message: "Prices are whole rupees" } },
      /** Words beside the price, e.g. "for both" or "per person". */
      priceNote: { type: String, trim: true, maxlength: 60, default: null },
      /** The first picture (kept in step with images[0]; older offers only have this one). */
      image: { type: String, default: null },
      /** Up to 5 pictures or posters, shown as a slideshow on the page, in this order (D63). */
      images: {
        type: [String],
        default: [],
        validate: { validator: (v) => v.length <= 5 && v.every((u) => typeof u === "string" && /^https:\/\/\S+$/.test(u) && u.length <= 1000), message: "At most 5 pictures, each an https link" },
      },
      /** A synced Instagram reel, shown first in the slideshow. */
      reelId: { type: mongoose.Schema.Types.ObjectId, ref: "Reel", default: null },
      /** The poster's packages (D64): name, one price, the services listed under it. Up to 8. */
      packages: { type: [pagePackageSchema], default: [], validate: { validator: (v) => v.length <= 8, message: "At most 8 packages on an offer page" } },
      /** What the booking form on the page pre-selects (and books) when there are no packages. */
      serviceIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Service" }], default: [] },
    },
  },
  { timestamps: true }
);

// One landing page per address.
campaignSchema.index({ "page.slug": 1 }, { unique: true, partialFilterExpression: { "page.slug": { $type: "string" } } });

campaignSchema.pre("validate", function () {
  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    this.invalidate("endDate", "The offer must end on or after the day it starts");
  }
});

campaignSchema.index({ active: 1, endDate: 1 });

/** scheduled | live | ended | paused, for the IST date given. */
campaignSchema.methods.statusOn = function (today) {
  if (!this.active) return "paused";
  if (today < this.startDate) return "scheduled";
  if (today > this.endDate) return "ended";
  return "live";
};

/**
 * Where "See the offer" goes. The staff form pre-fills "Button goes to" with the full menu
 * (/services), so most offers were saved with that even when they have a page of their own,
 * and the bar sent customers to the menu instead of the offer. An offer with a page address
 * now always goes to /offers/<address> unless the owner chose something specific (a menu
 * filter such as /services?for=her, or an outside link). "/services" and "/offers/now" count
 * as "didn't choose": the first is the form's default, the second is the same offer.
 */
const GENERIC_CTA = new Set(["", "/services", "/offers/now"]);
campaignSchema.methods.ctaTarget = function () {
  const href = (this.content?.ctaHref || "").trim();
  const slug = this.page?.slug;
  if (slug && GENERIC_CTA.has(href.replace(/\/+$/, ""))) return `/offers/${slug}`;
  return href;
};

/** Public fields only (CLAUDE.md, Privacy). */
campaignSchema.methods.toPublic = function () {
  return {
    id: String(this._id),
    startDate: this.startDate,
    endDate: this.endDate,
    theme: this.theme,
    showBar: this.showBar,
    showPopup: this.showPopup,
    content: {
      eyebrow: this.content?.eyebrow ?? null,
      headline: this.content.headline,
      body: this.content?.body ?? null,
      image: this.content?.image ?? null,
      ctaLabel: this.content?.ctaLabel || "See the offer",
      ctaHref: this.ctaTarget(),
    },
    popup: { delaySeconds: this.popup?.delaySeconds ?? 6, frequency: this.popup?.frequency ?? "day" },
  };
};

module.exports = mongoose.model("Campaign", campaignSchema);
module.exports.THEMES = THEMES;
module.exports.FREQUENCIES = FREQUENCIES;
module.exports.AUDIENCES = AUDIENCES;
