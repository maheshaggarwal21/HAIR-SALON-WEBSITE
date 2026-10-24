/**
 * @file test/booking-limits.test.js
 * @description Per-phone daily limits on POST /api/public/appointments (audit item 9).
 *
 * Before: the per-phone counter went up BEFORE createBooking ran, so a customer
 * who hit "that time was just taken" five times was locked out for the day
 * without ever having booked. Now:
 *   - successful bookings: counted only after createBooking succeeds, 10 per phone per day;
 *   - expected failures (4xx BookingError such as SLOT_TAKEN): a separate counter, 30 per phone per day;
 *   - the per-IP limiter (10 attempts per hour) is unchanged.
 *
 * Through the REAL app (index.js). Turnstile is a local stub; nothing leaves the machine.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub;
let server;
let base;
let Service, Artist, SiteSettings, RateLimitHit, time, bookingToken, limiter;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/turnstile") {
        const token = new URLSearchParams(raw).get("response");
        return res.end(JSON.stringify({ success: token === "good" }));
      }
      return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(process.env, {
    TURNSTILE_SECRET_KEY: "test-secret",
    TURNSTILE_VERIFY_URL: `${stubBase}/turnstile`,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_API_BASE: stubBase,
    META_WA_API_BASE: stubBase,
    META_WA_TOKEN: "",
    RAZORPAY_KEY_ID: "rzp_test_fake",
    RAZORPAY_KEY_SECRET: "test-key-secret",
    PUBLIC_TOKEN_SECRET: "test-public-token-secret",
    CUSTOMER_SITE_URL: "https://www.example.test",
  });

  await startDb();
  assert.match(process.env.MONGODB_URI, /^mongodb:\/\/127\.0\.0\.1/);
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;

  Service = require("../models/Service");
  Artist = require("../models/Artist");
  SiteSettings = require("../models/SiteSettings");
  RateLimitHit = require("../models/RateLimitHit");
  time = require("../utils/time");
  bookingToken = require("../utils/bookingToken");
  limiter = require("../middleware/mongoRateLimit");

  require("../utils/payments").setClientForTests({
    orders: { create: async (o) => ({ id: `order_${Math.random().toString(36).slice(2)}`, amount: o.amount, currency: o.currency, notes: o.notes }) },
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await stopDb();
});

let ipCounter = 0;
let DATE;
let ids;
const nextIp = () => `10.7.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function bookableDate() {
  let d = time.addDays(time.salonDate(), 2);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  return d;
}
const at = (hhmm, date = DATE) => time.salonInstant(date, hhmm).toISOString();

beforeEach(async () => {
  await clearDb();
  DATE = bookableDate();
  const [thread] = await Service.create([
    { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true, name: "Eyebrow Threading", price: 100, publicPrice: 50, slug: "eyebrow-threading", audience: "her", displayCategory: "Skin", durationMinutes: 15 },
  ]);
  await Artist.create([{ name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female", onlineBookable: true, publicProfile: { slug: "mansi", displayName: "Mansi", visible: true } }]);
  // The separate "open bookings per phone" rule (default 3) is not what is under test here.
  const s = await SiteSettings.getSingleton();
  s.maxActiveBookingsPerPhone = 50;
  await s.save();
  ids = { thread: String(thread._id) };
});

/** POST /appointments from a fresh IP unless one is given (so the per-IP limiter stays out of the way). */
async function book(phone, startAt, { ip = nextIp(), overrides = {} } = {}) {
  const res = await fetch(`${base}/api/public/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({
      bookingToken: bookingToken.issue(phone).token,
      phone,
      name: "Asha Rani",
      guests: [{ for: "her", services: [ids.thread] }],
      startAt,
      payment: "full",
      policyAccepted: true,
      turnstileToken: "good",
      ...overrides,
    }),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const slot = (i) => {
  // 11:00, 11:30, 12:00 ... one 15-minute service per slot, never overlapping.
  const mins = 11 * 60 + i * 30;
  return at(`${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
};

const counter = (name, phone) => limiter.peek({ name, id: phone, windowMs: DAY });

test("five slot-taken failures do not use up the day: the sixth, real booking succeeds", async () => {
  assert.equal((await book("9876500001", slot(0))).status, 201, "someone else takes 11:00");

  const phone = "9876500002";
  for (let i = 0; i < 5; i++) {
    const r = await book(phone, slot(0));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "SLOT_TAKEN");
  }
  assert.equal((await counter("appointment-phone", phone)).count, 0, "failures never count as bookings");
  assert.equal((await counter("appointment-fail-phone", phone)).count, 5);

  const ok = await book(phone, slot(1));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await counter("appointment-phone", phone)).count, 1);
});

test("ten successful bookings in a day are allowed and the eleventh is refused", async () => {
  const phone = "9876500003";
  for (let i = 0; i < 10; i++) {
    const r = await book(phone, slot(i));
    assert.equal(r.status, 201, `booking ${i + 1}: ${JSON.stringify(r.body)}`);
  }
  const eleventh = await book(phone, slot(10));
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.body.error, "LIMIT_REACHED");
  assert.equal((await counter("appointment-phone", phone)).count, 10, "a refused attempt is not counted as a booking");
});

test("thirty failed attempts are allowed; the 31st is refused even for a free slot", async () => {
  assert.equal((await book("9876500004", slot(0))).status, 201, "someone else takes 11:00");

  const phone = "9876500005";
  for (let i = 0; i < 30; i++) {
    const r = await book(phone, slot(0));
    assert.equal(r.body.error, "SLOT_TAKEN", `attempt ${i + 1}`);
  }
  const blocked = await book(phone, slot(3));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "LIMIT_REACHED");
  assert.equal((await counter("appointment-fail-phone", phone)).count, 30, "a refused attempt is not counted either");
});

test("the failure counter is per phone: someone else's phone is not affected", async () => {
  assert.equal((await book("9876500006", slot(0))).status, 201);
  const noisy = "9876500007";
  for (let i = 0; i < 30; i++) await book(noisy, slot(0));
  assert.equal((await book(noisy, slot(2))).status, 429);
  assert.equal((await book("9876500008", slot(2))).status, 201);
});

test("validation errors from a mistyped booking do not count against the phone", async () => {
  const phone = "9876500009";
  // Not a BookingError: caught by the request validators before the limiter code runs.
  const bad = await book(phone, slot(0), { overrides: { policyAccepted: false } });
  assert.equal(bad.status, 400);
  assert.equal((await counter("appointment-phone", phone)).count, 0);
  assert.equal((await counter("appointment-fail-phone", phone)).count, 0);
});

test("the per-IP limiter still applies: the 11th attempt in an hour from one IP is refused", async () => {
  const ip = "10.99.0.1";
  for (let i = 0; i < 10; i++) {
    const r = await book(`98765001${String(i).padStart(2, "0")}`, slot(i), { ip, overrides: { policyAccepted: false } });
    assert.equal(r.status, 400, `attempt ${i + 1} reaches validation`);
  }
  const eleventh = await book("9876500199", slot(0), { ip });
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.body.error, "LIMIT_REACHED");
  assert.ok(Number(eleventh.headers.get("retry-after")) >= 1);
});

test("peek() reads the counter without counting", async () => {
  const args = { name: "peek-test", id: "abc", windowMs: DAY };
  assert.equal((await limiter.peek(args)).count, 0);
  assert.equal((await limiter.peek(args)).count, 0);
  await limiter.hit({ ...args, max: 5 });
  assert.equal((await limiter.peek(args)).count, 1);
  assert.equal((await limiter.peek(args)).count, 1, "peeking twice did not move it");
  assert.ok((await limiter.peek(args)).resetAt > new Date());
});

test("hit() as middleware still fails open when the counter store is down", async () => {
  const original = RateLimitHit.findOneAndUpdate;
  RateLimitHit.findOneAndUpdate = () => Promise.reject(new Error("db down"));
  const log = console.error;
  console.error = () => {};
  try {
    let nextCalled = false;
    const mw = limiter.mongoRateLimit({ name: "x", windowMs: 1000, max: 1 });
    await mw({ headers: { "x-forwarded-for": "1.2.3.4" } }, { set() {}, status() { throw new Error("must not block"); } }, () => (nextCalled = true));
    assert.equal(nextCalled, true);
  } finally {
    RateLimitHit.findOneAndUpdate = original;
    console.error = log;
  }
});

test("a broken counter store never blocks a real booking (the per-phone check fails open)", async () => {
  const originalFind = RateLimitHit.findOne;
  const originalUpdate = RateLimitHit.findOneAndUpdate;
  // The IP middleware runs first; let it count, break everything the per-phone code touches afterwards.
  RateLimitHit.findOne = () => ({ lean: () => Promise.reject(new Error("db down")) });
  let calls = 0;
  RateLimitHit.findOneAndUpdate = function (...args) {
    calls++;
    // 1st call = the per-IP middleware. Every later call (phone counters) fails.
    return calls === 1 ? originalUpdate.apply(this, args) : Promise.reject(new Error("db down"));
  };
  const log = console.error;
  console.error = () => {};
  try {
    const r = await book("9876500010", slot(0));
    assert.equal(r.status, 201, JSON.stringify(r.body));
  } finally {
    RateLimitHit.findOne = originalFind;
    RateLimitHit.findOneAndUpdate = originalUpdate;
    console.error = log;
  }
});
