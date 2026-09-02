/**
 * @file management.js
 * @description Everything behind the owner's Management tab.
 *
 * Mounted at /api/management in index.js behind `authenticate`.
 * Read endpoints require team.view; every mutation requires team.manage.
 *
 * This router is the single place that spans BOTH staff collections. Team
 * members live in `User`; artists live in `Artist` with an optional linked
 * `User` for login. The roster endpoint merges them so the owner sees one list
 * instead of having to remember which tab a person lives in.
 *
 * Privilege containment: `guardOwnerTarget` blocks any non-owner actor from
 * acting on an owner-role account. Without it, anyone granted team.manage could
 * reset the owner's password and take over the salon — which is exactly what
 * the pre-existing /api/admin routes allowed.
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const User = require("../models/User");
const Artist = require("../models/Artist");
const SecuritySettings = require("../models/SecuritySettings");
const TrustedDevice = require("../models/TrustedDevice");
const PendingLogin = require("../models/PendingLogin");
const AuditLog = require("../models/AuditLog");
const validateId = require("../middleware/validateId");
const { invalidateUserSessions } = require("../utils/sessionUtils");
const { authorizePermission, evictPermissionCache } = require("../middleware/authMiddleware");
const { PERMISSIONS, PERMISSION_LABELS, PERMISSION_GROUPS } = require("../constants/permissions");
const telegram = require("../utils/telegram");
const sms = require("../utils/sms");
const gate = require("../utils/loginGate");
const audit = require("../utils/audit");

const router = express.Router();

const VALID_KEYS = Object.values(PERMISSIONS);
const ASSIGNABLE_ROLES = ["receptionist", "manager", "artist"];

// ── Ensure DB on every request (Vercel cold-start) ─────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[management] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

const canView   = authorizePermission(PERMISSIONS.TEAM_VIEW);
const canManage = authorizePermission(PERMISSIONS.TEAM_MANAGE);

/**
 * Only an owner may act on an owner-role account.
 * Loads req.targetUser as a side effect so handlers don't refetch.
 */
async function guardOwnerTarget(req, res, next) {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "Account not found" });

    if (user.role === "owner" && req.session.role !== "owner") {
      return res.status(403).json({
        error: "Only the owner can modify the owner account.",
      });
    }
    req.targetUser = user;
    next();
  } catch (err) {
    console.error("[management] guardOwnerTarget error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

function reject(res, errors) {
  return res.status(400).json({ errors: errors.array() });
}

// ═══ Roster ═════════════════════════════════════════════════════════════════

/**
 * GET /roster — every person in the salon, from both collections, in one list.
 *
 * Artists without a linked User account appear with `hasLogin: false`; they are
 * directory entries for visit attribution, not accounts, so permission and
 * approval controls are inert for them.
 */
router.get("/roster", canView, async (_req, res) => {
  try {
    const [users, artists, settings] = await Promise.all([
      User.find({}, "-passwordHash").sort({ createdAt: -1 }).lean(),
      Artist.find({}).populate("userId", "permissions isActive requiresApproval approverUserId lastLoginAt mustChangePassword").sort({ name: 1 }).lean(),
      SecuritySettings.load(),
    ]);

    // Artist-role Users are represented through their Artist row instead, so we
    // don't list the same human twice.
    const linkedUserIds = new Set(
      artists.map((a) => a.userId?._id?.toString()).filter(Boolean)
    );

    const teamRows = users
      .filter((u) => !linkedUserIds.has(u._id.toString()))
      .map((u) => ({
        id:            u._id.toString(),
        source:        "user",
        userId:        u._id.toString(),
        name:          u.name,
        email:         u.email,
        phone:         u.phone ?? null,
        role:          u.role,
        isActive:      u.isActive,
        hasLogin:      true,
        permissions:   u.permissions ?? [],
        requiresApproval: u.requiresApproval ?? null,
        approverUserId:   u.approverUserId?.toString() ?? null,
        effectiveApproval: resolveEffective(u, settings),
        mustChangePassword: Boolean(u.mustChangePassword),
        telegramLinked: Boolean(u.telegramChatId),
        lastLoginAt:   u.lastLoginAt ?? null,
        createdAt:     u.createdAt,
        updatedAt:     u.updatedAt,
      }));

    const artistRows = artists.map((a) => {
      const linked = a.userId ?? null;
      const shim = linked
        ? { role: "artist", requiresApproval: linked.requiresApproval ?? null }
        : null;
      return {
        id:          a._id.toString(),
        source:      "artist",
        artistId:    a._id.toString(),
        userId:      linked?._id?.toString() ?? null,
        name:        a.name,
        email:       a.email ?? null,
        phone:       a.phone,
        role:        "artist",
        isActive:    a.isActive,
        hasLogin:    Boolean(linked),
        permissions: linked?.permissions ?? [],
        requiresApproval:  linked?.requiresApproval ?? null,
        approverUserId:    linked?.approverUserId?.toString() ?? null,
        effectiveApproval: shim ? resolveEffective(shim, settings) : false,
        mustChangePassword: Boolean(linked?.mustChangePassword),
        telegramLinked: false,
        lastLoginAt: linked?.lastLoginAt ?? null,
        commission:  a.commission,
        registrationId: a.registrationId ?? null,
        createdAt:   a.createdAt,
        updatedAt:   a.updatedAt,
      };
    });

    return res.json({
      roster: [...teamRows, ...artistRows],
      registry: {
        permissions: VALID_KEYS,
        labels:      PERMISSION_LABELS,
        groups:      PERMISSION_GROUPS,
        roles:       ASSIGNABLE_ROLES,
      },
    });
  } catch (err) {
    console.error("[management] roster error:", err);
    return res.status(500).json({ error: "Failed to load the staff roster" });
  }
});

/** Mirror of loginGate.requiresApproval, for display only. */
function resolveEffective(user, settings) {
  if (!settings.approvalGateEnabled) return false;
  if (user.role === "owner") return false;
  if (user.requiresApproval === true) return true;
  if (user.requiresApproval === false) return false;
  return Boolean(settings.roleRequiresApproval?.[user.role]);
}

// ═══ Role defaults ══════════════════════════════════════════════════════════

router.get("/role-defaults", canView, async (_req, res) => {
  const settings = await SecuritySettings.load();
  return res.json({
    roleDefaults: settings.roleDefaults,
    registry: { permissions: VALID_KEYS, labels: PERMISSION_LABELS, groups: PERMISSION_GROUPS },
  });
});

/**
 * PUT /role-defaults — set the permission set new accounts of a role start with.
 *
 * Deliberately does NOT retro-apply to existing staff: someone who had a
 * permission individually revoked should not silently get it back because the
 * role default changed. Use POST /role-defaults/:role/apply for that, which is
 * an explicit, audited action.
 */
router.put(
  "/role-defaults",
  canManage,
  [body("roleDefaults").isObject().withMessage("roleDefaults must be an object")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);

    try {
      const settings = await SecuritySettings.load();
      const before = JSON.parse(JSON.stringify(settings.roleDefaults));
      const incoming = req.body.roleDefaults;

      for (const role of ASSIGNABLE_ROLES) {
        if (incoming[role] === undefined) continue;
        if (!Array.isArray(incoming[role])) {
          return res.status(400).json({ error: `roleDefaults.${role} must be an array` });
        }
        const invalid = incoming[role].filter((k) => !VALID_KEYS.includes(k));
        if (invalid.length) {
          return res.status(400).json({ error: "Invalid permission key(s)", invalid });
        }
        settings.roleDefaults[role] = [...new Set(incoming[role])];
      }

      await settings.save();
      await audit.record({
        action: "role_defaults.changed",
        req,
        meta: { before, after: settings.roleDefaults },
      });

      return res.json({ roleDefaults: settings.roleDefaults });
    } catch (err) {
      console.error("[management] role-defaults error:", err);
      return res.status(500).json({ error: "Failed to save role defaults" });
    }
  }
);

/** POST /role-defaults/:role/apply — opt-in backfill onto existing accounts. */
router.post("/role-defaults/:role/apply", canManage, async (req, res) => {
  const { role } = req.params;
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: "Unknown role" });
  }

  try {
    const settings = await SecuritySettings.load();
    const perms = settings.roleDefaults[role] ?? [];
    const targets = await User.find({ role, isActive: true }, "_id name permissions");

    await Promise.all(
      targets.map(async (u) => {
        await User.findByIdAndUpdate(u._id, { permissions: perms });
        evictPermissionCache(u._id.toString());
      })
    );

    await audit.record({
      action: "permissions.changed",
      req,
      meta: { bulk: true, role, appliedTo: targets.length, permissions: perms },
    });

    return res.json({ ok: true, updated: targets.length, permissions: perms });
  } catch (err) {
    console.error("[management] apply role defaults error:", err);
    return res.status(500).json({ error: "Failed to apply role defaults" });
  }
});

// ═══ Individual permissions ═════════════════════════════════════════════════

router.put(
  "/staff/:userId/permissions",
  validateId.param("userId"),
  canManage,
  guardOwnerTarget,
  [body("permissions").isArray().withMessage("permissions must be an array")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);

    try {
      const user = req.targetUser;
      if (user.role === "owner") {
        return res.status(400).json({ error: "The owner bypasses permissions — there is nothing to set." });
      }

      const invalid = req.body.permissions.filter((k) => !VALID_KEYS.includes(k));
      if (invalid.length) return res.status(400).json({ error: "Invalid permission key(s)", invalid });

      const before = user.permissions ?? [];
      user.permissions = [...new Set(req.body.permissions)];
      await user.save();
      evictPermissionCache(user._id.toString());

      await audit.record({
        action: "permissions.changed",
        req,
        target: { id: user._id, name: user.name },
        meta: audit.diffPermissions(before, user.permissions),
      });

      return res.json({ id: user._id, permissions: user.permissions });
    } catch (err) {
      console.error("[management] set permissions error:", err);
      return res.status(500).json({ error: "Failed to update permissions" });
    }
  }
);

// ═══ Login-approval policy ══════════════════════════════════════════════════

router.get("/security", canView, async (_req, res) => {
  try {
    const settings = await SecuritySettings.load();
    const approvers = await User.find(
      { role: "owner", isActive: true },
      "name email phone telegramChatId telegramUsername telegramLinkedAt"
    ).lean();

    return res.json({
      settings: {
        approvalGateEnabled:    settings.approvalGateEnabled,
        roleRequiresApproval:   settings.roleRequiresApproval,
        defaultApproverUserId:  settings.defaultApproverUserId,
        trustedWindowHours:     settings.trustedWindowHours,
        approvalTimeoutSeconds: settings.approvalTimeoutSeconds,
        otpExpiryMinutes:       settings.otpExpiryMinutes,
        maxOtpAttempts:         settings.maxOtpAttempts,
        failOpenIfUnreachable:  settings.failOpenIfUnreachable,
      },
      bypassCode: {
        isSet:      Boolean(settings.bypassCodeSetAt),
        setAt:      settings.bypassCodeSetAt,
        setByName:  settings.bypassCodeSetByName,
        lastUsedAt: settings.bypassCodeLastUsedAt,
        useCount:   settings.bypassCodeUseCount,
      },
      channels: {
        telegramConfigured: telegram.isConfigured(),
        smsConfigured:      sms.isConfigured(),
      },
      approvers: approvers.map((a) => ({
        id:               a._id.toString(),
        name:             a.name,
        email:            a.email,
        phone:            a.phone ?? null,
        maskedPhone:      a.phone ? sms.maskPhone(a.phone) : null,
        telegramLinked:   Boolean(a.telegramChatId),
        telegramUsername: a.telegramUsername ?? null,
        telegramLinkedAt: a.telegramLinkedAt ?? null,
      })),
    });
  } catch (err) {
    console.error("[management] get security error:", err);
    return res.status(500).json({ error: "Failed to load security settings" });
  }
});

router.patch(
  "/security",
  canManage,
  [
    body("approvalGateEnabled").optional().isBoolean(),
    body("roleRequiresApproval").optional().isObject(),
    body("trustedWindowHours").optional().isInt({ min: 0, max: 168 }),
    body("approvalTimeoutSeconds").optional().isInt({ min: 30, max: 600 }),
    body("otpExpiryMinutes").optional().isInt({ min: 1, max: 30 }),
    body("maxOtpAttempts").optional().isInt({ min: 1, max: 10 }),
    body("failOpenIfUnreachable").optional().isBoolean(),
    body("defaultApproverUserId").optional({ nullable: true }).isMongoId(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);

    try {
      const settings = await SecuritySettings.load();
      const changed = {};

      const scalars = [
        "approvalGateEnabled",
        "trustedWindowHours",
        "approvalTimeoutSeconds",
        "otpExpiryMinutes",
        "maxOtpAttempts",
        "failOpenIfUnreachable",
      ];
      for (const key of scalars) {
        if (req.body[key] !== undefined && req.body[key] !== settings[key]) {
          changed[key] = { from: settings[key], to: req.body[key] };
          settings[key] = req.body[key];
        }
      }

      if (req.body.roleRequiresApproval) {
        for (const role of ASSIGNABLE_ROLES) {
          const val = req.body.roleRequiresApproval[role];
          if (typeof val === "boolean" && val !== settings.roleRequiresApproval[role]) {
            changed[`roleRequiresApproval.${role}`] = {
              from: settings.roleRequiresApproval[role],
              to: val,
            };
            settings.roleRequiresApproval[role] = val;
          }
        }
      }

      if (req.body.defaultApproverUserId !== undefined) {
        changed.defaultApproverUserId = {
          from: settings.defaultApproverUserId,
          to: req.body.defaultApproverUserId,
        };
        settings.defaultApproverUserId = req.body.defaultApproverUserId || null;
      }

      await settings.save();

      if (Object.keys(changed).length) {
        await audit.record({ action: "security_settings.changed", req, meta: changed });
      }

      return res.json({ ok: true, changed });
    } catch (err) {
      console.error("[management] patch security error:", err);
      return res.status(500).json({ error: "Failed to save security settings" });
    }
  }
);

/** Per-person override of the role-level approval policy. */
router.patch(
  "/staff/:userId/approval",
  validateId.param("userId"),
  canManage,
  guardOwnerTarget,
  [
    body("requiresApproval").optional({ nullable: true }).isBoolean(),
    body("approverUserId").optional({ nullable: true }).isMongoId(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);

    try {
      const user = req.targetUser;
      if (user.role === "owner") {
        return res.status(400).json({ error: "The owner is never gated — they are the approver." });
      }

      const before = {
        requiresApproval: user.requiresApproval,
        approverUserId:   user.approverUserId,
      };

      // `null` is meaningful here: it means "inherit the role default".
      if ("requiresApproval" in req.body) {
        user.requiresApproval =
          req.body.requiresApproval === null ? null : Boolean(req.body.requiresApproval);
      }
      if ("approverUserId" in req.body) {
        user.approverUserId = req.body.approverUserId || null;
      }
      await user.save();

      await audit.record({
        action: "approval_policy.changed",
        req,
        target: { id: user._id, name: user.name },
        meta: { before, after: { requiresApproval: user.requiresApproval, approverUserId: user.approverUserId } },
      });

      const settings = await SecuritySettings.load();
      return res.json({
        id: user._id,
        requiresApproval:  user.requiresApproval,
        approverUserId:    user.approverUserId,
        effectiveApproval: resolveEffective(user, settings),
      });
    } catch (err) {
      console.error("[management] approval override error:", err);
      return res.status(500).json({ error: "Failed to update approval policy" });
    }
  }
);

/** Approver contact details — the phone the OTP fallback dials. */
router.patch(
  "/staff/:userId/contact",
  validateId.param("userId"),
  canManage,
  guardOwnerTarget,
  [
    body("phone")
      .optional({ nullable: true, values: "falsy" })
      .matches(/^[6-9]\d{9}$/)
      .withMessage("Enter a valid 10-digit Indian mobile number"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);

    try {
      const user = req.targetUser;
      if ("phone" in req.body) user.phone = req.body.phone || null;
      await user.save();

      await audit.record({
        action: "staff.updated",
        req,
        target: { id: user._id, name: user.name },
        meta: { field: "phone", set: Boolean(user.phone) },
      });

      return res.json({ id: user._id, phone: user.phone, maskedPhone: user.phone ? sms.maskPhone(user.phone) : null });
    } catch (err) {
      console.error("[management] contact error:", err);
      return res.status(500).json({ error: "Failed to update contact details" });
    }
  }
);

// ═══ Passwords ══════════════════════════════════════════════════════════════

/**
 * POST /staff/:userId/temp-password
 *
 * Generates (or accepts) a password, forces a change at next sign-in, and kills
 * every live session for that account. The plaintext is returned exactly once —
 * it is bcrypt-hashed on write and cannot be read back afterwards.
 */
router.post(
  "/staff/:userId/temp-password",
  validateId.param("userId"),
  canManage,
  guardOwnerTarget,
  [
    body("password").optional().isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
    body("forceChange").optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);

    try {
      const user = req.targetUser;
      const plaintext = req.body.password || gate.generateReadableCode(10);
      const forceChange = req.body.forceChange !== false; // default true

      user.passwordHash = await bcrypt.hash(plaintext, 12);
      user.mustChangePassword = forceChange;
      await user.save();

      await invalidateUserSessions(req.sessionStore, user._id.toString());

      await audit.record({
        action: "staff.password_reset",
        req,
        target: { id: user._id, name: user.name },
        meta: { generated: !req.body.password, forceChange },
      });

      return res.json({
        ok: true,
        // Shown once in the UI, then discarded. Never persisted in plaintext.
        password: plaintext,
        mustChangePassword: forceChange,
      });
    } catch (err) {
      console.error("[management] temp password error:", err);
      return res.status(500).json({ error: "Failed to reset the password" });
    }
  }
);

router.post(
  "/staff/:userId/force-logout",
  validateId.param("userId"),
  canManage,
  guardOwnerTarget,
  async (req, res) => {
    try {
      const user = req.targetUser;
      const killed = await invalidateUserSessions(req.sessionStore, user._id.toString());

      await audit.record({
        action: "staff.force_logout",
        req,
        target: { id: user._id, name: user.name },
        meta: { sessionsDestroyed: killed },
      });

      return res.json({ ok: true, sessionsDestroyed: killed });
    } catch (err) {
      console.error("[management] force logout error:", err);
      return res.status(500).json({ error: "Failed to sign the user out" });
    }
  }
);

// ═══ Trusted devices ════════════════════════════════════════════════════════

router.get("/staff/:userId/devices", validateId.param("userId"), canView, async (req, res) => {
  try {
    const devices = await TrustedDevice.find({
      userId: req.params.userId,
      trustedUntil: { $gt: new Date() },
    })
      .sort({ lastUsedAt: -1 })
      .lean();

    return res.json(
      devices.map((d) => ({
        id:           d._id.toString(),
        label:        d.label,
        ip:           d.ip,
        grantedVia:   d.grantedVia,
        trustedUntil: d.trustedUntil,
        lastUsedAt:   d.lastUsedAt,
        createdAt:    d.createdAt,
      }))
    );
  } catch (err) {
    console.error("[management] list devices error:", err);
    return res.status(500).json({ error: "Failed to load trusted devices" });
  }
});

router.delete("/devices/:deviceId", validateId.param("deviceId"), canManage, async (req, res) => {
  try {
    const device = await TrustedDevice.findById(req.params.deviceId);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const owner = await User.findById(device.userId, "name role");
    if (owner?.role === "owner" && req.session.role !== "owner") {
      return res.status(403).json({ error: "Only the owner can revoke the owner's devices." });
    }

    await TrustedDevice.findByIdAndDelete(req.params.deviceId);

    await audit.record({
      action: "device.revoked",
      req,
      target: { id: device.userId, name: owner?.name ?? null },
      meta: { device: device.label, grantedVia: device.grantedVia },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[management] revoke device error:", err);
    return res.status(500).json({ error: "Failed to revoke the device" });
  }
});

router.delete(
  "/staff/:userId/devices",
  validateId.param("userId"),
  canManage,
  guardOwnerTarget,
  async (req, res) => {
    try {
      const { deletedCount } = await TrustedDevice.deleteMany({ userId: req.params.userId });

      await audit.record({
        action: "device.revoked",
        req,
        target: { id: req.targetUser._id, name: req.targetUser.name },
        meta: { all: true, revoked: deletedCount },
      });

      return res.json({ ok: true, revoked: deletedCount });
    } catch (err) {
      console.error("[management] revoke all devices error:", err);
      return res.status(500).json({ error: "Failed to revoke devices" });
    }
  }
);

// ═══ Break-glass bypass code ════════════════════════════════════════════════

/**
 * PUT /bypass-code — set a custom code, or generate one.
 *
 * Owner-only, not merely team.manage: this code bypasses the entire approval
 * system for every account, so it must not be settable by someone the owner
 * granted team management to.
 */
router.put(
  "/bypass-code",
  canManage,
  [body("code").optional().isString().trim().isLength({ min: 6, max: 64 })
    .withMessage("A bypass code must be at least 6 characters")],
  async (req, res) => {
    if (req.session.role !== "owner") {
      return res.status(403).json({ error: "Only the owner can set the emergency bypass code." });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);

    try {
      const settings = await SecuritySettings.load(true);
      const plaintext = req.body.code?.trim() || gate.generateReadableCode(12);

      settings.bypassCodeHash       = await bcrypt.hash(plaintext, 12);
      settings.bypassCodeSetAt      = new Date();
      settings.bypassCodeSetByName  = req.session.name;
      settings.bypassCodeUseCount   = 0;
      settings.bypassCodeLastUsedAt = null;
      await settings.save();

      await audit.record({
        action: "bypass_code.set",
        req,
        meta: { custom: Boolean(req.body.code) },
      });

      return res.json({
        ok: true,
        // Shown once. There is no endpoint that can read it back.
        code: plaintext,
        setAt: settings.bypassCodeSetAt,
      });
    } catch (err) {
      console.error("[management] set bypass code error:", err);
      return res.status(500).json({ error: "Failed to set the bypass code" });
    }
  }
);

router.delete("/bypass-code", canManage, async (req, res) => {
  if (req.session.role !== "owner") {
    return res.status(403).json({ error: "Only the owner can clear the emergency bypass code." });
  }

  try {
    const settings = await SecuritySettings.load(true);
    settings.bypassCodeHash      = null;
    settings.bypassCodeSetAt     = null;
    settings.bypassCodeSetByName = null;
    await settings.save();

    await audit.record({ action: "bypass_code.cleared", req });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[management] clear bypass code error:", err);
    return res.status(500).json({ error: "Failed to clear the bypass code" });
  }
});

// ═══ Telegram linking ═══════════════════════════════════════════════════════

router.post("/telegram/link", canManage, async (req, res) => {
  try {
    if (!telegram.isConfigured()) {
      return res.status(503).json({
        error: "TELEGRAM_BOT_TOKEN is not set on the server. Create a bot with @BotFather and add the token.",
      });
    }

    const me = await telegram.getMe();
    if (!me.ok) return res.status(502).json({ error: "Could not reach Telegram. Check the bot token." });

    const user = await User.findById(req.session.userId);
    user.telegramLinkCode      = gate.generateReadableCode(8);
    user.telegramLinkExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    return res.json({
      code:      user.telegramLinkCode,
      deepLink:  `https://t.me/${me.result.username}?start=${user.telegramLinkCode}`,
      botUsername: me.result.username,
      expiresAt: user.telegramLinkExpiresAt,
    });
  } catch (err) {
    console.error("[management] telegram link error:", err);
    return res.status(500).json({ error: "Failed to start Telegram linking" });
  }
});

router.delete("/telegram/link", canManage, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    user.telegramChatId        = null;
    user.telegramUsername      = null;
    user.telegramLinkedAt      = null;
    user.telegramLinkCode      = null;
    user.telegramLinkExpiresAt = null;
    await user.save();

    await audit.record({ action: "telegram.unlinked", req, target: { id: user._id, name: user.name } });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[management] telegram unlink error:", err);
    return res.status(500).json({ error: "Failed to disconnect Telegram" });
  }
});

/** Sends a test message so the owner can confirm the wiring before relying on it. */
router.post("/telegram/test", canManage, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user.telegramChatId) return res.status(400).json({ error: "Telegram is not connected yet." });

    const result = await telegram.sendMessage(
      user.telegramChatId,
      "✅ Test message from your salon dashboard. Approval requests will arrive here."
    );
    if (!result.ok) return res.status(502).json({ error: result.error || "Telegram rejected the message." });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[management] telegram test error:", err);
    return res.status(500).json({ error: "Failed to send the test message" });
  }
});

// ═══ Audit + live approvals ═════════════════════════════════════════════════

router.get("/audit", canView, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.userId) {
      filter.$or = [{ targetUserId: req.query.userId }, { actorUserId: req.query.userId }];
    }

    const entries = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json(entries);
  } catch (err) {
    console.error("[management] audit error:", err);
    return res.status(500).json({ error: "Failed to load the audit log" });
  }
});

/** Recent gated sign-ins, for the "who tried to log in" view. */
router.get("/login-requests", canView, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await PendingLogin.find({}, "-otpHash -pollSecretHash -deviceToken")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json(rows);
  } catch (err) {
    console.error("[management] login-requests error:", err);
    return res.status(500).json({ error: "Failed to load login requests" });
  }
});

module.exports = router;
