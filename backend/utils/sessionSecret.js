/**
 * @file sessionSecret.js
 * @description Decides which secret signs the staff session cookie (audit item 6).
 *
 * Why this exists: index.js used `process.env.SESSION_SECRET || "dev-secret-change-in-prod"`.
 * A string in a public repo is not a secret — if the variable ever went missing
 * on a deploy, anyone could have forged a staff session cookie.
 *
 * "Production" means exactly what utils/bookingToken.js means by it:
 * `NODE_ENV === "production"` (not VERCEL_ENV). Vercel sets NODE_ENV=production
 * on Preview deployments too, so Preview needs SESSION_SECRET as well.
 *
 * ── Why it returns null instead of throwing ──────────────────────────────────
 * A throw at import would take down the WHOLE api — the public booking API, the
 * Razorpay webhook and the cron timers as well — over a staff-login setting.
 * index.js therefore boots anyway, answers 503 on staff/session routes, logs
 * loudly and reports `sessionSecret: "missing"` on /api/health. Payments and
 * online bookings keep working while the variable is fixed.
 *
 * Pure on purpose (takes the environment as an argument) so it is unit-tested.
 */

/** Used only outside production, so local dev and tests need no setup. Never used to sign a production cookie. */
const DEV_SESSION_SECRET = "dev-only-session-secret-not-for-production";

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} the secret, or null when production has none (fail closed).
 */
function sessionSecret(env = process.env) {
  const s = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET.trim() : "";
  if (s) return env.SESSION_SECRET;
  if (env.NODE_ENV === "production") return null;
  return DEV_SESSION_SECRET;
}

module.exports = { sessionSecret, DEV_SESSION_SECRET };
