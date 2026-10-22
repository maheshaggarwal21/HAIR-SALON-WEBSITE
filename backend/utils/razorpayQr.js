/**
 * @file razorpayQr.js
 * @description The only place that talks to Razorpay's UPI QR Codes API (D60, part A).
 *
 * Verified against the live API with a ₹1 payment (the QR spike):
 *   - POST /payments/qr_codes with type upi_qr, usage single_use, fixed_amount.
 *     The QR's `notes` are copied onto the payment, which has order_id null.
 *   - The QR flips to status "closed", close_reason "paid" ~3 s after payment.
 *   - GET /payments/qr_codes/:id/payments lags ~36 s: a fallback only.
 *   - `image_url` is an rzp.io redirect to a tall branded PNG poster, not a bare QR.
 *
 * Plain fetch, not the razorpay SDK, because the SDK has no QR helpers worth the
 * dependency surface. Every function RETURNS rather than throws, and none of them
 * logs a response body (it holds the payee's UPI id): only the HTTP status.
 *
 * `setGateway` swaps the whole object so tests never reach the network.
 */

const TIMEOUT_MS = 8000;
const MAX_POSTER_BYTES = 2 * 1024 * 1024;

const base = () => (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com/v1").replace(/\/+$/, "");
const auth = () =>
  "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID || ""}:${process.env.RAZORPAY_KEY_SECRET || ""}`).toString("base64");
const configured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

async function call(method, path, body) {
  if (!configured()) return { ok: false, status: 0, error: "Razorpay is not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(base() + path, {
      method,
      headers: { Authorization: auth(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, error: json?.error?.description || `HTTP ${res.status}`, json: null };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === "AbortError" ? "timeout" : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<{ok: true, id, imageUrl, closeBy} | {ok: false, error}>} */
async function createQr({ amountPaise, sessionId, closeBy, description }) {
  const r = await call("POST", "/payments/qr_codes", {
    type: "upi_qr",
    name: "The Experts",
    usage: "single_use",
    fixed_amount: true,
    payment_amount: amountPaise,
    // Printed on the poster customers see — no customer data, ever.
    description,
    close_by: closeBy,
    notes: { kind: "counter_qr", sessionId: String(sessionId) },
  });
  if (!r.ok || !r.json?.id) return { ok: false, error: r.error || "No QR returned" };
  return { ok: true, id: r.json.id, imageUrl: r.json.image_url || null, closeBy: r.json.close_by || closeBy };
}

/** The few fields we act on. */
async function getQr(id) {
  const r = await call("GET", `/payments/qr_codes/${encodeURIComponent(id)}`);
  if (!r.ok) return { ok: false, error: r.error };
  const q = r.json || {};
  return {
    ok: true,
    status: q.status, // "active" | "closed"
    closeReason: q.close_reason || null, // "paid" | "on_demand" | "expired" …
    amountReceivedPaise: Number(q.payments_amount_received) || 0,
    countReceived: Number(q.payments_count_received) || 0,
  };
}

async function closeQr(id) {
  const r = await call("POST", `/payments/qr_codes/${encodeURIComponent(id)}/close`);
  return r.ok ? { ok: true } : { ok: false, error: r.error, status: r.status };
}

/** Payments made against a QR: id, amount (paise) and status only. Lags ~36 s. */
async function listQrPayments(id) {
  const r = await call("GET", `/payments/qr_codes/${encodeURIComponent(id)}/payments`);
  if (!r.ok) return { ok: false, error: r.error };
  const items = Array.isArray(r.json?.items) ? r.json.items : [];
  return { ok: true, payments: items.map((p) => ({ id: p.id, amountPaise: Number(p.amount) || 0, status: p.status })) };
}

/** Razorpay-hosted poster only; never an arbitrary URL from a response. */
function trustedPosterUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "rzp.io" || u.hostname.endsWith(".razorpay.com") || u.hostname === "razorpay.com");
  } catch {
    return false;
  }
}

/** @returns {Promise<Buffer|null>} */
async function fetchPoster(imageUrl) {
  if (!trustedPosterUrl(imageUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(imageUrl, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") || "").includes("image/png")) return null;
    const len = Number(res.headers.get("content-length"));
    if (len && len > MAX_POSTER_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= MAX_POSTER_BYTES ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const real = { configured, createQr, getQr, closeQr, listQrPayments, fetchPoster };
let current = real;

module.exports = {
  gateway: () => current,
  setGateway: (g) => {
    current = g;
  },
  resetGateway: () => {
    current = real;
  },
  trustedPosterUrl,
};
