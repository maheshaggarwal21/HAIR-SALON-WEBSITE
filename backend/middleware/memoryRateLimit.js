/**
 * @file memoryRateLimit.js
 * @description Fixed-window rate limiter that counts IN MEMORY, for the public catalogue reads (audit #18).
 *
 * Those reads (/site, /services, /artists, /packages, /campaigns, /reels, /reviews, offer pages) are cached by
 * Vercel's edge for a minute or more, so only a fraction of page views reach the server. The MongoDB-backed
 * limiter (mongoRateLimit.js) still wrote a counter to Atlas for every one that did: under ad traffic that is a
 * database write per page view for data that is public and cached.
 *
 * ── What this trades away, on purpose ────────────────────────────────────────
 * Counters live in ONE server instance, so a burst spread over many instances is not stopped as a whole
 * (CLAUDE.md: "in-memory rate limiters are per-instance"). That is acceptable HERE because these routes only
 * read public, cached data. Anything that writes, sends a message, costs money or does heavy work (quote,
 * availability, OTP, booking, requests) keeps the shared MongoDB limiter.
 *
 * ── Serverless rules kept ────────────────────────────────────────────────────
 * No timers. Old windows are swept lazily when the table is full, and the table can never exceed `maxKeys`,
 * so a visitor cycling addresses cannot grow memory without limit. A request with no identifiable address is
 * let through, the same as mongoRateLimit. The answer when over the limit is identical (429 LIMIT_REACHED).
 */

const { clientIp } = require("../utils/audit");

function memoryRateLimit({ name, windowMs, max, keyBy = (req) => clientIp(req), now = Date.now, maxKeys = 5000 }) {
  const counters = new Map(); // id -> { windowStart, count }

  function sweep(windowStart) {
    for (const [id, c] of counters) if (c.windowStart !== windowStart) counters.delete(id);
    // Still full inside one window (many different visitors at once): drop the oldest half rather than grow.
    if (counters.size >= maxKeys) {
      let drop = Math.ceil(counters.size / 2);
      for (const id of counters.keys()) {
        if (drop-- <= 0) break;
        counters.delete(id);
      }
    }
  }

  const middleware = function (req, res, next) {
    const id = keyBy(req);
    if (id == null || id === "") return next();
    const t = now();
    const windowStart = Math.floor(t / windowMs) * windowMs;
    let c = counters.get(id);
    if (!c || c.windowStart !== windowStart) {
      if (!c && counters.size >= maxKeys) sweep(windowStart);
      c = { windowStart, count: 0 };
      counters.set(id, c);
    }
    c.count += 1;
    if (c.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((windowStart + windowMs - t) / 1000))));
      return res.status(429).json({ error: "LIMIT_REACHED", message: "Too many attempts. Try again a little later." });
    }
    return next();
  };
  middleware.size = () => counters.size;
  middleware.limiterName = name;
  return middleware;
}

/** The one limiter every public catalogue read shares (per visitor address, per instance). */
const publicReadLimit = memoryRateLimit({ name: "public-read", windowMs: 60_000, max: 120 });

module.exports = { memoryRateLimit, publicReadLimit };
