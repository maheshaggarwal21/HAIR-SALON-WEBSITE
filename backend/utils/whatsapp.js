/**
 * @file whatsapp.js
 * @description The one door every WhatsApp template message goes through
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §11, D7, D52).
 *
 * Two providers sit behind `sendTemplate`, chosen by WHATSAPP_PROVIDER:
 *
 *   meta     (default)  Meta's own WhatsApp Cloud API, as before (Wati was removed, D57).
 *   aisensy             AiSensy's campaign API. The salon number is on AiSensy, so the
 *                       Cloud API token may not be able to send from it.
 *
 * Callers (notify.js, otp.js, public.js) only know `sendTemplate`, `isConfigured`
 * and `templateFor`. Switching provider is a settings change, not a code change.
 *
 * ── The one-time code (OTP) stays on Meta ────────────────────────────────────
 * AiSensy's API has not been checked against an authentication template's copy-code
 * button, so `otp` always goes through Meta, whatever WHATSAPP_PROVIDER says, and
 * is never held back by DRY_RUN or redirected by TEST_PHONE (a customer is waiting
 * for that code).
 *
 * ── Safe testing ─────────────────────────────────────────────────────────────
 *   DRY_RUN=true     nothing leaves the server: the message is checked, logged and
 *                    recorded as skipped ("dry_run"), which notify.js never resends.
 *                    Unset means: on for AiSensy (new, untested), off for Meta (so
 *                    deploying this file changes nothing for the live Meta setup).
 *   TEST_PHONE=98…   every message goes to this number instead of the customer's.
 *                    A bad value stops all sends rather than risk a real customer.
 *
 * ── PARAMS ───────────────────────────────────────────────────────────────────
 * WhatsApp only delivers business-initiated messages from approved templates, and fills
 * their {{1}}, {{2}}… IN ORDER. PARAMS is that order per message type, plus the AiSensy
 * campaign name. docs/customer-platform/WHATSAPP_TEMPLATES.md holds the template text;
 * change one, change both. On Meta, template names come from env
 * (WHATSAPP_TEMPLATE_<TYPE>); on AiSensy the campaign name is the key, below.
 *
 * NEVER THROWS: it returns {status: "sent" | "failed" | "skipped"}. A booking is
 * already saved by the time anything is sent, and a WhatsApp outage must not
 * undo it (E21). Not configured → in development the message is printed to the
 * console (so the whole flow, OTP included, works with no provider); in
 * production it is "skipped" with a reason, and notify.js resends it once the
 * settings are fixed (inside the per-type time limits).
 */

const TIMEOUT_MS = 8000;

/**
 * Per message type: the AiSensy campaign and the variables in {{1}}, {{2}}… order.
 * Verify an order against the approved template text before going live.
 */
const PARAMS = {
  booking_confirmed: { campaign: "booking_confirmed", vars: ["name", "ref", "when", "link", "salon_link"] },
  request_received: { campaign: "request_received", vars: ["name", "ref", "when", "link", "salon_link"] },
  reminder_24h: { campaign: "reminder_24h", vars: ["name", "ref", "when", "link", "map", "salon_link"] },
  reminder_2h: { campaign: "reminder_2h", vars: ["name", "ref", "when", "link", "map", "salon_link"] },
  booking_cancelled: { campaign: "booking_cancelled", vars: ["name", "ref", "refund", "salon_link"] },
  booking_declined: { campaign: "booking_declined", vars: ["name", "ref", "refund", "salon_link"] },
  // A WhatsApp-ad / offer-page request the salon could not take: unpaid, so no refund line (D62).
  request_declined: { campaign: "request_declined", vars: ["name", "ref", "salon_link"] },
  request_cancelled: { campaign: "request_cancelled", vars: ["name", "ref", "salon_link"] },
  booking_refund: { campaign: "booking_refund", vars: ["name", "ref", "amount", "salon_link"] },
  booking_moved: { campaign: "booking_moved", vars: ["name", "ref", "when", "link", "salon_link"] },
  // To the ARTIST at 08:15 (D56); no salon link — they are staff.
  artist_day_sheet: { campaign: "artist_day_sheet", vars: ["name", "date", "count", "list"] },
  booking_artist_changed: { campaign: "artist_changed", vars: ["name", "ref", "when", "oldArtist", "newArtist", "reason", "link", "salon_link"] },
};

/** Variable order per message type: {{1}} is the first name listed. */
const ORDER = Object.fromEntries(Object.entries(PARAMS).map(([type, p]) => [type, p.vars]));

/** May be blank (no map link set, no reason given): sent as "-" instead of failing the message. */
const MAY_BE_BLANK = new Set(["map", "reason"]);
/** Money variables: the approved templates already print the ₹ sign, so these go out as bare numbers. */
const MONEY = new Set(["refund", "amount"]);
/** Said when the salon gave no reason for changing the artist. */
const DEFAULT_ARTIST_REASON = "The artist is unavailable";
/** Links: must be complete https URLs, or the customer gets text they cannot tap. */
const LINKS = new Set(["link", "map", "salon_link"]);

const PROVIDERS = ["meta", "aisensy"];
const AISENSY_URL = "https://backend.aisensy.com/campaign/t1/api";

function provider() {
  const p = String(process.env.WHATSAPP_PROVIDER || "meta").trim().toLowerCase();
  return PROVIDERS.includes(p) ? p : "meta";
}

/** The provider that really sends this type: the code (otp) is Meta-only. */
const providerFor = (type) => (type === "otp" ? "meta" : provider());

/** DRY_RUN: "true"/"1" on, "false"/"0" off, unset → on for AiSensy only (see header). */
function isDryRun(type = "") {
  if (type === "otp") return false;
  const v = String(process.env.DRY_RUN ?? "").trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return providerFor(type) === "aisensy";
}

/** 10-digit Indian mobile from "98765 43210", "+91 98765-43210", "098765…"; null when it is not one. */
function normalisePhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** TEST_PHONE: {on: false} | {on: true, phone: "98…"} | {on: true, phone: null} when it is set but not a mobile. */
function testPhone() {
  const raw = String(process.env.TEST_PHONE ?? "").trim();
  return raw ? { on: true, phone: normalisePhone(raw) } : { on: false, phone: null };
}

function metaConfig() {
  return {
    base: (process.env.META_WA_API_BASE || "https://graph.facebook.com").replace(/\/+$/, ""),
    version: process.env.META_WA_API_VERSION || "v21.0",
    token: process.env.META_WA_TOKEN || "",
    phoneNumberId: process.env.META_WA_PHONE_NUMBER_ID || "",
    language: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
  };
}

/** Meta is set up (token + number). The code (otp) and the site's "online booking" switch ask this. */
function isConfigured() {
  const { token, phoneNumberId } = metaConfig();
  return Boolean(token && phoneNumberId);
}

/** Template name for a message type: "booking_confirmed" → WHATSAPP_TEMPLATE_BOOKING_CONFIRMED . */
function templateFor(type) {
  const key = String(type).toUpperCase();
  return process.env[`WHATSAPP_TEMPLATE_${key}`] || null;
}

/** Why this type cannot be sent right now, or null when the provider is ready for it. */
function notReady(type) {
  if (providerFor(type) === "aisensy") {
    if (!PARAMS[type]) return `no campaign for ${type}`;
    return process.env.AISENSY_KEY ? null : "aisensy_not_configured";
  }
  if (!isConfigured()) return "meta_not_configured";
  return templateFor(type) ? null : `no template for ${type}`;
}

/** Can a real send happen for this type right now? notify.js asks before resending held-back messages. */
function canSend(type) {
  const tp = testPhone();
  return notReady(type) === null && !isDryRun(type) && !(tp.on && !tp.phone);
}

/**
 * Names (never values) of settings that stop messages today, for the start-up log and /api/health.
 * @returns {{provider: string, dryRun: boolean, testPhone: "set"|"not set"|"INVALID", missing: string[]}}
 */
function configStatus() {
  const prov = provider();
  const missing = [];
  if (String(process.env.WHATSAPP_PROVIDER || "").trim() && !PROVIDERS.includes(String(process.env.WHATSAPP_PROVIDER).trim().toLowerCase())) {
    missing.push("WHATSAPP_PROVIDER (unknown value)");
  }
  if (prov === "aisensy" && !process.env.AISENSY_KEY) missing.push("AISENSY_KEY");
  // The code is Meta-only whichever provider is chosen; everything else follows the provider.
  const { token, phoneNumberId } = metaConfig();
  if (!token) missing.push("META_WA_TOKEN");
  if (!phoneNumberId) missing.push("META_WA_PHONE_NUMBER_ID");
  if (!templateFor("otp")) missing.push("WHATSAPP_TEMPLATE_OTP");
  if (prov === "meta") {
    for (const type of Object.keys(PARAMS)) if (!templateFor(type)) missing.push(`WHATSAPP_TEMPLATE_${type.toUpperCase()}`);
  }
  const tp = testPhone();
  return { provider: prov, dryRun: isDryRun("booking_confirmed"), testPhone: !tp.on ? "not set" : tp.phone ? "set" : "INVALID", missing };
}

/**
 * Rupees as a bare number: 250 → "250", "₹1,250.5" → "1250.50", 175.004 → "175". No ₹, no commas.
 * Anything that is not a number is returned unchanged, for the checks after it to refuse.
 */
function bareAmount(v) {
  const digits = String(v ?? "").replace(/[^\d.]/g, "");
  if (!/\d/.test(digits)) return v; // no number in it at all: not 0, leave it to be refused
  const n = Math.round(Number(digits) * 100) / 100;
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * The reason sits before a full stop in the template ("Reason: {{6}}."), so a trailing
 * full stop would print twice. Blank → the default above.
 */
function tidyReason(v) {
  const text = String(v ?? "").replace(/\s+/g, " ").trim().replace(/[\s.…]+$/u, "");
  return text || DEFAULT_ARTIST_REASON;
}

/** What every provider needs done to the variables first: money as bare numbers, a usable artist-change reason. */
function prepare(type, params = {}) {
  const out = { ...params };
  for (const k of MONEY) if (k in out) out[k] = bareAmount(out[k]);
  if (type === "booking_artist_changed") out.reason = tidyReason(out.reason);
  return out;
}

/** Meta rejects newlines, tabs and runs of 4+ spaces inside a variable, and caps its length. */
const clean = (v) => String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 900) || "-";

/**
 * The AiSensy variables for a message: exactly PARAMS[type].vars, in order, no line breaks.
 * A variable that is missing (not just blank) fails the message instead of sending a gap;
 * only MAY_BE_BLANK ones may be empty (sent as "-").
 * @returns {{ok: true, values: string[]} | {ok: false, error: string}}
 */
function buildParams(type, params = {}) {
  const spec = PARAMS[type];
  if (!spec) return { ok: false, error: `no campaign for ${type}` };
  const values = [];
  const prepared = prepare(type, params);
  for (const name of spec.vars) {
    const text = clean(prepared[name]); // blank → "-"
    if (text === "-" && !MAY_BE_BLANK.has(name)) return { ok: false, error: `missing variable "${name}" for ${type}` };
    if (MONEY.has(name) && !/^\d+(\.\d{2})?$/.test(text)) return { ok: false, error: `variable "${name}" for ${type} is not an amount` };
    if (LINKS.has(name) && text !== "-" && !/^https:\/\/\S+$/.test(text)) return { ok: false, error: `variable "${name}" for ${type} is not a full https link` };
    values.push(text);
  }
  return { ok: true, values };
}

async function sendMeta({ to, type, params, template }) {
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
        to: `91${to}`,
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
 * AiSensy campaign API: POST {apiKey, campaignName, destination "+91…", userName, templateParams}.
 * HTTP 200 is success. Its error codes are not documented, so a failure keeps the status and
 * the start of the body (with the key blanked out) for whoever reads the log.
 */
async function sendAiSensy({ to, type, params }) {
  const built = buildParams(type, params);
  if (!built.ok) return { status: "failed", error: built.error, channel: "whatsapp" };
  const key = process.env.AISENSY_KEY || "";
  const url = process.env.AISENSY_API_URL || AISENSY_URL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: key,
        campaignName: PARAMS[type].campaign,
        destination: `+91${to}`,
        userName: clean(params.name || "Customer"),
        source: "website",
        templateParams: built.values,
      }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const body = (key ? text.split(key).join("***") : text).replace(/\s+/g, " ").slice(0, 300);
      return { status: "failed", error: `HTTP ${res.status}${body ? `: ${body}` : ""}`, channel: "whatsapp" };
    }
    let id = null;
    try {
      const data = JSON.parse(text);
      id = data?.submitted_message_id || data?.id || null;
    } catch {
      /* the body is not needed for success */
    }
    return { status: "sent", providerId: id, channel: "whatsapp" };
  } catch (err) {
    return { status: "failed", error: err.name === "AbortError" ? "timeout" : err.message, channel: "whatsapp" };
  } finally {
    clearTimeout(timer);
  }
}

/** Last two digits only: enough to recognise a number in a log, not enough to leak it. */
const masked = (p) => `+91******${String(p).slice(-2)}`;

/**
 * @param {object} opts
 * @param {string} opts.phone      Indian mobile ("98765 43210", "+91…" and "0…" are all accepted)
 * @param {string} opts.type       message type, e.g. "otp", "booking_confirmed"
 * @param {Record<string,string|number>} opts.params  template variables, by name
 * @returns {Promise<{status: "sent"|"failed"|"skipped", providerId?: string, error?: string, channel: "whatsapp"|"dev"}>}
 */
async function sendTemplate({ phone, type, params = {} }) {
  let to = normalisePhone(phone);
  if (!to) return { status: "failed", error: "invalid_phone", channel: "whatsapp" };

  // Test mode: every message goes to TEST_PHONE. A set-but-bad value stops sending (never fall back to the customer).
  if (type !== "otp") {
    const tp = testPhone();
    if (tp.on) {
      if (!tp.phone) return { status: "failed", error: "TEST_PHONE is not a valid mobile number", channel: "whatsapp" };
      to = tp.phone;
    }
  }

  params = prepare(type, params);
  const prov = providerFor(type);

  if (isDryRun(type)) {
    // Still checks the variables, so a dry run finds a wrong order or a missing value.
    const built = prov === "aisensy" ? buildParams(type, params) : { ok: true, values: (ORDER[type] || []).map((k) => clean(params[k])) };
    console.warn(`[whatsapp] DRY_RUN ${prov} ${masked(to)} [${type}]`, built.ok ? built.values : `INVALID: ${built.error}`);
    return { status: "skipped", error: "dry_run", channel: "dev" };
  }

  const reason = notReady(type);
  if (reason) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[whatsapp] ${reason} — DEV message to ${masked(to)} [${type}]`, params);
      return { status: "skipped", error: reason, channel: "dev" };
    }
    return { status: "skipped", error: reason, channel: "whatsapp" };
  }
  return prov === "aisensy" ? sendAiSensy({ to, type, params }) : sendMeta({ to, type, params, template: templateFor(type) });
}

module.exports = { bareAmount, tidyReason, prepare, sendTemplate, isConfigured, templateFor, ORDER, PARAMS, buildParams, normalisePhone, configStatus, canSend, isDryRun };
