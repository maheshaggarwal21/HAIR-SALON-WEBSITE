/**
 * @file test/payment-routes.test.js
 * @description CHARACTERIZATION tests for the desk payment routes in index.js (audit #10): they pin what
 * the code does TODAY so a later change (audit #1, #2) cannot alter it by accident. Where today's behaviour
 * is a known weakness (the browser's amount is echoed back, audit #19), the test says so and pins it as it is.
 *
 * Covers POST /api/create-order, POST /api/verify-order-payment, GET /api/order-status/:orderId and the
 * Razorpay webhook's recording of a payment. Razorpay is a fake class put in Node's module cache before
 * index.js loads, so nothing goes near the network and no production code is changed to allow it.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

const KEY_SECRET = "char-key-secret";
const WEBHOOK_SECRET = "char-webhook-secret";

// ── a fake Razorpay SDK, in place before index.js is loaded (test/helpers/fakeRazorpay.js) ──
const rz = require("./helpers/fakeRazorpay").install();

let server, base, cookie;
let Service, Appointment, Customer, Visit, PaymentEvent, User;
let ids;

before(async () => {
  Object.assign(process.env, {
    RAZORPAY_KEY_ID: "rzp_test_char",
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: "",
    META_WA_TOKEN: "",
    PUBLIC_TOKEN_SECRET: "t",
  });
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

/** Empty everything except the signed-in owner and their session. */
async function clearAllButSession() {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.filter((c) => !["users", "sessions"].includes(c.collectionName)).map((c) => c.deleteMany({})));
}

beforeEach(async () => {
  await clearAllButSession();
  rz.reset();
  const [hair, facial, wax, off] = await Service.create([
    { name: "Haircut", price: 1000, publicPrice: 500, isActive: true, durationMinutes: 45 },
    { name: "Facial", price: 3000, publicPrice: 1500, isActive: true, durationMinutes: 60 },
    { name: "Wax", price: 600, publicPrice: 300, isActive: true, durationMinutes: 30 },
    { name: "Retired", price: 100, publicPrice: 50, isActive: false, durationMinutes: 15 },
  ]);
  ids = { hair: String(hair._id), facial: String(facial._id), wax: String(wax._id), off: String(off._id) };
});

const call = (method, p, body, headers = { Cookie: cookie }) =>
  fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const order = (extra = {}) => call("POST", "/api/create-order", { name: "Asha Rani", phone: "9876543210", serviceIds: [ids.hair, ids.facial], ...extra });
const sign = (orderId, paymentId) => crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

// ─── POST /api/create-order: a desk sale, priced on the server ──────────────

test("create-order: the amount is the services' prices added up on the server (in paise), and the answer has the fields the staff app reads", async () => {
  const r = await order();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ["amount", "currency", "key_id", "name", "order_id", "phone"]);
  assert.equal(r.body.amount, 400000, "(1000 + 3000) x 100");
  assert.equal(r.body.currency, "INR");
  assert.equal(r.body.key_id, "rzp_test_char");
  assert.match(r.body.order_id, /^order_/);
  assert.equal(rz.created.length, 1);
  assert.deepEqual(rz.created[0].notes, { customer_name: "Asha Rani", customer_phone: "9876543210" });
  assert.match(rz.created[0].receipt, /^receipt_\d+$/);
});

test("create-order: an amount sent by the browser is ignored", async () => {
  const r = await order({ amount: 1, total: 1, amountInPaise: 100 });
  assert.equal(r.body.amount, 400000);
});

test("create-order: a discount percent is applied to the total and clamped to 0..100", async () => {
  assert.equal((await order({ discountPercent: 10 })).body.amount, 360000);
  assert.equal((await order({ discountPercent: -50 })).body.amount, 400000, "a negative discount is no discount");
  const full = await order({ discountPercent: 150 });
  assert.equal(full.status, 400, "clamped to 100%: nothing left to charge");
  assert.equal(full.body.error, "Online amount must be at least ₹1");
});

test("create-order: the same service twice is charged twice", async () => {
  assert.equal((await order({ serviceIds: [ids.hair, ids.hair] })).body.amount, 200000);
});

test("create-order: a split payment charges only the online part; the cash part must leave something on both sides", async () => {
  assert.equal((await order({ paymentMode: "partial", cashAmount: 1000 })).body.amount, 300000);
  for (const cashAmount of [0, 4000, 5000, -5]) {
    const r = await order({ paymentMode: "partial", cashAmount });
    assert.equal(r.status, 400, `cash ${cashAmount}`);
    assert.match(r.body.error, /Cash amount must be between ₹1 and total minus ₹1/);
  }
});

test("create-order: missing details and unknown or retired services are refused", async () => {
  assert.equal((await call("POST", "/api/create-order", { phone: "9876543210", serviceIds: [ids.hair] })).status, 400);
  assert.equal((await call("POST", "/api/create-order", { name: "A", serviceIds: [ids.hair] })).status, 400);
  const none = await call("POST", "/api/create-order", { name: "A", phone: "9876543210" });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /serviceIds are required/);
  const unknown = await order({ serviceIds: [String(new mongoose.Types.ObjectId())] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "No valid active services found");
  const retired = await order({ serviceIds: [ids.hair, ids.off] });
  assert.equal(retired.status, 400);
  assert.equal(retired.body.error, "One or more selected services are invalid or inactive");
  assert.equal(rz.created.length, 0, "no order was created for any of those");
});

test("create-order: needs a signed-in user", async () => {
  const r = await call("POST", "/api/create-order", { name: "A", phone: "9876543210", serviceIds: [ids.hair] }, {});
  assert.equal(r.status, 401);
});

// ─── POST /api/create-order for a booking at checkout ───────────────────────

async function booking({ deposit = 500, status = "checked_in" } = {}) {
  const customer = await Customer.findOneAndUpdate({ phone: "9876500001" }, { $setOnInsert: { name: "Asha", createdFrom: "web" } }, { upsert: true, returnDocument: "after" });
  const s = await Service.findById(ids.facial).lean();
  const start = new Date("2026-11-10T05:30:00Z");
  return Appointment.create({
    ref: `EXP-C${String(Math.floor(Math.random() * 9000) + 1000)}`,
    mode: "instant",
    status,
    customerId: customer._id,
    contact: "9876500001",
    name: "Asha",
    guests: [{ guestKey: "g1", name: "Asha", gender: "female", items: [{ serviceId: s._id, name: s.name, publicPrice: 1500, listPrice: 3000, durationMin: 60, artistId: new mongoose.Types.ObjectId(), artistName: "Mansi", startAt: start, endAt: new Date(start.getTime() + 3600e3) }] }],
    startAt: start,
    endAt: new Date(start.getTime() + 3600e3),
    pricing: { subtotal: 1500, discount: 0, total: 1500 },
    deposit: { required: true, kind: "deposit", amount: deposit, status: "paid", razorpayPaymentId: "pay_dep" },
    source: { channel: "web" },
  });
}

test("create-order for a booking: charges only what is still due (the booking's own price minus the deposit), and says it is for a visit", async () => {
  const appt = await booking({ deposit: 500 });
  const r = await call("POST", "/api/create-order", { name: "Asha", phone: "9876500001", appointmentId: String(appt._id) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 100000, "(1500 - 500) x 100");
  assert.deepEqual(rz.created[0].notes, { customer_name: "Asha", customer_phone: "9876500001", appointment_ref: appt.ref, kind: "visit" });
  assert.match(rz.created[0].receipt, new RegExp(`^appt_${appt.ref}_`));
});

test("create-order for a booking: a split charges the remainder minus the cash part; nothing due and a closed booking are refused", async () => {
  const appt = await booking({ deposit: 500 });
  assert.equal((await call("POST", "/api/create-order", { name: "A", phone: "9876500001", appointmentId: String(appt._id), paymentMode: "partial", cashAmount: 400 })).body.amount, 60000);
  const bad = await call("POST", "/api/create-order", { name: "A", phone: "9876500001", appointmentId: String(appt._id), paymentMode: "partial", cashAmount: 1000 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Cash amount must be between ₹1 and the amount due minus ₹1/);

  const paid = await booking({ deposit: 1500 });
  const nothing = await call("POST", "/api/create-order", { name: "A", phone: "9876500001", appointmentId: String(paid._id) });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.error, "Nothing is due online for this booking");

  const cancelled = await booking({ status: "cancelled" });
  const closed = await call("POST", "/api/create-order", { name: "A", phone: "9876500001", appointmentId: String(cancelled._id) });
  assert.equal(closed.status, 409);
  assert.match(closed.body.error, /cancelled — it can't be billed/);
});

// ─── POST /api/verify-order-payment ─────────────────────────────────────────

test("verify-order-payment: a good signature is accepted; a bad or missing one is refused", async () => {
  const ok = await call("POST", "/api/verify-order-payment", { razorpay_order_id: "order_x", razorpay_payment_id: "pay_x", razorpay_signature: sign("order_x", "pay_x"), name: "Asha", phone: "9876543210", amount: 150000 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.payment_id, "pay_x");
  assert.equal(ok.body.order_id, "order_x");
  assert.equal(ok.body.name, "Asha");
  assert.equal(ok.body.phone, "9876543210");

  const wrong = await call("POST", "/api/verify-order-payment", { razorpay_order_id: "order_x", razorpay_payment_id: "pay_y", razorpay_signature: sign("order_x", "pay_x") });
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, { success: false, error: "Invalid payment signature" });
  const missing = await call("POST", "/api/verify-order-payment", { razorpay_order_id: "order_x" });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { success: false, error: "Missing payment parameters" });
});

test("verify-order-payment TODAY: the amount it reports is the browser's own number divided by 100 (audit #19), not a checked one", async () => {
  const sig = sign("order_x", "pay_x");
  const base1 = { razorpay_order_id: "order_x", razorpay_payment_id: "pay_x", razorpay_signature: sig };
  assert.equal((await call("POST", "/api/verify-order-payment", { ...base1, amount: 150000 })).body.amount, 1500);
  assert.equal((await call("POST", "/api/verify-order-payment", { ...base1, amount: 1 })).body.amount, 0.01, "a made-up amount is echoed back");
  assert.equal((await call("POST", "/api/verify-order-payment", base1)).body.amount, 0, "no amount sent: 0");
});

// ─── GET /api/order-status/:orderId ─────────────────────────────────────────

test("order-status: paid when Razorpay says an attempt was captured, and the answer carries that payment's id and paise amount", async () => {
  rz.paymentsOf.set("order_a", [{ id: "pay_1", status: "failed", amount: 150000 }, { id: "pay_2", status: "captured", amount: 150000 }]);
  const r = await call("GET", "/api/order-status/order_a");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { paid: true, payment_id: "pay_2", amount: 150000, status: "captured", attempts: 2 });
});

test("order-status: not paid while nothing is captured; a malformed id is refused; a Razorpay error is a 502, never 'unpaid'", async () => {
  rz.paymentsOf.set("order_b", [{ id: "pay_1", status: "failed", amount: 100 }]);
  assert.deepEqual((await call("GET", "/api/order-status/order_b")).body, { paid: false, payment_id: null, amount: null, status: null, attempts: 1 });
  assert.deepEqual((await call("GET", "/api/order-status/order_none")).body, { paid: false, payment_id: null, amount: null, status: null, attempts: 0 });
  assert.equal((await call("GET", "/api/order-status/not-an-order")).status, 400);
  rz.failFetch = true;
  const down = await call("GET", "/api/order-status/order_a");
  assert.equal(down.status, 502);
  assert.equal(down.body.error, "Could not reach Razorpay");
});

// ─── the webhook records a payment ──────────────────────────────────────────

const hook = (event, payment) => {
  const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return fetch(`${base}/api/razorpay/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": sig }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const pay = (over = {}) => ({ id: "pay_wh1", order_id: "order_wh1", amount: 318570, currency: "INR", status: "captured", method: "upi", contact: "+919876543210", created_at: 1792800000, notes: { customer_name: "Asha" }, ...over });

test("webhook: a captured payment with no visit is recorded as 'unmatched', amount in whole rupees (rounded), the exact paise kept in raw", async () => {
  const r = await hook("payment.captured", pay());
  assert.deepEqual(r.body, { received: true, reconciled: false });
  const e = await PaymentEvent.findOne({ razorpayPaymentId: "pay_wh1" }).lean();
  assert.equal(e.status, "captured");
  assert.equal(e.reconcileStatus, "unmatched");
  assert.equal(e.amount, 3186, "₹3,185.70 is stored as ₹3,186");
  assert.equal(e.raw.amount, 318570, "the exact paise are in raw");
  assert.equal(e.contact, "9876543210");
  assert.equal(e.razorpayOrderId, "order_wh1");
});

test("webhook: a payment that already has a visit is recorded as 'matched' to it; the same event twice is one record", async () => {
  const v = await Visit.create({ name: "Asha", contact: "9876543210", gender: "female", date: new Date("2026-10-26"), services: [{ name: "Haircut", price: 1000 }], subtotal: 1000, finalTotal: 1000, paymentMethod: "online", onlineAmount: 1000, paymentStatus: "success", razorpayPaymentId: "pay_wh2", filledBy: "Test" });
  await hook("payment.captured", pay({ id: "pay_wh2", amount: 100000 }));
  await hook("payment.captured", pay({ id: "pay_wh2", amount: 100000 }));
  const events = await PaymentEvent.find({ razorpayPaymentId: "pay_wh2" }).lean();
  assert.equal(events.length, 1);
  assert.equal(events[0].reconcileStatus, "matched");
  assert.equal(String(events[0].reconciledVisitId), String(v._id));
});

test("webhook: a failed payment is recorded as failed; a bad signature and other events change nothing", async () => {
  await hook("payment.failed", pay({ id: "pay_wh3", status: "failed" }));
  assert.equal((await PaymentEvent.findOne({ razorpayPaymentId: "pay_wh3" }).lean()).status, "failed");
  const ignored = await hook("order.paid", pay({ id: "pay_wh4" }));
  assert.equal(ignored.body.ignored, "order.paid");
  assert.equal(await PaymentEvent.countDocuments({ razorpayPaymentId: "pay_wh4" }), 0);
  const bad = await fetch(`${base}/api/razorpay/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": "nope" }, body: JSON.stringify({ event: "payment.captured", payload: { payment: { entity: pay({ id: "pay_wh5" }) } } }) });
  assert.equal(bad.status, 400);
  assert.equal(await PaymentEvent.countDocuments({ razorpayPaymentId: "pay_wh5" }), 0);
});
