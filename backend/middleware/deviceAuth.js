/**
 * @file deviceAuth.js
 * @description Authenticates a counter tablet by its bearer token (D60, part A).
 *
 * The tablet has no staff session and must never get one, so this is the only way
 * in for it. One atomic update does three jobs at once, so a poll costs a single
 * database write:
 *   - authenticates: the token's hash must match a device that is not revoked;
 *   - throttles: a device may poll at most once per 1.5 s (the fast poll is 2.5 s),
 *     which stops a runaway tablet tab from burning function invocations;
 *   - records "seen", which is what the staff screen's online/offline chip reads.
 *
 * The salon's IP-wide limiter does not cover the display endpoint (it would be
 * exhausted by the tablet itself), so this per-device throttle is its limiter.
 */

const connectDB = require("../db");
const CounterDevice = require("../models/CounterDevice");
const { sha256 } = require("../utils/counter");

const MIN_GAP_MS = 1500;

async function deviceAuth(req, res, next) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get("authorization") || "");
  if (!m) return res.status(401).json({ error: "This tablet is not paired", unpaired: true });
  try {
    await connectDB();
    const now = new Date();
    const tokenHash = sha256(m[1]);
    const device = await CounterDevice.findOneAndUpdate(
      { tokenHash, revokedAt: null, $or: [{ lastPollAt: null }, { lastPollAt: { $lt: new Date(now.getTime() - MIN_GAP_MS) } }] },
      { $set: { lastPollAt: now } },
      { returnDocument: "after" }
    );
    if (device) {
      req.device = device;
      return next();
    }
    if (await CounterDevice.exists({ tokenHash, revokedAt: null })) {
      res.set("Retry-After", "2");
      return res.status(429).json({ error: "Too many requests" });
    }
    return res.status(401).json({ error: "This tablet is not paired", unpaired: true });
  } catch (err) {
    console.error("[deviceAuth] error:", err.message);
    return res.status(503).json({ error: "Database unavailable" });
  }
}

module.exports = { deviceAuth };
