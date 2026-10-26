/**
 * @file Lead.js
 * @description A person who showed interest but did not ask for a time: they left a name, a phone number and, if they
 * wanted, a question. Two places make one: an offer page when NO bundle was chosen, and the "Interested?" section on
 * the landing page. A request with a bundle chosen is not a lead: it is a booking request (Appointment, mode "request").
 *
 * Privacy (CLAUDE.md): only what the person typed, plus where it came from. A lead is NOT a customer (no Customer
 * row) and agreeing to be contacted about the question is not agreeing to promotions: there is no marketing consent
 * here. The salon works the list in the staff app, Bookings -> Leads: new -> contacted -> closed, with a note.
 */
const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** 10 digits, no +91. */
    phone: { type: String, required: true, match: /^[6-9]\d{9}$/ },
    query: { type: String, trim: true, maxlength: 500, default: null },
    status: { type: String, enum: ["new", "contacted", "closed"], default: "new", index: true },
    /** Staff-only note ("called, coming Friday"). */
    note: { type: String, trim: true, maxlength: 300, default: null },
    handledBy: { type: String, default: null },
    handledAt: { type: Date, default: null },
    source: {
      channel: { type: String, enum: ["offer_page", "landing"], required: true },
      offerSlug: { type: String, default: null },
      campaign: { type: String, default: null },
      utm: { type: mongoose.Schema.Types.Mixed, default: null },
    },
  },
  { timestamps: true }
);

leadSchema.index({ createdAt: -1 });
leadSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model("Lead", leadSchema);
