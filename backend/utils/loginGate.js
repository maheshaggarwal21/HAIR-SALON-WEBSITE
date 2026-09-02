/**
 * @file loginGate.js
 * @description Shared machinery for the owner-approval login gate.
 *
 * Everything that can mint a session — a direct login, a Telegram approval, a
 * relayed OTP, a break-glass bypass — funnels through establishSession() here,
 * so session shape and audit coverage cannot drift between the four paths.
 *
 * Session-based, not JWT: the project uses express-session + connect-mongo
 * (see index.js). "Issuing a token" therefore means writing req.session and
 * letting express-session set the httpOnly cookie on that response.
 */

const crypto = require("crypto");
const User = require("../models/User");
const SecuritySettings = require("../models/SecuritySettings");
const TrustedDevice = require("../models/TrustedDevice");
const PendingLogin = require("../models/PendingLogin");
const audit = require("./audit");

/** Cookie holding the device-trust token. Long-lived; the DB row governs expiry. */
const DEVICE_COOKIE = "salon_device";
const DEVICE_COOKIE_MAX_AGE = 180 * 24 * 60 * 60 * 1000; // 180 days

/** Cookie binding a poll of /login-status to the browser that authenticated. */
const PENDING_COOKIE = "salon_pending";
const PENDING_COOKIE_MAX_AGE = 15 * 60 * 1000; // 15 min — outlives the OTP window

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

// ─── Session creation ────────────────────────────────────────────────────────

/**
 * Write the authenticated session and return the client-facing user payload.
 * Mirrors the shape /api/auth/me returns so the frontend can treat them alike.
 *
 * @param {import("express").Request} req
 * @param {object} user  a full User document
 * @returns {Promise<object>} payload to send to the client
 */
function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.userId = user._id.toString();
    req.session.role   = user.role;
    req.session.name   = user.name;
    req.session.email  = user.email;

    // Explicit save: serverless can terminate the invocation before the
    // implicit end-of-response save runs.
    req.session.save((err) => {
      if (err) return reject(err);
      resolve({
        id:                 user._id,
        name:               user.name,
        email:              user.email,
        role:               user.role,
        permissions:        user.permissions ?? [],
        mustChangePassword: Boolean(user.mustChangePassword),
      });
    });
  });
}

// ─── Approval policy resolution ──────────────────────────────────────────────

/**
 * Decide whether this login must be approved.
 *
 * Precedence, highest first:
 *   1. master kill switch off              → never gated
 *   2. user is the owner                   → never gated (they are the approver)
 *   3. user.requiresApproval === true/false → explicit per-user override
 *   4. settings.roleRequiresApproval[role] → role default
 *
 * @returns {boolean}
 */
function requiresApproval(user, settings) {
  if (!settings.approvalGateEnabled) return false;
  if (user.role === "owner") return false;
  if (user.requiresApproval === true) return true;
  if (user.requiresApproval === false) return false;
  return Boolean(settings.roleRequiresApproval?.[user.role]);
}

/**
 * Resolve who should approve this user's logins.
 * Per-user approver wins; otherwise the configured default; otherwise the
 * first active owner account, so a fresh install works with no configuration.
 *
 * @returns {Promise<object|null>} approver User document
 */
async function resolveApprover(user, settings) {
  const candidates = [user.approverUserId, settings.defaultApproverUserId].filter(Boolean);

  for (const id of candidates) {
    const approver = await User.findById(id);
    if (approver?.isActive) return approver;
  }

  return User.findOne({ role: "owner", isActive: true }).sort({ createdAt: 1 });
}

// ─── Device trust ────────────────────────────────────────────────────────────

/**
 * Is the browser making this request already trusted for this user?
 * Refreshes lastUsedAt on a hit so the revoke list shows real activity.
 *
 * @returns {Promise<object|null>} the TrustedDevice row, or null
 */
async function findTrustedDevice(req, userId) {
  const token = req.cookies?.[DEVICE_COOKIE];
  if (!token) return null;

  const device = await TrustedDevice.findOne({
    userId,
    tokenHash: TrustedDevice.hashToken(token),
    trustedUntil: { $gt: new Date() },
  });

  if (device) {
    device.lastUsedAt = new Date();
    await device.save();
  }
  return device;
}

/**
 * Mark this browser trusted for the configured window.
 *
 * Reuses the existing cookie token when there is one, so a returning device
 * refreshes its row rather than accumulating a new row per shift.
 *
 * @param {string} grantedVia "telegram" | "otp" | "bypass"
 * @returns {Promise<object|null>} the TrustedDevice row, or null if trust is off
 */
async function trustDevice(req, res, userId, grantedVia, settings, presetToken) {
  const hours = settings.trustedWindowHours;
  if (!hours || hours <= 0) return null; // device trust disabled by the owner

  const token = presetToken || req.cookies?.[DEVICE_COOKIE] || TrustedDevice.mintToken();
  const tokenHash = TrustedDevice.hashToken(token);
  const trustedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
  const userAgent = req.get("user-agent") || null;

  const device = await TrustedDevice.findOneAndUpdate(
    { tokenHash },
    {
      $set: {
        userId,
        tokenHash,
        trustedUntil,
        label: TrustedDevice.describe(userAgent),
        ip: audit.clientIp(req),
        userAgent,
        lastUsedAt: new Date(),
        grantedVia,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.cookie(DEVICE_COOKIE, token, cookieOptions(DEVICE_COOKIE_MAX_AGE));
  return device;
}

// ─── Pending-login helpers ───────────────────────────────────────────────────

/** Cryptographically random 6-digit OTP, uniformly distributed. */
function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Random code for the break-glass bypass and temp passwords. */
function generateReadableCode(length = 10) {
  // Excludes 0/O/1/I/l — these get read aloud over the phone and written down.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

/**
 * The client-safe projection of a pending login. Never leaks the OTP, the
 * poll secret, or the approver's full phone number.
 */
function publicPendingState(pending, extra = {}) {
  return {
    pendingId:    pending._id,
    status:       pending.status,
    expiresAt:    pending.expiresAt,
    otpExpiresAt: pending.otpExpiresAt,
    otpSentTo:    pending.otpSentTo,
    otpDelivered: pending.otpDelivered,
    attemptsLeft: Math.max(0, (pending.maxAttempts ?? 5) - pending.attemptCount),
    ...extra,
  };
}

/**
 * Validate that the caller polling/verifying this pending login is the same
 * browser that supplied the password. Without this, a leaked pendingId alone
 * would be enough to ride someone else's approval into a session.
 */
function ownsPending(req, pending) {
  const secret = req.cookies?.[PENDING_COOKIE];
  if (!secret) return false;
  return PendingLogin.hashesMatch(
    PendingLogin.hash(secret),
    pending.pollSecretHash
  );
}

module.exports = {
  DEVICE_COOKIE,
  PENDING_COOKIE,
  PENDING_COOKIE_MAX_AGE,
  cookieOptions,
  establishSession,
  requiresApproval,
  resolveApprover,
  findTrustedDevice,
  trustDevice,
  generateOtp,
  generateReadableCode,
  publicPendingState,
  ownsPending,
};
