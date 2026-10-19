/**
 * @file wati.js
 * @description The WATI provider behind utils/whatsapp.js (WHATSAPP_PROVIDER=wati) — WhatsApp template messages through Wati
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §11, D7).
 *
 * WhatsApp only delivers business-initiated messages from templates Meta has
 * approved (T0.9), so every send names a template and passes its variables;
 * we never build free text. Template names come from env
 * (WATI_TEMPLATE_OTP, WATI_TEMPLATE_BOOKING_CONFIRMED, …) so a renamed or
 * re-approved template is a settings change, not a deploy.
 *
 * NEVER THROWS. It returns {status: "sent" | "failed" | "skipped"}. A booking
 * is already saved by the time anything is sent, and a WhatsApp outage must
 * not undo it (E21). Callers that need a record go through utils/notify.js.
 *
 * Not configured (no WATI_API_URL / token, or no template name):
 *   - outside production the message is printed to the console, so the whole
 *     flow — OTP included — works locally with no provider;
 *   - in production it is "skipped" with a reason.
 */

const TIMEOUT_MS = 8000;

function config() {
  return {
    url: (process.env.WATI_API_URL || "").replace(/\/+$/, ""),
    token: process.env.WATI_API_TOKEN || "",
  };
}

function isConfigured() {
  const { url, token } = config();
  return Boolean(url && token);
}

/** Template name for a message type: "booking_confirmed" → WATI_TEMPLATE_BOOKING_CONFIRMED. */
function templateFor(type) {
  const key = String(type).toUpperCase();
  return process.env[`WHATSAPP_TEMPLATE_${key}`] || process.env[`WATI_TEMPLATE_${key}`] || null;
}

/**
 * @param {object} opts
 * @param {string} opts.phone      10-digit Indian mobile
 * @param {string} opts.type       message type, e.g. "otp", "booking_confirmed"
 * @param {Record<string,string|number>} opts.params  template variables
 * @returns {Promise<{status: "sent"|"failed"|"skipped", providerId?: string, error?: string, channel: "whatsapp"|"dev"}>}
 */
async function sendTemplate({ phone, type, params = {} }) {
  const template = templateFor(type);
  if (!isConfigured() || !template) {
    const reason = !isConfigured() ? "wati_not_configured" : `no template for ${type}`;
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[wati] ${reason} — DEV message to +91${phone} [${type}]`, params);
      return { status: "skipped", error: reason, channel: "dev" };
    }
    return { status: "skipped", error: reason, channel: "whatsapp" };
  }

  const { url, token } = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/v1/sendTemplateMessage?whatsappNumber=91${phone}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        template_name: template,
        broadcast_name: `${type}_${Date.now()}`,
        parameters: Object.entries(params).map(([name, value]) => ({ name, value: String(value ?? "") })),
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.result === false) {
      return { status: "failed", error: data?.info || data?.message || `HTTP ${res.status}`, channel: "whatsapp" };
    }
    return { status: "sent", providerId: data?.id || data?.messageId || null, channel: "whatsapp" };
  } catch (err) {
    return { status: "failed", error: err.name === "AbortError" ? "timeout" : err.message, channel: "whatsapp" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendTemplate, isConfigured, templateFor };
