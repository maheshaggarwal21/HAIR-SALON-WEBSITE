/**
 * @file mongoRateLimit.js
 * @description Fixed-window rate limiter backed by MongoDB (RateLimitHit), for
 * the public API (CONTROL_FLOW_AND_DATA_LOGIC.md §14, T1.6).
 *
 * Why not the global express-rate-limit: its store is in memory, so on Vercel
 * every instance counts separately and a burst spread across instances is never
 * stopped. Why not keyed like the staff limiter: every salon device shares one
 * IP, but public visitors don't — public limits key on the visitor's own IP or
 * on a phone number, and are sized for one person, not a whole front desk.
 *
 * One atomic upsert per check: `$inc` on `{key, windowStart}`. Two instances
 * creating the same window at the same instant can race on the unique index;
 * the loser retries once and lands on the winner's document.
 *
 * ── Failure mode: open ───────────────────────────────────────────────────────
 * If the database can't be reached the request is let through and the error
 * logged. The limiter protects against abuse; Turnstile still guards writes,
 * and blocking every customer because a counter write failed would turn a
 * monitoring problem into an outage.
 *
 * Payment-completion endpoints must never use this (CLAUDE.md, "Money").
 */

const crypto = require("crypto");
const RateLimitHit = require("../models/RateLimitHit");
const { clientIp } = require("../utils/audit");

const hash = (v) => crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 32);

/**
 * Count one hit and report whether it is within the limit.
 * @returns {Promise<{allowed: boolean, count: number, resetAt: Date}>}
 */
async function hit({ name, id, windowMs, max }) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);
  const key = `${name}:${hash(id)}`;

  const bump = () =>
    RateLimitHit.findOneAndUpdate(
      { key, windowStart },
      // Keep the document a minute past its window so a slow clock on one
      // instance can't recreate a fresh counter for a window that just ended.
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(resetAt.getTime() + 60_000) } },
      { upsert: true, returnDocument: "after", lean: true }
    );

  let doc;
  try {
    doc = await bump();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    doc = await bump();
  }
  return { allowed: doc.count <= max, count: doc.count, resetAt };
}

/**
 * Express middleware.
 * @param {object}   opts
 * @param {string}   opts.name       limiter name, part of the key
 * @param {number}   opts.windowMs
 * @param {number}   opts.max        hits allowed per window
 * @param {Function} [opts.keyBy]    req => string|null. Default: client IP.
 *                                   Return null to skip this limiter for the request.
 */
function mongoRateLimit({ name, windowMs, max, keyBy = (req) => clientIp(req) }) {
  return async function (req, res, next) {
    const id = keyBy(req);
    if (id == null || id === "") return next();
    try {
      const { allowed, resetAt } = await hit({ name, id, windowMs, max });
      if (!allowed) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))));
        return res.status(429).json({
          error: "LIMIT_REACHED",
          message: "Too many attempts. Try again a little later.",
        });
      }
    } catch (err) {
      console.error(`[rateLimit:${name}] store error — allowing request:`, err.message);
    }
    return next();
  };
}

module.exports = { mongoRateLimit, hit };
