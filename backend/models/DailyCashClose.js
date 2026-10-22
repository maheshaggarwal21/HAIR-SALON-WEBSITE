/**
 * @file DailyCashClose.js
 * @description The end-of-day cash count (D60, part C): one immutable record per day.
 *
 * ── Blind count ───────────────────────────────────────────────────────────────
 * Whoever closes the day counts the drawer FIRST and types the figure in; only after
 * they submit does the app show what the till should hold and the difference. So the
 * count cannot be nudged to match. `expectedCash` is computed by the SERVER at that
 * moment from the day's paid visits and kept here as a snapshot.
 *
 *   expectedCash = openingFloat + cash taken for the day − cash taken out
 *
 * "Cash taken" is the cash PORTION of paid visits only (Visit.cashAmount): the card
 * and UPI parts of a visit, and card-only or UPI-only visits, never touch the drawer.
 *
 * ── Never edited ──────────────────────────────────────────────────────────────
 * No route updates a closed record. Receptionist and manager cannot change it at
 * all. If the owner finds the count was wrong, they add an ADJUSTMENT (a signed
 * rupee amount and a reason, audited); the original numbers stay exactly as
 * submitted, and the "effective" figures are the original plus the adjustments.
 *
 * `day` is the IST calendar day ("YYYY-MM-DD"), unique: a day closes once.
 */

const mongoose = require("mongoose");

const takenOutSchema = new mongoose.Schema(
  {
    reason: { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const adjustmentSchema = new mongoose.Schema(
  {
    /** Signed rupees added to the counted cash (+ the recount found more, - less). */
    delta: { type: Number, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    byId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const dailyCashCloseSchema = new mongoose.Schema(
  {
    day: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    // What the person closing entered.
    openingFloat: { type: Number, required: true, min: 0 },
    /** Where openingFloat started: the previous close's "left in drawer", or typed in. */
    openingFloatSource: { type: String, enum: ["previous_close", "entered"], default: "entered" },
    countedCash: { type: Number, required: true, min: 0 },
    cashTakenOut: { type: [takenOutSchema], default: [] },
    /** Cash that stays in the drawer overnight; tomorrow's default opening float. */
    leftInDrawer: { type: Number, required: true, min: 0 },
    note: { type: String, default: null, maxlength: 300 },

    // Computed by the server at submission.
    cashSales: { type: Number, required: true },
    cashSalesVisits: { type: Number, required: true },
    takenOutTotal: { type: Number, required: true },
    expectedCash: { type: Number, required: true },
    /** counted − expected, as submitted. Negative = the drawer is short. */
    difference: { type: Number, required: true },

    closedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    closedByName: { type: String, default: null },
    closedAt: { type: Date, default: Date.now },

    adjustments: { type: [adjustmentSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.models.DailyCashClose || mongoose.model("DailyCashClose", dailyCashCloseSchema);
