/**
 * @file test/payment-id-unique.test.js
 * @description Audit #2: one Razorpay payment id may sit on only ONE visit, enforced by the database.
 *
 * The routes already check this before saving (the duplicate replay in /visits/v2, the 409 at booking
 * checkout), but two requests that arrive together can both pass the check before either saves. The fix is a
 * partial unique index created ONLY by migration M8 (never declared in the schema, so Mongoose can never
 * build it by itself on first use in production), plus routes that answer a lost race the same way they
 * answer a sequential reuse.
 *
 * Covers: what the index allows and refuses; the migration (dry run by default, refuses to apply while a
 * payment id is on more than one visit, reports no customer data, idempotent); the two routes when the
 * database, not the pre-check, catches the second visit; and the late-webhook case.
 */

const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

process.env.MIGRATION_REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "m8-reports-"));
const { startDb, stopDb } = require("./helpers/db");
const rz = require("./helpers/fakeRazorpay").install();

const WEBHOOK_SECRET = "m8-webhook-secret";
let server, base, cookie;
let Service, Appointment, Customer, Visit, PaymentEvent, User, AuditLog, SiteSettings, m8;
let ids;

before(async () => {
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_m8", RAZORPAY_KEY_SECRET: "m8-key-secret", RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN: "", META_WA_TOKEN: "", PUBLIC_TOKEN_SECRET: "t" });
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
  SiteSettings = require("../models/SiteSettings");
  m8 = require("../migrations/lib/paymentIdIndex");
  await User.collection.insertOne({ name: "Owner", email: "owner@test.example", passwordHash: await bcrypt.hash("Owner@12345", 4), role: "owner", isActive: true, permissions: [] });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@test.example", password: "Owner@12345" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
  fs.rmSync(process.env.MIGRATION_REPORT_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.filter((c) => !["users", "sessions"].includes(c.collectionName)).map((c) => c.deleteMany({})));
  rz.reset();
  const [hair, facial] = await Service.create([
    { name: "Haircut", price: 1000, publicPrice: 500, isActive: true, durationMinutes: 45 },
    { name: "Facial", price: 3000, publicPrice: 1500, isActive: true, durationMinutes: 60 },
  ]);
  ids = { hair: String(hair._id), facial: String(facial._id) };
});

afterEach(async () => {
  await Visit.collection.dropIndex(m8.INDEX_NAME).catch(() => {});
  await Visit.collection.dropIndex(m8.LOOKUP_INDEX_NAME).catch(() => {});
  for (const f of fs.readdirSync(process.env.MIGRATION_REPORT_DIR)) fs.rmSync(path.join(process.env.MIGRATION_REPORT_DIR, f));
});

const call = (method, p, body, headers = {}) =>
  fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sale = (extra = {}) => call("POST", "/api/visits/v2", { name: "Asha Rani", contact: "9876543210", gender: "female", date: "2026-10-26", serviceIds: [ids.hair, ids.facial], paymentMethod: "online", ...extra });
let n = 0;
const event = (over = {}) => PaymentEvent.create({ razorpayPaymentId: `pay_u${++n}`, amount: 4000, status: "captured", reconcileStatus: "unmatched", capturedAt: new Date(), raw: { amount: 400000 }, ...over });
const raw = (over = {}) => ({ name: "Test Person", contact: "9811122233", gender: "female", date: new Date("2026-10-01"), services: [], subtotal: 100, finalTotal: 100, paymentMethod: "cash", cashAmount: 100, paymentStatus: "success", filledBy: "Test", ...over });
const applyM8 = () => m8.runM8({ argv: ["--apply"] });
const dryM8 = (argv = []) => m8.runM8({ argv });
const indexes = async () => (await Visit.collection.indexes()).filter((i) => i.name === m8.INDEX_NAME);
const lookupIndexes = async () => (await Visit.collection.indexes()).filter((i) => i.name === m8.LOOKUP_INDEX_NAME);

/** Make exactly the next call of `Model.method(...)` that matches `when` behave as if nothing was found (a lost race). */
function loseRaceOnce(Model, method, when) {
  const original = Model[method];
  let done = false;
  Model[method] = function (...args) {
    if (!done && when(...args)) {
      done = true;
      return { lean: async () => null, session: async () => null, then: (r) => Promise.resolve(method === "exists" ? false : null).then(r) };
    }
    return original.apply(this, args);
  };
  return () => (Model[method] = original);
}

// ─── the index is a migration, not part of the schema ───────────────────────

test("the index is NOT declared in the Visit schema, and does not exist until the migration creates it", async () => {
  assert.equal(Visit.schema.indexes().filter(([k]) => k.razorpayPaymentId).length, 0, "Mongoose must never build this by itself");
  await Visit.init();
  assert.equal((await Visit.collection.indexes()).filter((i) => i.key.razorpayPaymentId).length, 0, "no payment-id index of any kind exists before M8");
  await applyM8();
  const [ix] = await indexes();
  assert.equal(ix.unique, true);
  assert.deepEqual(ix.partialFilterExpression, { razorpayPaymentId: { $type: "string", $gt: "" } });
});

// ─── what the index allows and refuses ──────────────────────────────────────

test("the partial index: many visits with no payment id (null, missing, '') coexist; the same REAL id twice cannot", async () => {
  await applyM8();
  await Visit.collection.insertMany([
    raw({ razorpayPaymentId: null }),
    raw({ razorpayPaymentId: null }),
    raw(), // field missing
    raw(),
    raw({ razorpayPaymentId: "" }),
    raw({ razorpayPaymentId: "" }),
    ...Array.from({ length: 5 }, () => raw({ paymentMethod: "cash" })),
  ]);
  assert.equal(await Visit.countDocuments(), 11);
  await Visit.collection.insertOne(raw({ razorpayPaymentId: "pay_same", paymentMethod: "online" }));
  await assert.rejects(Visit.collection.insertOne(raw({ razorpayPaymentId: "pay_same", paymentMethod: "online" })), (err) => err.code === 11000);
  await Visit.collection.insertOne(raw({ razorpayPaymentId: "pay_other" }));
  assert.equal(await Visit.countDocuments({ razorpayPaymentId: "pay_same" }), 1);
});

// ─── the migration ──────────────────────────────────────────────────────────

const twoOnOne = async () => {
  await Visit.collection.insertMany([
    raw({ name: "Private Name One", contact: "9000000001", razorpayPaymentId: "pay_dup", date: new Date("2026-09-01") }),
    raw({ name: "Private Name Two", contact: "9000000002", razorpayPaymentId: "pay_dup", date: new Date("2026-09-02") }),
    raw({ razorpayPaymentId: "pay_ok" }),
    raw({ razorpayPaymentId: "" }),
    raw({ razorpayPaymentId: null }),
  ]);
};

test("M8 dry run is the default: creates nothing, and the report names every shared id and every '' visit without customer data", async () => {
  await twoOnOne();
  const out = await dryM8();
  assert.equal(out.mode, "dry-run");
  assert.equal((await indexes()).length, 0, "nothing was created");
  assert.equal(await AuditLog.countDocuments({ action: "migration.applied" }), 0);

  assert.equal(out.duplicates.length, 1);
  const [d] = out.duplicates;
  assert.deepEqual([d.paymentId, d.count], ["pay_dup", 2]);
  assert.equal(d.visits.length, 2);
  assert.ok(d.visits.every((v) => v.visitId && v.date));
  assert.equal(out.emptyStringVisits.length, 1);
  assert.ok(out.emptyStringVisits[0].visitId && out.emptyStringVisits[0].date);
  assert.deepEqual([out.summary.visitsWithRealId, out.summary.distinctRealIds, out.summary.idsOnMoreThanOneVisit], [3, 2, 1]);

  const text = fs.readFileSync(out.file, "utf8");
  for (const secret of ["Private Name", "9000000001", "9000000002", "9811122233", "Test Person"]) assert.ok(!text.includes(secret), `the report must not contain ${secret}`);
  assert.ok(text.includes("pay_dup"));
  assert.ok((await dryM8(["--dry-run"])).mode === "dry-run", "--dry-run is accepted and means the same");
  await assert.rejects(dryM8(["--apply", "--dry-run"]), /either --apply or --dry-run/);
});

test("M8 --apply REFUSES while a payment id is on more than one visit: no index, a report, a clear message", async () => {
  await twoOnOne();
  await assert.rejects(applyM8(), (err) => /pay_dup/.test(err.message) && /not created/i.test(err.message));
  assert.equal((await indexes()).length, 0);
  assert.equal(await AuditLog.countDocuments({ action: "migration.applied" }), 0);
  const reports = fs.readdirSync(process.env.MIGRATION_REPORT_DIR);
  assert.ok(reports.some((f) => /apply/.test(f)), "the refusal is written to a report too");
});

test("M8 --apply with nothing shared creates the index, audits it, and a second run is harmless", async () => {
  await Visit.collection.insertMany([raw({ razorpayPaymentId: "pay_a" }), raw({ razorpayPaymentId: "pay_b" }), raw({ razorpayPaymentId: "" }), raw()]);
  const first = await applyM8();
  assert.equal(first.created, true);
  assert.equal((await indexes()).length, 1);
  assert.equal((await lookupIndexes()).length, 1, "and the plain lookup index");
  assert.equal(await AuditLog.countDocuments({ action: "migration.applied", "meta.id": "M8" }), 1);
  const again = await applyM8();
  assert.equal(again.created, false);
  assert.equal((await indexes()).length, 1);
  assert.equal(await Visit.countDocuments(), 4, "no visit was touched");
});

test("M8 dry run says whether the indexes already exist", async () => {
  const before = await dryM8();
  assert.deepEqual([before.indexExists, before.lookupIndexExists], [false, false]);
  await applyM8();
  const after = await dryM8();
  assert.deepEqual([after.indexExists, after.lookupIndexExists], [true, true]);
});

// ─── the routes when the DATABASE catches the second visit ──────────────────

test("TODAY, without the index: two requests that both pass the pre-check save two visits with one payment id", async () => {
  const e = await event();
  assert.equal((await sale({ razorpayPaymentId: e.razorpayPaymentId })).status, 201);
  const restore = loseRaceOnce(Visit, "findOne", (f) => f && f.razorpayPaymentId === e.razorpayPaymentId);
  try {
    assert.equal((await sale({ razorpayPaymentId: e.razorpayPaymentId })).status, 201);
  } finally {
    restore();
  }
  assert.equal(await Visit.countDocuments({ razorpayPaymentId: e.razorpayPaymentId }), 2, "this is the gap the index closes");
});

test("with the index, /visits/v2 that loses the race gets the first visit back as today's 'duplicate' answer (not a 500)", async () => {
  await applyM8();
  const e = await event();
  const first = await sale({ razorpayPaymentId: e.razorpayPaymentId });
  assert.equal(first.status, 201);
  const restore = loseRaceOnce(Visit, "findOne", (f) => f && f.razorpayPaymentId === e.razorpayPaymentId);
  let second;
  try {
    second = await sale({ razorpayPaymentId: e.razorpayPaymentId });
  } finally {
    restore();
  }
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.visitId, first.body.visitId);
  assert.equal(await Visit.countDocuments(), 1);
});

let refN = 0;
async function booking(deposit = 500) {
  const customer = await Customer.findOneAndUpdate({ phone: "9876500001" }, { $setOnInsert: { name: "Asha", createdFrom: "web" } }, { upsert: true, returnDocument: "after" });
  const start = new Date("2026-11-10T05:30:00Z");
  const s = await Service.findById(ids.facial).lean();
  return Appointment.create({
    ref: `EXP-U${String(++refN).padStart(4, "0")}`, mode: "instant", status: "checked_in", customerId: customer._id, contact: "9876500001", name: "Asha",
    guests: [{ guestKey: "g1", name: "Asha", gender: "female", items: [{ serviceId: s._id, name: s.name, publicPrice: 1500, listPrice: 3000, durationMin: 60, artistId: new mongoose.Types.ObjectId(), artistName: "Mansi", startAt: start, endAt: new Date(start.getTime() + 3600e3) }] }],
    startAt: start, endAt: new Date(start.getTime() + 3600e3), pricing: { subtotal: 1500, discount: 0, total: 1500 },
    deposit: { required: true, kind: "deposit", amount: deposit, status: "paid", razorpayPaymentId: `pay_dep${refN}` }, source: { channel: "web" },
  });
}
const checkout = (appt, extra = {}) => call("POST", "/api/visits/v2", { appointmentId: String(appt._id), serviceIds: [ids.facial], date: "2026-11-10", paymentMethod: "online", ...extra });

/** Skip the in-transaction "already on another visit" check once, as if the other request had not saved yet. */
function loseCheckoutRaceOnce() {
  const original = Visit.exists;
  let done = false;
  Visit.exists = function (...args) {
    const q = original.apply(this, args);
    const realSession = q.session.bind(q);
    q.session = (...a) => {
      if (!done) {
        done = true;
        return Promise.resolve(null);
      }
      return realSession(...a);
    };
    return q;
  };
  return () => (Visit.exists = original);
}

test("with the index, a booking checkout that loses the race on a payment id used by ANOTHER booking keeps the 409, and the booking stays open", async () => {
  await applyM8();
  const e = await event({ amount: 1000, raw: { amount: 100000 } });
  const a1 = await booking();
  assert.equal((await checkout(a1, { razorpayPaymentId: e.razorpayPaymentId })).status, 201);
  const a2 = await booking();
  const restore = loseCheckoutRaceOnce();
  let r;
  try {
    r = await checkout(a2, { razorpayPaymentId: e.razorpayPaymentId });
  } finally {
    restore();
  }
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "That payment is already on another visit");
  assert.equal((await Appointment.findById(a2._id).lean()).status, "checked_in");
  assert.equal(await Visit.countDocuments({ razorpayPaymentId: e.razorpayPaymentId }), 1);
});

test("with the index, a booking checkout that loses the race on the SAME booking is the existing 'duplicate' or 'already billed' answer, never a 500, and one visit", async () => {
  await applyM8();
  const e = await event({ amount: 1000, raw: { amount: 100000 } });
  const a1 = await booking();
  const first = await checkout(a1, { razorpayPaymentId: e.razorpayPaymentId });
  assert.equal(first.status, 201);
  // The second request read the booking before the first one saved.
  await Appointment.updateOne({ _id: a1._id }, { $set: { status: "checked_in", visitId: null } });
  const undoFind = loseRaceOnce(Visit, "findOne", (f) => f && f.appointmentId);
  const undoExists = loseCheckoutRaceOnce();
  let r;
  try {
    r = await checkout(a1, { razorpayPaymentId: e.razorpayPaymentId });
  } finally {
    undoFind();
    undoExists();
  }
  assert.ok((r.status === 200 && r.body.duplicate === true && r.body.visitId === first.body.visitId) || (r.status === 409 && /already been billed/.test(r.body.error)), JSON.stringify(r));
  assert.equal(await Visit.countDocuments(), 1);
});

// ─── a late webhook is not affected ─────────────────────────────────────────

const webhook = (payment) => {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return call("POST", "/api/razorpay/webhook", body, { "x-razorpay-signature": sig, Cookie: "" });
};

test("a late webhook for a payment whose sale was closed by ANOTHER payment still appears in Unreconciled payments; the index and the check do not touch it", async () => {
  await applyM8();
  const paid = await event({ amount: 4000 });
  assert.equal((await sale({ razorpayPaymentId: paid.razorpayPaymentId })).status, 201);

  // The customer's second attempt went through at Razorpay too; its webhook arrives after the visit was closed.
  const late = { id: "pay_lateB", order_id: "order_x", amount: 400000, currency: "INR", status: "captured", method: "upi", contact: "+919876543210", created_at: Math.floor(Date.now() / 1000), notes: { customer_name: "Asha Rani" } };
  const hook = await webhook(late);
  assert.equal(hook.status, 200);
  assert.equal(hook.body.reconciled, false);

  const list = await call("GET", "/api/payments/unreconciled?days=30");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.payments.map((p) => p.razorpayPaymentId), ["pay_lateB"], "only the late one: the paid one is matched");
  assert.equal(list.body.totalAmount, 4000);
  assert.equal(await Visit.countDocuments(), 1, "nothing was created for it");
  assert.equal(await AuditLog.countDocuments({ action: "payment.id_unverified" }), 0, "the payment-id check is not part of the webhook");
});

test("the Unreconciled payments screen only LISTS (and links to 'record as a visit'); the route behind it has no refund action", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const block = src.slice(src.indexOf('"/api/payments/unreconciled"'), src.indexOf("GET /api/verify-payment"));
  assert.ok(!/refund/i.test(block), "no refund call near the unreconciled route");
  const ui = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "pages", "dashboard", "shared", "UnreconciledPayments.tsx"), "utf8");
  assert.ok(!/refund\(|\/refund/i.test(ui));
});
void SiteSettings;

// ─── the webhook's lookup uses the index ────────────────────────────────────

test("the lookups by payment id (webhook, unreconciled list, guards) use the index instead of scanning the collection", async () => {
  await applyM8();
  await Visit.collection.insertMany(Array.from({ length: 50 }, (_, i) => raw({ razorpayPaymentId: `pay_scan${i}` })));
  const stage = (plan) => JSON.stringify(plan);
  const one = await Visit.collection.find({ razorpayPaymentId: "pay_scan7" }).explain("queryPlanner");
  const many = await Visit.collection.find({ razorpayPaymentId: { $in: ["pay_scan1", "pay_scan2"] } }).explain("queryPlanner");
  for (const [label, e] of [["one id", one], ["$in", many]]) {
    const plan = stage(e.queryPlanner.winningPlan);
    assert.ok(plan.includes("IXSCAN") && plan.includes(m8.LOOKUP_INDEX_NAME) && !plan.includes("COLLSCAN"), `${label}: ${plan}`);
  }
});
