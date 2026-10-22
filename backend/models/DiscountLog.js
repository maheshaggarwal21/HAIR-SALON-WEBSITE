/**
 * @file DiscountLog.js
 * @description One row every time a discount is given at the desk (D60, part B).
 *
 * The owner asked for NO cap on discounts — staff must be able to give any
 * percentage the moment a regular asks. What they asked for instead is to be able
 * to see afterwards who gave how much, so every discount above 0% leaves a row
 * here, and unusual ones (above SiteSettings.discountReviewPercent) are
 * highlighted in the owner's summary. Nothing here ever blocks a sale.
 *
 * Append-only: a row is never edited. If a visit's discount is changed later,
 * `recordDiscountEdit` appends another row (`kind: "edited"`) so the history
 * reads created → edited → edited. The Visit still holds the current figure.
 *
 * `day` is the IST calendar day the row was written, so the summary groups by
 * the salon's day and not by UTC (a 1 a.m. IST entry is yesterday in UTC).
 */

const mongoose = require("mongoose");

const discountLogSchema = new mongoose.Schema(
  {
    visitId: { type: mongoose.Schema.Types.ObjectId, ref: "Visit", required: true, index: true },
    kind: { type: String, enum: ["created", "edited"], required: true },

    percent: { type: Number, required: true, min: 0, max: 100 },
    /** Rupees given away on this visit (subtotal × percent). */
    amount: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
    finalTotal: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, default: null },
    /** Free text from the desk — optional, never required to proceed. */
    reason: { type: String, default: null },

    /** Who entered the visit. Name is kept because staff can be renamed or deactivated. */
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    staffName: { type: String, default: "Unknown" },

    /** IST "YYYY-MM-DD" of the write. */
    day: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One "created" row per visit: a retried request must not log the discount twice.
discountLogSchema.index(
  { visitId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "created" } }
);
discountLogSchema.index({ day: 1, staffName: 1 });

module.exports = mongoose.models.DiscountLog || mongoose.model("DiscountLog", discountLogSchema);
