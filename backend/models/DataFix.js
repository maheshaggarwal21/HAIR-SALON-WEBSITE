/**
 * @file DataFix.js
 * @description What reception decided about one flagged item on Fix Numbers (D54).
 *
 * Detection is live (utils/numberChecks.js over Visits), so nothing here says an
 * item "exists". A row appears only once someone acts on it: marked fixed,
 * dismissed ("these are two different people"), or identified (a refunded
 * payment matched to a client). `key` is stable per item, so a dismissed pair
 * never comes back, while a new typo creates a new key.
 */
const mongoose = require("mongoose");

const dataFixSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    kind: { type: String, enum: ["duplicate", "invalid", "payment", "unassigned"], required: true, index: true },
    status: { type: String, enum: ["fixed", "dismissed"], required: true, index: true },
    note: { type: String, trim: true, maxlength: 300, default: null },
    /** For a refunded/failed payment: who it turned out to be. */
    identified: {
      name: { type: String, trim: true, maxlength: 80, default: null },
      contact: { type: String, trim: true, maxlength: 20, default: null },
    },
    resolvedBy: { id: { type: mongoose.Schema.Types.ObjectId, default: null }, name: { type: String, default: null } },
    resolvedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DataFix", dataFixSchema);
