/**
 * @file OtpChallenge.js
 * @description One one-time code sent to a customer's WhatsApp
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §2.2, §18, T2.6).
 *
 * Nothing here can be read back into a phone number or a code:
 *   - `phoneHash` is an HMAC of the phone (utils/bookingToken.phoneHash);
 *   - `codeHash` is sha256(salt + code) with a random per-challenge salt.
 *
 * A code lives 5 minutes (TTL index deletes it) and allows 5 wrong guesses;
 * then the customer asks for a new one. `consumedAt` is set by a conditional
 * update, so a code works exactly once even if two tabs submit it together.
 */

const mongoose = require("mongoose");

const otpChallengeSchema = new mongoose.Schema(
  {
    phoneHash: { type: String, required: true },
    codeHash: { type: String, required: true },
    salt: { type: String, required: true },
    purpose: { type: String, enum: ["booking", "manage", "giftcard"], required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    /** "dev" = not sent anywhere; printed to the server console outside production. */
    channel: { type: String, enum: ["whatsapp", "sms", "dev"], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

otpChallengeSchema.index({ phoneHash: 1, purpose: 1, createdAt: -1 });
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OtpChallenge", otpChallengeSchema);
