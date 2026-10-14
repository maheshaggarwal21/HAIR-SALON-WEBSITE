/**
 * @file Customer.js
 * @description One person the salon serves, keyed by their 10-digit mobile
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §2.2, T1.3).
 *
 * Until now a "customer" only existed implicitly as the `contact` string on
 * Visits. The website needs a real record: to recognise a returning client, to
 * hold their WhatsApp consent, and to tie a web request to the visit it turns
 * into (attribution, §17). Migration M1 backfills one Customer per distinct
 * Visit contact; web requests and (later) desk lookups create the rest.
 *
 * ── Privacy (CLAUDE.md, "Privacy and consent") ───────────────────────────────
 * Collect the minimum: phone, name, optional email, gender of the person served.
 * `patchTestDoneAt` is the ONLY health-adjacent field allowed — do not add notes,
 * allergies or conditions here. Marketing consent is opt-in, unticked by
 * default, and recorded with when and where it was given. Nothing in this model
 * is ever returned by a public endpoint.
 */

const mongoose = require("mongoose");

const GENDERS = ["female", "male", "other", "prefer_not"];
const CREATED_FROM = ["backfill", "web", "desk"];

/** Same rule the Artist model uses: 10 digits starting 6–9. */
const PHONE_RE = /^[6-9]\d{9}$/;

/**
 * "+91 98765-43210", "09876543210", "919876543210" → "9876543210".
 * Returns null for anything that is not a valid Indian mobile after cleanup.
 */
function normalisePhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return PHONE_RE.test(digits) ? digits : null;
}

const utmSchema = new mongoose.Schema(
  {
    source: { type: String, trim: true, maxlength: 100 },
    medium: { type: String, trim: true, maxlength: 100 },
    campaign: { type: String, trim: true, maxlength: 100 },
    content: { type: String, trim: true, maxlength: 100 },
    fbclid: { type: String, trim: true, maxlength: 255 },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [PHONE_RE, "Enter a valid 10-digit Indian mobile number"],
    },
    /** Latest known name. */
    name: { type: String, trim: true, maxlength: 80, default: null },
    /** Of this person (the one served), not of whoever booked for them. */
    gender: { type: String, enum: [...GENDERS, null], default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: null },
    householdId: { type: mongoose.Schema.Types.ObjectId, default: null },
    preferredArtistId: { type: mongoose.Schema.Types.ObjectId, ref: "Artist", default: null },
    patchTestDoneAt: { type: Date, default: null },
    marketing: {
      whatsappOptIn: { type: Boolean, default: false },
      at: { type: Date, default: null },
      source: { type: String, default: null },
    },
    policyAcceptedAt: { type: Date, default: null },
    policyVersion: { type: String, default: null },
    stats: {
      visits: { type: Number, default: 0 },
      firstVisitAt: { type: Date, default: null },
      lastVisitAt: { type: Date, default: null },
      noShows: { type: Number, default: 0 },
      lateCancels: { type: Number, default: 0 },
    },
    /** First marketing touch we know of (web only). Never overwritten. */
    firstTouch: {
      utm: { type: utmSchema, default: null },
      at: { type: Date, default: null },
    },
    createdFrom: { type: String, enum: CREATED_FROM, required: true },
  },
  { timestamps: true }
);

customerSchema.index({ "stats.lastVisitAt": -1 });

module.exports = mongoose.model("Customer", customerSchema);
module.exports.normalisePhone = normalisePhone;
module.exports.PHONE_RE = PHONE_RE;
module.exports.GENDERS = GENDERS;
module.exports.utmSchema = utmSchema;
