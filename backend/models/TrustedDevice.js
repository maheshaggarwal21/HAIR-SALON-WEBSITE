/**
 * @file TrustedDevice.js
 * @description Remembers that a specific user+browser pair already cleared the
 * owner-approval gate, so staff are approved once per shift rather than once
 * per login.
 *
 * The "fingerprint" is deliberately NOT derived from IP or user-agent — salon
 * wifi is shared and dynamic, so an IP-based fingerprint would either trust
 * every device on the network or none of them consistently. Instead the server
 * mints 32 random bytes at approval time, stores the SHA-256 digest here, and
 * hands the plaintext to the browser as an httpOnly cookie. Clearing cookies,
 * switching browsers, or using a different machine all correctly read as a new,
 * untrusted device.
 *
 * Rows self-delete when `trustedUntil` passes (TTL index), so the revoke list
 * only ever shows live trust.
 */

const mongoose = require("mongoose");
const crypto = require("crypto");

const trustedDeviceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    /** SHA-256 of the cookie value. The plaintext never touches the database. */
    tokenHash: { type: String, required: true, unique: true },

    trustedUntil: { type: Date, required: true },

    /** Human-readable hint so the owner can tell devices apart in the revoke UI. */
    label:      { type: String, default: "Unknown device" },
    ip:         { type: String, default: null },
    userAgent:  { type: String, default: null },
    lastUsedAt: { type: Date, default: Date.now },

    /** Which path originally earned this device its trust. */
    grantedVia: {
      type: String,
      enum: ["telegram", "otp", "bypass"],
      required: true,
    },
  },
  { timestamps: true }
);

// Expire the row the instant the trust window closes.
trustedDeviceSchema.index({ trustedUntil: 1 }, { expireAfterSeconds: 0 });

trustedDeviceSchema.statics.hashToken = function (token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
};

trustedDeviceSchema.statics.mintToken = function () {
  return crypto.randomBytes(32).toString("hex");
};

/**
 * Condense a User-Agent string into something an owner can recognise in a list.
 * Intentionally crude — this is a label, not analytics.
 * @param {string} ua
 * @returns {string}
 */
trustedDeviceSchema.statics.describe = function (ua) {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua)     ? "Edge"    :
    /OPR\//.test(ua)     ? "Opera"   :
    /Chrome\//.test(ua)  ? "Chrome"  :
    /Firefox\//.test(ua) ? "Firefox" :
    /Safari\//.test(ua)  ? "Safari"  : "Browser";
  const os =
    /Windows/.test(ua)          ? "Windows" :
    /Android/.test(ua)          ? "Android" :
    /iPhone|iPad|iOS/.test(ua)  ? "iOS"     :
    /Mac OS X/.test(ua)         ? "macOS"   :
    /Linux/.test(ua)            ? "Linux"   : "Unknown OS";
  return `${browser} on ${os}`;
};

module.exports = mongoose.model("TrustedDevice", trustedDeviceSchema);
