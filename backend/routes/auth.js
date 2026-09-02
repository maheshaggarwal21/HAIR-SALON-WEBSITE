/**
 * @file auth.js
 * @description Authentication routes — login, the owner-approval gate, logout,
 * session check, and self-service password change.
 *
 * Mounted at /api/auth in index.js (public — no auth middleware).
 *
 * ── The login gate ──────────────────────────────────────────────────────────
 * POST /login                 credentials → either a session, or a pending id
 * GET  /login-status/:id      polled every ~2.5s; also lazily triggers the SMS
 *                             fallback and mints the session on approval
 * POST /verify-otp/:id        staff enters the code the owner relayed to them
 * POST /bypass/:id            break-glass code, when every channel is down
 *
 * A gated login never creates a session at /login. The session is only written
 * once the pending row reaches `approved` or `otp_verified` (or a valid bypass
 * code is presented), and the row is stamped `consumedAt` at that moment so it
 * can never mint a second session.
 *
 * NOTE: this project authenticates with express-session cookies, not JWTs.
 * "Completing the login" therefore means writing req.session and letting
 * express-session set connect.sid on that response.
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const connectDB = require("../db");
const User = require("../models/User");
const PendingLogin = require("../models/PendingLogin");
const TrustedDevice = require("../models/TrustedDevice");
const SecuritySettings = require("../models/SecuritySettings");
const telegram = require("../utils/telegram");
const sms = require("../utils/sms");
const audit = require("../utils/audit");
const gate = require("../utils/loginGate");

const router = express.Router();

// ─── Rate limits ─────────────────────────────────────────────────────────────

/**
 * Credentials: 10 attempts per 15 min per ACCOUNT per IP.
 *
 * Keyed on IP alone this was 10 attempts for the entire salon. Every device in
 * the shop NATs to one public address (the same reason the payment endpoints
 * are exempted from the global limiter), so eight staff signing in at opening
 * time would exhaust the budget and lock each other out — and adding the
 * approval gate makes multi-step sign-ins more common, not less.
 *
 * Keying on account+IP keeps brute-force protection exactly as tight per
 * target account while removing the collision between colleagues.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // ipKeyGenerator normalises IPv6 to a /64 subnet; required by v8 when
    // building a custom key that includes the IP.
    const ip = ipKeyGenerator(req.ip);
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    return email ? `${ip}|${email}` : ip;
  },
  message: { error: "Too many login attempts. Please try again later." },
});

// Polling is intentionally generous: one gated login is ~36 requests at 2.5s
// over a 90s window, and several staff may be signing in at opening time.
const pollLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many status checks. Please start a new sign-in." },
});

// The per-attempt cap lives on the pending row; this only stops someone
// burning through fresh pending rows to brute-force codes at scale.
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// ── Ensure DB on every request (Vercel cold-start) ─────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[auth] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ─── POST /login ────────────────────────────────────────────────────────────

router.post(
  "/login",
  loginLimiter,
  [
    body("email").isEmail().withMessage("A valid email is required"),
    body("password")
      .isString()
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const email = req.body.email.toLowerCase();
      const user = await User.findOne({ email, isActive: true });

      if (!user || !(await user.verifyPassword(req.body.password))) {
        await audit.record({
          action: "login.failed",
          req,
          actor: { id: null, name: email, role: null },
          meta: { reason: user ? "bad_password" : "no_such_account" },
        });
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const settings = await SecuritySettings.load();

      // ── Path 1: not gated ──────────────────────────────────────────────────
      if (!gate.requiresApproval(user, settings)) {
        return finishDirectLogin(req, res, user, "login.direct");
      }

      // ── Path 2: gated, but this device already cleared the gate ────────────
      const trusted = await gate.findTrustedDevice(req, user._id);
      if (trusted) {
        return finishDirectLogin(req, res, user, "login.direct", {
          via: "trusted_device",
          deviceLabel: trusted.label,
          trustedUntil: trusted.trustedUntil,
        });
      }

      // ── Path 3: gated — start the approval flow ────────────────────────────
      const approver = await gate.resolveApprover(user, settings);

      // Nobody can be reached. Fail closed by default; the break-glass code is
      // the intended escape hatch, not a silent fail-open.
      if (!approver || !approver.canApprove()) {
        if (settings.failOpenIfUnreachable) {
          return finishDirectLogin(req, res, user, "login.direct", {
            via: "fail_open",
            reason: "no_reachable_approver",
          });
        }
        await audit.record({
          action: "login.failed",
          req,
          actor: { id: user._id, name: user.name, role: user.role },
          meta: { reason: "no_reachable_approver" },
        });
        return res.status(503).json({
          error:
            "Sign-in needs owner approval, but the owner cannot be reached right now. Use the emergency bypass code, or ask the owner to connect Telegram.",
          code: "NO_APPROVER",
        });
      }

      // Mint the two secrets: one binds polling to this browser, one is the
      // device-trust token handed out if the login succeeds.
      const pollSecret = TrustedDevice.mintToken();
      const deviceToken = req.cookies?.[gate.DEVICE_COOKIE] || TrustedDevice.mintToken();
      const userAgent = req.get("user-agent") || null;

      const pending = await PendingLogin.create({
        userId:         user._id,
        approverUserId: approver._id,
        staffName:      user.name,
        staffEmail:     user.email,
        staffRole:      user.role,
        status:         "pending",
        pollSecretHash: PendingLogin.hash(pollSecret),
        deviceToken,
        maxAttempts:    settings.maxOtpAttempts,
        ip:             audit.clientIp(req),
        userAgent,
        expiresAt: new Date(Date.now() + settings.approvalTimeoutSeconds * 1000),
      });

      res.cookie(
        gate.PENDING_COOKIE,
        pollSecret,
        gate.cookieOptions(gate.PENDING_COOKIE_MAX_AGE)
      );

      // Try Telegram first. If the approver never linked a chat, skip the dead
      // 90-second wait and go straight to the SMS fallback.
      let channel = "none";
      if (approver.telegramChatId && telegram.isConfigured()) {
        const sent = await telegram.sendApprovalRequest({
          chatId:         approver.telegramChatId,
          pendingId:      pending._id,
          staffName:      user.name,
          staffRole:      user.role,
          deviceLabel:    TrustedDevice.describe(userAgent),
          timeoutSeconds: settings.approvalTimeoutSeconds,
        });
        if (sent.ok) {
          pending.telegramChatId    = approver.telegramChatId;
          pending.telegramMessageId = sent.messageId;
          await pending.save();
          channel = "telegram";
        }
      }

      if (channel === "none") {
        await startOtpFallback(pending, approver, settings, req);
      }

      await audit.record({
        action: "login.gated",
        req,
        actor: { id: user._id, name: user.name, role: user.role },
        meta: { channel: pending.status === "otp_fallback" ? "sms" : channel, approver: approver.name },
      });

      return res.json({
        status: "pending",
        ...gate.publicPendingState(pending, {
          approverName: approver.name,
          channel: pending.status === "otp_fallback" ? "sms" : channel,
          timeoutSeconds: settings.approvalTimeoutSeconds,
        }),
      });
    } catch (err) {
      console.error("[auth] Login error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── GET /login-status/:pendingId ───────────────────────────────────────────
// Polled by the waiting screen. Also where lazy expiry lives — no cron needed.

router.get("/login-status/:pendingId", pollLimiter, async (req, res) => {
  try {
    const pending = await PendingLogin.findById(req.params.pendingId);
    if (!pending) {
      return res.status(404).json({ status: "expired", error: "This sign-in request no longer exists." });
    }
    // Consumption is checked BEFORE ownership: completing a login clears the
    // binding cookie, so a replayed poll has no cookie to prove ownership with
    // and would otherwise report "different browser" for what is really
    // "already used". A used pendingId is not a secret worth protecting.
    if (pending.consumedAt) {
      return res.status(409).json({ status: "expired", error: "This sign-in request was already used." });
    }
    if (!gate.ownsPending(req, pending)) {
      return res.status(403).json({ error: "This sign-in request belongs to a different browser." });
    }

    const settings = await SecuritySettings.load();

    // Lazy transition: the Telegram window closed with no answer → send an OTP.
    if (pending.status === "pending" && Date.now() > pending.expiresAt.getTime()) {
      const approver = pending.approverUserId
        ? await User.findById(pending.approverUserId)
        : null;
      await startOtpFallback(pending, approver, settings, req);

      if (pending.telegramChatId && pending.telegramMessageId) {
        await telegram.resolveMessage({
          chatId:    pending.telegramChatId,
          messageId: pending.telegramMessageId,
          staffName: pending.staffName,
          outcome:   "otp",
        });
      }
    }

    // Lazy transition: the OTP itself expired.
    if (
      pending.status === "otp_fallback" &&
      pending.otpExpiresAt &&
      Date.now() > pending.otpExpiresAt.getTime()
    ) {
      pending.status = "otp_failed";
      await pending.save();
    }

    // Terminal success — mint the session here, exactly once.
    if (pending.status === "approved" || pending.status === "otp_verified") {
      return completeGatedLogin(req, res, pending, settings);
    }

    return res.json(gate.publicPendingState(pending));
  } catch (err) {
    console.error("[auth] login-status error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /verify-otp/:pendingId ────────────────────────────────────────────

router.post(
  "/verify-otp/:pendingId",
  codeLimiter,
  [body("code").isString().trim().isLength({ min: 4, max: 8 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Enter the 6-digit code." });
    }

    try {
      const pending = await PendingLogin.findById(req.params.pendingId);
      if (!pending) return res.status(404).json({ error: "This sign-in request no longer exists." });
      if (!gate.ownsPending(req, pending)) {
        return res.status(403).json({ error: "This sign-in request belongs to a different browser." });
      }
      if (pending.consumedAt) return res.status(409).json({ error: "This sign-in request was already used." });
      if (pending.status !== "otp_fallback") {
        return res.status(409).json({ error: "This sign-in is not waiting for a code.", status: pending.status });
      }

      const settings = await SecuritySettings.load();
      const expired = pending.otpExpiresAt && Date.now() > pending.otpExpiresAt.getTime();

      pending.attemptCount += 1;

      const matches =
        !expired &&
        pending.otpHash &&
        PendingLogin.hashesMatch(PendingLogin.hash(req.body.code.trim()), pending.otpHash);

      if (matches) {
        pending.status = "otp_verified";
        pending.resolvedVia = "otp";
        await pending.save();
        await audit.record({
          action: "login.otp_verified",
          req,
          actor: { id: pending.userId, name: pending.staffName, role: pending.staffRole },
        });
        return completeGatedLogin(req, res, pending, settings);
      }

      // Burn the request once the cap is hit, or once the code has expired.
      if (expired || pending.attemptCount >= pending.maxAttempts) {
        pending.status = "otp_failed";
        await pending.save();
        await audit.record({
          action: "login.otp_failed",
          req,
          actor: { id: pending.userId, name: pending.staffName, role: pending.staffRole },
          meta: { attempts: pending.attemptCount, expired: Boolean(expired) },
        });
        // Deliberately does not distinguish expiry from a wrong code.
        return res.status(401).json({
          status: "otp_failed",
          error: "That code is not valid. Please start a new sign-in.",
        });
      }

      await pending.save();
      return res.status(401).json({
        status: "otp_fallback",
        error: "That code is not valid.",
        attemptsLeft: Math.max(0, pending.maxAttempts - pending.attemptCount),
      });
    } catch (err) {
      console.error("[auth] verify-otp error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── POST /bypass/:pendingId — break glass ──────────────────────────────────
// Deliberately available from any non-terminal gate state: the whole point is
// that it works when Telegram and SMS have both failed.

router.post(
  "/bypass/:pendingId",
  codeLimiter,
  [body("code").isString().trim().isLength({ min: 6, max: 64 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Enter the emergency bypass code." });
    }

    try {
      const pending = await PendingLogin.findById(req.params.pendingId);
      if (!pending) return res.status(404).json({ error: "This sign-in request no longer exists." });
      if (!gate.ownsPending(req, pending)) {
        return res.status(403).json({ error: "This sign-in request belongs to a different browser." });
      }
      if (pending.consumedAt) return res.status(409).json({ error: "This sign-in request was already used." });

      const settings = await SecuritySettings.load(true);
      if (!settings.bypassCodeHash) {
        return res.status(400).json({ error: "No emergency bypass code has been set." });
      }

      pending.attemptCount += 1;
      const ok = await bcrypt.compare(req.body.code.trim(), settings.bypassCodeHash);

      if (!ok) {
        if (pending.attemptCount >= pending.maxAttempts) {
          pending.status = "otp_failed";
          await pending.save();
          return res.status(401).json({
            status: "otp_failed",
            error: "That code is not valid. Please start a new sign-in.",
          });
        }
        await pending.save();
        return res.status(401).json({ error: "That code is not valid." });
      }

      // A bypass is a deliberate hole in the approval system. Log it loudly and
      // notify the owner out-of-band, so it can never be used unnoticed.
      pending.status = "approved";
      pending.resolvedVia = "bypass";
      await pending.save();

      settings.bypassCodeLastUsedAt = new Date();
      settings.bypassCodeUseCount += 1;
      await settings.save();

      await audit.record({
        action: "login.bypass_used",
        req,
        actor: { id: pending.userId, name: pending.staffName, role: pending.staffRole },
        meta: { device: TrustedDevice.describe(pending.userAgent), ip: pending.ip },
      });

      const approver = pending.approverUserId ? await User.findById(pending.approverUserId) : null;
      if (approver?.telegramChatId && telegram.isConfigured()) {
        await telegram.sendMessage(
          approver.telegramChatId,
          `🔓 Emergency bypass code used\n\nStaff: ${pending.staffName}\nDevice: ${TrustedDevice.describe(pending.userAgent)}\n\nIf this wasn't expected, regenerate the bypass code from Management → Break Glass.`
        );
      }

      return completeGatedLogin(req, res, pending, settings);
    } catch (err) {
      console.error("[auth] bypass error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── POST /logout ───────────────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("[auth] Session destroy error:", err);
      return res.status(500).json({ error: "Failed to sign out" });
    }
    res.clearCookie("connect.sid", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return res.json({ ok: true });
  });
});

// ─── GET /me ────────────────────────────────────────────────────────────────

router.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const user = await User.findById(req.session.userId, {
      permissions: 1,
      mustChangePassword: 1,
      isActive: 1,
    }).lean();

    // The account was deactivated while the session was still alive.
    if (!user || user.isActive === false) {
      return req.session.destroy(() =>
        res.status(401).json({ error: "Not authenticated" })
      );
    }

    return res.json({
      id:                 req.session.userId,
      name:               req.session.name,
      email:              req.session.email,
      role:               req.session.role,
      permissions:        user.permissions ?? [],
      mustChangePassword: Boolean(user.mustChangePassword),
    });
  } catch (err) {
    console.error("[auth] /me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /change-password — self-service, clears mustChangePassword ────────

router.post(
  "/change-password",
  [
    body("currentPassword").isString().notEmpty(),
    body("newPassword")
      .isString()
      .isLength({ min: 8 })
      .withMessage("New password must be at least 8 characters"),
  ],
  async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const user = await User.findById(req.session.userId);
      if (!user) return res.status(404).json({ error: "Account not found" });

      if (!(await user.verifyPassword(req.body.currentPassword))) {
        return res.status(401).json({ error: "Your current password is not correct" });
      }
      if (req.body.currentPassword === req.body.newPassword) {
        return res.status(400).json({ error: "The new password must be different" });
      }

      user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
      user.mustChangePassword = false;
      await user.save();

      await audit.record({
        action: "staff.password_reset",
        req,
        target: { id: user._id, name: user.name },
        meta: { self: true },
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error("[auth] change-password error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Ungated login: write the session and answer immediately. */
async function finishDirectLogin(req, res, user, action, meta = {}) {
  const payload = await gate.establishSession(req, user);
  user.lastLoginAt = new Date();
  await user.save();
  await audit.record({
    action,
    req,
    actor: { id: user._id, name: user.name, role: user.role },
    meta,
  });
  return res.json({ status: "authenticated", user: payload });
}

/**
 * Move a pending row into the SMS fallback state and dispatch the OTP.
 * Mutates and saves `pending`.
 */
async function startOtpFallback(pending, approver, settings, req) {
  const code = gate.generateOtp();

  pending.status       = "otp_fallback";
  pending.otpHash      = PendingLogin.hash(code);
  pending.otpExpiresAt = new Date(Date.now() + settings.otpExpiryMinutes * 60 * 1000);
  pending.attemptCount = 0;
  pending.otpSentTo    = approver?.phone ? sms.maskPhone(approver.phone) : null;

  const result = await sms.sendOtp(approver?.phone, code);
  pending.otpDelivered = result.sent;

  // Telegram is linked but the owner just didn't tap in time — send the code
  // there too, so a missing DLT registration doesn't block the fallback.
  if (!result.sent && approver?.telegramChatId && telegram.isConfigured()) {
    const relayed = await telegram.sendMessage(
      approver.telegramChatId,
      `📩 Login code for ${pending.staffName}: ${code}\n\nRead this out to them. Valid for ${settings.otpExpiryMinutes} minutes.`
    );
    if (relayed.ok) {
      pending.otpSentTo = "the owner's Telegram";
      pending.otpDelivered = true;
    }
  }

  // Nothing reached anyone. Say so plainly — claiming a code went to a phone
  // that received nothing sends staff hunting for a message that isn't coming.
  if (!pending.otpDelivered) pending.otpSentTo = null;
  await pending.save();

  await audit.record({
    action: "login.otp_sent",
    req,
    actor: { id: pending.userId, name: pending.staffName, role: pending.staffRole },
    meta: { delivered: result.sent, reason: result.reason ?? null, to: pending.otpSentTo },
  });
}

/**
 * Consume an approved pending row: mint the session, trust the device, and
 * stamp consumedAt so this row can never produce a second session.
 */
async function completeGatedLogin(req, res, pending, settings) {
  const user = await User.findById(pending.userId);
  if (!user || !user.isActive) {
    return res.status(401).json({ error: "This account is no longer active." });
  }

  // Stamp first. If two polls race, the second sees consumedAt and bails.
  const claimed = await PendingLogin.findOneAndUpdate(
    { _id: pending._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    return res.status(409).json({ status: "expired", error: "This sign-in request was already used." });
  }

  const payload = await gate.establishSession(req, user);
  user.lastLoginAt = new Date();
  await user.save();

  const device = await gate.trustDevice(
    req,
    res,
    user._id,
    claimed.resolvedVia === "bypass" ? "bypass" : claimed.status === "approved" ? "telegram" : "otp",
    settings,
    claimed.deviceToken
  );

  res.clearCookie(gate.PENDING_COOKIE, { path: "/" });

  if (device) {
    await audit.record({
      action: "login.device_trusted",
      req,
      actor: { id: user._id, name: user.name, role: user.role },
      meta: { device: device.label, trustedUntil: device.trustedUntil },
    });
  }

  return res.json({
    status: "authenticated",
    user: payload,
    trustedUntil: device?.trustedUntil ?? null,
  });
}

module.exports = router;
