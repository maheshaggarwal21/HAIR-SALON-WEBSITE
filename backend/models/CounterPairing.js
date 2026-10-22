/**
 * @file CounterPairing.js
 * @description A one-time code the owner generates to pair a tablet (D60, part A).
 *
 * Six digits, valid for 5 minutes, usable once. Only a hash of the code is stored.
 * A wrong guess cannot be tied to one pairing (the guesser does not know which
 * code they are attacking), so every wrong guess counts against EVERY live
 * pairing; at 5 wrong tries a code is locked and a new one must be generated.
 * With the 5-per-minute-per-IP limit on the pair endpoint, guessing a code is
 * hopeless: at most 5 tries against a space of a million.
 *
 * Expired rows are deleted by the TTL index.
 */

const mongoose = require("mongoose");

const counterPairingSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, index: true },
    deviceName: { type: String, required: true, trim: true, maxlength: 60 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    wrongTries: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "CounterDevice", default: null },
  },
  { timestamps: true }
);

// Keep a used/expired row for a day so the owner's list can say "used", then drop it.
counterPairingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.models.CounterPairing || mongoose.model("CounterPairing", counterPairingSchema);
