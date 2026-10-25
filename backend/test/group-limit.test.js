/**
 * @file test/group-limit.test.js
 * @description The owner can set "people per booking" (`maxGuests`) from the staff app, and 1 switches
 * group bookings off (D68). Through the real app (index.js).
 *
 * What must hold:
 *   - PATCH /api/website/settings accepts a whole number 1 to 10 for `maxGuests`, audits the change and
 *     tells the customer site to refresh; anything else is refused; a save that does not touch it leaves it alone;
 *   - only someone with website.manage can change it;
 *   - at 1, every place a group is made refuses with a clear message (not "up to 1 people"), and one person
 *     still books exactly as before; at 2, two people are fine and three are refused;
 *   - bookings that already have several people stay fully manageable at 1.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub, server, base, cookie, shim, shimBase;
let Service, Artist, Appointment, SiteSettings, User, AuditLog, SlotLock, bookingToken, time, booking, evictPermissionCache;
let stubCalls = [];
let caller;
let DAY;
let ipN = 0;
let S;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      stubCalls.push({ url: req.url, headers: req.headers, body: raw });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/turnstile") return res.end(JSON.stringify({ success: new URLSearchParams(raw).get("response") === "good" }));
      return res.end(JSON.stringify({ ok: true, revalidated: true }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(process.env, {
    TURNSTILE_SECRET_KEY: "test-secret", TURNSTILE_VERIFY_URL: `${stubBase}/turnstile`, TELEGRAM_BOT_TOKEN: "", TELEGRAM_API_BASE: stubBase,
    META_WA_TOKEN: "", RAZORPAY_KEY_ID: "rzp_test_fake", RAZORPAY_KEY_SECRET: "k", PUBLIC_TOKEN_SECRET: "test-public-token-secret",
    CUSTOMER_SITE_URL: stubBase, REVALIDATE_SECRET: "reval-secret",
  });
  await startDb();
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
  Service = require("../models/Service");
  Artist = require("../models/Artist");
  Appointment = require("../models/Appointment");
  SlotLock = require("../models/SlotLock");
  SiteSettings = require("../models/SiteSettings");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  time = require("../utils/time");
  bookingToken = require("../utils/bookingToken");
  booking = require("../utils/booking");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  require("../utils/payments").setClientForTests({ orders: { create: async (o) => ({ id: `order_${Math.random().toString(36).slice(2)}`, amount: o.amount, currency: o.currency, notes: o.notes }) } });

  // A small app with the website router behind a stub session, to try other people's permissions.
  const s = express();
  s.use(express.json());
  s.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  s.use("/api/website", require("../routes/website"));
  await new Promise((r) => (shim = s.listen(0, r)));
  shimBase = `http://127.0.0.1:${shim.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => shim.close(r));
  await new Promise((r) => stub.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  stubCalls = [];
  let d = time.addDays(time.salonDate(), 3);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  DAY = d;
  const s = await SiteSettings.getSingleton();
  s.maxActiveBookingsPerPhone = 10;
  await s.save();
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true, audience: "her", displayCategory: "Hair" };
  S = await Service.create([
    { ...common, name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", durationMinutes: 45 },
    { ...common, name: "Blow-dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
  ]);
  await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female", onlineBookable: true, publicProfile: { slug: "mansi", displayName: "Mansi", visible: true } },
    { name: "Ravi", phone: "9888800002", commission: 30, gender: "male", onlineBookable: true, publicProfile: { slug: "ravi", displayName: "Ravi", visible: true } },
  ]);
  await User.collection.insertOne({ name: "Owner", email: "owner@test.example", passwordHash: await bcrypt.hash("Owner@12345", 4), role: "owner", isActive: true, permissions: [] });
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@test.example", password: "Owner@12345" }) });
  assert.equal(login.status, 200, "the owner signs in");
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
});

const patch = (body) => fetch(`${base}/website/settings`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getSettings = () => fetch(`${base}/website/settings`, { headers: { Cookie: cookie } }).then((r) => r.json());
const pub = (method, path, payload) =>
  fetch(`${base}/public${path}`, { method, headers: { "Content-Type": "application/json", "x-forwarded-for": `10.6.${Math.floor(++ipN / 250)}.${ipN % 250}` }, body: payload === undefined ? undefined : JSON.stringify(payload) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const ids = (...n) => n.map((i) => String(S[i]._id));
const at = (hhmm) => time.salonInstant(DAY, hhmm).toISOString();
let phoneN = 0;
const book = (guests) => {
  const phone = `98765${String(80000 + ++phoneN)}`;
  return pub("POST", "/appointments", { bookingToken: bookingToken.issue(phone).token, phone, name: "Asha Rani", guests, startAt: at("11:00"), payment: "full", policyAccepted: true, turnstileToken: "good" });
};
const people = (n) => Array.from({ length: n }, (_, i) => ({ for: "her", services: [ids(i % 2)[0]] }));
const GROUP_MSG = /Group bookings aren't available right now/;

// ─── the setting ────────────────────────────────────────────────────────────

test("the owner sets people per booking: saved, shown on the website's settings, audited, and the customer site is told to refresh", async () => {
  assert.equal((await getSettings()).maxGuests, 4, "starts at 4");
  const r = await patch({ maxGuests: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.maxGuests, 2);
  assert.equal((await SiteSettings.getSingleton()).maxGuests, 2);
  assert.equal((await pub("GET", "/site")).body.onlineBooking.maxGuests, 2, "the website sees it at once");
  const log = await AuditLog.findOne({ action: "website.settings_changed" }).lean();
  assert.deepEqual(log.meta.changes.maxGuests, { from: 4, to: 2 });
  const refresh = stubCalls.find((c) => c.url === "/api/revalidate");
  assert.ok(refresh, "the customer site was asked to refresh");
  assert.deepEqual(JSON.parse(refresh.body).tags, ["site"]);
});

test("only a whole number from 1 to 10 is accepted", async () => {
  for (const bad of [0, 11, -1, 2.5, "two", null, ""]) {
    const r = await patch({ maxGuests: bad });
    assert.equal(r.status, 400, `maxGuests=${JSON.stringify(bad)}`);
  }
  assert.equal((await SiteSettings.getSingleton()).maxGuests, 4, "nothing changed");
  assert.equal((await patch({ maxGuests: 1 })).status, 200);
  assert.equal((await patch({ maxGuests: 10 })).status, 200);
  assert.equal((await patch({ maxGuests: "3" })).body.maxGuests, 3, "a number typed in a box arrives as text");
});

test("saving the whole settings form without touching it leaves people per booking alone and records no change to it", async () => {
  const form = await getSettings();
  await patch({ maxGuests: 3 });
  await AuditLog.deleteMany({});
  stubCalls = [];
  const again = await getSettings();
  const r = await patch(again);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await SiteSettings.getSingleton()).maxGuests, 3);
  // (The first full save also stores the starting gallery, hero and owner text: that is older behaviour.)
  const rows = await AuditLog.find({ action: "website.settings_changed" }).lean();
  assert.ok(rows.every((r) => !("maxGuests" in r.meta.changes)), "people per booking is not recorded as changed");
  assert.ok(form.maxGuests === 4);
});

test("only someone allowed to edit the website can change it", async () => {
  const u = await User.collection.insertOne({ name: "Reena", email: "reena@test.example", role: "receptionist", isActive: true, permissions: ["bookings.view"] });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name: "Reena", role: "receptionist" };
  const denied = await fetch(`${shimBase}/website/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxGuests: 1 }) });
  assert.equal(denied.status, 403);
  assert.equal((await SiteSettings.getSingleton()).maxGuests, 4);
});

// ─── 1 switches groups off ──────────────────────────────────────────────────

test("at 1: every way to make a group is refused with a clear message, and one person books as before", async () => {
  await patch({ maxGuests: 1 });
  const a = await pub("GET", `/availability?date=${DAY}&g=${ids(0)}&g=${ids(1)}`);
  assert.equal(a.status, 400);
  assert.match(a.body.message, GROUP_MSG);
  const q = await pub("POST", "/quote", { guests: people(2) });
  assert.equal(q.status, 400);
  assert.match(q.body.message, GROUP_MSG);
  const b = await book(people(2));
  assert.equal(b.status, 400);
  assert.match(b.body.message, GROUP_MSG);
  const w = await pub("POST", "/requests/wa", { services: ids(0), date: DAY, time: "11:00", name: "Asha Kaur", phone: "9876599991", people: 2 });
  assert.equal(w.status, 400);
  assert.match(w.body.message, GROUP_MSG);
  assert.equal(await Appointment.countDocuments(), 0, "nothing was made");
  for (const r of [a, q, b, w]) assert.doesNotMatch(r.body.message, /1 people/);

  // One person is exactly as before.
  assert.equal((await pub("GET", `/availability?date=${DAY}&g=${ids(0)}`)).status, 200);
  assert.equal((await pub("POST", "/quote", { guests: people(1) })).status, 200);
  assert.equal((await book(people(1))).status, 201);
  const one = await pub("POST", "/requests/wa", { services: ids(0), date: DAY, time: "15:00", name: "Asha Kaur", phone: "9876599992" });
  assert.equal(one.status, 201, JSON.stringify(one.body));
});

test("the website is told: at 1 it hides the group controls", async () => {
  await patch({ maxGuests: 1 });
  assert.equal((await pub("GET", "/site")).body.onlineBooking.maxGuests, 1);
});

test("at 2: two people are fine and three are refused with the number in the message", async () => {
  await patch({ maxGuests: 2 });
  assert.equal((await book(people(2))).status, 201);
  const three = await book(people(3));
  assert.equal(three.status, 400);
  assert.match(three.body.message, /Book up to 2 people at a time\./);
  assert.equal((await pub("POST", "/requests/wa", { services: ids(0), date: DAY, time: "16:00", name: "Asha Kaur", phone: "9876599993", people: 3 })).status, 400);
});

test("raising it again turns groups back on at once", async () => {
  await patch({ maxGuests: 1 });
  assert.equal((await book(people(2))).status, 400);
  await patch({ maxGuests: 4 });
  assert.equal((await book(people(2))).status, 201);
});

test("a booking that already has several people stays fully manageable at 1", async () => {
  const b = await book(people(2));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const a = await Appointment.findOne({ ref: b.body.booking.ref });
  await Appointment.updateOne({ _id: a._id }, { $set: { status: "confirmed", "deposit.status": "paid" } });
  await patch({ maxGuests: 1 });
  const moved = await booking.moveBooking(a._id, { startAt: new Date(at("15:00")) });
  assert.equal(moved.ok, true);
  const otherArtist = (await Artist.find({ _id: { $ne: a.guests[0].items[0].artistId } }).lean())[0];
  const changed = await booking.changeGuestArtist(a._id, "g2", String(otherArtist._id));
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal((await SlotLock.find({ appointmentId: a._id })).length > 0, true);
});
