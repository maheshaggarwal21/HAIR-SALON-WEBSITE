/**
 * @file telegram.js
 * @description Public Telegram Bot webhook.
 *
 * Mounted at /api/telegram in index.js WITHOUT the authenticate middleware —
 * Telegram has no session cookie. Authenticity is proved instead by the
 * secret token Telegram echoes in the X-Telegram-Bot-Api-Secret-Token header,
 * which we set when registering the webhook.
 *
 * Handles exactly two update types:
 *   callback_query  — the owner tapped ✅ Approve / ❌ Deny
 *   message         — /start <code>, the one-time account-linking flow
 *
 * Always answers 200. Telegram retries non-2xx responses with backoff, and a
 * retry storm over a malformed update helps nobody; failures are logged instead.
 */

const express = require("express");
const connectDB = require("../db");
const User = require("../models/User");
const PendingLogin = require("../models/PendingLogin");
const telegram = require("../utils/telegram");
const audit = require("../utils/audit");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[telegram] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

// ─── POST /webhook ──────────────────────────────────────────────────────────

router.post("/webhook", async (req, res) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;

  // Refuse to run unauthenticated. Without a configured secret anyone who
  // guesses the URL could approve their own logins.
  if (!expected) {
    console.error("[telegram] TELEGRAM_WEBHOOK_SECRET is not set — rejecting update");
    return res.status(503).json({ ok: false });
  }
  if (req.get("x-telegram-bot-api-secret-token") !== expected) {
    console.warn("[telegram] webhook called with a bad secret token");
    return res.status(401).json({ ok: false });
  }

  // Acknowledge immediately; Telegram does not wait on our processing.
  res.json({ ok: true });

  try {
    await processUpdate(req.body, req);
  } catch (err) {
    console.error("[telegram] update handling failed:", err);
  }
});

/**
 * Single entry point for a Telegram update, whichever transport delivered it.
 *
 * The webhook calls this, and so does the dev long-poller (see
 * telegram.startPolling). Sharing one function means the path you test locally
 * is the same one that runs in production — the transport differs, the handling
 * does not.
 *
 * @param {object} update  raw Telegram Update
 * @param {object} [req]   express request when available; only used for audit
 *                         metadata (ip / user-agent), safe to omit when polling
 */
async function processUpdate(update, req) {
  // The poller runs outside the router, so it never passes through the
  // connect-on-request middleware above.
  await connectDB();

  if (update?.callback_query) return handleCallback(update.callback_query, req);
  if (update?.message) return handleMessage(update.message, req);
}

// ─── ✅ Approve / ❌ Deny ────────────────────────────────────────────────────

async function handleCallback(cq, req) {
  const [action, pendingId] = String(cq.data || "").split(":");
  if (!["approve", "deny"].includes(action) || !pendingId) {
    return telegram.answerCallback(cq.id, "Unrecognised action.");
  }

  const pending = await PendingLogin.findById(pendingId);
  if (!pending) {
    return telegram.answerCallback(cq.id, "That request no longer exists.");
  }

  const chatId = String(cq.message?.chat?.id ?? "");

  // The tapper must be the approver this request was actually sent to.
  // Telegram messages can be forwarded; the button must not travel with them.
  if (pending.telegramChatId && chatId !== String(pending.telegramChatId)) {
    return telegram.answerCallback(cq.id, "You are not the approver for this request.");
  }

  // Already resolved — a double-tap, or the SMS fallback already fired.
  if (pending.status !== "pending") {
    await telegram.answerCallback(cq.id, `Already ${pending.status.replace("_", " ")}.`);
    return telegram.resolveMessage({
      chatId,
      messageId: cq.message.message_id,
      staffName: pending.staffName,
      outcome:   pending.status === "approved" ? "approved" : pending.status === "denied" ? "denied" : "otp",
    });
  }

  // The 90s window closed between the message being sent and the tap landing.
  // The poll will have moved this to otp_fallback already in most cases; this
  // covers the race where nobody has polled yet.
  if (Date.now() > pending.expiresAt.getTime()) {
    await telegram.answerCallback(cq.id, "This request timed out — an SMS code was sent instead.");
    return telegram.resolveMessage({
      chatId,
      messageId: cq.message.message_id,
      staffName: pending.staffName,
      outcome:   "otp",
    });
  }

  const approverName = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(" ") || "Owner";

  pending.status = action === "approve" ? "approved" : "denied";
  if (action === "approve") pending.resolvedVia = "telegram";
  await pending.save();

  await telegram.answerCallback(
    cq.id,
    action === "approve" ? "Approved — signing them in." : "Denied."
  );

  await telegram.resolveMessage({
    chatId,
    messageId: cq.message.message_id,
    staffName: pending.staffName,
    outcome:   action === "approve" ? "approved" : "denied",
    byName:    approverName,
  });

  await audit.record({
    action: action === "approve" ? "login.approved" : "login.denied",
    req,
    actor:  { id: pending.approverUserId, name: approverName, role: "owner" },
    target: { id: pending.userId, name: pending.staffName },
    meta:   { via: "telegram" },
  });
}

// ─── /start <code> — one-time account linking ───────────────────────────────

async function handleMessage(message, req) {
  const text = String(message.text || "").trim();
  const chatId = String(message.chat?.id ?? "");
  if (!chatId) return;

  if (!text.startsWith("/start")) {
    return telegram.sendMessage(
      chatId,
      "This bot delivers salon login approvals.\n\nTo connect your account, open the Management → Login Approval tab in your dashboard and tap “Connect Telegram”."
    );
  }

  const code = text.split(/\s+/)[1];
  if (!code) {
    return telegram.sendMessage(
      chatId,
      "Missing linking code.\n\nOpen Management → Login Approval in your dashboard and tap “Connect Telegram” to get a fresh link."
    );
  }

  const user = await User.findOne({
    telegramLinkCode: code.toUpperCase(),
    telegramLinkExpiresAt: { $gt: new Date() },
  });

  if (!user) {
    return telegram.sendMessage(
      chatId,
      "That linking code is invalid or has expired. Generate a new one from your dashboard."
    );
  }

  user.telegramChatId        = chatId;
  user.telegramUsername      = message.from?.username ?? null;
  user.telegramLinkedAt      = new Date();
  user.telegramLinkCode      = null;   // single use
  user.telegramLinkExpiresAt = null;
  await user.save();

  await audit.record({
    action: "telegram.linked",
    req,
    actor:  { id: user._id, name: user.name, role: user.role },
    target: { id: user._id, name: user.name },
    meta:   { username: user.telegramUsername },
  });

  return telegram.sendMessage(
    chatId,
    `✅ Connected, ${user.name}.\n\nYou'll get an Approve / Deny message here whenever a gated staff member signs in.`
  );
}

module.exports = router;
// Exposed so the dev poller can reuse the exact webhook handling path.
module.exports.processUpdate = processUpdate;
