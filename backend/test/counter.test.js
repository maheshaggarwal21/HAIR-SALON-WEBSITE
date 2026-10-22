/**
 * @file test/counter.test.js
 * @description Counter UPI payments (D60, part A): the server prices the sale, makes the
 * QR, and is the only judge of "paid"; the tablet is paired by a one-time code and only
 * ever shown an amount and a QR.
 *
 * Razorpay is replaced by a fake gateway: nothing here touches the network.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { PNG } = require("pngjs");
const { encode } = require("uqr");
const { startDb, stopDb, clearDb } = require("./helpers/db");

process.env.COUNTER_DISPLAY_ENABLED = "true";

let Visit, User, Service, SiteSettings, CounterSession, CounterDevice, CounterPairing, PaymentEvent, AuditLog;
let counter, razorpayQr, evictPermissionCache;
let server;
let base;
let caller;
let svc;
let fake;

/** A Razorpay-like poster: a QR for `text` on a white page. */
function posterPng(text) {
  const m = encode(text, { ecc: "M", border: 0 }).data;
  const scale = 6;
  const pad = 40;
  const size = m.length * scale + pad * 2;
  const png = new PNG({ width: size, height: size });
  png.data.fill(255);
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((pad + y * scale + dy) * size + pad + x * scale + dx) * 4;
          png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
        }
      }
    }
  }
  return PNG.sync.write(png);
}
const upiFor = (rupees) => `upi://pay?pa=salon@bank&pn=SALON&tr=T123&am=${rupees}.00&cu=INR&mc=7230&mode=22`;

function makeFake() {
  const f = {
    qrs: new Map(),
    calls: { create: 0, get: 0, close: 0, list: 0 },
    failCreate: false,
    noPoster: false,
    posterFor: (rupees) => posterPng(upiFor(rupees)),
    list: [],
  };
  f.configured = () => true;
  f.createQr = async ({ amountPaise, sessionId, closeBy }) => {
    f.calls.create++;
    if (f.failCreate) return { ok: false, error: "down" };
    const id = `qr_${f.qrs.size + 1}`;
    f.qrs.set(id, { status: "active", closeReason: null, amountPaise, sessionId: String(sessionId), received: 0 });
    return { ok: true, id, imageUrl: `https://rzp.io/rzp/${id}`, closeBy };
  };
  f.fetchPoster = async (url) => {
    if (f.noPoster) return null;
    const q = f.qrs.get(url.split("/").pop());
    return f.posterFor(q.amountPaise / 100);
  };
  f.getQr = async (id) => {
    f.calls.get++;
    const q = f.qrs.get(id);
    return { ok: true, status: q.status, closeReason: q.closeReason, amountReceivedPaise: q.received, countReceived: q.received ? 1 : 0 };
  };
  f.closeQr = async (id) => {
    f.calls.close++;
    const q = f.qrs.get(id);
    if (q.status === "closed") return { ok: false, error: "closed", status: 400 };
    q.status = "closed";
    q.closeReason = "on_demand";
    return { ok: true };
  };
  f.listQrPayments = async () => {
    f.calls.list++;
    return { ok: true, payments: f.list };
  };
  f.pay = (id) => {
    const q = f.qrs.get(id);
    q.status = "closed";
    q.closeReason = "paid";
    q.received = q.amountPaise;
  };
  return f;
}

before(async () => {
  await startDb();
  Visit = require("../models/Visit");
  User = require("../models/User");
  Service = require("../models/Service");
  SiteSettings = require("../models/SiteSettings");
  CounterSession = require("../models/CounterSession");
  CounterDevice = require("../models/CounterDevice");
  CounterPairing = require("../models/CounterPairing");
  PaymentEvent = require("../models/PaymentEvent");
  AuditLog = require("../models/AuditLog");
  counter = require("../utils/counter");
  razorpayQr = require("../utils/razorpayQr");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  await Promise.all([Visit, CounterSession, CounterDevice, CounterPairing, PaymentEvent].map((m) => m.init()));

  const app = express();
  app.use(express.json());
  app.use("/api/display", require("../routes/counterDisplay"));
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/visits", require("../routes/visits"));
  app.use("/api/counter", require("../routes/counter"));
  app.use("/api/data-fixes", require("../routes/dataFixes"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  razorpayQr.resetGateway();
  await new Promise((r) => server.close(r));
  await stopDb();
});

let userN = 0;
async function staff(name, role, permissions = ["visit.create"]) {
  const u = await User.collection.insertOne({ name, email: `c${++userN}@example.com`, role, isActive: true, permissions });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name, role };
  return u.insertedId;
}

async function call(method, path, data, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

const sale = (over = {}) => ({ serviceIds: [String(svc._id)], discountPercent: 50, paymentMode: "online", ...over });
const startSale = (over) => call("POST", "/counter/sessions", sale(over));
const webhook = (session, over = {}) =>
  counter.applyCapturedPayment({
    id: "pay_1",
    status: "captured",
    amount: session.upiAmountPaise,
    order_id: null,
    notes: { kind: "counter_qr", sessionId: String(session._id) },
    ...over,
  });
const customer = { name: "Asha", contact: "9876543210", gender: "female", date: "2026-10-22" };

beforeEach(async () => {
  await clearDb();
  counter.clearSettingsCache();
  fake = makeFake();
  razorpayQr.setGateway(fake);
  process.env.COUNTER_DISPLAY_ENABLED = "true";
  svc = await Service.create({
    name: "Haircut Women",
    price: 1000,
    publicPrice: 500,
    slug: "haircut-women",
    isActive: true,
    durationMinutes: 45,
    durationConfirmed: true,
    bookingMode: "instant",
    audience: "her",
    displayCategory: "Hair",
  });
  await SiteSettings.getSingleton();
  await staff("Reena", "receptionist");
});

// ─── pricing ────────────────────────────────────────────────────────────────

test("the server prices the sale: list price, duplicates, discount, cash part", async () => {
  const id = String(svc._id);
  let r = await counter.computeAmounts({ serviceIds: [id, id], discountPercent: 50 });
  assert.deepEqual([r.subtotal, r.discountAmount, r.finalTotal, r.upiAmount, r.upiAmountPaise], [2000, 1000, 1000, 1000, 100000]);
  r = await counter.computeAmounts({ serviceIds: [id], discountPercent: 50, paymentMode: "partial", cashAmount: 200 });
  assert.deepEqual([r.finalTotal, r.cashAmount, r.upiAmount], [500, 200, 300]);
});

test("bad sales are refused: cash with paise, cash >= total, 100% off, unknown or inactive service, bad discount", async () => {
  const id = String(svc._id);
  const bad = async (over, re) => {
    const r = await counter.computeAmounts({ serviceIds: [id], discountPercent: 50, ...over });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.error, re);
  };
  await bad({ paymentMode: "partial", cashAmount: 100.5 }, /whole rupees/);
  await bad({ paymentMode: "partial", cashAmount: 500 }, /Cash must be between/);
  await bad({ paymentMode: "partial", cashAmount: 0 }, /Cash must be between/);
  await bad({ discountPercent: 100 }, /at least ₹1/);
  await bad({ paymentMode: "card" }, /online or partial/);
  await bad({ serviceIds: [] }, /At least one service/);
  await bad({ serviceIds: [String(new mongoose.Types.ObjectId())] }, /invalid or inactive/);
  await Service.updateOne({ _id: svc._id }, { isActive: false });
  await bad({}, /invalid or inactive/);
});

// ─── QR image → UPI string ──────────────────────────────────────────────────

test("the UPI string is read from the poster only when its amount matches", () => {
  const png = posterPng(upiFor(500));
  assert.equal(counter.decodeUpiFromPoster(png, 500), upiFor(500));
  assert.equal(counter.decodeUpiFromPoster(png, 501), null);
  assert.equal(counter.decodeUpiFromPoster(posterPng("https://evil.example/pay?am=500"), 500), null);
  assert.equal(counter.decodeUpiFromPoster(Buffer.from("not a png"), 500), null);
});

// ─── sessions ───────────────────────────────────────────────────────────────

test("a session is priced by the server, never the browser, and the QR is redrawn from the poster", async () => {
  const r = await startSale({ amount: 1, finalTotal: 1, upiAmount: 1, upiAmountPaise: 100 }); // lies are ignored
  assert.equal(r.status, 201);
  assert.equal(r.body.session.amount, 500);
  const s = await CounterSession.findById(r.body.session.id);
  assert.equal(s.upiAmountPaise, 50000);
  assert.equal(s.qrMode, "decoded");
  assert.equal(s.qrUpi, upiFor(500));
  assert.equal(r.body.session.qr, undefined, "the tablet shows it, not the browser");
  assert.equal(fake.calls.create, 1);
});

test("if the poster cannot be read, the session falls back to showing the cropped poster", async () => {
  fake.noPoster = true;
  const r = await startSale({ target: "pc" });
  assert.equal(r.status, 201);
  assert.equal(r.body.session.qr.mode, "image");
  assert.ok(r.body.session.qr.imageUrl.startsWith("https://rzp.io/"));
  assert.ok(r.body.session.qr.crop.w > 0);
  assert.equal((await CounterSession.findById(r.body.session.id)).qrMode, "image");
});

test("a QR shown on the staff screen carries the UPI string; a tablet session does not", async () => {
  const r = await startSale({ target: "pc" });
  assert.deepEqual(r.body.session.qr, { mode: "decoded", upi: upiFor(500) });
});

test("when Razorpay is down no session is left behind", async () => {
  fake.failCreate = true;
  const r = await startSale();
  assert.equal(r.status, 502);
  assert.equal(r.body.qrFailed, true);
  assert.equal(await CounterSession.countDocuments(), 0);
});

test("a new payment replaces the same person's old QR (and closes it at Razorpay)", async () => {
  const a = await startSale();
  const b = await startSale();
  assert.equal(b.status, 201);
  assert.equal((await CounterSession.findById(a.body.session.id)).status, "cancelled");
  assert.equal((await CounterSession.findById(a.body.session.id)).cancelReason, "superseded");
  assert.equal(fake.calls.close, 1);
  assert.equal(await CounterSession.countDocuments({ status: "pending" }), 1);
});

test("someone else's live tablet payment is not cancelled: the second person is told, and may use their own screen", async () => {
  const a = await startSale();
  await staff("Kiran", "receptionist");
  const busy = await startSale();
  assert.equal(busy.status, 409);
  assert.equal(busy.body.busy, true);
  assert.equal((await CounterSession.findById(a.body.session.id)).status, "pending");
  assert.equal((await startSale({ target: "pc" })).status, 201);
});

test("only the creator (or the owner) can see or cancel a session", async () => {
  const a = await startSale();
  await staff("Kiran", "receptionist");
  assert.equal((await call("GET", `/counter/sessions/${a.body.session.id}`)).status, 404);
  assert.equal((await call("POST", `/counter/sessions/${a.body.session.id}/cancel`)).status, 404);
  await staff("Owner", "owner");
  assert.equal((await call("GET", `/counter/sessions/${a.body.session.id}`)).status, 200);
});

test("cancel closes the QR; 'show on this screen' moves it to the staff screen", async () => {
  const a = await startSale();
  const moved = await call("POST", `/counter/sessions/${a.body.session.id}/target`, { target: "pc" });
  assert.equal(moved.body.session.qr.mode, "decoded");
  const c = await call("POST", `/counter/sessions/${a.body.session.id}/cancel`);
  assert.equal(c.body.session.status, "cancelled");
  assert.equal(fake.calls.close, 1);
  assert.equal((await call("POST", `/counter/sessions/${a.body.session.id}/target`, { target: "pc" })).status, 409);
});

test("cancelling a QR that was just paid keeps the payment (paid wins)", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  const c = await call("POST", `/counter/sessions/${a.body.session.id}/cancel`);
  assert.equal(c.body.session.status, "paid");
});

// ─── status polling ─────────────────────────────────────────────────────────

test("status: the QR turning 'paid' marks the session paid, reference pending; polling is capped at one Razorpay call per 2 s", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  let r = await call("GET", `/counter/sessions/${s.id}`);
  assert.equal(r.body.session.status, "pending");
  await call("GET", `/counter/sessions/${s.id}`);
  await call("GET", `/counter/sessions/${s.id}`);
  assert.equal(fake.calls.get, 1, "three polls inside 2 s, one Razorpay call");

  fake.pay(s.qrId);
  await CounterSession.updateOne({ _id: s._id }, { $set: { lastSyncAt: new Date(Date.now() - 3000) } });
  r = await call("GET", `/counter/sessions/${s.id}`);
  assert.equal(r.body.session.status, "paid");
  assert.equal(r.body.session.referencePending, true);
});

test("status: a paid QR for the wrong amount is not accepted", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  fake.qrs.get(s.qrId).received = 100;
  assert.equal((await call("GET", `/counter/sessions/${s.id}`)).body.session.status, "pending");
});

test("status: an unpaid QR past its time becomes expired", async () => {
  const a = await startSale();
  await CounterSession.updateOne({ _id: a.body.session.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call("GET", `/counter/sessions/${a.body.session.id}`)).body.session.status, "expired");
});

// ─── webhook ────────────────────────────────────────────────────────────────

test("webhook: a captured counter payment marks the session paid with its payment id, once", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  assert.equal((await webhook(s)).outcome, "paid");
  assert.equal((await webhook(s)).outcome, "duplicate");
  const after = await CounterSession.findById(s._id);
  assert.deepEqual([after.status, after.razorpayPaymentId, after.paidVia], ["paid", "pay_1", "webhook"]);
});

test("webhook: wrong amount is not matched; uncaptured and unknown sessions are ignored", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  assert.equal((await webhook(s, { amount: 100 })).outcome, "amount_mismatch");
  assert.equal((await webhook(s, { status: "failed" })).outcome, "not_captured");
  assert.equal((await webhook(s, { notes: { kind: "counter_qr", sessionId: String(new mongoose.Types.ObjectId()) } })).outcome, "unknown_session");
  assert.equal((await webhook(s, { notes: { kind: "counter_qr" } })).outcome, "no_session");
  assert.equal((await CounterSession.findById(s._id)).status, "pending");
});

test("webhook: money arriving after the session was cancelled is kept aside for a human, not lost", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  await call("POST", `/counter/sessions/${s.id}/cancel`);
  assert.equal((await webhook(s)).outcome, "late_cancelled");
  const after = await CounterSession.findById(s._id);
  assert.deepEqual([after.status, after.latePaymentId, after.razorpayPaymentId], ["cancelled", "pay_1", null]);
});

test("webhook: money arriving just after the QR expired still pays the session", async () => {
  const a = await startSale();
  await CounterSession.updateOne({ _id: a.body.session.id }, { $set: { status: "expired" } });
  const s = await CounterSession.findById(a.body.session.id);
  assert.equal((await webhook(s)).outcome, "paid");
});

test("webhook: a second payment on an already paid session is flagged, not merged", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  await webhook(s);
  assert.equal((await webhook(s, { id: "pay_2" })).outcome, "second_payment");
  assert.equal((await CounterSession.findById(s._id)).razorpayPaymentId, "pay_1");
});

test("webhook: the id fills in a session the poll already marked paid", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  await call("GET", `/counter/sessions/${s.id}`);
  assert.equal((await CounterSession.findById(s._id)).razorpayPaymentId, null);
  assert.equal((await webhook(s)).outcome, "reference_filled");
  assert.equal((await CounterSession.findById(s._id)).razorpayPaymentId, "pay_1");
});

// ─── visit from a paid session ──────────────────────────────────────────────

async function paidSession(over) {
  const a = await startSale(over);
  const s = await CounterSession.findById(a.body.session.id);
  await PaymentEvent.create({ razorpayPaymentId: "pay_1", amount: s.upiAmount, status: "captured", reconcileStatus: "unmatched" });
  await webhook(s);
  return s;
}
const saveVisit = (s, over = {}) => call("POST", "/visits/v2", { ...customer, counterSessionId: String(s._id), ...over });

test("visit: built from the session; the browser's services, discount and payment id are ignored", async () => {
  const s = await paidSession();
  const cheap = await Service.create({ name: "Threading", price: 10, slug: "threading", isActive: true, durationMinutes: 15, durationConfirmed: true, bookingMode: "instant", audience: "her", displayCategory: "Hair" });
  const r = await saveVisit(s, { serviceIds: [String(cheap._id)], discountPercent: 0, paymentMethod: "cash", razorpayPaymentId: "pay_FAKE" });
  assert.equal(r.status, 201);
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.finalTotal, 500);
  assert.equal(v.discountPercent, 50);
  assert.equal(v.paymentMethod, "online");
  assert.equal(v.onlineAmount, 500);
  assert.equal(v.razorpayPaymentId, "pay_1");
  assert.equal(v.referencePending, false);
  assert.equal(String(v.counterSessionId), String(s._id));
  assert.equal((await PaymentEvent.findOne({ razorpayPaymentId: "pay_1" })).reconcileStatus, "matched");
  assert.equal(String((await CounterSession.findById(s._id)).visitId), String(v._id));
});

test("visit: split payment keeps the cash part and the sum invariant", async () => {
  const s = await paidSession({ paymentMode: "partial", cashAmount: 200 });
  const v = await Visit.findById((await saveVisit(s)).body.visitId).lean();
  assert.deepEqual([v.paymentMethod, v.cashAmount, v.cardAmount, v.onlineAmount], ["partial", 200, 0, 300]);
  assert.equal(v.cashAmount + v.cardAmount + v.onlineAmount, v.finalTotal);
});

test("visit: not paid yet, the session cannot be saved", async () => {
  const a = await startSale();
  const r = await call("POST", "/visits/v2", { ...customer, counterSessionId: a.body.session.id });
  assert.equal(r.status, 409);
  assert.equal(await Visit.countDocuments(), 0);
});

test("visit: a double click or retry returns the same visit, never a second", async () => {
  const s = await paidSession();
  const first = await saveVisit(s);
  const second = await saveVisit(s);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(String(second.body.visitId), String(first.body.visitId));
  assert.equal(await Visit.countDocuments(), 1);
});

test("visit: two simultaneous saves still make one visit", async () => {
  const s = await paidSession();
  const [a, b] = await Promise.all([saveVisit(s), saveVisit(s)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(await Visit.countDocuments(), 1);
});

test("visit: another staff member cannot save someone else's payment", async () => {
  const s = await paidSession();
  await staff("Kiran", "receptionist");
  assert.equal((await saveVisit(s)).status, 403);
  await staff("Owner", "owner");
  assert.equal((await saveVisit(s)).status, 201);
});

test("visit: missing customer details are refused without using up the payment", async () => {
  const s = await paidSession();
  assert.equal((await saveVisit(s, { name: "" })).status, 400);
  assert.equal((await saveVisit(s)).status, 201);
});

test("visit: a price that changed while the customer paid is not saved automatically", async () => {
  const s = await paidSession();
  await Service.updateOne({ _id: svc._id }, { $set: { price: 1200 } });
  const r = await saveVisit(s);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Unreconciled/);
  assert.equal(await Visit.countDocuments(), 0);
});

test("visit: saved before the payment id arrives, it is 'reference pending' and the webhook completes it", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  await call("GET", `/counter/sessions/${s.id}`);
  const r = await saveVisit(s);
  assert.equal(r.status, 201);
  let v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.referencePending, v.razorpayPaymentId], [true, null]);

  await PaymentEvent.create({ razorpayPaymentId: "pay_1", amount: 500, status: "captured", reconcileStatus: "unmatched" });
  assert.equal((await webhook(s)).outcome, "reference_filled");
  v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.referencePending, v.razorpayPaymentId, v.paymentSnapshot.razorpayPaymentId], [false, "pay_1", "pay_1"]);
  assert.equal((await PaymentEvent.findOne({ razorpayPaymentId: "pay_1" })).reconcileStatus, "matched");
});

test("backfill: after 60 s with no webhook the id comes from Razorpay's payments list, and the visit is completed", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  await call("GET", `/counter/sessions/${s.id}`);
  const r = await saveVisit(s);

  const now = new Date();
  assert.deepEqual(await counter.backfillReferences({ now }), { checked: 0, filled: 0, repaired: 0 }, "too early");
  fake.list = [{ id: "pay_9", amountPaise: 50000, status: "captured" }];
  const later = new Date(Date.now() + 61_000);
  const out = await counter.backfillReferences({ now: later });
  assert.equal(out.filled, 1);
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual([v.referencePending, v.razorpayPaymentId], [false, "pay_9"]);
  assert.equal((await PaymentEvent.findOne({ razorpayPaymentId: "pay_9" })).reconcileStatus, "matched");
  assert.equal((await CounterSession.findById(s._id)).paidVia, "backfill");
});

test("backfill: a payment of a different amount is not adopted", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  await call("GET", `/counter/sessions/${s.id}`);
  fake.list = [{ id: "pay_9", amountPaise: 100, status: "captured" }];
  assert.equal((await counter.backfillReferences({ now: new Date(Date.now() + 61_000) })).filled, 0);
});

// ─── tablet ─────────────────────────────────────────────────────────────────

async function pairTablet(name = "Counter tablet") {
  await staff("Owner", "owner");
  const p = await call("POST", "/counter/pairings", { name });
  const paired = await call("POST", "/display/pair", { code: p.body.code });
  return { token: paired.body.token, code: p.body.code, paired };
}
const state = (token) => call("GET", "/display/state", null, { authorization: `Bearer ${token}` });
const backdate = (token) => CounterDevice.updateMany({}, { $set: { lastPollAt: new Date(Date.now() - 5000) } });

test("pairing: the owner makes a one-time code, the tablet trades it for a token, and the token is only stored hashed", async () => {
  const { token, code, paired } = await pairTablet("Front desk");
  assert.equal(paired.status, 200);
  assert.equal(paired.body.name, "Front desk");
  assert.match(code, /^\d{6}$/);
  const dev = await CounterDevice.findOne().lean();
  assert.notEqual(dev.tokenHash, token);
  assert.equal(dev.tokenHash, counter.sha256(token));
  const p = await CounterPairing.findOne().lean();
  assert.notEqual(p.codeHash, code);
  assert.ok(p.expiresAt - Date.now() <= 5 * 60_000 && p.expiresAt - Date.now() > 4 * 60_000);
  assert.ok(await AuditLog.findOne({ action: "counter.device_paired" }));
});

test("pairing: a code works once", async () => {
  const { code } = await pairTablet();
  const again = await call("POST", "/display/pair", { code });
  assert.equal(again.status, 400);
  assert.equal(await CounterDevice.countDocuments(), 1);
});

test("pairing: an expired code does not work, and says nothing more than a wrong one", async () => {
  await staff("Owner", "owner");
  const p = await call("POST", "/counter/pairings", { name: "T" });
  await CounterPairing.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call("POST", "/display/pair", { code: p.body.code });
  const wrong = await call("POST", "/display/pair", { code: p.body.code === "000000" ? "111111" : "000000" });
  assert.equal(expired.status, 400);
  assert.deepEqual(expired.body, wrong.body);
});

test("pairing: 5 wrong tries lock the code, even for the right code afterwards", async () => {
  await staff("Owner", "owner");
  const p = await call("POST", "/counter/pairings", { name: "T" });
  const wrongCode = p.body.code === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/display/pair", { code: wrongCode })).status, 400);
  await require("../models/RateLimitHit").deleteMany({}); // take the per-IP limit out of the picture
  const right = await call("POST", "/display/pair", { code: p.body.code });
  assert.equal(right.status, 400, "locked");
  assert.equal(await CounterDevice.countDocuments(), 0);
});

test("pairing: a 6th attempt inside a minute from one address is rate limited, whatever the code", async () => {
  await staff("Owner", "owner");
  const p = await call("POST", "/counter/pairings", { name: "T" });
  for (let i = 0; i < 5; i++) await call("POST", "/display/pair", { code: "000000" });
  const r = await call("POST", "/display/pair", { code: p.body.code });
  assert.equal(r.status, 429);
});

test("pairing: only the owner (counter.manage) can make codes or see and revoke tablets", async () => {
  await staff("Reena", "receptionist");
  assert.equal((await call("POST", "/counter/pairings", { name: "x" })).status, 403);
  assert.equal((await call("GET", "/counter/devices")).status, 403);
  assert.equal((await call("DELETE", `/counter/devices/${new mongoose.Types.ObjectId()}`)).status, 403);
  const { ROLE_DEFAULTS } = require("../constants/permissions");
  assert.ok(!ROLE_DEFAULTS.receptionist.includes("counter.manage") && !ROLE_DEFAULTS.manager.includes("counter.manage"));
});

test("the tablet is shown an amount and a QR, nothing about the customer, and only its own token works", async () => {
  const { token } = await pairTablet();
  assert.equal((await call("GET", "/display/state")).status, 401);
  assert.equal((await state("x".repeat(43))).status, 401);

  let r = await state(token);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "idle");

  await staff("Reena", "receptionist");
  const a = await startSale();
  await backdate(token);
  r = await state(token);
  assert.equal(r.body.mode, "payment");
  assert.equal(r.body.amount, 500);
  assert.deepEqual(r.body.qr, { mode: "decoded", upi: upiFor(500) });
  assert.equal(r.body.nextPollMs, 2500);
  assert.deepEqual(Object.keys(r.body).sort(), ["amount", "device", "expiresAt", "mode", "nextPollMs", "qr", "sessionId"]);
  assert.ok(!JSON.stringify(r.body).includes("Reena"));

  const s = await CounterSession.findById(a.body.session.id);
  await webhook(s);
  await backdate(token);
  r = await state(token);
  assert.equal(r.body.mode, "paid");
  await CounterSession.updateOne({ _id: s._id }, { $set: { paidAt: new Date(Date.now() - 20_000) } });
  await backdate(token);
  assert.equal((await state(token)).body.mode, "idle");
});

test("a session shown on the staff screen, or cancelled, never appears on the tablet", async () => {
  const { token } = await pairTablet();
  await staff("Reena", "receptionist");
  const a = await startSale({ target: "pc" });
  await backdate(token);
  assert.equal((await state(token)).body.mode, "idle");
  await call("POST", `/counter/sessions/${a.body.session.id}/cancel`);
  await startSale();
  await backdate(token);
  assert.equal((await state(token)).body.mode, "payment");
});

test("a tablet that asks again within 1.5 s is throttled; one that waits is not", async () => {
  const { token } = await pairTablet();
  await backdate(token);
  assert.equal((await state(token)).status, 200);
  const fast = await state(token);
  assert.equal(fast.status, 429);
  assert.equal(fast.headers.get("retry-after"), "2");
  await backdate(token);
  assert.equal((await state(token)).status, 200);
});

test("a revoked tablet stops working at once", async () => {
  const { token } = await pairTablet();
  const list = await call("GET", "/counter/devices");
  assert.equal((await call("DELETE", `/counter/devices/${list.body.devices[0].id}`)).body.revoked, true);
  await backdate(token);
  const r = await state(token);
  assert.equal(r.status, 401);
  assert.equal(r.body.unpaired, true);
  assert.ok(await AuditLog.findOne({ action: "counter.device_revoked" }));
});

test("the chip: online while the tablet keeps to its own schedule, offline once it misses it", async () => {
  const { token } = await pairTablet();
  await backdate(token);
  await state(token);
  await staff("Reena", "receptionist");
  assert.equal((await call("GET", "/counter/status")).body.anyOnline, true);
  await CounterDevice.updateMany({}, { $set: { lastPollAt: new Date(Date.now() - 60_000), lastPollIntervalMs: 20_000 } });
  assert.equal((await call("GET", "/counter/status")).body.anyOnline, false);
  // the slow overnight rate (5 min) must not read as offline
  await CounterDevice.updateMany({}, { $set: { lastPollAt: new Date(Date.now() - 4 * 60_000), lastPollIntervalMs: 300_000 } });
  assert.equal((await call("GET", "/counter/status")).body.anyOnline, true);
});

// ─── polling rate ───────────────────────────────────────────────────────────

test("idle polling: fast from 30 min before opening to 15 min after closing, slow otherwise, never overshooting the start of fast", () => {
  const hours = { mon: [{ open: "10:00", close: "20:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  const settings = { openingHours: hours, holidays: [] };
  const at = (hhmm, date = "2026-10-26") => new Date(`${date}T${hhmm}:00+05:30`); // a Monday
  assert.equal(counter.idlePollMs(settings, at("12:00")), 20_000);
  assert.equal(counter.idlePollMs(settings, at("09:30")), 20_000, "30 min before opening");
  assert.equal(counter.idlePollMs(settings, at("20:10")), 20_000, "just after closing");
  assert.equal(counter.idlePollMs(settings, at("22:00")), 300_000, "night");
  assert.equal(counter.idlePollMs(settings, at("09:10")), 300_000, "20 min before the fast window: slow");
  // fast starts at 09:30, so the slow wait is cut to arrive exactly then
  assert.equal(counter.idlePollMs(settings, at("09:27")), 180_000);
  assert.equal(counter.idlePollMs(settings, at("09:29")), 60_000);
  // Tuesday is closed: slow all day
  assert.equal(counter.idlePollMs(settings, at("12:00", "2026-10-27")), 300_000);
  // a holiday on Monday keeps it slow
  assert.equal(counter.idlePollMs({ ...settings, holidays: ["2026-10-26"] }, at("12:00")), 300_000);
  // nothing configured at all: never slow
  assert.equal(counter.idlePollMs({ openingHours: {}, holidays: [] }, at("03:00")), 20_000);
});

// ─── flag ───────────────────────────────────────────────────────────────────

test("with COUNTER_DISPLAY_ENABLED off everything answers 'off' and the form falls back to Checkout", async () => {
  process.env.COUNTER_DISPLAY_ENABLED = "false";
  assert.deepEqual((await call("GET", "/counter/status")).body, { enabled: false });
  assert.equal((await startSale()).status, 404);
  assert.equal((await call("POST", "/display/pair", { code: "123456" })).status, 404);
  assert.equal((await call("GET", "/display/state")).status, 404);
});

test("the polling endpoints are exempt from the IP limiter; pairing, creating and cancelling are not", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../index.js"), "utf8");
  const block = src.match(/const POLLING_ONLY = \[([\s\S]*?)\];/)[1];
  assert.match(block, /display\\\/state/);
  assert.match(block, /counter\\\/status/);
  assert.match(block, /counter\\\/sessions/);
  assert.doesNotMatch(block, /pair|cancel/);
  assert.ok(!/"\/api\/counter"|"\/api\/display"/.test(src.match(/const PAYMENT_CRITICAL = \[([\s\S]*?)\];/)[1]), "no blanket exemption");
});

// ─── Fix Numbers: references that never arrived ─────────────────────────────

test("Fix Numbers lists a counter visit whose payment reference is still missing after 10 minutes, and drops it once it arrives", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  await call("GET", `/counter/sessions/${s.id}`);
  const r = await saveVisit(s);
  await staff("Owner", "owner");

  const list = async () => (await call("GET", "/data-fixes?kind=reference")).body.issues;
  assert.equal((await list()).length, 0, "too new to worry about");

  await Visit.collection.updateOne({ _id: new mongoose.Types.ObjectId(r.body.visitId) }, { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } });
  const open = await list();
  assert.equal(open.length, 1);
  assert.equal(open[0].key, `rf:${r.body.visitId}`);
  assert.equal(open[0].amount, 500);

  await webhook(s); // the reference finally arrives
  assert.equal((await list()).length, 0);
});

test("Fix Numbers heals a stuck reference from Razorpay's payments list before listing it", async () => {
  const a = await startSale();
  const s = await CounterSession.findById(a.body.session.id);
  fake.pay(s.qrId);
  await call("GET", `/counter/sessions/${s.id}`);
  const r = await saveVisit(s);
  await staff("Owner", "owner");
  await Visit.collection.updateOne({ _id: new mongoose.Types.ObjectId(r.body.visitId) }, { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } });
  await CounterSession.updateOne({ _id: s._id }, { $set: { paidAt: new Date(Date.now() - 11 * 60_000), lastSyncAt: null } });
  fake.list = [{ id: "pay_7", amountPaise: 50000, status: "captured" }];
  assert.equal((await call("GET", "/data-fixes?kind=reference")).body.issues.length, 0);
  assert.equal((await Visit.findById(r.body.visitId)).razorpayPaymentId, "pay_7");
});
