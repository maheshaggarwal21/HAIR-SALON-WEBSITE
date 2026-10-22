/**
 * @file CounterSession.js
 * @description One UPI payment at the counter, from "Pay" on the staff screen to a
 * saved Visit (D60, part A).
 *
 * The SERVER is the only authority on the amount and on whether it was paid:
 * the staff screen sends what is being sold (services, discount %, cash part) and
 * the server prices it exactly as the Visit will be priced. The tablet is a
 * dumb display. When the visit is saved the staff screen sends only this
 * session's id; the services, discount and payment id come from here, never
 * from the browser (routes/visits.js).
 *
 * Status:
 *   pending   QR is live at Razorpay
 *   paid      Razorpay says the QR was paid (webhook or poll). `razorpayPaymentId`
 *             can still be null for a short while — the QR flips to paid ~3 s
 *             after payment but the payment id only arrives with the webhook
 *             (or the payments list, which lags ~36 s). The Visit is then saved
 *             as "reference pending" and filled in later.
 *   cancelled staff cancelled, a newer session replaced it, or the QR was closed
 *   expired   the 10-minute QR life ran out unpaid
 *
 * A payment that lands on a cancelled session is real money with no sale; it is
 * kept as `latePaymentId` and surfaces in the unreconciled list for a human.
 */

const mongoose = require("mongoose");

const counterSessionSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "Unknown" },

    /** Where the QR is shown. "pc" is the fallback when the tablet is off or busy. */
    target: { type: String, enum: ["tablet", "pc"], default: "tablet" },

    status: { type: String, enum: ["pending", "paid", "cancelled", "expired"], default: "pending" },
    cancelReason: { type: String, enum: ["staff", "superseded", "razorpay_closed", "no_qr", null], default: null },

    // What is being sold — duplicates kept (two haircuts = the id twice).
    serviceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    paymentMode: { type: String, enum: ["online", "partial"], default: "online" },
    cashAmount: { type: Number, default: 0, min: 0 },

    /**
     * What the tablet shows the customer: their name (typed at the desk, DISPLAY ONLY: it never
     * touches money) and the bill lines, built by the server from its own service list.
     */
    customerName: { type: String, default: null, maxlength: 60 },
    lines: {
      type: [new mongoose.Schema({ name: String, quantity: Number, price: Number }, { _id: false })],
      default: [],
    },

    // Server-computed money, whole rupees.
    subtotal: { type: Number, required: true, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    finalTotal: { type: Number, required: true, min: 0 },
    upiAmount: { type: Number, required: true, min: 1 },
    upiAmountPaise: { type: Number, required: true, min: 100 },

    // The Razorpay QR.
    qrId: { type: String, default: null },
    qrImageUrl: { type: String, default: null },
    /** The UPI string decoded from Razorpay's poster; null when decoding failed (then the image is cropped). */
    qrUpi: { type: String, default: null },
    qrMode: { type: String, enum: ["decoded", "image"], default: "image" },
    expiresAt: { type: Date, required: true },

    // Payment.
    razorpayPaymentId: { type: String, default: null },
    paidAt: { type: Date, default: null },
    paidVia: { type: String, enum: ["webhook", "poll", "backfill", null], default: null },
    /** A payment that arrived after the session was cancelled (money with no sale). */
    latePaymentId: { type: String, default: null },

    /** Throttle: at most one Razorpay status call per 2 s per session. */
    lastSyncAt: { type: Date, default: null },

    visitId: { type: mongoose.Schema.Types.ObjectId, ref: "Visit", default: null },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

counterSessionSchema.index({ status: 1, target: 1, createdAt: -1 });
counterSessionSchema.index({ createdBy: 1, status: 1 });
counterSessionSchema.index({ qrId: 1 }, { unique: true, partialFilterExpression: { qrId: { $type: "string" } } });
counterSessionSchema.index({ razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } });
// Backfill sweep: paid sessions still missing their payment id.
counterSessionSchema.index({ status: 1, razorpayPaymentId: 1, paidAt: 1 });

module.exports = mongoose.models.CounterSession || mongoose.model("CounterSession", counterSessionSchema);
