/**
 * @file RateLimitHit.js
 * @description One counter per (limiter key, fixed window), shared by every
 * serverless instance (CONTROL_FLOW_AND_DATA_LOGIC.md §14, T1.6).
 *
 * The existing global express-rate-limit keeps its counters in memory, which on
 * Vercel means per instance: twenty requests spread over five warm instances
 * each see four. Public endpoints face the open internet, so their limits live
 * here instead, where every instance increments the same document.
 *
 * Keys hold a sha256 of the IP or phone, never the raw value. Documents delete
 * themselves via the TTL index shortly after their window closes.
 */

const mongoose = require("mongoose");

const rateLimitHitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    windowStart: { type: Date, required: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

rateLimitHitSchema.index({ key: 1, windowStart: 1 }, { unique: true });
rateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RateLimitHit", rateLimitHitSchema);
