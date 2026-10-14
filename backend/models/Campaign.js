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
 * Status is derived, never stored: scheduled / live / ended / paused.
 */

const mongoose = require("mongoose");

const THEMES = ["festive", "rose", "emerald", "midnight"];
const FREQUENCIES = ["session", "day"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      /** A page on this site ("/offers/karva-chauth") or an https link. */
      ctaHref: { type: String, trim: true, maxlength: 300, required: true },
    },
    popup: {
      /** DS §5 Popup: never blocks the first 5 seconds. */
      delaySeconds: { type: Number, min: 5, max: 60, default: 6 },
      /** At most once per visit ("session") or once per day. */
      frequency: { type: String, enum: FREQUENCIES, default: "day" },
    },
    /** Lower shows first when two offers overlap. */
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

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
      ctaHref: this.content.ctaHref,
    },
    popup: { delaySeconds: this.popup?.delaySeconds ?? 6, frequency: this.popup?.frequency ?? "day" },
  };
};

module.exports = mongoose.model("Campaign", campaignSchema);
module.exports.THEMES = THEMES;
module.exports.FREQUENCIES = FREQUENCIES;
