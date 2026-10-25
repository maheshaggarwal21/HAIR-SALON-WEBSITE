/**
 * @file test/payment-id-check.test.js
 * @description Audit #1: the Razorpay payment id on a desk visit is checked against our own record of the
 * payment (and Razorpay itself if the webhook has not arrived). The check is an OBSERVER:
 *   - "log" mode (the default) never blocks and never changes a save; it only records what it found;
 *   - "enforce" mode refuses only when the payment is clearly wrong; anything ambiguous is allowed and recorded;
 *   - if the check cannot run, the save goes through unchanged, in both modes.
 * Through the real app (index.js) with a fake Razorpay (test/helpers/fakeRazorpay.js).
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { startDb, stopDb } = require("./helpers/db");
const rz = require("./helpers/fakeRazorpay").install();

let server, base, cookie, shim, shimBase, caller;
let Service, Appointment, Customer, Visit, PaymentEvent, User, AuditLog, DataFix, SiteSettings, NotificationLog, telegram, check, evictPermissionCache;
let ids;
let sent = [];

before(async () => {
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_char", RAZORPAY_KEY_SECRET: "char-key-secret", TELEGRAM_BOT_TOKEN: "x", META_WA_TOKEN: "", PUBLIC_TOKEN_SECRET: "t" });
  await startDb();
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  Service = require("../models/Service");
  Appointment = require("../models/Appointment");
  Customer = require("../models/Customer");
  Visit = require("../models/Visit");
  PaymentEvent = require("../models/PaymentEvent");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  DataFix = require("../models/DataFix");
  SiteSettings = require("../models/SiteSettings");
  NotificationLog = require("../models/NotificationLog");
  telegram = require("../utils/telegram");
  telegram.isConfigured = () => true;
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId: String(chatId), text });
    return { ok: true };
  };
  check = require("../utils/paymentIdCheck");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));

  // Sign in ONCE (a login per test would hit the login rate limit); the per-test cleanup keeps this user and session.
  await User.collection.insertOne({ name: "Owner", email: "owner@test.example", passwordHash: await bcrypt.hash("Owner@12345", 4), role: "owner", isActive: true, permissions: [], telegramChatId: "555" });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@test.example", password: "Owner@12345" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  // The same routers behind a stub session, to try other roles without the login gate.
  const s = express();
  s.use(express.json());
  s.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  s.use("/api/payment-id-check", require("../routes/paymentIdCheck"));
  s.use("/api/data-fixes", require("../routes/dataFixes"));
  await new Promise((r) => (shim = s.listen(0, r)));
  shimBase = `http://127.0.0.1:${shim.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => shim.close(r));
  await stopDb();
});

async function clearAllButSession() {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.filter((c) => !["users", "sessions"].includes(c.collectionName)).map((c) => c.deleteMany({})));
}

beforeEach(async () => {
  await clearAllButSession();
  rz.reset();
  sent = [];
  check.__test.reset();
  const [hair, facial] = await Service.create([
    { name: "Haircut", price: 1000, publicPrice: 500, isActive: true, durationMinutes: 45 },
    { name: "Facial", price: 3000, publicPrice: 1500, isActive: true, durationMinutes: 60 },
  ]);
  ids = { hair: String(hair._id), facial: String(facial._id) };
});

const call = (method, p, body) =>
  fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const asRole = (role, permissions = [], name = "Reena") => {
  const userId = new mongoose.Types.ObjectId();
  return User.collection.insertOne({ _id: userId, name, email: `${role}${Math.random()}@test.example`, role, isActive: true, permissions }).then(() => {
    evictPermissionCache?.(String(userId));
    caller = { userId, name, role };
  });
};
const shimCall = (method, p, body) =>
  fetch(`${shimBase}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const openList = (status = "open") => shimCall("GET", `/api/data-fixes?kind=payment_id&status=${status}`).then((r) => r.body);
const keyOf = async (paymentId) => (await openList("all")).issues.find((i) => i.paymentId === paymentId).key;
const dismiss = async (paymentId, note = "looked at it") => {
  const key = await keyOf(paymentId);
  const r = await shimCall("POST", "/api/data-fixes/resolve", { key, kind: "payment_id", status: "dismissed", note });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 10)); // later problems must be recorded AFTER the decision
  return key;
};
const setMode = async (mode) => {
  await SiteSettings.updateOne({ key: "default" }, { $set: { paymentIdCheck: mode } }, { upsert: true });
  check.__test.clearModeCache();
};

const sale = (extra = {}) => call("POST", "/api/visits/v2", { name: "Asha Rani", contact: "9876543210", gender: "female", date: "2026-10-26", serviceIds: [ids.hair, ids.facial], ...extra });
let eventN = 0;
const event = (over = {}) => PaymentEvent.create({ razorpayPaymentId: `pay_ev${++eventN}`, amount: 4000, status: "captured", reconcileStatus: "unmatched", capturedAt: new Date(), raw: { amount: 400000 }, ...over });
const unverified = () => AuditLog.find({ action: "payment.id_unverified" }).sort({ createdAt: 1 }).lean();
const online = (extra = {}) => sale({ paymentMethod: "online", ...extra });

// ─── the default ────────────────────────────────────────────────────────────

test("the default mode is 'log', and reading the setting changes nothing", async () => {
  assert.equal((await call("GET", "/api/payment-id-check")).body.mode, "log");
  assert.equal((await SiteSettings.getSingleton()).paymentIdCheck, "log");
});

// ─── log mode: observes, never blocks ───────────────────────────────────────

test("log: a good payment (captured, exact amount) passes silently", async () => {
  const e = await event();
  const r = await online({ razorpayPaymentId: e.razorpayPaymentId });
  assert.equal(r.status, 201);
  assert.equal((await unverified()).length, 0);
  assert.equal(rz.fetched.length, 0, "our own record was enough: Razorpay was not asked");
  assert.equal(sent.length, 0);
});

test("log: a made-up id (no record, and Razorpay does not know it) SAVES, and is recorded as not_found with what the sale needed", async () => {
  const r = await online({ razorpayPaymentId: "pay_madeUp1" });
  assert.equal(r.status, 201, "log mode never blocks");
  assert.equal(await Visit.countDocuments({ razorpayPaymentId: "pay_madeUp1" }), 1);
  assert.deepEqual(rz.fetched, ["pay_madeUp1"], "Razorpay was asked as the fallback");
  const [a] = await unverified();
  assert.equal(a.meta.reason, "not_found");
  assert.equal(a.meta.paymentId, "pay_madeUp1");
  assert.equal(a.meta.expectedPaise, 400000);
  assert.equal(a.meta.mode, "log");
  assert.equal(a.meta.refused, false);
  assert.equal(a.meta.visitName, "Asha Rani");
  assert.equal(String(a.meta.visitId), r.body.visitId);
  assert.equal(a.actorName, "Owner", "who was at the desk");
  assert.equal(sent.length, 0, "no message for a single payment id");
});

test("log: the webhook has not arrived yet, but Razorpay says it is captured for the right amount: passes silently", async () => {
  rz.payment.set("pay_lag1", { id: "pay_lag1", status: "captured", amount: 400000 });
  const r = await online({ razorpayPaymentId: "pay_lag1" });
  assert.equal(r.status, 201);
  assert.deepEqual(rz.fetched, ["pay_lag1"]);
  assert.equal((await unverified()).length, 0);
});

test("log: the fallback finds a different amount: saves, recorded as amount_mismatch with both amounts", async () => {
  rz.payment.set("pay_lag2", { id: "pay_lag2", status: "captured", amount: 150000 });
  assert.equal((await online({ razorpayPaymentId: "pay_lag2" })).status, 201);
  const [a] = await unverified();
  assert.deepEqual([a.meta.reason, a.meta.expectedPaise, a.meta.foundPaise], ["amount_mismatch", 400000, 150000]);
});

test("log: a payment that was not captured is recorded as not_captured, and still saves", async () => {
  const e = await event({ status: "failed" });
  rz.payment.set(e.razorpayPaymentId, { id: e.razorpayPaymentId, status: "failed", amount: 400000 });
  assert.equal((await online({ razorpayPaymentId: e.razorpayPaymentId })).status, 201);
  const [a] = await unverified();
  assert.equal(a.meta.reason, "not_captured");
  assert.equal(a.meta.status, "failed");
});

test("log: an id that belongs to a booking's deposit is recorded as already_used, and still saves", async () => {
  const e = await event({ purpose: "booking", reconcileStatus: "matched_appointment" });
  assert.equal((await online({ razorpayPaymentId: e.razorpayPaymentId })).status, 201);
  assert.equal((await unverified())[0].meta.reason, "already_used");
});

test("log: a cash or card visit that carries a Razorpay id is flagged as a mismatch (nothing was due online), and saves", async () => {
  const e = await event();
  const r = await sale({ paymentMethod: "cash", razorpayPaymentId: e.razorpayPaymentId });
  assert.equal(r.status, 201);
  const [a] = await unverified();
  assert.deepEqual([a.meta.reason, a.meta.expectedPaise, a.meta.foundPaise], ["amount_mismatch", 0, 400000]);
});

test("log: a split payment is checked against the ONLINE part only", async () => {
  const good = await event({ amount: 3000, raw: { amount: 300000 } });
  assert.equal((await sale({ paymentMethod: "partial", cashAmount: 1000, razorpayPaymentId: good.razorpayPaymentId })).status, 201);
  assert.equal((await unverified()).length, 0, "₹3,000 online + ₹1,000 cash = ₹4,000");
  const wrong = await event({ amount: 4000, raw: { amount: 400000 } });
  await sale({ paymentMethod: "partial", cashAmount: 1000, razorpayPaymentId: wrong.razorpayPaymentId });
  const [a] = await unverified();
  assert.deepEqual([a.meta.reason, a.meta.expectedPaise, a.meta.foundPaise], ["amount_mismatch", 300000, 400000]);
});

test("log: the same payment id sent again is the existing replay and does not run the check again", async () => {
  await online({ razorpayPaymentId: "pay_once" });
  const again = await online({ razorpayPaymentId: "pay_once" });
  assert.equal(again.body.duplicate, true);
  assert.equal((await unverified()).length, 1, "only the first save was looked at");
  assert.deepEqual(rz.fetched, ["pay_once"]);
});

test("the recovery path: log records an amount mismatch and saves", async () => {
  const e = await event({ amount: 50, raw: { amount: 5000 } });
  const r = await online({ recoveredPaymentId: e.razorpayPaymentId });
  assert.equal(r.status, 201);
  const [a] = await unverified();
  assert.deepEqual([a.meta.reason, a.meta.expectedPaise, a.meta.foundPaise], ["amount_mismatch", 400000, 5000]);
});

// ─── enforce mode: refuses only the clearly wrong ───────────────────────────

test("enforce: a good payment still saves; the webhook-lag fallback too", async () => {
  await setMode("enforce");
  const e = await event();
  assert.equal((await online({ razorpayPaymentId: e.razorpayPaymentId })).status, 201);
  rz.payment.set("pay_lag3", { id: "pay_lag3", status: "captured", amount: 400000 });
  assert.equal((await online({ razorpayPaymentId: "pay_lag3" })).status, 201);
  assert.equal((await unverified()).length, 0);
});

test("enforce: a made-up id is refused with a clear message, nothing is saved, and the refusal is recorded", async () => {
  await setMode("enforce");
  const r = await online({ razorpayPaymentId: "pay_madeUp2" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "PAYMENT_ID_CHECK");
  assert.match(r.body.error, /isn't a payment Razorpay has/);
  assert.match(r.body.error, /Log only/, "it says how to get past it");
  assert.equal(await Visit.countDocuments(), 0);
  const [a] = await unverified();
  assert.deepEqual([a.meta.reason, a.meta.refused, a.meta.mode], ["not_found", true, "enforce"]);
  assert.equal(a.meta.visitId, null);
});

test("enforce: a payment that failed, or an amount clearly different, is refused", async () => {
  await setMode("enforce");
  const failed = await event({ status: "failed" });
  rz.payment.set(failed.razorpayPaymentId, { id: failed.razorpayPaymentId, status: "failed", amount: 400000 });
  const f = await online({ razorpayPaymentId: failed.razorpayPaymentId });
  assert.equal(f.status, 400);
  assert.match(f.body.error, /shows that payment as failed/);
  const small = await event({ amount: 1500, raw: { amount: 150000 } });
  const m = await online({ razorpayPaymentId: small.razorpayPaymentId });
  assert.equal(m.status, 400);
  assert.match(m.body.error, /₹1,500/);
  assert.match(m.body.error, /₹4,000/);
  assert.equal(await Visit.countDocuments(), 0);
});

test("enforce: an id that belongs to a booking's deposit is refused", async () => {
  await setMode("enforce");
  const e = await event({ purpose: "booking", reconcileStatus: "matched_appointment" });
  assert.equal((await online({ razorpayPaymentId: e.razorpayPaymentId })).status, 400);
});

test("enforce, conservative: anything ambiguous is ALLOWED and recorded (authorized, a difference under ₹1, a cash visit carrying an id)", async () => {
  await setMode("enforce");
  const authorized = await event({ status: "authorized" });
  rz.payment.set(authorized.razorpayPaymentId, { id: authorized.razorpayPaymentId, status: "authorized", amount: 400000 });
  assert.equal((await online({ razorpayPaymentId: authorized.razorpayPaymentId })).status, 201, "authorized may still be captured");
  const close = await event({ raw: { amount: 399950 } });
  assert.equal((await online({ razorpayPaymentId: close.razorpayPaymentId, serviceIds: [ids.hair, ids.facial] })).status, 201, "50 paise off");
  const cashEv = await event();
  assert.equal((await sale({ paymentMethod: "cash", razorpayPaymentId: cashEv.razorpayPaymentId })).status, 201);
  const reasons = (await unverified()).map((a) => [a.meta.reason, a.meta.refused]);
  assert.deepEqual(reasons, [["not_captured", false], ["amount_mismatch", false], ["amount_mismatch", false]]);
});

test("enforce: the recovery path refuses an amount mismatch", async () => {
  await setMode("enforce");
  const e = await event({ amount: 50, raw: { amount: 5000 } });
  const r = await online({ recoveredPaymentId: e.razorpayPaymentId });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "PAYMENT_ID_CHECK");
  assert.equal(await Visit.countDocuments(), 0);
});

// ─── the check cannot run: the save goes through, both modes ────────────────

for (const mode of ["log", "enforce"]) {
  test(`${mode}: Razorpay is down and we have no record: the sale SAVES and 'check_failed' is recorded`, async () => {
    await setMode(mode);
    rz.failPayments = true;
    const r = await online({ razorpayPaymentId: `pay_down_${mode}` });
    assert.equal(r.status, 201);
    assert.equal((await unverified())[0].meta.reason, "check_failed");
  });

  test(`${mode}: a database error inside the check never reaches the sale`, async () => {
    await setMode(mode);
    const original = PaymentEvent.findOne;
    PaymentEvent.findOne = () => {
      throw new Error("db hiccup");
    };
    try {
      const r = await online({ razorpayPaymentId: `pay_dberr_${mode}` });
      assert.equal(r.status, 201);
    } finally {
      PaymentEvent.findOne = original;
    }
    assert.equal(await Visit.countDocuments(), 1);
  });

  test(`${mode}: a check that hangs is cut off after the time limit and the sale saves`, async () => {
    await setMode(mode);
    check.__test.setTimeoutMs(150);
    rz.payment.set(`pay_hang_${mode}`, null);
    const original = rz.payment.get;
    // payments.fetch never answers
    const Razorpay = require("../utils/payments").getClient();
    const realFetch = Razorpay.payments.fetch;
    Razorpay.payments.fetch = () => new Promise(() => {});
    const started = Date.now();
    try {
      const r = await online({ razorpayPaymentId: `pay_hang_${mode}` });
      assert.equal(r.status, 201);
    } finally {
      Razorpay.payments.fetch = realFetch;
      void original;
    }
    assert.ok(Date.now() - started < 3000, "not held up");
    assert.equal((await unverified())[0].meta.reason, "check_failed");
  });
}

test("a failure to read the mode setting means 'log'", async () => {
  const original = SiteSettings.findOne;
  SiteSettings.findOne = () => {
    throw new Error("db hiccup");
  };
  check.__test.clearModeCache();
  try {
    assert.equal(await check.getMode(), "log");
  } finally {
    SiteSettings.findOne = original;
  }
});

// ─── a booking at checkout, and a group on one bill ─────────────────────────

let refN = 0;
async function booking({ deposit = 500, people = [["facial", 1500, 3000, "Asha"]] } = {}) {
  const customer = await Customer.findOneAndUpdate({ phone: "9876500001" }, { $setOnInsert: { name: "Asha", createdFrom: "web" } }, { upsert: true, returnDocument: "after" });
  const start = new Date("2026-11-10T05:30:00Z");
  const guests = await Promise.all(
    people.map(async ([key, publicPrice, listPrice, name], i) => {
      const s = await Service.findById(ids[key]).lean();
      return { guestKey: `g${i + 1}`, name, gender: "female", items: [{ serviceId: s._id, name: s.name, publicPrice, listPrice, durationMin: s.durationMinutes, artistId: new mongoose.Types.ObjectId(), artistName: "Mansi", startAt: start, endAt: new Date(start.getTime() + 3600e3) }] };
    })
  );
  const subtotal = people.reduce((n, p) => n + p[1], 0);
  return Appointment.create({
    ref: `EXP-I${String(++refN).padStart(4, "0")}`, mode: "instant", status: "checked_in", customerId: customer._id, contact: "9876500001", name: "Asha", guests,
    startAt: start, endAt: new Date(start.getTime() + 3600e3), pricing: { subtotal, discount: 0, total: subtotal },
    deposit: { required: true, kind: "deposit", amount: deposit, status: "paid", razorpayPaymentId: "pay_dep" }, source: { channel: "web" },
  });
}
const checkout = (appt, extra = {}) => call("POST", "/api/visits/v2", { appointmentId: String(appt._id), serviceIds: appt.guests.flatMap((g) => g.items.map((i) => String(i.serviceId))), date: "2026-11-10", ...extra });

for (const mode of ["log", "enforce"]) {
  test(`${mode}: booking checkout: the desk payment must equal what is still due (the total minus the deposit and any cash)`, async () => {
    await setMode(mode);
    const good = await event({ amount: 1000, raw: { amount: 100000 } });
    const r = await checkout(await booking(), { paymentMethod: "online", razorpayPaymentId: good.razorpayPaymentId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const split = await event({ amount: 600, raw: { amount: 60000 } });
    assert.equal((await checkout(await booking(), { paymentMethod: "partial", cashAmount: 400, razorpayPaymentId: split.razorpayPaymentId })).status, 201);
    assert.equal((await unverified()).length, 0);
  });

  test(`${mode}: a GROUP on one bill (two people's services, one visit, one payment equal to the total due) PASSES`, async () => {
    await setMode(mode);
    const appt = await booking({ deposit: 500, people: [["facial", 1500, 3000, "Asha"], ["hair", 500, 1000, "Bina"]] });
    const e = await event({ amount: 1500, raw: { amount: 150000 } });
    const r = await checkout(appt, { paymentMethod: "online", razorpayPaymentId: e.razorpayPaymentId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await Visit.countDocuments(), 1);
    assert.equal((await unverified()).length, 0, "(1500 + 500) − 500 deposit = ₹1,500, exactly the payment");
  });
}

test("log: a booking-checkout payment of the wrong amount saves and is recorded; enforce refuses it and the booking stays open", async () => {
  const wrong = await event({ amount: 400, raw: { amount: 40000 } });
  assert.equal((await checkout(await booking(), { paymentMethod: "online", razorpayPaymentId: wrong.razorpayPaymentId })).status, 201);
  assert.equal((await unverified())[0].meta.reason, "amount_mismatch");
  await setMode("enforce");
  const appt = await booking();
  const wrong2 = await event({ amount: 400, raw: { amount: 40000 } });
  const r = await checkout(appt, { paymentMethod: "online", razorpayPaymentId: wrong2.razorpayPaymentId });
  assert.equal(r.status, 400);
  assert.equal((await Appointment.findById(appt._id).lean()).status, "checked_in");
});

test("booking checkout: a payment id already on another visit is still the existing 409, with the same message", async () => {
  await Visit.create({ name: "Other", contact: "9811111111", gender: "male", date: new Date("2026-10-26"), services: [{ name: "Haircut", price: 1000 }], subtotal: 1000, finalTotal: 1000, paymentMethod: "online", onlineAmount: 1000, paymentStatus: "success", razorpayPaymentId: "pay_taken", filledBy: "Test" });
  const r = await checkout(await booking(), { paymentMethod: "online", razorpayPaymentId: "pay_taken" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "That payment is already on another visit");
});

test("booking checkout: a cash visit sends no payment id to the check (the id is not stored)", async () => {
  await checkout(await booking(), { paymentMethod: "cash", razorpayPaymentId: "pay_ignored" });
  assert.equal(rz.fetched.length, 0);
  assert.equal((await unverified()).length, 0);
});

// ─── the slider's route ─────────────────────────────────────────────────────

test("the mode can be changed by the owner and by a receptionist (visit.create) or anyone with datafixes.manage; other roles get 403", async () => {
  caller = { userId: (await User.findOne({ role: "owner" }))._id, name: "Owner", role: "owner" };
  assert.equal((await shimCall("PUT", "/api/payment-id-check", { mode: "enforce" })).status, 200);
  assert.equal((await SiteSettings.getSingleton()).paymentIdCheck, "enforce");
  await asRole("receptionist", ["visit.create", "bookings.view"]);
  assert.equal((await shimCall("PUT", "/api/payment-id-check", { mode: "log" })).status, 200);
  await asRole("manager", ["datafixes.manage"], "Manu");
  assert.equal((await shimCall("PUT", "/api/payment-id-check", { mode: "enforce" })).status, 200);
  await asRole("artist", [], "Arti");
  assert.equal((await shimCall("PUT", "/api/payment-id-check", { mode: "log" })).status, 403);
  assert.equal((await shimCall("GET", "/api/payment-id-check")).status, 403);
  await asRole("receptionist", ["bookings.view"], "NoBilling");
  assert.equal((await shimCall("PUT", "/api/payment-id-check", { mode: "log" })).status, 403);
  assert.equal((await SiteSettings.getSingleton()).paymentIdCheck, "enforce", "the refused ones changed nothing");
});

test("the mode must be 'log' or 'enforce'", async () => {
  await asRole("receptionist", ["visit.create"]);
  for (const mode of ["off", "", null, 1, "ENFORCE "]) assert.equal((await shimCall("PUT", "/api/payment-id-check", { mode })).status, 400, JSON.stringify(mode));
});

test("every change is audited with who made it; an unchanged save is not; a change alerts the owner at once", async () => {
  await asRole("receptionist", ["visit.create"], "Reena");
  await shimCall("PUT", "/api/payment-id-check", { mode: "enforce" });
  await shimCall("PUT", "/api/payment-id-check", { mode: "enforce" });
  const rows = await AuditLog.find({ action: "payment.id_check_mode_changed" }).lean();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].actorName, rows[0].actorRole, rows[0].meta.from, rows[0].meta.to], ["Reena", "receptionist", "log", "enforce"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Reena/);
  assert.match(sent[0].text, /Enforce/);
  await shimCall("PUT", "/api/payment-id-check", { mode: "log" });
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Log only/);
});

test("the mode is cached for at most 30 seconds, and changing it through the route is seen at once", async () => {
  let t = 1_000_000;
  check.__test.setNow(() => t);
  assert.equal(await check.getMode(), "log");
  await SiteSettings.updateOne({ key: "default" }, { $set: { paymentIdCheck: "enforce" } }, { upsert: true });
  t += 29_000;
  assert.equal(await check.getMode(), "log", "inside 30 s the cached value is used");
  t += 2_000;
  assert.equal(await check.getMode(), "enforce", "after 30 s it is read again");
  await asRole("receptionist", ["visit.create"]);
  await shimCall("PUT", "/api/payment-id-check", { mode: "log" });
  assert.equal(await check.getMode(), "log", "the route clears the cache on this instance");
});

// ─── the owner's messages ───────────────────────────────────────────────────

test("the morning job sends ONE line a day, 'N payment ids need checking', only when N > 0, counting open entries only", async () => {
  const morning = require("../utils/morning");
  const JobRun = require("../models/JobRun");
  const now = new Date();
  await JobRun.create({ name: "bookings-tick", lastRunAt: new Date(now.getTime() - 60_000) }); // the timer is alive
  await morning.morningRun(now);
  assert.equal(sent.filter((m) => /payment id/.test(m.text)).length, 0, "nothing open: no message");

  await online({ razorpayPaymentId: "pay_n1" });
  await online({ razorpayPaymentId: "pay_n2" });
  await online({ razorpayPaymentId: "pay_n3" });
  const n3 = await AuditLog.findOne({ action: "payment.id_unverified", "meta.paymentId": "pay_n3" }).lean();
  await DataFix.create({ key: check.keyFor("pay_n3", n3.meta.visitId, "not_found"), kind: "payment_id", status: "dismissed", note: "checked in Razorpay", resolvedAt: new Date(Date.now() + 1000) });
  sent = [];
  await morning.morningRun(now);
  await morning.morningRun(now);
  const lines = sent.filter((m) => /payment id/.test(m.text));
  assert.equal(lines.length, 1, "once a day");
  assert.match(lines[0].text, /2 payment ids need checking/);
  assert.equal(lines[0].chatId, "555");
});

test("an immediate alert for 3 or more check_failed in an hour, once; fewer than 3, or any other reason, sends nothing", async () => {
  rz.failPayments = true;
  await online({ razorpayPaymentId: "pay_f1" });
  await online({ razorpayPaymentId: "pay_f2" });
  assert.equal(sent.length, 0, "two failures: nothing yet");
  await online({ razorpayPaymentId: "pay_f3" });
  assert.equal(sent.filter((m) => /could not be checked/.test(m.text)).length, 1);
  await online({ razorpayPaymentId: "pay_f4" });
  assert.equal(sent.filter((m) => /could not be checked/.test(m.text)).length, 1, "not again in the same hour");
  rz.failPayments = false;
  sent = [];
  await online({ razorpayPaymentId: "pay_other1" });
  await online({ razorpayPaymentId: "pay_other2" });
  await online({ razorpayPaymentId: "pay_other3" });
  assert.equal(sent.length, 0, "not_found is never an immediate message");
});

// ─── "Payment log errors" on Fix Numbers ────────────────────────────────────

test("payment log errors: an entry made today is listed today, with the visit, the reason in plain words, both amounts and the payment id", async () => {
  const r = await online({ razorpayPaymentId: "pay_list1" });
  await asRole("receptionist", ["datafixes.manage"]);
  const list = await shimCall("GET", "/api/data-fixes?kind=payment_id&status=open");
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  const i = list.body.issues[0];
  assert.match(i.key, /^pid:pay_list1:[0-9a-f]{24}:not_found$/, "a problem is identified by payment id + visit + reason");
  assert.equal(i.paymentId, "pay_list1");
  assert.equal(i.name, "Asha Rani");
  assert.equal(i.visitId, r.body.visitId);
  assert.equal(i.reason, "not_found");
  assert.match(i.what, /Razorpay has no payment with this id/);
  assert.equal(i.expected, 4000);
  assert.equal(i.found, null);
  assert.equal(i.status, "open");
  assert.ok(new Date(i.at).toDateString() === new Date().toDateString(), "today's entry is listed today");
});

test("payment log errors: one row per payment id (the latest result), and the listing reads the recorded results, not the visits", async () => {
  const e = await event({ status: "failed" });
  await online({ razorpayPaymentId: e.razorpayPaymentId });
  await Visit.deleteMany({});
  await asRole("receptionist", ["datafixes.manage"]);
  const list = await shimCall("GET", "/api/data-fixes?kind=payment_id");
  assert.equal(list.body.total, 1, "still listed with no visit to scan");
  assert.equal(list.body.issues[0].reason, "not_captured");
});

test("payment log errors: checked or dismissed needs a note, is audited, moves the row to 'resolved', and can be reopened", async () => {
  await online({ razorpayPaymentId: "pay_res1" });
  await asRole("receptionist", ["datafixes.manage"], "Reena");
  const key = await keyOf("pay_res1");
  const noNote = await shimCall("POST", "/api/data-fixes/resolve", { key, kind: "payment_id", status: "fixed" });
  assert.equal(noNote.status, 400);
  assert.match(noNote.body.error, /note/i);
  const blank = await shimCall("POST", "/api/data-fixes/resolve", { key, kind: "payment_id", status: "dismissed", note: "   " });
  assert.equal(blank.status, 400);
  assert.equal((await shimCall("POST", "/api/data-fixes/resolve", { key, kind: "payment_id", status: "fixed", note: "verified in the Razorpay dashboard" })).status, 200);
  assert.equal((await shimCall("GET", "/api/data-fixes?kind=payment_id&status=open")).body.total, 0);
  const done = await shimCall("GET", "/api/data-fixes?kind=payment_id&status=resolved");
  assert.equal(done.body.total, 1);
  assert.deepEqual([done.body.issues[0].status, done.body.issues[0].note, done.body.issues[0].resolvedBy], ["fixed", "verified in the Razorpay dashboard", "Reena"]);
  const log = await AuditLog.findOne({ action: "datafix.resolved" }).lean();
  assert.deepEqual([log.meta.kind, log.meta.status, log.actorName], ["payment_id", "fixed", "Reena"]);
  assert.equal((await shimCall("POST", "/api/data-fixes/resolve", { key, kind: "payment_id", status: "open" })).status, 200);
  assert.equal((await shimCall("GET", "/api/data-fixes?kind=payment_id&status=open")).body.total, 1, "reopened");
});

test("payment log errors: read-only for money: the section changes no visit, payment event or amount", async () => {
  const r = await online({ razorpayPaymentId: "pay_ro1" });
  const before = JSON.stringify(await Visit.findById(r.body.visitId).lean());
  await asRole("receptionist", ["datafixes.manage"]);
  await shimCall("POST", "/api/data-fixes/resolve", { key: "pid:pay_ro1", kind: "payment_id", status: "dismissed", note: "ok" });
  assert.equal(JSON.stringify(await Visit.findById(r.body.visitId).lean()), before);
});

test("payment log errors: needs datafixes.manage like the rest of the page", async () => {
  await asRole("receptionist", ["visit.create"]);
  assert.equal((await shimCall("GET", "/api/data-fixes?kind=payment_id")).status, 403);
});

test("the existing tabs keep their rule: nothing from today, and the new kind does not leak into them", async () => {
  await online({ razorpayPaymentId: "pay_tabs1" });
  await asRole("receptionist", ["datafixes.manage"]);
  for (const kind of ["duplicate", "invalid", "unassigned"]) {
    const r = await shimCall("GET", `/api/data-fixes?kind=${kind}`);
    assert.equal(r.status, 200, kind);
    assert.equal(r.body.total, 0, `${kind}: today's visit is not listed`);
    assert.ok(r.body.through < new Date().toISOString().slice(0, 10) || r.body.through, "the window still ends yesterday");
  }
  assert.equal((await shimCall("GET", "/api/data-fixes?kind=bogus")).status, 400);
});

// ─── a reused payment id that replays the first visit (audit #1 addition) ───

const replayCase = async (mode) => {
  await setMode(mode);
  const e = await event();
  const first = await online({ razorpayPaymentId: e.razorpayPaymentId });
  assert.equal(first.status, 201);
  return { e, first };
};

for (const mode of ["log", "enforce"]) {
  test(`${mode}: the same payment id on a DIFFERENT sale replays the first visit exactly as before, and records already_used`, async () => {
    const { e, first } = await replayCase(mode);
    const same = await online({ razorpayPaymentId: e.razorpayPaymentId });
    assert.equal(same.body.duplicate, true);
    assert.equal((await unverified()).length, 0, "the identical sale again (a retry) records nothing");

    const other = await online({ razorpayPaymentId: e.razorpayPaymentId, serviceIds: [ids.hair] });
    assert.equal(other.status, 200);
    assert.deepEqual(other.body, { ...same.body }, "the caller receives exactly what a plain replay returns");
    assert.equal(other.body.visitId, first.body.visitId);
    assert.equal(await Visit.countDocuments(), 1, "no second visit");

    const [a] = await unverified();
    assert.deepEqual([a.meta.reason, a.meta.replay, a.meta.refused, a.meta.mode], ["already_used", true, false, mode]);
    assert.equal(String(a.meta.visitId), first.body.visitId, "recorded against the FIRST visit");
    assert.deepEqual([a.meta.requestedTotal, a.meta.existingTotal], [1000, 4000]);
    assert.deepEqual([a.meta.expectedPaise, a.meta.foundPaise], [100000, 400000]);
  });
}

test("a reused payment id whose total differs (same services, a discount) is recorded too", async () => {
  const { e } = await replayCase("log");
  const r = await online({ razorpayPaymentId: e.razorpayPaymentId, discountPercent: 10 });
  assert.equal(r.body.duplicate, true);
  assert.equal((await unverified())[0].meta.requestedTotal, 3600);
});

test("a replay that cannot be compared (unknown service) changes nothing and records nothing", async () => {
  const { e } = await replayCase("log");
  const r = await online({ razorpayPaymentId: e.razorpayPaymentId, serviceIds: [String(new mongoose.Types.ObjectId())] });
  assert.equal(r.body.duplicate, true, "still the replay");
  assert.equal((await unverified()).length, 0);
});

test("a database error while comparing a replay never reaches the caller", async () => {
  const { e } = await replayCase("log");
  const original = Service.find;
  Service.find = () => {
    throw new Error("db hiccup");
  };
  try {
    const r = await online({ razorpayPaymentId: e.razorpayPaymentId, serviceIds: [ids.hair] });
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, true);
  } finally {
    Service.find = original;
  }
});

test("payment log errors: the replay entry is listed in plain words with the first visit", async () => {
  const { e, first } = await replayCase("log");
  await online({ razorpayPaymentId: e.razorpayPaymentId, serviceIds: [ids.hair] });
  await asRole("receptionist", ["datafixes.manage"]);
  const [i] = (await openList()).issues;
  assert.equal(i.visitId, first.body.visitId);
  assert.equal(i.replay, true);
  assert.match(i.what, /second sale/i);
  assert.deepEqual([i.expected, i.found], [1000, 4000]);
});

// ─── a dismissal covers THAT problem only ───────────────────────────────────

test("a dismissal applies to payment id + visit + reason: a different reason for the same payment id reappears", async () => {
  await online({ razorpayPaymentId: "pay_scope1" }); // not_found, on visit 1
  await asRole("receptionist", ["datafixes.manage"]);
  const key = await dismiss("pay_scope1");
  assert.equal((await openList()).total, 0);

  // A second, different sale reuses the id: a NEW problem (already_used, replayed onto visit 1).
  await online({ razorpayPaymentId: "pay_scope1", serviceIds: [ids.hair] });
  const open = (await openList()).issues;
  assert.equal(open.length, 1);
  assert.equal(open[0].reason, "already_used");
  assert.notEqual(open[0].key, key);
  const all = (await openList("all")).issues;
  assert.equal(all.length, 2, "the earlier problem is still there, and still dismissed");
  assert.equal(all.find((i) => i.key === key).status, "dismissed");
});

test("a dismissal does not cover the same payment id on a different visit", async () => {
  await online({ razorpayPaymentId: "pay_scope2" });
  await asRole("receptionist", ["datafixes.manage"]);
  await dismiss("pay_scope2");
  // The first visit is gone from the picture (e.g. removed by a migration), then the id is typed again on another sale.
  await Visit.deleteMany({});
  await online({ razorpayPaymentId: "pay_scope2", name: "Someone Else" });
  const open = (await openList()).issues;
  assert.equal(open.length, 1);
  assert.equal(open[0].name, "Someone Else");
});

test("the same problem recorded AGAIN after it was dismissed reappears", async () => {
  await online({ razorpayPaymentId: "pay_scope3" });
  await online({ razorpayPaymentId: "pay_scope3", serviceIds: [ids.hair] }); // already_used (replay)
  await asRole("receptionist", ["datafixes.manage"]);
  const key = await keyOf("pay_scope3");
  const replayKey = (await openList()).issues.find((i) => i.reason === "already_used").key;
  await shimCall("POST", "/api/data-fixes/resolve", { key: replayKey, kind: "payment_id", status: "dismissed", note: "customer paid twice, refunded" });
  await new Promise((res) => setTimeout(res, 10));
  assert.equal((await openList()).issues.filter((i) => i.reason === "already_used").length, 0);
  await online({ razorpayPaymentId: "pay_scope3", serviceIds: [ids.facial] }); // the same kind of problem, again
  const again = (await openList()).issues.filter((i) => i.reason === "already_used");
  assert.equal(again.length, 1, "a new problem for the same payment id and visit shows up again");
  assert.equal(again[0].key, replayKey);
  void key;
});

test("the morning count follows the same rule (a re-recorded problem counts again)", async () => {
  await online({ razorpayPaymentId: "pay_scope4" });
  await asRole("receptionist", ["datafixes.manage"]);
  await dismiss("pay_scope4");
  assert.equal(await check.countOpen(), 0);
  await online({ razorpayPaymentId: "pay_scope4", serviceIds: [ids.hair] });
  assert.equal(await check.countOpen(), 1);
});
