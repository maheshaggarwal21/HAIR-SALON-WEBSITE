/**
 * @file test/payment-visit-paths.test.js
 * @description CHARACTERIZATION tests for every way a desk Visit is created through POST /api/visits/v2
 * (audit #10). They pin what the code does TODAY, including its known weaknesses, so audit #1 (check the
 * payment id) and #2 (one visit per payment id) can change them on purpose and nothing else by accident.
 *
 * Paths: a manual desk sale (cash, card, online, split), the recovery path (`recoveredPaymentId`), and a
 * booking at checkout (`appointmentId`), including a booking for a group that is billed as ONE visit with
 * ONE payment. The counter QR flow has its own tests (counter.test.js).
 *
 * "TODAY" in a title marks behaviour that is a weakness, pinned as it is.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { startDb, stopDb } = require("./helpers/db");
const rz = require("./helpers/fakeRazorpay").install();

let server, base, cookie;
let Service, Appointment, Customer, Visit, PaymentEvent, User;
let ids;

before(async () => {
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_char", RAZORPAY_KEY_SECRET: "char-key-secret", TELEGRAM_BOT_TOKEN: "", META_WA_TOKEN: "", PUBLIC_TOKEN_SECRET: "t" });
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
  // Sign in ONCE (a login per test would hit the login rate limit); the per-test cleanup keeps this user and session.
  await User.collection.insertOne({ name: "Owner", email: "owner@test.example", passwordHash: await bcrypt.hash("Owner@12345", 4), role: "owner", isActive: true, permissions: [] });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@test.example", password: "Owner@12345" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

async function clearAllButSession() {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.filter((c) => !["users", "sessions"].includes(c.collectionName)).map((c) => c.deleteMany({})));
}

beforeEach(async () => {
  await clearAllButSession();
  rz.reset();
  const [hair, facial] = await Service.create([
    { name: "Haircut", price: 1000, publicPrice: 500, isActive: true, durationMinutes: 45 },
    { name: "Facial", price: 3000, publicPrice: 1500, isActive: true, durationMinutes: 60 },
  ]);
  ids = { hair: String(hair._id), facial: String(facial._id) };
});

const call = (method, p, body) =>
  fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sale = (extra = {}) => call("POST", "/api/visits/v2", { name: "Asha Rani", contact: "9876543210", gender: "female", date: "2026-10-26", serviceIds: [ids.hair, ids.facial], ...extra });
const invariant = (v) => assert.equal(v.cashAmount + v.cardAmount + v.onlineAmount, v.finalTotal, "cash + card + online must equal finalTotal");
let eventN = 0;
const event = (over = {}) =>
  PaymentEvent.create({ razorpayPaymentId: `pay_ev${++eventN}`, amount: 4000, status: "captured", reconcileStatus: "unmatched", capturedAt: new Date(), raw: { amount: 400000 }, ...over });

// ─── a manual desk sale ─────────────────────────────────────────────────────

test("v2: missing or bad details are refused with the message the staff app shows", async () => {
  const cases = [
    [{ name: "" }, "Name is required"],
    [{ contact: "12345" }, "Valid 10-digit Indian mobile required"],
    [{ gender: "x" }, "Gender is required"],
    [{ date: "" }, "Date is required"],
    [{ serviceIds: [] }, "At least one service is required"],
    [{ paymentMethod: "bitcoin" }, "Invalid payment method"],
    [{ serviceIds: ["nope"] }, "Invalid service ID in serviceIds"],
    [{ serviceIds: [String(new mongoose.Types.ObjectId())] }, "No valid active services found"],
  ];
  for (const [over, message] of cases) {
    const r = await sale({ paymentMethod: "cash", ...over });
    assert.equal(r.status, 400, message);
    assert.equal(r.body.error, message);
  }
  assert.equal(await Visit.countDocuments(), 0);
});

test("v2 cash: priced on the server from the menu, all of it in cash, waiting for the artist assignment", async () => {
  const r = await sale({ paymentMethod: "cash", total: 1, finalTotal: 1, subtotal: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ["assignmentStatus", "finalTotal", "lockUntilAssigned", "services", "success", "visitId"]);
  assert.equal(r.body.finalTotal, 4000, "totals sent by the browser are ignored");
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.subtotal, v.discountAmount, v.finalTotal, v.cashAmount, v.cardAmount, v.onlineAmount], [4000, 0, 4000, 4000, 0, 0]);
  assert.deepEqual([v.paymentMethod, v.paymentStatus, v.assignmentStatus, v.schemaVersion, v.filledBy], ["cash", "success", "pending", 2, "Owner"]);
  assert.deepEqual(v.services.map((s) => [s.name, s.price, s.artistId]), [["Haircut", 1000, null], ["Facial", 3000, null]]);
  assert.equal(v.razorpayPaymentId, null);
  invariant(v);
});

test("v2 card: all of it on card", async () => {
  const v = await Visit.findById((await sale({ paymentMethod: "card" })).body.visitId).lean();
  assert.deepEqual([v.cardAmount, v.cashAmount, v.onlineAmount], [4000, 0, 0]);
  invariant(v);
});

test("v2 discount: a percent typed at the desk is applied on the server and clamped to 0..100", async () => {
  const ten = await Visit.findById((await sale({ paymentMethod: "cash", discountPercent: 10 })).body.visitId).lean();
  assert.deepEqual([ten.discountPercent, ten.discountAmount, ten.finalTotal, ten.cashAmount], [10, 400, 3600, 3600]);
  const over = await Visit.findById((await sale({ paymentMethod: "cash", discountPercent: 150 })).body.visitId).lean();
  assert.deepEqual([over.discountPercent, over.finalTotal], [100, 0], "clamped to 100%");
  const neg = await Visit.findById((await sale({ paymentMethod: "cash", discountPercent: -5 })).body.visitId).lean();
  assert.deepEqual([neg.discountPercent, neg.finalTotal], [0, 4000]);
});

test("v2 online: needs a Razorpay payment id; with one, the whole total is 'online'", async () => {
  const none = await sale({ paymentMethod: "online" });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, "Razorpay Payment ID is required for online payment");
  const r = await sale({ paymentMethod: "online", razorpayPaymentId: "pay_on1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.onlineAmount, v.cashAmount, v.cardAmount, v.razorpayPaymentId], [4000, 0, 0, "pay_on1"]);
  assert.equal(v.paymentSnapshot.razorpayPaymentId, "pay_on1");
  invariant(v);
});

test("v2 split (partial): the typed cash part stays cash and the rest is online; needs a payment id", async () => {
  const none = await sale({ paymentMethod: "partial", cashAmount: 1000 });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, "Razorpay Payment ID is required for partial payment");
  const r = await sale({ paymentMethod: "partial", cashAmount: 1000, razorpayPaymentId: "pay_sp1" });
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.cashAmount, v.onlineAmount, v.finalTotal, v.razorpayPaymentId], [1000, 3000, 4000, "pay_sp1"]);
  invariant(v);
  // a discount applies before the split
  const d = await Visit.findById((await sale({ paymentMethod: "partial", cashAmount: 600, discountPercent: 10, razorpayPaymentId: "pay_sp2" })).body.visitId).lean();
  assert.deepEqual([d.finalTotal, d.cashAmount, d.onlineAmount], [3600, 600, 3000]);
  invariant(d);
});

test("v2 split: a cash part of 0 or the whole total is refused (today as a 500 with the reason in 'details')", async () => {
  for (const cashAmount of [0, 4000]) {
    const r = await sale({ paymentMethod: "partial", cashAmount, razorpayPaymentId: `pay_bad${cashAmount}` });
    assert.equal(r.status, 500, `cash ${cashAmount}`);
    assert.equal(r.body.error, "Failed to create V2 visit");
    assert.match(r.body.details, /Cash amount must be between Rs1 and total minus Rs1/);
  }
  assert.equal(await Visit.countDocuments(), 0);
});

test("v2 TODAY (audit #1): a made-up payment id is accepted and saved as 'paid online'; nothing checks it", async () => {
  assert.equal(await PaymentEvent.countDocuments(), 0, "Razorpay never reported this payment");
  const r = await sale({ paymentMethod: "online", razorpayPaymentId: "pay_madeUp123" });
  assert.equal(r.status, 201);
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.paymentMethod, v.onlineAmount, v.razorpayPaymentId], ["online", 4000, "pay_madeUp123"]);
  assert.equal(rz.fetched.length, 0, "Razorpay is not asked about it either");
});

test("v2 TODAY (audit #1): a cash visit that carries a payment id keeps the id, with 0 online", async () => {
  const v = await Visit.findById((await sale({ paymentMethod: "cash", razorpayPaymentId: "pay_oddcash" })).body.visitId).lean();
  assert.deepEqual([v.paymentMethod, v.cashAmount, v.onlineAmount, v.razorpayPaymentId], ["cash", 4000, 0, "pay_oddcash"]);
});

test("v2 TODAY: the same payment id again returns the FIRST visit as a duplicate and makes no second one, whatever the second sale was", async () => {
  const first = await sale({ paymentMethod: "online", razorpayPaymentId: "pay_dup1" });
  const second = await sale({ name: "Someone Else", serviceIds: [ids.hair], paymentMethod: "online", razorpayPaymentId: "pay_dup1" });
  assert.equal(second.status, 200, "success-shaped, not an error");
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.visitId, first.body.visitId);
  assert.equal(second.body.finalTotal, 4000, "the first sale's total, not the second sale's");
  assert.equal(await Visit.countDocuments({ razorpayPaymentId: "pay_dup1" }), 1);
});

test("v2: once the visit exists, Razorpay's own record of the payment is marked 'matched' to it", async () => {
  const e = await event({ razorpayPaymentId: "pay_ev_match" });
  const r = await sale({ paymentMethod: "online", razorpayPaymentId: "pay_ev_match" });
  const after = await PaymentEvent.findById(e._id).lean();
  assert.equal(after.reconcileStatus, "matched");
  assert.equal(String(after.reconciledVisitId), r.body.visitId);
});

// ─── the recovery path ──────────────────────────────────────────────────────

test("recovery: an id Razorpay never reported, or one that was not captured, is refused", async () => {
  const unknown = await sale({ paymentMethod: "online", recoveredPaymentId: "pay_unknown" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /^Unknown payment reference/);
  const failed = await event({ razorpayPaymentId: "pay_failed1", status: "failed" });
  const r = await sale({ paymentMethod: "online", recoveredPaymentId: failed.razorpayPaymentId });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /"failed", not captured/);
  assert.equal(await Visit.countDocuments(), 0);
});

test("recovery: a captured payment becomes a visit marked 'recovered', and its event is marked matched with a note", async () => {
  const e = await event({ razorpayPaymentId: "pay_rec1" });
  const r = await sale({ paymentMethod: "online", recoveredPaymentId: "pay_rec1", razorpayPaymentId: "pay_ignored" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.filledBy, "Owner (recovered payment)");
  assert.equal(v.razorpayPaymentId, "pay_rec1", "the id comes from Razorpay's record, not from the browser");
  const after = await PaymentEvent.findById(e._id).lean();
  assert.equal(after.reconcileStatus, "matched");
  assert.match(after.note, /Recorded from the unreconciled list by Owner/);
});

test("recovery TODAY (audit #1): the amount is NOT compared: a ₹50 payment can be recovered onto a ₹4,000 sale", async () => {
  await event({ razorpayPaymentId: "pay_small", amount: 50, raw: { amount: 5000 } });
  const r = await sale({ paymentMethod: "online", recoveredPaymentId: "pay_small" });
  assert.equal(r.status, 201);
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.finalTotal, v.onlineAmount], [4000, 4000]);
});

// ─── a booking at checkout (appointmentId) ──────────────────────────────────

let refN = 0;
/** A checked-in booking with a paid deposit. `people` = [[serviceKey, publicPrice, listPrice, name], ...] one entry per guest. */
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
    ref: `EXP-P${String(++refN).padStart(4, "0")}`,
    mode: "instant",
    status: "checked_in",
    customerId: customer._id,
    contact: "9876500001",
    name: "Asha",
    guests,
    startAt: start,
    endAt: new Date(start.getTime() + 3600e3),
    pricing: { subtotal, discount: 0, total: subtotal },
    deposit: { required: true, kind: "deposit", amount: deposit, status: "paid", razorpayPaymentId: "pay_dep" },
    source: { channel: "web" },
  });
}
const checkout = (appt, extra = {}) => call("POST", "/api/visits/v2", { appointmentId: String(appt._id), serviceIds: appt.guests.flatMap((g) => g.items.map((i) => String(i.serviceId))), date: "2026-11-10", ...extra });

test("checkout: the rest by UPI needs a payment id; the visit keeps the DESK payment in razorpayPaymentId and the deposit apart", async () => {
  const appt = await booking();
  const none = await checkout(appt, { paymentMethod: "online" });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, "Razorpay Payment ID is required for the online part");
  const r = await checkout(appt, { paymentMethod: "online", razorpayPaymentId: "pay_desk1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.finalTotal, v.depositAmount, v.depositPaymentId, v.razorpayPaymentId], [1500, 500, "pay_dep", "pay_desk1"]);
  assert.equal(v.onlineAmount, 1500, "the deposit (500) + the desk payment (1000)");
  invariant(v);
});

test("checkout split: the cash part stays cash; online = (what is due − cash) + the deposit", async () => {
  const appt = await booking();
  const v = await Visit.findById((await checkout(appt, { paymentMethod: "partial", cashAmount: 400, razorpayPaymentId: "pay_desk2" })).body.visitId).lean();
  assert.deepEqual([v.cashAmount, v.onlineAmount, v.finalTotal, v.razorpayPaymentId], [400, 1100, 1500, "pay_desk2"]);
  invariant(v);
});

test("checkout: the rest in cash takes no payment id, and one sent anyway is NOT stored", async () => {
  const appt = await booking();
  const v = await Visit.findById((await checkout(appt, { paymentMethod: "cash", razorpayPaymentId: "pay_ignoredcash" })).body.visitId).lean();
  assert.deepEqual([v.cashAmount, v.onlineAmount, v.razorpayPaymentId], [1000, 500, null]);
  invariant(v);
});

test("checkout TODAY (audit #1): a made-up payment id for the online part is accepted", async () => {
  const appt = await booking();
  const r = await checkout(appt, { paymentMethod: "online", razorpayPaymentId: "pay_madeUpDesk" });
  assert.equal(r.status, 201);
  assert.equal((await Visit.findById(r.body.visitId).lean()).razorpayPaymentId, "pay_madeUpDesk");
  assert.equal(rz.fetched.length, 0);
});

test("checkout: a payment id already on another visit is refused (409), and the booking stays open", async () => {
  await Visit.create({ name: "Other", contact: "9811111111", gender: "male", date: new Date("2026-10-26"), services: [{ name: "Haircut", price: 1000 }], subtotal: 1000, finalTotal: 1000, paymentMethod: "online", onlineAmount: 1000, paymentStatus: "success", razorpayPaymentId: "pay_taken", filledBy: "Test" });
  const appt = await booking();
  const r = await checkout(appt, { paymentMethod: "online", razorpayPaymentId: "pay_taken" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "That payment is already on another visit");
  assert.equal((await Appointment.findById(appt._id).lean()).status, "checked_in");
});

test("checkout, a GROUP on one bill: one visit with both people's services, one payment equal to the total due, and the invariant holds", async () => {
  const appt = await booking({ deposit: 500, people: [["facial", 1500, 3000, "Asha"], ["hair", 500, 1000, "Bina"]] });
  assert.equal(appt.guests.length, 2);
  const r = await checkout(appt, { paymentMethod: "online", razorpayPaymentId: "pay_group1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(await Visit.countDocuments(), 1, "ONE visit for the whole group");
  assert.deepEqual(v.services.map((s) => s.name).sort(), ["Facial", "Haircut"]);
  assert.deepEqual([v.finalTotal, v.depositAmount, v.razorpayPaymentId], [2000, 500, "pay_group1"]);
  assert.equal(v.onlineAmount, 2000, "the deposit (500) + the one desk payment (1500)");
  invariant(v);
});

test("checkout: a second try for the same booking returns the same visit; the booking closes in the same write", async () => {
  const appt = await booking();
  const first = await checkout(appt, { paymentMethod: "cash" });
  const again = await checkout(appt, { paymentMethod: "cash" });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.visitId, first.body.visitId);
  assert.equal(await Visit.countDocuments(), 1);
  assert.equal((await Appointment.findById(appt._id).lean()).status, "completed");
});
