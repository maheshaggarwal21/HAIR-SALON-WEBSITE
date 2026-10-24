/**
 * @file whatsapp.js
 * @description The one door every WhatsApp template message goes through
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §11, D7, D52).
 *
 * Everything goes through Meta's own WhatsApp Cloud API — no middleman platform,
 * just Meta's per-message price (Wati was removed, D57). The number is shared
 * with AiSensy, which is used only by the owner for marketing broadcasts; this
 * app never calls AiSensy.
 *
 * Callers (notify.js, otp.js, public.js) only know `sendTemplate`, `isConfigured`
 * and `templateFor`.
 *
 * ── Meta specifics ───────────────────────────────────────────────────────────
 * WhatsApp only delivers business-initiated messages from templates approved in
 * Meta's WhatsApp Manager, so every send names an approved template and fills
 * its {{1}}, {{2}}… variables IN ORDER. ORDER below is that order per message
 * type; docs/customer-platform/WHATSAPP_TEMPLATES.md holds the exact template
 * text to submit, with the variables numbered to match. Change one, change both.
 * Template names come from env (WHATSAPP_TEMPLATE_<TYPE>), so a renamed
 * template is a settings change.
 *
 * NEVER THROWS: it returns {status: "sent" | "failed" | "skipped"}. A booking is
 * already saved by the time anything is sent, and a WhatsApp outage must not
 * undo it (E21). Not configured → in development the message is printed to the
 * console (so the whole flow, OTP included, works with no provider); in
 * production it is "skipped" with a reason.
 */

const TIMEOUT_MS = 8000;

/** Variable order per message type: {{1}} is the first name listed. */
const ORDER = {
  booking_confirmed: ["name", "ref", "when", "link", "salon_link"],
  request_received: ["name", "ref", "when", "link", "salon_link"],
  reminder_24h: ["name", "ref", "when", "link", "map", "salon_link"],
  reminder_2h: ["name", "ref", "when", "link", "map", "salon_link"],
  booking_cancelled: ["name", "ref", "refund", "salon_link"],
  booking_declined: ["name", "ref", "refund", "salon_link"],
  // A WhatsApp-ad / offer-page request the salon could not take: unpaid, so no refund line (D62).
  request_declined: ["name", "ref", "salon_link"],
  request_cancelled: ["name", "ref", "salon_link"],
  booking_refund: ["name", "ref", "amount", "salon_link"],
  booking_moved: ["name", "ref", "when", "link", "salon_link"],
  // To the ARTIST at 08:15 (D56); no salon link — they are staff.
  artist_day_sheet: ["name", "date", "count", "list"],
  booking_artist_changed: ["name", "ref", "when", "oldArtist", "newArtist", "reason", "link", "salon_link"],
};

function metaConfig() {
  return {
    base: (process.env.META_WA_API_BASE || "https://graph.facebook.com").replace(/\/+$/, ""),
    version: process.env.META_WA_API_VERSION || "v21.0",
    token: process.env.META_WA_TOKEN || "",
    phoneNumberId: process.env.META_WA_PHONE_NUMBER_ID || "",
    language: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
  };
}

function isConfigured() {
  const { token, phoneNumberId } = metaConfig();
  return Boolean(token && phoneNumberId);
}

/** Template name for a message type: "booking_confirmed" → WHATSAPP_TEMPLATE_BOOKING_CONFIRMED . */
function templateFor(type) {
  const key = String(type).toUpperCase();
  return process.env[`WHATSAPP_TEMPLATE_${key}`] || null;
}

/** Meta rejects newlines, tabs and runs of 4+ spaces inside a variable, and caps its length. */
const clean = (v) => String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 900) || "-";

async function sendMeta({ phone, type, params, template }) {
  const { base, version, token, phoneNumberId, language } = metaConfig();
  const components =
    type === "otp"
      ? // Authentication templates: the code goes in the body AND the copy-code button.
        [
          { type: "body", parameters: [{ type: "text", text: clean(params.code) }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: clean(params.code) }] },
        ]
      : [{ type: "body", parameters: (ORDER[type] || Object.keys(params)).map((k) => ({ type: "text", text: clean(params[k]) })) }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/${version}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: `91${phone}`,
        type: "template",
        template: { name: template, language: { code: language }, components },
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    const id = data?.messages?.[0]?.id;
    if (!res.ok || !id) {
      const e = data?.error;
      return { status: "failed", error: e ? `${e.message || "error"}${e.code ? ` (${e.code})` : ""}` : `HTTP ${res.status}`, channel: "whatsapp" };
    }
    return { status: "sent", providerId: id, channel: "whatsapp" };
  } catch (err) {
    return { status: "failed", error: err.name === "AbortError" ? "timeout" : err.message, channel: "whatsapp" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.phone      10-digit Indian mobile
 * @param {string} opts.type       message type, e.g. "otp", "booking_confirmed"
 * @param {Record<string,string|number>} opts.params  template variables, by name
 * @returns {Promise<{status: "sent"|"failed"|"skipped", providerId?: string, error?: string, channel: "whatsapp"|"dev"}>}
 */
async function sendTemplate({ phone, type, params = {} }) {
  const template = templateFor(type);
  if (!isConfigured() || !template) {
    const reason = !isConfigured() ? "meta_not_configured" : `no template for ${type}`;
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[whatsapp] ${reason} — DEV message to +91${phone} [${type}]`, params);
      return { status: "skipped", error: reason, channel: "dev" };
    }
    return { status: "skipped", error: reason, channel: "whatsapp" };
  }
  return sendMeta({ phone, type, params, template });
}

module.exports = { sendTemplate, isConfigured, templateFor, ORDER };
