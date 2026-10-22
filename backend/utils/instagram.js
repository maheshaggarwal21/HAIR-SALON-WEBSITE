/**
 * @file instagram.js
 * @description Daily Instagram → reels wall sync and token renewal
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §13, D58, T3.6).
 *
 * Uses the Instagram API with Instagram Login (graph.instagram.com): one
 * long-lived token for the salon's own professional account, no app review.
 *
 *   - Videos only. The wall is for reels; photos and carousels are skipped.
 *   - New posts arrive VISIBLE; the owner hides or tags ("Book this look") in
 *     the staff app. A re-sync refreshes only the media/thumbnail URLs (Instagram's
 *     CDN links expire) and never touches caption, visibility, tag or order.
 *   - The token is renewed once it is a week old (any renewal needs it to be
 *     24 h old). The renewed token is kept in IntegrationToken; the env token
 *     only seeds it. A failure sends the owner a Telegram alert, at most one a day.
 *
 * NEVER THROWS (returns {ok:false, error}); idempotent, so a second run the same
 * day changes nothing. Not configured (no token) → {skipped:true}.
 */

const crypto = require("crypto");
const Reel = require("../models/Reel");
const User = require("../models/User");
const IntegrationToken = require("../models/IntegrationToken");
const telegram = require("./telegram");
const { revalidateSite } = require("./revalidate");

const DAY = 24 * 60 * 60 * 1000;
const REFRESH_AFTER = 7 * DAY;
const WARN_WITHIN = 14 * DAY;
const ASSUMED_LIFETIME = 55 * DAY; // a freshly generated token is good for 60 days; assume a bit less
const KEY = "instagram";
const FIELDS = "id,media_type,media_url,thumbnail_url,permalink,caption,timestamp";

const base = () => (process.env.INSTAGRAM_API_BASE || "https://graph.instagram.com").replace(/\/+$/, "");

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) return { ok: false, error: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "timeout" : err.message };
  }
}

async function currentToken(now) {
  const seed = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!seed) return null;
  const seedHash = crypto.createHash("sha256").update(seed).digest("hex");
  const doc = await IntegrationToken.findOne({ key: KEY });
  if (doc && doc.seedHash === seedHash) return doc;
  return IntegrationToken.findOneAndUpdate(
    { key: KEY },
    { $set: { token: seed, seedHash, refreshedAt: now, expiresAt: new Date(now.getTime() + ASSUMED_LIFETIME), lastError: null } },
    { upsert: true, returnDocument: "after" }
  );
}

async function alertOwners(doc, text, now) {
  if (doc.lastAlertAt && now - doc.lastAlertAt < DAY) return;
  if (!telegram.isConfigured()) return;
  const owners = await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean();
  for (const o of owners) await telegram.sendMessage(o.telegramChatId, text);
  await IntegrationToken.updateOne({ _id: doc._id }, { $set: { lastAlertAt: now } });
}

async function refreshIfDue(doc, now) {
  if (now - doc.refreshedAt < REFRESH_AFTER) return null;
  const r = await getJson(`${base()}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(doc.token)}`);
  if (!r.ok || !r.data.access_token) return r.error || "no token in reply";
  doc.token = r.data.access_token;
  doc.refreshedAt = now;
  doc.expiresAt = new Date(now.getTime() + (Number(r.data.expires_in) || 60 * 24 * 3600) * 1000);
  await IntegrationToken.updateOne({ _id: doc._id }, { $set: { token: doc.token, refreshedAt: doc.refreshedAt, expiresAt: doc.expiresAt } });
  return null;
}

async function instagramSync(now = new Date()) {
  const doc = await currentToken(now);
  if (!doc) return { skipped: true, reason: "not_configured" };

  const refreshError = await refreshIfDue(doc, now);
  const media = await getJson(`${base()}/me/media?fields=${FIELDS}&limit=30&access_token=${encodeURIComponent(doc.token)}`);

  const problem = !media.ok ? `sync failed: ${media.error}` : refreshError ? `token renewal failed: ${refreshError}` : null;
  const expiresSoon = doc.expiresAt && doc.expiresAt - now < WARN_WITHIN;
  if (problem || expiresSoon) {
    const why = problem || `the token runs out on ${doc.expiresAt.toISOString().slice(0, 10)} and has not renewed`;
    await alertOwners(doc, `Instagram reels sync needs attention: ${why}. Generate a new token in the Meta app (Instagram → Generate token) and paste it into Vercel as INSTAGRAM_ACCESS_TOKEN.`, now);
  }
  await IntegrationToken.updateOne({ _id: doc._id }, { $set: { lastError: problem, ...(media.ok ? { lastSyncAt: now } : {}) } });
  if (!media.ok) return { ok: false, error: media.error };

  const videos = (media.data.data || []).filter((m) => m.media_type === "VIDEO" && m.media_url);
  let result = { upsertedCount: 0, modifiedCount: 0 };
  if (videos.length) {
    result = await Reel.bulkWrite(
      videos.map((m) => ({
        updateOne: {
          filter: { igMediaId: m.id },
          update: {
            $set: { mediaUrl: m.media_url, thumbnailUrl: m.thumbnail_url || null, permalink: m.permalink || null, urlRefreshedAt: now },
            $setOnInsert: {
              mediaType: "video",
              caption: m.caption ? m.caption.slice(0, 300) : null,
              postedAt: m.timestamp ? new Date(m.timestamp) : now,
              visible: true,
              sortOrder: 0,
            },
          },
          upsert: true,
        },
      }))
    );
    await revalidateSite(["reels"]);
  }
  return { ok: true, fetched: videos.length, added: result.upsertedCount, refreshed: result.modifiedCount, tokenExpiresAt: doc.expiresAt, tokenRefreshError: refreshError };
}

module.exports = { instagramSync };
