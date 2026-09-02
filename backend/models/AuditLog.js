/**
 * @file AuditLog.js
 * @description Append-only record of security-relevant events.
 *
 * Two things make this worth having rather than relying on console logs:
 * the owner needs to see when the break-glass bypass code was used (it is a
 * deliberate hole in the approval system), and they need to see who changed
 * whose permissions.
 *
 * Entries expire after 180 days.
 */

const mongoose = require("mongoose");

const ACTIONS = [
  // Authentication
  "login.direct",
  "login.gated",
  "login.approved",
  "login.denied",
  "login.otp_sent",
  "login.otp_verified",
  "login.otp_failed",
  "login.bypass_used",
  "login.device_trusted",
  "login.failed",
  // Administration
  "staff.created",
  "staff.updated",
  "staff.deactivated",
  "staff.deleted",
  "staff.password_reset",
  "staff.force_logout",
  "permissions.changed",
  "role_defaults.changed",
  "approval_policy.changed",
  "security_settings.changed",
  "bypass_code.set",
  "bypass_code.cleared",
  "device.revoked",
  "telegram.linked",
  "telegram.unlinked",
];

const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ACTIONS, required: true, index: true },

    /** Who did it. Null for unauthenticated events such as a failed login. */
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName:   { type: String, default: "system" },
    actorRole:   { type: String, default: null },

    /** Who it was done to. Often the same as the actor for login events. */
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    targetName:   { type: String, default: null },

    /** Free-form event detail — permission diffs, masked phone, device label. */
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    ip:        { type: String, default: null },
    userAgent: { type: String, default: null },

    purgeAt: {
      type: Date,
      default: () => new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ targetUserId: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
module.exports.ACTIONS = ACTIONS;
