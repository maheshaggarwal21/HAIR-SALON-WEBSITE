/**
 * @file metaCapi.js
 * @description Meta Conversions API: the server half of the Meta Pixel
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §17, T3.7, D65).
 *
 *   await metaCapi.send("Lead", appt, { ip })       request saved / booking waiting for approval
 *   await metaCapi.send("Schedule", appt)           booking confirmed (engine, webhook or staff)
 *
 * ── Why a server copy of events the browser already sends ────────────────────
 * The pixel runs in the customer's browser, so iPhones' tracking limits, ad
 * blockers and Instagram's in-app browser lose some Lead and Schedule events,
 * and a request that reception confirms days later never reaches the browser
 * at all. This file sends the same two events from the server.
 *
 * ── Counted once ─────────────────────────────────────────────────────────────
 * `event_id` is the booking ref, the same value the browser passes as the
 * pixel's eventID (customer/lib/pixel.ts). Meta keeps one event per
 * (event_name, event_id), so the browser copy and this one count once, and a
 * webhook plus a browser confirming the same payment sending twice is harmless.
 *
 * ── What is sent ─────────────────────────────────────────────────────────────
 * No name, phone, email or notes, hashed or not: the privacy page promises
 * that (customer/app/privacy). Matching uses only what the pixel itself already
 * sees: the `_fbp` / `_fbc` cookie ids, the browser's user agent and, while the
 * customer's own request is being handled, their IP address. The ids and the
 * user agent are copied onto the booking (`source.pixel`) when it is made, so a
 * Razorpay webhook or a staff confirmation hours later can still be matched; the
 * IP is never stored. Value is the server's own total, never a browser number.
 *
 * Only bookings that came from the website or an offer / ad page are sent.
 * Desk, phone and walk-in bookings were not caused by a web visit.
 *
 * Off until META_PIXEL_ID and META_CAPI_TOKEN are set (a System User token with
 * the dataset assigned). META_CAPI_TEST_CODE routes events to Events Manager →
 * Test events instead of live data.
 *
 * NEVER THROWS: it returns {status: "sent" | "skipped" | "failed"}. The booking is
 * already saved, and the awaited call is short (Vercel may stop work left
 * running after the response).
 */

const TIMEOUT_MS = 4000;
const ONLINE_CHANNELS = new Set(["web", "wa_ad"]);
const EVENTS = new Set(["Lead", "Schedule"]);

// fb.<subdomain index>.<creation ms>.<random | fbclid>, as set by the pixel.
const FBP_RE = /^fb\.[0-9]\.[0-9]{10,16}\.[0-9]{1,30}$/;
const FBC_RE = /^fb\.[0-9]\.[0-9]{10,16}\.[A-Za-z0-9_-]{1,500}$/;
const FBCLID_RE = /^[A-Za-z0-9_-]{1,500}$/;

function config() {
  return {
    base: (process.env.META_CAPI_BASE || "https://graph.facebook.com").replace(/\/+$/, ""),
    version: process.env.META_GRAPH_VERSION || "v21.0",
    pixelId: process.env.META_PIXEL_ID || "",
    token: process.env.META_CAPI_TOKEN || "",
    testCode: process.env.META_CAPI_TEST_CODE || "",
  };
}

function isConfigured() {
  const { pixelId, token } = config();
  return Boolean(pixelId && token);
}

function readCookie(header, name) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const valid = (v, re) => (typeof v === "string" && re.test(v) ? v : null);

/**
 * The pixel ids and user agent from a customer's request, for `source.pixel`.
 * The site sends the ids as X-Meta-Fbp / X-Meta-Fbc headers (customer/lib/pixel.ts);
 * the cookies themselves are the fallback. Junk is dropped, never stored.
 * @returns {{fbp?: string, fbc?: string, userAgent?: string} | null}
 */
function fromRequest(req) {
  const h = req?.headers || {};
  const fbp = valid(h["x-meta-fbp"], FBP_RE) || valid(readCookie(h.cookie, "_fbp"), FBP_RE);
  const fbc = valid(h["x-meta-fbc"], FBC_RE) || valid(readCookie(h.cookie, "_fbc"), FBC_RE);
  const ua = typeof h["user-agent"] === "string" ? h["user-agent"].slice(0, 400) : "";
  const out = {};
  if (fbp) out.fbp = fbp;
  if (fbc) out.fbc = fbc;
  if (ua) out.userAgent = ua;
  return Object.keys(out).length ? out : null;
}

/** An ad click's fbclid as an `fbc` value, when the cookie never got set (pixel blocked). */
function fbcFromFbclid(fbclid, at) {
  if (!valid(fbclid, FBCLID_RE)) return null;
  const ms = at instanceof Date && Number.isFinite(at.getTime()) ? at.getTime() : Date.now();
  return `fb.1.${ms}.${fbclid}`;
}

function siteUrl() {
  return (process.env.CUSTOMER_SITE_URL || "https://www.thexpertshair.com").replace(/\/+$/, "");
}

function contentName(appt) {
  return appt.source?.offerPackage?.name || appt.guests?.[0]?.items?.[0]?.name || "Booking";
}

/**
 * The Graph API event, or null when this booking shouldn't be sent: not from
 * the web, or nothing Meta could match it on.
 */
function buildEvent(name, appt, { ip = null, now = new Date() } = {}) {
  if (!EVENTS.has(name) || !appt?.ref || !ONLINE_CHANNELS.has(appt.source?.channel)) return null;
  const pixel = appt.source?.pixel || {};
  const userData = {};
  if (pixel.userAgent) userData.client_user_agent = pixel.userAgent;
  if (ip) userData.client_ip_address = ip;
  if (pixel.fbp) userData.fbp = pixel.fbp;
  const fbc = pixel.fbc || fbcFromFbclid(appt.source?.utm?.fbclid, appt.createdAt);
  if (fbc) userData.fbc = fbc;
  // Meta refuses a website event without a user agent, and can't match one with
  // nothing but a user agent.
  if (!userData.client_user_agent || !(userData.fbp || userData.fbc || userData.client_ip_address)) return null;

  const offer = appt.source?.offerSlug;
  return {
    event_name: name,
    event_time: Math.floor(now.getTime() / 1000),
    event_id: appt.ref,
    action_source: "website",
    event_source_url: offer ? `${siteUrl()}/offers/${offer}` : `${siteUrl()}/`,
    user_data: userData,
    custom_data: { currency: "INR", value: Math.max(0, Number(appt.pricing?.total) || 0), content_name: contentName(appt) },
  };
}

/**
 * @param {"Lead"|"Schedule"} name
 * @param {object} appt     the saved Appointment (lean or document)
 * @param {object} [opts]
 * @param {string} [opts.ip]  the customer's IP, only while handling their own request
 * @returns {Promise<{status: "sent"|"skipped"|"failed", error?: string}>}
 */
async function send(name, appt, { ip = null, now = new Date() } = {}) {
  try {
    if (!isConfigured()) return { status: "skipped", error: "not_configured" };
    const event = buildEvent(name, appt, { ip, now });
    if (!event) return { status: "skipped", error: "not_sendable" };
    const { base, version, pixelId, token, testCode } = config();
    // The token goes in the body, not the address, so it never lands in a request log.
    const res = await fetch(`${base}/${version}/${pixelId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [event], access_token: token, ...(testCode ? { test_event_code: testCode } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const e = data?.error;
      const error = e ? `${e.message || "error"}${e.code ? ` (${e.code})` : ""}` : `HTTP ${res.status}`;
      console.error(`[meta-capi] ${name} for ${appt.ref} not sent: ${error}`);
      return { status: "failed", error };
    }
    return { status: "sent" };
  } catch (err) {
    console.error(`[meta-capi] ${name} for ${appt?.ref} not sent:`, err?.name === "TimeoutError" ? "timeout" : err?.message);
    return { status: "failed", error: err?.name === "TimeoutError" ? "timeout" : "error" };
  }
}

module.exports = { send, buildEvent, fromRequest, fbcFromFbclid, isConfigured, ONLINE_CHANNELS };
