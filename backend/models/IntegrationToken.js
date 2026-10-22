/**
 * @file IntegrationToken.js
 * @description Where a third party's rotating access token lives once we have
 * refreshed it (CF §13, D58). Today only Instagram uses it.
 *
 * Instagram long-lived tokens last 60 days and must be renewed before then, so
 * the renewed token cannot stay in an environment variable (Vercel env is not
 * writable from the app). The env value only SEEDS this row: `seedHash` is the
 * hash of the env token it came from, so pasting a fresh token into Vercel
 * later replaces whatever was stored here.
 */

const mongoose = require("mongoose");

const integrationTokenSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    token: { type: String, required: true },
    seedHash: { type: String, default: null },
    refreshedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastAlertAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("IntegrationToken", integrationTokenSchema);
