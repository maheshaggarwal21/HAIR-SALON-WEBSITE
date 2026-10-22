/**
 * @file test/discounts.test.js
 * @description Discount logging and the owner's summary (D60, part B).
 *
 * What must hold: there is no cap, so a 100% discount is accepted — but nonsense
 * (negative, over 100, not a number) is rejected instead of clamped; every
 * discount above 0% leaves exactly one row whatever the payment mode; a later
 * edit appends a row and never changes the first; the summary shows each
 * person's discounted visits against ALL their visits, the rupees given away and
 * the highest percentage; and the highlight is a mark, never a block.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const { salonDate } = require("../utils/time");

let Visit, User, Service, DiscountLog, AuditLog, SiteSettings, evictPermissionCache, discounts;
let server;
let base;
let caller;
let svc;

before(async () => {
  await startDb();
  Visit = require("../models/Visit");
  User = require("../models/User");
  Service = require("../models/Service");
  DiscountLog = require("../models/DiscountLog");
  AuditLog = require("../models/AuditLog");
  SiteSettings = require("../models/SiteSettings");
  discounts = require("../utils/discounts");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  await DiscountLog.init();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/visits", require("../routes/visits"));
  app.use("/api/discounts", require("../routes/discounts"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
let userN = 0;
async function staff(name, role, permissions) {
  const u = await User.collection.insertOne({ name, email: `s${++userN}@example.com`, role, isActive: true, permissions });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name, role };
  return u.insertedId;
}

async function call(method, path, data) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const newVisit = (over = {}) =>
  call("POST", "/visits/v2", {
    name: "Asha",
    contact: "9876543210",
    gender: "female",
    date: salonDate(),
    serviceIds: [String(svc._id)],
    discountPercent: 50,
    paymentMethod: "cash",
    ...over,
  });

beforeEach(async () => {
  await clearDb();
  caller = OWNER;
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
});

test("a discounted cash visit leaves one row with who, how much and why", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  const r = await newVisit({ discountPercent: 40, discountReason: "  regular   customer  " });
  assert.equal(r.status, 201);

  const rows = await DiscountLog.find().lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "created");
  assert.equal(rows[0].percent, 40);
  assert.equal(rows[0].amount, 400);
  assert.equal(rows[0].finalTotal, 600);
  assert.equal(rows[0].staffName, "Reena");
  assert.equal(rows[0].reason, "regular customer");
  assert.equal(rows[0].day, salonDate());
  assert.equal(String(rows[0].visitId), String(r.body.visitId));

  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.discountReason, "regular customer");
});

test("a visit with no discount logs nothing", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  assert.equal((await newVisit({ discountPercent: 0 })).status, 201);
  assert.equal(await DiscountLog.countDocuments(), 0);
});

test("every payment mode is logged: cash, card, UPI/online and split", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  assert.equal((await newVisit({ paymentMethod: "cash" })).status, 201);
  assert.equal((await newVisit({ paymentMethod: "card" })).status, 201);
  assert.equal((await newVisit({ paymentMethod: "online", razorpayPaymentId: "pay_A1" })).status, 201);
  assert.equal((await newVisit({ paymentMethod: "partial", cashAmount: 100, razorpayPaymentId: "pay_A2" })).status, 201);
  const modes = (await DiscountLog.find().lean()).map((r) => r.paymentMethod).sort();
  assert.deepEqual(modes, ["card", "cash", "online", "partial"]);
});

test("there is no cap: 100% is accepted and logged", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  const r = await newVisit({ discountPercent: 100, paymentMethod: "online", razorpayPaymentId: "pay_FREE" });
  // A free visit has nothing to pay, but the discount itself must not be what stops it.
  assert.notEqual(r.status, 500);
  if (r.status === 201) assert.equal((await DiscountLog.findOne()).percent, 100);
});

test("nonsense discounts are rejected, not clamped, and leave no visit or row", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  for (const bad of [150, -5, "abc", "101"]) {
    const r = await newVisit({ discountPercent: bad });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.body.error, /Discount/);
  }
  assert.equal(await Visit.countDocuments(), 0);
  assert.equal(await DiscountLog.countDocuments(), 0);
});

test("the reason is optional and capped at 200 characters", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  await newVisit({ discountReason: "x".repeat(500) });
  await newVisit();
  const rows = await DiscountLog.find().sort({ createdAt: 1 }).lean();
  assert.equal(rows[0].reason.length, 200);
  assert.equal(rows[1].reason, null);
});

test("a later change appends an 'edited' row and never rewrites the first", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  const { body } = await newVisit({ discountPercent: 50 });
  const visit = await Visit.findById(body.visitId).lean();

  const edit = { ...visit, discountPercent: 20, discountAmount: 200, finalTotal: 800 };
  await discounts.recordDiscountEdit({ visit: edit, req: { session: caller }, reason: "client complained" });
  // Removing the discount entirely is an edit worth recording too.
  await discounts.recordDiscountEdit({ visit: { ...visit, discountPercent: 0, discountAmount: 0, finalTotal: 1000 }, req: { session: caller } });

  const rows = await DiscountLog.find({ visitId: visit._id }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(rows.map((r) => [r.kind, r.percent]), [["created", 50], ["edited", 20], ["edited", 0]]);
  assert.equal(rows[1].reason, "client complained");
});

test("logging the same visit's creation twice is a no-op, and never throws", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  const { body } = await newVisit();
  const visit = await Visit.findById(body.visitId).lean();
  assert.equal(await discounts.recordDiscount({ visit, req: { session: caller } }), null);
  assert.equal(await DiscountLog.countDocuments(), 1);
});

test("summary: discounted visits against all visits, rupees, highest percent, and the highlight", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  await newVisit({ discountPercent: 50 }); // 500
  await newVisit({ discountPercent: 10 }); // 100
  await newVisit({ discountPercent: 0 }); // not discounted, still a visit
  await staff("Kiran", "receptionist", ["visit.create"]);
  await newVisit({ discountPercent: 80, discountReason: "friend" }); // 800
  await newVisit({ discountPercent: 0 });
  await newVisit({ discountPercent: 0 });

  caller = OWNER;
  const r = await call("GET", "/discounts/summary");
  assert.equal(r.status, 200);
  assert.equal(r.body.reviewPercent, 30);

  const by = Object.fromEntries(r.body.staff.map((s) => [s.staffName, s]));
  assert.deepEqual(
    [by.Reena.totalVisits, by.Reena.discountedVisits, by.Reena.totalAmount, by.Reena.highestPercent, by.Reena.aboveThreshold],
    [3, 2, 600, 50, 1]
  );
  assert.deepEqual(
    [by.Kiran.totalVisits, by.Kiran.discountedVisits, by.Kiran.totalAmount, by.Kiran.highestPercent, by.Kiran.aboveThreshold],
    [3, 1, 800, 80, 1]
  );
  assert.deepEqual(r.body.totals, { totalVisits: 6, discountedVisits: 3, totalAmount: 1400, highestPercent: 80 });

  // Highlight, never block: the two above 30% are listed, and they were all saved.
  assert.deepEqual(r.body.flagged.map((f) => f.percent).sort((a, b) => a - b), [50, 80]);
  assert.equal(await Visit.countDocuments(), 6);
  assert.equal(r.body.flagged.find((f) => f.percent === 80).reason, "friend");
});

test("summary: an edit counts as an edit, not as extra rupees", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  const { body } = await newVisit({ discountPercent: 50 });
  const visit = await Visit.findById(body.visitId).lean();
  await discounts.recordDiscountEdit({ visit: { ...visit, discountPercent: 60, discountAmount: 600 }, req: { session: caller } });

  caller = OWNER;
  const s = (await call("GET", "/discounts/summary")).body.staff.find((x) => x.staffName === "Reena");
  assert.equal(s.discountedVisits, 1);
  assert.equal(s.edits, 1);
  assert.equal(s.totalAmount, 500);
  assert.equal(s.highestPercent, 60);
});

test("summary: rows from another day are left out, and the range is validated", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  await newVisit();
  await DiscountLog.updateMany({}, { $set: { day: "2020-01-01" } });
  caller = OWNER;
  assert.equal((await call("GET", "/discounts/summary")).body.totals.discountedVisits, 0);
  assert.equal((await call("GET", "/discounts/summary?from=2020-01-01&to=2020-01-01")).body.totals.discountedVisits, 1);
  assert.equal((await call("GET", "/discounts/summary?from=nope")).status, 400);
  assert.equal((await call("GET", "/discounts/summary?from=2020-01-05&to=2020-01-01")).status, 400);
  assert.equal((await call("GET", "/discounts/summary?from=2019-01-01&to=2020-01-01")).status, 400);
});

test("the summary is for people with discounts.view only (the owner, by default)", async () => {
  await staff("Reena", "receptionist", ["visit.create", "payments.view", "cashclose.manage"]);
  assert.equal((await call("GET", "/discounts/summary")).status, 403);
  await staff("Meera", "manager", ["discounts.view"]);
  assert.equal((await call("GET", "/discounts/summary")).status, 200);
  const { ROLE_DEFAULTS } = require("../constants/permissions");
  assert.ok(!ROLE_DEFAULTS.manager.includes("discounts.view"));
  assert.ok(!ROLE_DEFAULTS.receptionist.includes("discounts.view"));
});

test("only the owner changes the review percent; it is validated and audited", async () => {
  await staff("Meera", "manager", ["discounts.view"]);
  assert.equal((await call("PUT", "/discounts/settings", { reviewPercent: 10 })).status, 403);

  caller = OWNER;
  for (const bad of [-1, 101, "x", null]) {
    assert.equal((await call("PUT", "/discounts/settings", { reviewPercent: bad })).status, 400, String(bad));
  }
  assert.equal((await call("PUT", "/discounts/settings", { reviewPercent: 50 })).body.reviewPercent, 50);
  assert.equal((await call("GET", "/discounts/settings")).body.reviewPercent, 50);
  const log = await AuditLog.findOne({ action: "discount.threshold_changed" }).lean();
  assert.deepEqual([log.meta.from, log.meta.to], [30, 50]);
});

test("with the review percent at 50, a standard 50% desk discount is not highlighted", async () => {
  await staff("Reena", "receptionist", ["visit.create"]);
  await newVisit({ discountPercent: 50 });
  caller = OWNER;
  await call("PUT", "/discounts/settings", { reviewPercent: 50 });
  const r = await call("GET", "/discounts/summary");
  assert.equal(r.body.flagged.length, 0);
  assert.equal(r.body.staff[0].aboveThreshold, 0);
  assert.equal(r.body.staff[0].discountedVisits, 1); // still logged
});
