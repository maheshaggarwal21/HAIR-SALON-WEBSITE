/**
 * @file PendingLogin.js
 * @description One row per gated login attempt — the single state machine for
 * BOTH the Telegram approval path and the SMS OTP fallback path.
 *
 * There is deliberately no separate tracking collection for Telegram vs SMS:
 * both resolve this same document.
 *
 *   pending      → approved      (owner tapped Approve in Telegram)
 *   pending      → denied        (owner tapped Deny)
 *   pending      → otp_fallback  (approval window elapsed, OTP sent to approver)
 *   otp_fallback → otp_verified  (staff entered the code the owner relayed)
 *   otp_fallback → otp_failed    (too many wrong attempts, or the OTP expired)
 *   pending      → expired       (gate abandoned entirely)
 *
 * `approved` and `otp_verified` are terminal-but-unconsumed: the session is
 * only created once, on the first poll that observes them, after which
 * `consumedAt` is stamped and the row can never mint another session.
 *
 * Secrets (`otpHash`, `pollSecretHash`) are SHA-256 digests, never plaintext.
 * A 6-digit OTP has too little entropy for bcrypt to buy anything here — the
 * real protection is the 5-attempt cap and the 5-minute expiry.
 */

const mongoose = require("mongoose");
const crypto = require("crypto");

const STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "otp_fallback",
  "otp_verified",
  "otp_failed",
];

const pendingLoginSchema = new mongoose.Schema(
  {
    // UUID rather than an ObjectId — this value is handed to the browser and
    // embedded in Telegram callback_data, so a non-sequential opaque id is
    // the right shape.
    _id: { type: String, default: () => crypto.randomUUID() },

    userId:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    approverUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    /** Snapshot for display — survives a rename or deletion of the staff account. */
    staffName:  { type: String, required: true },
    staffEmail: { type: String, required: true },
    staffRole:  { type: String, required: true },

    status: { type: String, enum: STATUSES, default: "pending", index: true },

    // ── SMS OTP fallback ─────────────────────────────────────────────────────
    otpHash:      { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpSentTo:    { type: String, default: null }, // masked phone, safe to return
    /**
     * Whether the code actually reached a channel. False when MSG91 is not yet
     * configured (DLT pending) and the approver has no Telegram either — the
     * login screen must say "nobody could be reached, use the bypass code"
     * rather than pointing at a phone that received nothing.
     */
    otpDelivered: { type: Boolean, default: false },
    attemptCount: { type: Number, default: 0 },
    /** Snapshotted from SecuritySettings so mid-flight policy edits can't
     *  retroactively widen or narrow an in-progress attempt. */
    maxAttempts:  { type: Number, default: 5 },

    /**
     * Binds polling to the browser that actually supplied the password.
     * The plaintext half lives in an httpOnly cookie set on the /login response,
     * so a leaked pendingId alone cannot be polled into a session.
     */
    pollSecretHash: { type: String, required: true },

    /**
     * Device-trust token minted at /login. Persisted here so that whichever
     * path completes the login (Telegram, OTP, or bypass) trusts the same device.
     */
    deviceToken: { type: String, default: null },

    // ── Telegram message bookkeeping (so the webhook can edit it in place) ───
    telegramChatId:    { type: String, default: null },
    telegramMessageId: { type: Number, default: null },

    // ── Forensics ────────────────────────────────────────────────────────────
    ip:        { type: String, default: null },
    userAgent: { type: String, default: null },

    /** End of the Telegram Approve/Deny window. */
    expiresAt:  { type: Date, required: true },
    /** Set the moment a session is minted from this row. Enforces single use. */
    consumedAt: { type: Date, default: null },
    /** How the login was ultimately completed — for the audit view. */
    resolvedVia: {
      type: String,
      enum: ["telegram", "otp", "bypass", null],
      default: null,
    },

    /** Housekeeping TTL — rows self-delete an hour after creation. */
    purgeAt: { type: Date, default: () => new Date(Date.now() + 60 * 60 * 1000) },
  },
  { timestamps: true, _id: false }
);

pendingLoginSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
pendingLoginSchema.index({ userId: 1, createdAt: -1 });

/** SHA-256 helper used for both the OTP and the poll secret. */
pendingLoginSchema.statics.hash = function (value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
};

/** Constant-time comparison so OTP checking does not leak timing information. */
pendingLoginSchema.statics.hashesMatch = function (a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

module.exports = mongoose.model("PendingLogin", pendingLoginSchema);
module.exports.STATUSES = STATUSES;
