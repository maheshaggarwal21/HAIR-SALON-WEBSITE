/**
 * @file scripts/seedOwner.js
 * @description One-shot owner-account seed. Run at deploy time (or whenever the
 * OWNER_EMAIL / OWNER_PASSWORD env vars change) — NOT on every request.
 *
 * ── Why this is a script and no longer request middleware ─────────────────────
 * This used to run lazily inside an `app.use(...)` on the first request. The
 * `ownerSeeded` guard only holds within a single warm process, but on Vercel
 * every cold start is a fresh process — so the seed (a bcrypt cost-12
 * hash-compare plus one or two DB round trips) re-ran on the FIRST request of
 * every new serverless container, piling onto an already-slow cold start. Moved
 * here it runs exactly once, out of the request path, and never taxes a login.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   npm run seed:owner        (from backend/)
 * or as a Vercel deploy/build step. Requires OWNER_EMAIL and OWNER_PASSWORD.
 *
 * WARNING: if an owner already exists, this SYNCS its email/name/password to the
 * env vars. A mismatched OWNER_PASSWORD will reset the live owner password — the
 * same foot-gun the old middleware had, now confined to an explicit, auditable
 * run instead of firing silently on every deploy's first request.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const connectDB = require("../db");
const User = require("../models/User");

/**
 * Ensures exactly one owner account exists, matching OWNER_EMAIL /
 * OWNER_PASSWORD. Safe to call repeatedly. Returns a short status string.
 *
 * @returns {Promise<"skipped"|"created"|"updated"|"unchanged">}
 */
async function ensureOwner() {
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  const name = "Salon Owner";

  if (!email || !password) {
    console.warn("[seedOwner] OWNER_EMAIL / OWNER_PASSWORD not set — skipping owner seed");
    return "skipped";
  }

  await connectDB();
  const existing = await User.findOne({ role: "owner" });

  if (existing) {
    let changed = false;
    if (existing.email !== email) { existing.email = email; changed = true; }
    if (existing.name !== name) { existing.name = name; changed = true; }

    // Only re-hash if the password actually changed.
    const passwordMatch = await bcrypt.compare(password, existing.passwordHash);
    if (!passwordMatch) {
      existing.passwordHash = await bcrypt.hash(password, 12);
      changed = true;
    }

    if (!existing.isActive) { existing.isActive = true; changed = true; }
    if (changed) {
      await existing.save();
      console.log("[seedOwner] Owner account updated:", email);
      return "updated";
    }
    console.log("[seedOwner] Owner account already up to date:", email);
    return "unchanged";
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await User.create({ name, email, passwordHash, role: "owner" });
  console.log("[seedOwner] Owner account created:", email);
  return "created";
}

module.exports = ensureOwner;

// Run standalone: `node scripts/seedOwner.js` / `npm run seed:owner`.
if (require.main === module) {
  ensureOwner()
    .then(() => mongoose.disconnect())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seedOwner] Failed:", err.message);
      process.exit(1);
    });
}
