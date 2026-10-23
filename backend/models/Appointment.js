/**
 * @file Appointment.js
 * @description A booking made before the customer arrives — or, from Phase 2, a
 * walk-in (CONTROL_FLOW_AND_DATA_LOGIC.md §2.2, §3, T1.4).
 *
 * ── Phase 1: request-lite (§6.1) ─────────────────────────────────────────────
 * The website collects REQUESTS without checking live availability: services,
 * a preferred day and a window (morning / afternoon / evening). That creates
 * `{mode: "request", status: "requested", requestedWindow}` with no slot locks
 * and no deposit. Reception agrees a time with the customer by phone or
 * WhatsApp and records it with "Confirm with time", which sets startAt/endAt
 * and moves the status to `confirmed`. Slot locks arrive with the engine in
 * Phase 2; until then nothing here can double-book anyone, because nothing
 * here holds a slot.
 *
 * The full Phase 2 shape (deposit, holds, manage token, check-in) is declared
 * now so later phases add behaviour, not a schema migration.
 *
 * ── Rules that hold from day one ─────────────────────────────────────────────
 * - Never delete an Appointment. Change its status; `statusHistory` keeps how
 *   it got there (CLAUDE.md, "Booking integrity").
 * - Prices and durations are SNAPSHOTS taken by the server at creation, like
 *   Visit does. Editing a service later never changes an existing booking (E6).
 * - `listPrice` is stored for analytics and is never returned by a public route.
 * - Status changes are conditional updates on the current status
 *   (`{_id, status: "requested"}`), so two receptionists tapping Confirm at once
 *   cannot both win.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const { utmSchema } = require("./Customer");

const STATUSES = [
  "pending_payment",
  "requested",
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "declined",
  "expired",
  "no_show",
];
const MODES = ["instant", "request"];
/** "wa_ad": a request made from a WhatsApp ad link, unpaid until the salon confirms it (D62). */
const CHANNELS = ["web", "desk", "phone", "whatsapp", "walkin", "wa_ad"];
const WINDOWS = ["morning", "afternoon", "evening"];
const DEPOSIT_STATUSES = ["none", "pending", "paid", "refunded", "partially_refunded", "forfeited", "applied"];
const REFUND_STATUSES = ["none", "pending", "processing", "processed", "failed"];

/**
 * Human booking code, e.g. "EXP-7K3Q9". The alphabet drops 0/O, 1/I/L and U/V
 * so a code read out over the phone can't be misheard. 29^5 ≈ 20M codes; the
 * unique index catches the rare collision and the caller retries.
 */
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";
function generateRef() {
  let out = "";
  for (let i = 0; i < 5; i++) out += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  return `EXP-${out}`;
}

const itemSchema = new mongoose.Schema(
  {
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
    name: { type: String, required: true },
    publicPrice: { type: Number, required: true, min: 0 },
    listPrice: { type: Number, default: null },
    durationMin: { type: Number, default: null },
    bufferMin: { type: Number, default: 0 },
    artistId: { type: mongoose.Schema.Types.ObjectId, ref: "Artist", default: null },
    artistName: { type: String, default: null },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    resourceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { _id: false }
);

const guestSchema = new mongoose.Schema(
  {
    guestKey: { type: String, required: true },
    name: { type: String, trim: true, default: null },
    gender: { type: String, enum: ["female", "male", "other", "prefer_not", null], default: null },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    items: { type: [itemSchema], default: [] },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    at: { type: Date, required: true },
    /** "customer", "system", or a staff member's name. */
    by: { type: String, default: null },
    byUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, default: null },
  },
  { _id: false }
);

const appointmentSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true },
    mode: { type: String, enum: MODES, required: true },
    status: { type: String, enum: STATUSES, required: true },

    // The booker.
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    contact: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },

    guests: { type: [guestSchema], default: [] },

    /** Whole appointment including buffers. Null on a request until a time is agreed. */
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    /** Phase 1 request-lite: what the customer asked for. IST calendar date. */
    requestedWindow: {
      date: { type: String, default: null }, // "YYYY-MM-DD"
      window: { type: String, enum: [...WINDOWS, null], default: null },
      /**
       * WhatsApp-ad requests (D62) ask for a specific start time, IST "HH:mm". Staff can change it when confirming.
       * No default on purpose: bookings that do not use it must keep exactly the shape they always had.
       */
      time: { type: String },
    },
    /** The artist the customer would like, if any. A wish, not an assignment. */
    preferredArtistId: { type: mongoose.Schema.Types.ObjectId, ref: "Artist", default: null },
    preferredArtistName: { type: String, default: null },

    pricing: {
      subtotal: { type: Number, required: true, min: 0 },
      discount: { type: Number, default: 0, min: 0 },
      total: { type: Number, required: true, min: 0 },
      promoCode: { type: String, default: null },
      packageId: { type: mongoose.Schema.Types.ObjectId, default: null },
      campaignId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    deposit: {
      required: { type: Boolean, default: false },
      /**
       * D18: what the customer chose to pay online. "deposit" = deposit now,
       * rest at the salon; "full" = the whole total now. Either way `amount`
       * is money already received and is deducted at checkout (§8).
       */
      kind: { type: String, enum: ["deposit", "full"], default: "deposit" },
      amount: { type: Number, default: 0, min: 0 },
      /** The part kept on a customer cancel or no-show (§5.2): min(paid, fee). */
      forfeitable: { type: Number, default: 0, min: 0 },
      status: { type: String, enum: DEPOSIT_STATUSES, default: "none" },
      razorpayOrderId: { type: String, default: null },
      razorpayPaymentId: { type: String, default: null },
      paidAt: { type: Date, default: null },
    },
    /**
     * Money going back to the customer (§5.2). `pending` = we owe it and the
     * Razorpay call hasn't succeeded yet — the cron retries and the owner is
     * alerted (E24). Never silently dropped.
     */
    refund: {
      amount: { type: Number, default: 0, min: 0 },
      status: { type: String, enum: REFUND_STATUSES, default: "none" },
      reason: { type: String, default: null },
      razorpayRefundId: { type: String, default: null },
      requestedAt: { type: Date, default: null },
      processedAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
      error: { type: String, default: null },
      /** Set while a refund call is in flight, so a double tap can't refund twice. */
      claimedAt: { type: Date, default: null },
    },
    /** Walk-in forced over a lock (E2): staff must move one of the two. */
    lockConflict: { type: Boolean, default: false },
    holdExpiresAt: { type: Date, default: null },
    requestExpiresAt: { type: Date, default: null },
    /** When the owner was nudged that this request passed its SLA (routes/cron.js). */
    slaAlertedAt: { type: Date, default: null },

    source: {
      channel: { type: String, enum: CHANNELS, required: true },
      utm: { type: utmSchema, default: null },
      /** Short tag from the ad link (?c=karwa), lower case. Shown to staff next to the source. */
      campaign: { type: String, maxlength: 40 },
      /** Offer landing page this request came from (D62), with what it said at the time, so the desk can apply the matching discount by hand. */
      offerSlug: { type: String, maxlength: 60 },
      offerHeadline: { type: String, maxlength: 90 },
      offerPrice: { type: Number },
      offerPriceNote: { type: String, maxlength: 60 },
      campaignId: { type: mongoose.Schema.Types.ObjectId, default: null },
      promoCode: { type: String, default: null },
    },

    policyVersion: { type: String, default: null },
    policyAcceptedAt: { type: Date, default: null },
    /** Customer's own note, max 300 chars. Shown to staff. */
    notes: { type: String, trim: true, maxlength: 300, default: null },
    /** Staff-only note (T1.10). Never returned publicly. */
    internalNote: { type: String, trim: true, maxlength: 500, default: null },

    /** sha256 of the manage-link token (Phase 2, §9). The token itself is never stored. */
    manageTokenHash: { type: String, default: null },
    rescheduleCount: { type: Number, default: 0 },
    checkedInAt: { type: Date, default: null },
    /** "Finished" tap on the Today board: the real end of the service (start = checkedInAt). Feeds artist time performance. */
    finishedAt: { type: Date, default: null },
    /** Cancellation fee / forfeited deposit the salon KEPT, and when (D51). Shown on the Refunds screen: no Visit records it. */
    feeKept: { type: Number, default: 0, min: 0 },
    feeKeptAt: { type: Date, default: null },
    /** The salon changed the artist the customer had named: they may cancel free whatever the notice (D51). */
    artistChangedBySalon: { type: Boolean, default: false },
    visitId: { type: mongoose.Schema.Types.ObjectId, ref: "Visit", default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: ["customer", "salon", "system", null], default: null },
    cancelReason: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    statusHistory: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

appointmentSchema.index({ status: 1, startAt: 1 });
appointmentSchema.index({ customerId: 1, startAt: -1 });
appointmentSchema.index({ contact: 1, status: 1 });
appointmentSchema.index({ "guests.items.artistId": 1, startAt: 1 });
appointmentSchema.index({ holdExpiresAt: 1 });
appointmentSchema.index({ requestExpiresAt: 1 });
/** Requests page: newest first within a status. */
appointmentSchema.index({ status: 1, createdAt: -1 });
appointmentSchema.index({ "deposit.razorpayOrderId": 1 }, { sparse: true });
appointmentSchema.index({ manageTokenHash: 1 }, { sparse: true });
appointmentSchema.index({ "refund.status": 1 });

/** All items across all guests, in order. */
appointmentSchema.methods.allItems = function () {
  return this.guests.flatMap((g) => g.items);
};

module.exports = mongoose.model("Appointment", appointmentSchema);
module.exports.STATUSES = STATUSES;
module.exports.WINDOWS = WINDOWS;
module.exports.CHANNELS = CHANNELS;
module.exports.generateRef = generateRef;
module.exports.REF_ALPHABET = REF_ALPHABET;
