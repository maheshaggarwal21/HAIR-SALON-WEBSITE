/**
 * @file Visit.js
 * @description Mongoose model for salon visit records.
 *
 * Each document represents one client visit — from arrival (startTime)
 * to departure (endTime). It tracks the services performed, the artist
 * who served the client, billing details, and Razorpay payment status.
 */

const mongoose = require("mongoose");

const visitSchema = new mongoose.Schema(
  {
    // ── Schema versioning ──
    // 1 = legacy single-artist flow
    // 2 = post-payment per-service assignment flow
    schemaVersion: {
      type: Number,
      enum: [1, 2],
      default: 1,
    },

    // ── Client info ──
    name: { type: String, required: true, trim: true },
    contact: { type: String, required: true, trim: true },
    /** Every correction of `contact` made from Fix Numbers (D54): what it was, when, by whom. Never removed. */
    contactHistory: [
      {
        from: String,
        to: String,
        at: { type: Date, default: Date.now },
        byName: String,
        _id: false,
      },
    ],
    // Kept for legacy rows only; new rows no longer collect/store age.
    age: { type: String, required: false, trim: true, default: null },
    gender: {
      type: String,
      required: true,
      enum: ["male", "female", "other", "prefer_not"],
    },

    // ── Timing ──
    date: { type: Date, required: true },
    // Required for legacy flow; optional while V2 assignment is pending.
    startTime: { type: String, default: null }, // "HH:mm"
    endTime: { type: String, default: null },   // "HH:mm"

    // ── Service details ──
    // Visit-level artist is retained for legacy compatibility.
    // For V2, each service row holds its own artist assignment.
    artist: { type: String, trim: true, default: null },
    serviceType: { type: String, trim: true },
    services: [
      {
        serviceId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Service",
          default: null,
        },
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        // Snapshot of durationMinutes at the time of visit creation.
        // Null for services that had no duration set, or older visits.
        // Snapshotting protects historical accuracy — if the admin edits
        // a service's duration tomorrow, past visits should not change.
        duration: { type: Number, default: null },
        /** Internal menu price at the time, for analytics when `price` is the website price (CF §8, D3). */
        listPrice: { type: Number, default: null },

        // V2 per-service assignment fields (null until confirmed).
        artistId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Artist",
          default: null,
        },
        artistName: { type: String, default: null, trim: true },
        startTime: { type: String, default: null },
        endTime: { type: String, default: null },
        actualDurationMins: { type: Number, default: null },
      },
    ],
    // Total actual duration of the full visit in minutes (endTime - startTime).
    // Calculated in the frontend and sent with the form, stored here for
    // efficient analytics queries (avoids recalculating from time strings).
    visitDurationMins: { type: Number, default: null },
    filledBy: { type: String, required: true, trim: true },

    // ── Billing ──
    subtotal: { type: Number, required: true, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    finalTotal: { type: Number, required: true, min: 0 },
    /** Why there is a discount when it isn't the desk percentage, e.g. "package" (CF §8). */
    discountReason: { type: String, default: null },

    // ── Online booking (Phase 2, CF §8, T2.16) ──
    /** The booking this visit closes. Unique: one booking, one visit. */
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment", default: null },
    /**
     * Money the customer paid online when booking (deposit or full, D18), taken
     * off the bill here. Already inside onlineAmount — never counted twice.
     */
    depositAmount: { type: Number, default: 0, min: 0 },
    depositPaymentId: { type: String, default: null },

    // ── Payment ──
    paymentMethod: {
      type: String,
      enum: ["online", "cash", "card", "partial"],
      default: "online",
    },
    cashAmount: { type: Number, default: 0, min: 0 },
    cardAmount: { type: Number, default: 0, min: 0 },
    onlineAmount: { type: Number, default: 0, min: 0 },
    paymentStatus: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending",
    },
    razorpayPaymentId: { type: String, default: null },

    // ── V2 assignment control fields ──
    assignmentStatus: {
      type: String,
      enum: ["not_required", "pending", "completed"],
      default: "not_required",
    },
    lockUntilAssigned: { type: Boolean, default: false },
    assignmentConfirmedAt: { type: Date, default: null },
    paymentConfirmedAt: { type: Date, default: null },
    paymentSnapshot: {
      subtotal: { type: Number, default: null },
      discountPercent: { type: Number, default: null },
      discountAmount: { type: Number, default: null },
      finalTotal: { type: Number, default: null },
      paymentMethod: {
        type: String,
        enum: ["online", "cash", "card", "partial", null],
        default: null,
      },
      cashAmount: { type: Number, default: null },
      cardAmount: { type: Number, default: null },
      onlineAmount: { type: Number, default: null },
      razorpayPaymentId: { type: String, default: null },
    },
  },
  {
    timestamps: true, // Adds createdAt & updatedAt automatically
  }
);

// Indexes for common analytics queries
visitSchema.index({ date: 1 });
visitSchema.index({ artist: 1, date: 1 });
visitSchema.index({ contact: 1 });
visitSchema.index({ assignmentStatus: 1, date: -1 });
visitSchema.index({ lockUntilAssigned: 1, createdAt: -1 });
visitSchema.index({ appointmentId: 1 }, { unique: true, partialFilterExpression: { appointmentId: { $type: "objectId" } } });

module.exports = mongoose.model("Visit", visitSchema);
