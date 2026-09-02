/**
 * @file User.js
 * @description Mongoose model for staff user accounts.
 *
 * Roles:
 *   - receptionist — can create visit entries, view form data
 *   - manager      — everything a receptionist can do + analytics
 *   - owner        — everything + user management (admin dashboard)
 *
 * Soft-delete: users are never removed; `isActive: false` disables their account.
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { PERMISSIONS } = require('../constants/permissions');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["receptionist", "manager", "owner", "artist"],
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isActive: { type: Boolean, default: true },

    // ── Login-approval gate ──────────────────────────────────────────────────
    /**
     * Per-user override of the role-level approval policy in SecuritySettings.
     *   null  → inherit SecuritySettings.roleRequiresApproval[role]
     *   true  → always gated, even if the role is not
     *   false → never gated, even if the role is
     * Tri-state matters: a plain boolean could not express "follow the role",
     * so flipping a role default would silently skip anyone already edited.
     */
    requiresApproval: {
      type: Boolean,
      default: null,
    },

    /**
     * Who approves this person's logins. Falls back to
     * SecuritySettings.defaultApproverUserId when null, which keeps the door
     * open for per-branch approvers later without a schema change.
     */
    approverUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── Approver contact details (only meaningful on approver accounts) ──────
    /** Destination for the SMS OTP fallback. 10-digit Indian mobile. */
    phone: {
      type: String,
      default: null,
      trim: true,
      validate: {
        validator: (v) => v == null || v === "" || /^[6-9]\d{9}$/.test(v),
        message: "Enter a valid 10-digit Indian mobile number",
      },
    },
    /** Set once, when the approver links the bot via /start <code>. */
    telegramChatId:        { type: String, default: null },
    telegramUsername:      { type: String, default: null },
    telegramLinkedAt:      { type: Date, default: null },
    /** Short-lived one-time code backing the "Connect Telegram" deep link. */
    telegramLinkCode:      { type: String, default: null },
    telegramLinkExpiresAt: { type: Date, default: null },

    /** Forces a password change before any other page renders. */
    mustChangePassword: { type: Boolean, default: false },

    lastLoginAt: { type: Date, default: null },

    permissions: {
      type:    [String],
      default: [], // existing users start empty; migratePermissions.js will backfill them
      validate: {
        validator: function(arr) {
          const validKeys = Object.values(PERMISSIONS);
          return arr.every(k => validKeys.includes(k));
        },
        message: 'permissions array contains an invalid permission key',
      },
    },
  },
  { timestamps: true }
);

/**
 * Compare a plaintext password against the stored hash.
 * @param {string} plain - The plaintext password to check
 * @returns {Promise<boolean>}
 */
userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

/** True when this account can actually receive an approval request. */
userSchema.methods.canApprove = function () {
  return Boolean(this.telegramChatId || this.phone);
};

userSchema.index({ telegramLinkCode: 1 }, { sparse: true });
userSchema.index({ telegramChatId: 1 }, { sparse: true });

module.exports = mongoose.model("User", userSchema);
