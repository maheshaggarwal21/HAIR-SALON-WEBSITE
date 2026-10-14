/**
 * @file turnstile.js
 * @description Server-side Cloudflare Turnstile check (CF §18, T0.11).
 *
 * The browser widget only produces a token; this is the part that decides.
 * Every public write that a bot would want to spam (request-lite form, OTP
 * send, gift-card order) calls verifyTurnstile() before touching the database.
 *
 * ── Without a secret ─────────────────────────────────────────────────────────
 * Production refuses: a missing TURNSTILE_SECRET_KEY must not quietly turn the
 * protection off on the live site. Anywhere else (local dev, tests) the check
 * is skipped with a warning so the form can be used before the keys exist.
 * Cloudflare's documented test secret `1x0000000000000000000000000000000AA`
 * always passes and is the right value for a staging environment.
 *
 * Never throws — a Cloudflare outage returns { ok: false } and the caller
 * answers with a retryable error.
 */

// Overridable so tests can point at a local stub; unset in every real environment.
const verifyUrl = () =>
  process.env.TURNSTILE_VERIFY_URL || "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * @param {string} token     the widget's response token from the browser
 * @param {string} [ip]      client IP (optional, improves Cloudflare's signal)
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>}
 */
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[turnstile] TURNSTILE_SECRET_KEY is not set in production — rejecting");
      return { ok: false, error: "not_configured" };
    }
    return { ok: true, skipped: true };
  }
  if (!token || typeof token !== "string" || token.length > 2048) {
    return { ok: false, error: "missing_token" };
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(verifyUrl(), {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data.success) return { ok: true };
    return { ok: false, error: (data["error-codes"] || []).join(",") || "failed" };
  } catch (err) {
    console.error("[turnstile] verify error:", err.message);
    return { ok: false, error: "unavailable" };
  }
}

module.exports = { verifyTurnstile };
