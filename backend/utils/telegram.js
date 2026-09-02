/**
 * @file telegram.js
 * @description Thin Telegram Bot API client for the owner-approval gate.
 *
 * Raw fetch rather than node-telegram-bot-api: we use four methods total, and
 * the library's main value-add (long polling) is exactly what we are avoiding.
 *
 * Webhook mode is the production path. Set it once after deploying:
 *
 *   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *        -d "url=https://your-api.vercel.app/api/telegram/webhook" \
 *        -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
 *
 * or just call registerWebhook() below from a one-off script.
 *
 * NOTE FOR LOCAL DEV: Telegram cannot reach http://localhost:5000, so the
 * webhook will never fire on your machine. Either tunnel it (`ngrok http 5000`
 * then point setWebhook at the tunnel URL) or set TELEGRAM_MODE=polling, which
 * makes startPolling() below pull updates on an interval instead. Polling is
 * dev-only — never enable it on a serverless deployment.
 */

// Overridable so the integration tests can point at a local stub. Unset in
// every real environment, where it resolves to the public Bot API.
const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

/** True when a bot token is present. Everything else no-ops without one. */
function isConfigured() {
  return Boolean(botToken());
}

/**
 * Call a Bot API method.
 * Never throws — a Telegram outage must not take down the login endpoint, so
 * failures are returned as { ok: false } and the caller falls through to SMS.
 */
async function call(method, payload) {
  const token = botToken();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not set" };

  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[telegram] ${method} failed:`, data.description);
      return { ok: false, error: data.description };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    console.error(`[telegram] ${method} network error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Send the owner a login request with inline Approve / Deny buttons.
 *
 * @param {object}  opts
 * @param {string}  opts.chatId
 * @param {string}  opts.pendingId   embedded in callback_data
 * @param {string}  opts.staffName
 * @param {string}  opts.staffRole
 * @param {string}  [opts.deviceLabel]
 * @param {number}  opts.timeoutSeconds
 * @returns {Promise<{ok: boolean, messageId?: number, error?: string}>}
 */
async function sendApprovalRequest({
  chatId,
  pendingId,
  staffName,
  staffRole,
  deviceLabel,
  timeoutSeconds,
}) {
  const when = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  // MarkdownV2 requires escaping reserved punctuation in LITERAL text too, not
  // just in interpolated values — an unescaped "(" or "." makes Telegram reject
  // the whole send with "can't parse entities", which would silently kill the
  // entire approval channel. Every non-markup character below goes through
  // escapeMarkdown for that reason.
  const text = [
    "⚠️ *Login request*",
    "",
    `*Staff:* ${escapeMarkdown(`${staffName} (${staffRole})`)}`,
    `*Time:* ${escapeMarkdown(when)}`,
    deviceLabel ? `*Device:* ${escapeMarkdown(deviceLabel)}` : null,
    "",
    `_${escapeMarkdown(`Falls back to an SMS code in ${timeoutSeconds}s if you don't respond.`)}_`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${pendingId}` },
          { text: "❌ Deny",    callback_data: `deny:${pendingId}` },
        ],
      ],
    },
  });

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, messageId: result.result.message_id };
}

/**
 * Rewrite the original request message once resolved, and strip the buttons.
 * This is what stops the owner double-tapping a stale request.
 */
async function resolveMessage({ chatId, messageId, staffName, outcome, byName }) {
  const icon =
    outcome === "approved" ? "✅" :
    outcome === "denied"   ? "❌" :
    outcome === "otp"      ? "📩" : "⏳";

  const label =
    outcome === "approved" ? "Approved"                       :
    outcome === "denied"   ? "Denied"                         :
    outcome === "otp"      ? "Timed out — SMS code sent"      : "Expired";

  const lines = [
    `${icon} *${escapeMarkdown(label)}*`,
    "",
    `*Staff:* ${escapeMarkdown(staffName)}`,
    byName ? `*By:* ${escapeMarkdown(byName)}` : null,
    `*At:* ${escapeMarkdown(
      new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    )}`,
  ].filter(Boolean);

  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: lines.join("\n"),
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: [] },
  });
}

/** Dismiss the button's loading spinner in the owner's Telegram client. */
async function answerCallback(callbackQueryId, text) {
  return call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function sendMessage(chatId, text) {
  return call("sendMessage", { chat_id: chatId, text });
}

/** Point Telegram at our webhook. Safe to call repeatedly — it is idempotent. */
async function registerWebhook(url, secret) {
  return call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
}

async function getMe() {
  return call("getMe", {});
}

/**
 * MarkdownV2 requires escaping a long list of punctuation. Names and device
 * labels are user-controlled, so escape everything Telegram lists as reserved.
 */
function escapeMarkdown(str) {
  return String(str ?? "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

module.exports = {
  isConfigured,
  sendApprovalRequest,
  resolveMessage,
  answerCallback,
  sendMessage,
  registerWebhook,
  getMe,
  call,
};
