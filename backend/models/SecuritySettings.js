/**
 * @file SecuritySettings.js
 * @description Singleton document holding every owner-configurable access policy.
 *
 * There is exactly one document, keyed `global`. Fetch it with
 * `SecuritySettings.load()` — it self-creates on first call, so no seed script
 * is needed and a fresh database boots with sane defaults.
 *
 * Two families of settings live here:
 *
 *   1. roleDefaults — the permission array a NEW account of each role starts
 *      with. This replaces the hardcoded ROLE_DEFAULTS constant so the owner
 *      can change it from the Management tab without a redeploy. The constant
 *      in constants/permissions.js remains the fallback seed value.
 *
 *   2. Login-approval policy — which roles are gated behind owner approval,
 *      how long a Telegram approval window stays open, how long a device stays
 *      trusted, and the hashed break-glass bypass code.
 */

const mongoose = require("mongoose");
const { ROLE_DEFAULTS } = require("../constants/permissions");

const GATED_ROLES = ["receptionist", "manager", "artist"];

const securitySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true, immutable: true },

    // ── Default permissions granted to a newly created account, per role ─────
    // The owner role is absent on purpose: it bypasses PBAC entirely.
    roleDefaults: {
      receptionist: { type: [String], default: () => [...ROLE_DEFAULTS.receptionist] },
      manager:      { type: [String], default: () => [...ROLE_DEFAULTS.manager] },
      artist:       { type: [String], default: () => [...ROLE_DEFAULTS.artist] },
    },

    // ── Which roles require owner approval to sign in ────────────────────────
    // A per-user override on User.requiresApproval (true/false) beats this.
    // User.requiresApproval === null means "inherit whatever is set here".
    roleRequiresApproval: {
      receptionist: { type: Boolean, default: false },
      manager:      { type: Boolean, default: false },
      artist:       { type: Boolean, default: false },
    },

    /**
     * Master kill switch. When false, every login is direct regardless of role
     * or per-user policy. Exists so the owner can disable the gate instantly
     * if Telegram and SMS are both down, without editing per-user rows.
     */
    approvalGateEnabled: { type: Boolean, default: true },

    /** Fallback approver when a staff member has no approverUserId of their own. */
    defaultApproverUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /**
     * How long a device stays trusted after a successful approval.
     * 12h covers a full salon shift, so staff are approved once per day rather
     * than once per login. 0 disables device trust entirely.
     */
    trustedWindowHours: { type: Number, default: 12, min: 0, max: 168 },

    /** How long the Telegram Approve/Deny window stays open before SMS fallback. */
    approvalTimeoutSeconds: { type: Number, default: 90, min: 30, max: 600 },

    /** OTP lifetime once the SMS fallback fires. */
    otpExpiryMinutes: { type: Number, default: 5, min: 1, max: 30 },

    /** Wrong-OTP attempts allowed before the pending login is burned. */
    maxOtpAttempts: { type: Number, default: 5, min: 1, max: 10 },

    /**
     * When true, a staff member is let in if BOTH Telegram and SMS are
     * unreachable (no chat id, no phone, or the provider errored).
     * Defaults to false — fail closed. The break-glass bypass code is the
     * intended escape hatch, not silent fail-open.
     */
    failOpenIfUnreachable: { type: Boolean, default: false },

    // ── Break-glass bypass code ──────────────────────────────────────────────
    // Hashed with bcrypt, never stored or returned in plaintext. `select: false`
    // keeps it out of every query that does not explicitly ask for it.
    bypassCodeHash:        { type: String, default: null, select: false },
    bypassCodeSetAt:       { type: Date, default: null },
    bypassCodeSetByName:   { type: String, default: null },
    bypassCodeLastUsedAt:  { type: Date, default: null },
    bypassCodeUseCount:    { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * Fetch the singleton, creating it on first call.
 * @param {boolean} [withSecret=false] include the bcrypt bypass hash
 * @returns {Promise<mongoose.Document>}
 */
securitySettingsSchema.statics.load = async function (withSecret = false) {
  const projection = withSecret ? "+bypassCodeHash" : "";
  let doc = await this.findOne({ key: "global" }).select(projection);
  if (!doc) {
    await this.create({ key: "global" });
    doc = await this.findOne({ key: "global" }).select(projection);
  }
  return doc;
};

module.exports = mongoose.model("SecuritySettings", securitySettingsSchema);
module.exports.GATED_ROLES = GATED_ROLES;
