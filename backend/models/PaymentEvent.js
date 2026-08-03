/**
 * @file PaymentEvent.js
 * @description Server-side record of every payment Razorpay captures.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Until now a visit was created ONLY by the customer's browser after paying:
 *
 *   Razorpay captures → browser calls /verify-order-payment → browser calls
 *   /visits/v2 → the visit finally exists
 *
 * If anything interrupted that chain — a 429 from the rate limiter, a dropped
 * connection, a closed tab — the money was taken and the salon had no record of
 * it at all. Reconciling Razorpay against the database found 14 such payments
 * worth ₹3,185.70, roughly one in every 120 online payments, going back months.
 *
 * A PaymentEvent is written by the Razorpay webhook, which arrives server-to-
 * server and does not depend on the customer's browser surviving. It is the
 * durable record that a payment happened; the Visit remains the record of what
 * was actually sold. `reconciledVisitId` links the two once they are matched.
 *
 * This model deliberately does NOT try to invent a Visit. The webhook knows the
 * amount and the payer, but nothing about which services were performed or by
 * whom — guessing that would put fiction into the revenue reports.
 */

const mongoose = require("mongoose");

const paymentEventSchema = new mongoose.Schema(
  {
    /** Razorpay payment id, e.g. "pay_TK6fRfXoUaBUVS". The idempotency key. */
    razorpayPaymentId: { type: String, required: true, unique: true, index: true },
    razorpayOrderId: { type: String, default: null, index: true },

    /** Whole rupees, converted from Razorpay's paise. */
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR" },
    method: { type: String, default: null },

    /** Payer details as Razorpay saw them — may differ from the visit record. */
    contact: { type: String, default: null, index: true },
    customerName: { type: String, default: null },
    email: { type: String, default: null },

    /** captured | failed | authorized — mirrors Razorpay's own status. */
    status: { type: String, default: "captured", index: true },

    /** When Razorpay captured it, not when we heard about it. */
    capturedAt: { type: Date, default: null, index: true },

    /**
     * Reconciliation state:
     *   matched     — a Visit carries this payment id
     *   unmatched   — captured money with no visit; needs attention
     *   ignored     — deliberately dismissed (test payment, refunded, etc.)
     */
    reconcileStatus: {
      type: String,
      enum: ["matched", "unmatched", "ignored"],
      default: "unmatched",
      index: true,
    },
    reconciledVisitId: { type: mongoose.Schema.Types.ObjectId, ref: "Visit", default: null },
    reconciledAt: { type: Date, default: null },
    note: { type: String, default: null },

    /** How we learned about it — useful when debugging a gap. */
    source: { type: String, enum: ["webhook", "backfill", "manual"], default: "webhook" },

    /** Raw event, kept for audit. */
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

paymentEventSchema.index({ reconcileStatus: 1, capturedAt: -1 });

module.exports = mongoose.model("PaymentEvent", paymentEventSchema);
