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
const { PERMISSIONS, ROLE_DEFAULTS } = require('../constants/permissions');

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

module.exports = mongoose.model("User", userSchema);
