/**
 * @file test/memory-rate-limit.test.js
 * @description Audit #18: the public catalogue reads (/site, /services, /artists, ...) are cached by Vercel's edge,
 * yet each one that reached the server used to write a rate-limit counter to MongoDB. They now count in memory
 * (per instance, no database write). The sensitive routes (quote, availability, OTP, booking, requests) keep the
 * MongoDB-backed limiter, which is shared across instances.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const { memoryRateLimit } = require("../middleware/memoryRateLimit");

const run = (mw, req) =>
  new Promise((resolve) => {
    const headers = {};
    const res = { set: (k, v) => (headers[k] = v), status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code, body: b, headers }); } };
    mw(req, res, () => resolve({ status: 200, headers }));
  });
const ipReq = (ip) => ({ headers: { "x-forwarded-for": ip }, ip });

test("allows `max` requests per window, then answers 429 LIMIT_REACHED with Retry-After (same shape as the MongoDB limiter)", async () => {
  let t = 1_000_000;
  const mw = memoryRateLimit({ name: "x", windowMs: 60_000, max: 3, now: () => t });
  for (let i = 0; i < 3; i++) assert.equal((await run(mw, ipReq("1.1.1.1"))).status, 200, `request ${i + 1}`);
  const blocked = await run(mw, ipReq("1.1.1.1"));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "LIMIT_REACHED");
  assert.ok(Number(blocked.headers["Retry-After"]) >= 1);
});

test("each visitor has their own count, and a new window starts fresh", async () => {
  let t = 1_000_000;
  const mw = memoryRateLimit({ name: "x", windowMs: 60_000, max: 1, now: () => t });
  assert.equal((await run(mw, ipReq("1.1.1.1"))).status, 200);
  assert.equal((await run(mw, ipReq("1.1.1.1"))).status, 429);
  assert.equal((await run(mw, ipReq("2.2.2.2"))).status, 200, "someone else is not affected");
  t += 60_000;
  assert.equal((await run(mw, ipReq("1.1.1.1"))).status, 200, "next minute");
});

test("a request with no identifiable address is let through, like the MongoDB limiter", async () => {
  const mw = memoryRateLimit({ name: "x", windowMs: 60_000, max: 1, keyBy: () => null });
  assert.equal((await run(mw, ipReq("1.1.1.1"))).status, 200);
  assert.equal((await run(mw, ipReq("1.1.1.1"))).status, 200);
});

test("memory stays bounded: old windows are dropped and the table never grows past its cap, with no timers", async () => {
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  let t = 1_000_000;
  const mw = memoryRateLimit({ name: "x", windowMs: 60_000, max: 5, now: () => t, maxKeys: 100 });
  for (let i = 0; i < 100; i++) await run(mw, ipReq(`10.0.0.${i}`));
  assert.equal(mw.size(), 100);
  t += 60_000; // all of them are now stale
  await run(mw, ipReq("9.9.9.9"));
  assert.ok(mw.size() <= 2, `stale entries swept, size=${mw.size()}`);
  // an attacker cycling addresses inside ONE window cannot grow it without limit
  for (let i = 0; i < 1000; i++) await run(mw, ipReq(`172.16.${Math.floor(i / 250)}.${i % 250}`));
  assert.ok(mw.size() <= 100, `size=${mw.size()}`);
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.equal(timersAfter, timersBefore, "the limiter starts no in-process timers (serverless rule)");
});

// ─── through the real app ───────────────────────────────────────────────────

let server, base, RateLimitHit;
before(async () => {
  Object.assign(process.env, { TURNSTILE_SECRET_KEY: "t", TELEGRAM_BOT_TOKEN: "", META_WA_TOKEN: "", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", PUBLIC_TOKEN_SECRET: "p" });
  await startDb();
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  RateLimitHit = require("../models/RateLimitHit");
});
after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});
beforeEach(clearDb);

test("public catalogue reads no longer write a counter to MongoDB, and are still limited per visitor", async () => {
  const get = (p, ip) => fetch(`${base}/api/public${p}`, { headers: { "x-forwarded-for": ip } }).then((r) => r.status);
  for (const p of ["/site", "/services", "/artists", "/packages", "/campaigns", "/reels", "/reviews"]) await get(p, "198.51.100.1");
  assert.equal(await RateLimitHit.countDocuments({ key: /^public-read:/ }), 0, "no database write for cached reads");

  const codes = [];
  for (let i = 0; i < 125; i++) codes.push(await get("/site", "198.51.100.2"));
  assert.equal(codes.filter((c) => c === 429).length >= 4, true, "the 121st+ request in a minute is refused");
  assert.equal(codes.slice(0, 120).includes(429), false);
  assert.equal(await get("/site", "198.51.100.3"), 200, "another visitor is fine");
});

test("the sensitive public routes still use the shared MongoDB limiter", async () => {
  const fs = require("fs");
  const src = (f) => fs.readFileSync(require("path").join(__dirname, "..", "routes", f), "utf8");
  assert.match(src("publicBooking.js"), /mongoRateLimit\(/);
  assert.match(src("public.js"), /mongoRateLimit\(\{ name: "request-ip"/);
  assert.doesNotMatch(src("public.js"), /mongoRateLimit\(\{ name: "public-read"/);
  assert.doesNotMatch(src("publicOfferPages.js"), /mongoRateLimit\(\{ name: "public-read"/);
});
