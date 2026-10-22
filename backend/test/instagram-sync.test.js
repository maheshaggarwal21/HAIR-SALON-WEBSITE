/**
 * @file test/instagram-sync.test.js
 * @description Instagram reels sync + token renewal (D58, T3.6). A local stub
 * plays graph.instagram.com and Telegram is a recorder; nothing leaves the machine.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub, Reel, User, IntegrationToken, telegram, instagram;
let calls = [];
let media;
let mediaStatus;
let refreshReply;
let alerts = [];

const DAY = 86400000;

before(async () => {
  stub = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/me/media")) {
      res.statusCode = mediaStatus;
      return res.end(JSON.stringify(mediaStatus === 200 ? { data: media } : { error: { message: "Invalid OAuth access token", code: 190 } }));
    }
    if (req.url.startsWith("/refresh_access_token")) return res.end(JSON.stringify(refreshReply));
    res.statusCode = 404;
    return res.end("{}");
  });
  await new Promise((r) => stub.listen(0, r));
  Object.assign(process.env, {
    INSTAGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
    INSTAGRAM_ACCESS_TOKEN: "seed-token",
    TELEGRAM_BOT_TOKEN: "x",
    CUSTOMER_SITE_URL: "",
  });
  await startDb();
  Reel = require("../models/Reel");
  User = require("../models/User");
  IntegrationToken = require("../models/IntegrationToken");
  telegram = require("../utils/telegram");
  telegram.isConfigured = () => true;
  telegram.sendMessage = async (chatId, text) => { alerts.push({ chatId, text }); return { ok: true }; };
  instagram = require("../utils/instagram");
});

after(async () => {
  await new Promise((r) => stub.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  calls = [];
  alerts = [];
  mediaStatus = 200;
  process.env.INSTAGRAM_ACCESS_TOKEN = "seed-token";
  refreshReply = { access_token: "renewed-token", token_type: "bearer", expires_in: 5184000 };
  media = [
    { id: "1", media_type: "VIDEO", media_url: "https://cdn.test/1.mp4", thumbnail_url: "https://cdn.test/1.jpg", permalink: "https://instagram.com/reel/1", caption: "Colour day", timestamp: "2026-10-20T10:00:00+0000" },
    { id: "2", media_type: "IMAGE", media_url: "https://cdn.test/2.jpg", permalink: "https://instagram.com/p/2", timestamp: "2026-10-19T10:00:00+0000" },
    { id: "3", media_type: "CAROUSEL_ALBUM", permalink: "https://instagram.com/p/3", timestamp: "2026-10-18T10:00:00+0000" },
  ];
  await User.collection.insertOne({ name: "Owner", email: "o@x.test", role: "owner", isActive: true, telegramChatId: "42" });
});

test("not configured: skipped, nothing called", async () => {
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  const out = await instagram.instagramSync();
  assert.equal(out.skipped, true);
  assert.equal(calls.length, 0);
});

test("only videos become reels, visible, with the Instagram link", async () => {
  const out = await instagram.instagramSync();
  assert.equal(out.ok, true);
  assert.equal(out.added, 1);
  const reels = await Reel.find().lean();
  assert.equal(reels.length, 1);
  assert.equal(reels[0].igMediaId, "1");
  assert.equal(reels[0].visible, true);
  assert.equal(reels[0].mediaType, "video");
  assert.equal(reels[0].permalink, "https://instagram.com/reel/1");
});

test("a re-sync refreshes the CDN links but keeps the owner's edits", async () => {
  await instagram.instagramSync();
  await Reel.updateOne({ igMediaId: "1" }, { $set: { visible: false, caption: "Edited by owner", sortOrder: 3 } });
  media[0].media_url = "https://cdn.test/1-new.mp4";
  const out = await instagram.instagramSync();
  assert.equal(out.added, 0);
  const r = await Reel.findOne({ igMediaId: "1" }).lean();
  assert.equal(r.mediaUrl, "https://cdn.test/1-new.mp4");
  assert.equal(r.visible, false);
  assert.equal(r.caption, "Edited by owner");
  assert.equal(r.sortOrder, 3);
  assert.equal(await Reel.countDocuments(), 1);
});

test("token is renewed once a week old and the renewed one is used afterwards", async () => {
  await instagram.instagramSync(); // seeds, nothing due yet
  assert.ok(!calls.some((u) => u.startsWith("/refresh_access_token")));
  await IntegrationToken.updateOne({ key: "instagram" }, { $set: { refreshedAt: new Date(Date.now() - 8 * DAY) } });
  calls = [];
  await instagram.instagramSync();
  assert.ok(calls.some((u) => u.startsWith("/refresh_access_token") && u.includes("seed-token")));
  assert.equal((await IntegrationToken.findOne({ key: "instagram" })).token, "renewed-token");
  calls = [];
  await instagram.instagramSync();
  assert.ok(calls.find((u) => u.startsWith("/me/media")).includes("renewed-token"));
  assert.ok(!calls.some((u) => u.startsWith("/refresh_access_token")), "not renewed again the same day");
});

test("pasting a new token into Vercel replaces the stored one", async () => {
  await instagram.instagramSync();
  await IntegrationToken.updateOne({ key: "instagram" }, { $set: { token: "renewed-token" } });
  process.env.INSTAGRAM_ACCESS_TOKEN = "fresh-from-meta";
  calls = [];
  await instagram.instagramSync();
  assert.ok(calls.find((u) => u.startsWith("/me/media")).includes("fresh-from-meta"));
});

test("a failing sync alerts the owner on Telegram, once a day", async () => {
  mediaStatus = 400;
  const out = await instagram.instagramSync();
  assert.equal(out.ok, false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Instagram reels sync needs attention/);
  await instagram.instagramSync();
  assert.equal(alerts.length, 1, "no second alert within a day");
  assert.match((await IntegrationToken.findOne({ key: "instagram" })).lastError, /sync failed/);
});

test("a token close to expiry that cannot renew raises the alert even if syncing works", async () => {
  await instagram.instagramSync();
  await IntegrationToken.updateOne({ key: "instagram" }, { $set: { refreshedAt: new Date(Date.now() - 8 * DAY), expiresAt: new Date(Date.now() + 5 * DAY) } });
  refreshReply = { error: { message: "Cannot refresh" } };
  const out = await instagram.instagramSync();
  assert.equal(out.ok, true);
  assert.equal(alerts.length, 1);
});
