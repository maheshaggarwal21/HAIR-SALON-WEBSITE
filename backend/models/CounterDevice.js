/**
 * @file CounterDevice.js
 * @description A paired counter tablet (D60, part A).
 *
 * The tablet shows the customer's payment QR. It is not a person and has no
 * login, so it carries a random bearer token instead: generated once when the
 * pairing code is redeemed, handed to the tablet exactly once, and stored here
 * only as a SHA-256 hash (a database leak must not hand out working tokens).
 * Revoking the device (revokedAt) makes its token useless at once.
 *
 * `lastPollAt` does double duty: it is the "tablet online" signal for the staff
 * screen's chip, and the per-device throttle for polling (one atomic update per
 * poll — see middleware/deviceAuth.js). `lastPollIntervalMs` is how often the
 * tablet was told to poll, so "offline" means "missed its own schedule" and the
 * slow overnight rate never reads as offline.
 */

const mongoose = require("mongoose");

const counterDeviceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    tokenHash: { type: String, required: true, unique: true },
    pairedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    pairedByName: { type: String, default: null },
    lastPollAt: { type: Date, default: null },
    lastPollIntervalMs: { type: Number, default: null },
    revokedAt: { type: Date, default: null },
    revokedByName: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.CounterDevice || mongoose.model("CounterDevice", counterDeviceSchema);
