/**
 * @file test/leads.test.js
 * @description Leads: a visitor who has NOT chosen a bundle (offer page) or who is just "interested" (landing page) leaves a
 * name, a phone number and an optional question. It is stored as a Lead (not a booking request) and listed for the salon
 * in the staff app under Bookings -> Leads. A request with a bundle chosen is unchanged: it goes to Website requests.
 *
 * Public POST /api/public/leads: validation, spam controls (honeypot, per-address and per-phone limits, duplicates),
 * nothing else created, the owner told once. Staff GET/PATCH /api/leads: permissions, filters, status and note, audited.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.META_WA_TOKEN = "";
process.env.PUBLIC_TOKEN_SECRET = "t";

let server, base, caller, ip, ipN = 0, phoneN = 0;
let Lead, Customer, Appointment, User, AuditLog, telegram, evictPermissionCache;
let sent = [];

before(async () => {
  await startDb();
  Lead = require("../models/Lead");
  Customer = require("../models/Customer");
  Appointment = require("../models/Appointment");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  telegram = require("../utils/telegram");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  telegram.isConfigured = () => true;
  telegram.sendMessage = async (chat, text) => {
    if (process.env.LEAD_TEST_TELEGRAM_FAILS) throw new Error("telegram is down");
    sent.push({ chat: String(chat), text });
    return { ok: true };
  };
  const app = express();
  app.use(express.json());
  app.use("/api/public", require("../routes/public"));
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/leads", require("../routes/leads"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
  sent = [];
  delete process.env.LEAD_TEST_TELEGRAM_FAILS;
  ip = `10.5.${Math.floor(++ipN / 250)}.${ipN % 250}`;
  phoneN = 0;
  await User.collection.insertOne({ name: "Owner", email: "o@t.example", role: "owner", isActive: true, permissions: [], telegramChatId: "555" });
  caller = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
});

const call = (method, p, body, headers = {}) =>
  fetch(base + p, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const phone = () => `98${String(76500000 + ++phoneN)}`;
const lead = (over = {}) => call("POST", "/public/leads", { name: "Asha Kaur", phone: phone(), query: "Do you do bridal trials?", source: "offer_page", offerSlug: "karwa", campaign: "karwa", ...over });
const as = async (role, permissions) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, name: "Reena", email: `${_id}@t.example`, role, isActive: true, permissions });
  evictPermissionCache(String(_id));
  caller = { userId: _id, name: "Reena", role };
};

// ─── the public form ────────────────────────────────────────────────────────

test("a lead is stored with name, phone, question and where it came from; it is NOT a booking request and makes no customer", async () => {
  const r = await lead({ phone: " +91 98765 00001 " });
  assert.equal(r.status, 201);
  assert.equal(r.body.duplicate, false);
  const l = await Lead.findOne().lean();
  assert.deepEqual([l.name, l.phone, l.query, l.status], ["Asha Kaur", "9876500001", "Do you do bridal trials?", "new"]);
  assert.deepEqual([l.source.channel, l.source.offerSlug, l.source.campaign], ["offer_page", "karwa", "karwa"]);
  assert.equal(await Appointment.countDocuments(), 0, "not a booking request");
  assert.equal(await Customer.countDocuments(), 0, "a lead is not a customer");
});

test("the question is optional; a landing-page lead needs no offer", async () => {
  const r = await call("POST", "/public/leads", { name: "Bina Rani", phone: phone(), source: "landing" });
  assert.equal(r.status, 201);
  const l = await Lead.findOne().lean();
  assert.deepEqual([l.query, l.source.channel, l.source.offerSlug], [null, "landing", null]);
});

test("validation: a real name, a 10-digit mobile, a question of at most 500 characters, a known source", async () => {
  for (const [over, why] of [[{ name: "A" }, "name too short"], [{ name: "Asha 123" }, "digits in a name"], [{ phone: "12345" }, "short phone"], [{ phone: "5876500000" }, "not a mobile"], [{ query: "x".repeat(501) }, "question too long"], [{ source: "somewhere" }, "unknown source"], [{ offerSlug: "Bad Slug!" }, "bad offer slug"]]) {
    const r = await lead(over);
    assert.equal(r.status, 400, why);
    assert.equal(r.body.error, "VALIDATION", why);
  }
  assert.equal(await Lead.countDocuments(), 0);
});

test("unknown fields are refused, and marketing consent cannot be smuggled in", async () => {
  for (const extra of [{ whatsappOptIn: true }, { status: "closed" }, { price: 1 }]) assert.equal((await lead(extra)).status, 400, JSON.stringify(extra));
  assert.equal(await Lead.countDocuments(), 0);
});

test("the honeypot: a bot that fills the hidden box is told 'sent' and nothing is stored or sent", async () => {
  const r = await lead({ website: "http://spam.example" });
  assert.equal(r.status, 201);
  assert.equal(await Lead.countDocuments(), 0);
  assert.equal(sent.length, 0);
});

test("the same person sending the same words again is one lead, not two", async () => {
  const p = phone();
  assert.equal((await lead({ phone: p })).status, 201);
  const again = await lead({ phone: `+91${p}` });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal(sent.length, 1, "the owner is told once");
});

test("limits: 3 new leads per phone a day and 10 per address an hour", async () => {
  const p = phone();
  for (let i = 0; i < 3; i++) assert.equal((await lead({ phone: p, query: `question ${i}` })).status, 201);
  assert.equal((await lead({ phone: p, query: "question 4" })).status, 429);
  ip = "10.99.0.1";
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await lead({ query: `q${i}` })).status);
  assert.equal(codes.slice(0, 10).every((c) => c === 201), true);
  assert.equal(codes[10], 429);
});

test("the owner gets one Telegram message with the name, number and question; a Telegram failure never loses the lead", async () => {
  await lead({ name: "Chitra Devi", phone: "9876500009", query: "Is there a group discount?" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, "555");
  assert.match(sent[0].text, /Chitra Devi/);
  assert.match(sent[0].text, /9876500009/);
  assert.match(sent[0].text, /group discount/);
  process.env.LEAD_TEST_TELEGRAM_FAILS = "1";
  const r = await lead({ name: "Disha Singh" });
  assert.equal(r.status, 201);
  assert.equal(await Lead.countDocuments(), 2);
});

// ─── the staff list ─────────────────────────────────────────────────────────

test("staff list: newest first with the columns the salon needs, and counts by status", async () => {
  await lead({ name: "Asha Kaur", query: "first" });
  await new Promise((r) => setTimeout(r, 5));
  await call("POST", "/public/leads", { name: "Bina Rani", phone: phone(), source: "landing" });
  const r = await call("GET", "/leads");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.leads.map((l) => l.name), ["Bina Rani", "Asha Kaur"]);
  const a = r.body.leads[1];
  assert.deepEqual([a.phone, a.query, a.status, a.source, a.offerSlug], ["9876500001", "first", "new", "offer_page", "karwa"]);
  assert.ok(a.id && a.createdAt);
  assert.deepEqual(r.body.counts, { new: 2, contacted: 0, closed: 0 });
});

test("staff list: filter by status, search by name, number or question, and page through", async () => {
  for (let i = 0; i < 5; i++) await lead({ name: `Client ${String.fromCharCode(65 + i)}${i}`.replace(/\d/g, "x"), query: i === 3 ? "needs a bridal trial" : null });
  const l = (await call("GET", "/leads")).body.leads;
  await call("PATCH", `/leads/${l[0].id}`, { status: "contacted" });
  assert.equal((await call("GET", "/leads?status=contacted")).body.leads.length, 1);
  assert.equal((await call("GET", "/leads?status=new")).body.leads.length, 4);
  assert.equal((await call("GET", "/leads?q=bridal")).body.leads.length, 1);
  assert.equal((await call("GET", `/leads?q=${l[1].phone}`)).body.leads.length, 1);
  const page = await call("GET", "/leads?limit=2&page=2");
  assert.equal(page.body.leads.length, 2);
  assert.equal(page.body.total, 5);
  assert.equal((await call("GET", "/leads?status=bogus")).status, 400);
});

test("staff update: set status and a note; who and when are kept; it is audited; bad input is refused", async () => {
  await lead();
  const id = (await call("GET", "/leads")).body.leads[0].id;
  await as("receptionist", ["bookings.manage", "bookings.view"]);
  const r = await call("PATCH", `/leads/${id}`, { status: "contacted", note: "Called, coming Friday" });
  assert.equal(r.status, 200);
  const l = await Lead.findById(id).lean();
  assert.deepEqual([l.status, l.note, l.handledBy], ["contacted", "Called, coming Friday", "Reena"]);
  assert.ok(l.handledAt);
  const log = await AuditLog.findOne({ action: "lead.updated" }).lean();
  assert.deepEqual([log.actorName, log.meta.from, log.meta.to], ["Reena", "new", "contacted"]);
  assert.equal((await call("PATCH", `/leads/${id}`, { status: "weird" })).status, 400);
  assert.equal((await call("PATCH", `/leads/${id}`, { note: "x".repeat(301) })).status, 400);
  assert.equal((await call("PATCH", `/leads/${new mongoose.Types.ObjectId()}`, { status: "closed" })).status, 404);
  assert.equal((await call("PATCH", "/leads/not-an-id", { status: "closed" })).status, 400);
});

test("permissions: bookings.view can read, bookings.manage can change, everyone else is refused; the owner always can", async () => {
  await lead();
  const id = (await call("GET", "/leads")).body.leads[0].id;
  await as("receptionist", ["bookings.view"]);
  assert.equal((await call("GET", "/leads")).status, 200);
  assert.equal((await call("PATCH", `/leads/${id}`, { status: "closed" })).status, 403);
  await as("receptionist", ["visit.create"]);
  assert.equal((await call("GET", "/leads")).status, 403);
  await as("artist", []);
  assert.equal((await call("GET", "/leads")).status, 403);
});
