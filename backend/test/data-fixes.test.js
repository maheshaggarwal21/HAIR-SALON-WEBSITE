/**
 * @file test/data-fixes.test.js
 * @description Fix Numbers (D54): the receptionist's next-day list of wrong numbers.
 *
 * What must hold: today is never listed (a full day must pass), only close
 * typos of the same name are paired, a correction moves visits but never money,
 * the correction is recorded and reversible, and only people with
 * datafixes.manage can open any of it.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const { salonDate, addDays } = require("../utils/time");

let Visit, User, DataFix, AuditLog, evictPermissionCache;
let server;
let base;
let caller;

before(async () => {
  await startDb();
  Visit = require("../models/Visit");
  User = require("../models/User");
  DataFix = require("../models/DataFix");
  AuditLog = require("../models/AuditLog");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/data-fixes", require("../routes/dataFixes"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/data-fixes`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
const TODAY = salonDate();
const YESTERDAY = addDays(TODAY, -1);
const LAST_WEEK = addDays(TODAY, -7);

beforeEach(async () => {
  await clearDb();
  caller = OWNER;
});

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}
async function post(path, data) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  return { status: res.status, body: await res.json() };
}

let userN = 0;
async function staff(role, permissions) {
  const u = await User.collection.insertOne({ name: "Reena", email: `r${++userN}@example.com`, role, isActive: true, permissions });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name: "Reena", role };
}

function visit(name, contact, day, total, over = {}) {
  return Visit.create({
    schemaVersion: 2,
    name,
    contact,
    gender: "female",
    date: new Date(day),
    services: [{ name: "Hair cut", price: total }],
    filledBy: "Desk",
    subtotal: total,
    finalTotal: total,
    paymentMethod: "cash",
    cashAmount: total,
    paymentStatus: "success",
    assignmentStatus: "completed",
    ...over,
  });
}

// ── Access ───────────────────────────────────────────────────────────────────

test("only people with datafixes.manage can open Fix Numbers", async () => {
  await staff("receptionist", ["payments.view", "visit.create"]);
  assert.equal((await get("/?kind=duplicate")).status, 403);
  assert.equal((await post("/resolve", { key: "dup:1:2", kind: "duplicate", status: "dismissed" })).status, 403);

  await staff("receptionist", ["datafixes.manage"]);
  assert.equal((await get("/?kind=duplicate")).status, 200);
});

// ── Duplicates ───────────────────────────────────────────────────────────────

test("same name with one digit different is paired; the number with fewer visits is the likely typo", async () => {
  await visit("Jagdeep Singh", "9876543210", LAST_WEEK, 500);
  await visit("Jagdeep Singh", "9876543210", addDays(TODAY, -20), 500);
  await visit("Jagdeep Singh", "9876543211", YESTERDAY, 400);

  const { body } = await get("/?kind=duplicate");
  assert.equal(body.total, 1);
  const p = body.issues[0];
  assert.equal(p.confidence, "high");
  assert.equal(p.nameMatch, "identical");
  const typo = p.likelyWrong === "a" ? p.a : p.b;
  assert.equal(typo.contact, "9876543211");
  assert.equal(typo.visits, 1);
});

test("different people with similar numbers are not paired", async () => {
  await visit("Jagdeep Singh", "9876543210", LAST_WEEK, 500);
  await visit("Neha Verma", "9876543211", YESTERDAY, 400);
  assert.equal((await get("/?kind=duplicate")).body.total, 0);
});

test("a visit from today is not listed until a full day has passed", async () => {
  await visit("Jagdeep Singh", "9876543210", LAST_WEEK, 500);
  await visit("Jagdeep Singh", "9876543211", TODAY, 400);
  assert.equal((await get("/?kind=duplicate")).body.total, 0);
});

test("dismissing a pair hides it, and reopening brings it back", async () => {
  await visit("Jagdeep Singh", "9876543210", LAST_WEEK, 500);
  await visit("Jagdeep Singh", "9876543211", YESTERDAY, 400);
  const key = (await get("/?kind=duplicate")).body.issues[0].key;

  await post("/resolve", { key, kind: "duplicate", status: "dismissed", note: "twins" });
  assert.equal((await get("/?kind=duplicate")).body.total, 0);
  const done = (await get("/?kind=duplicate&status=resolved")).body;
  assert.equal(done.total, 1);
  assert.equal(done.issues[0].note, "twins");

  await post("/resolve", { key, kind: "duplicate", status: "open" });
  assert.equal((await get("/?kind=duplicate")).body.total, 1);
});

// ── Invalid numbers ──────────────────────────────────────────────────────────

test("a number that cannot be a real mobile is listed", async () => {
  await visit("Anil", "98765", YESTERDAY, 300);
  await visit("Sunita", "9876543210", YESTERDAY, 300);
  const { body } = await get("/?kind=invalid");
  assert.equal(body.total, 1);
  assert.equal(body.issues[0].contact, "98765");
});

// ── Correcting a number ──────────────────────────────────────────────────────

test("correcting a number moves the visits, keeps the money, and records the change", async () => {
  await visit("Jagdeep Singh", "9876543210", LAST_WEEK, 500);
  await visit("Jagdeep Singh", "9876543211", YESTERDAY, 400);
  const key = (await get("/?kind=duplicate")).body.issues[0].key;
  const before = await Visit.aggregate([{ $group: { _id: null, t: { $sum: "$finalTotal" } } }]);

  const r = await post("/correct-contact", { from: "9876543211", to: "9876543210", key, note: "typo" });
  assert.equal(r.status, 200);
  assert.equal(r.body.visitsMoved, 1);

  const all = await Visit.find().lean();
  assert.deepEqual([...new Set(all.map((v) => v.contact))], ["9876543210"]);
  const after = await Visit.aggregate([{ $group: { _id: null, t: { $sum: "$finalTotal" } } }]);
  assert.equal(after[0].t, before[0].t);

  const moved = all.find((v) => v.contactHistory?.length);
  assert.equal(moved.contactHistory[0].from, "9876543211");
  assert.equal(moved.contactHistory[0].to, "9876543210");
  assert.equal(await AuditLog.countDocuments({ action: "visit.contact_corrected" }), 1);
  assert.equal((await DataFix.findOne({ key })).status, "fixed");
  assert.equal((await get("/?kind=duplicate")).body.total, 0);
});

test("a correction needs a real number, a different number, and visits to move", async () => {
  await visit("Anil", "98765", YESTERDAY, 300);
  assert.equal((await post("/correct-contact", { from: "98765", to: "12345" })).status, 400);
  assert.equal((await post("/correct-contact", { from: "9000000000", to: "9876543210" })).status, 404); // nothing is filed under it
  assert.equal((await post("/correct-contact", { from: "9876543210", to: "9876543210" })).status, 400);
});

// ── Payments ─────────────────────────────────────────────────────────────────

test("without Razorpay keys the payments list says so instead of failing", async () => {
  const saved = [process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET];
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  try {
    const { status, body } = await get("/?kind=payment");
    assert.equal(status, 200);
    assert.equal(body.total, 0);
    assert.match(body.warning, /Razorpay/);
  } finally {
    [process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET] = saved;
  }
});

test("a paid visit still waiting for its artists is listed", async () => {
  await visit("Anmol", "9056663585", YESTERDAY, 150, { assignmentStatus: "pending" });
  await visit("Today Guest", "9056663586", TODAY, 150, { assignmentStatus: "pending" });
  const { body } = await get("/?kind=unassigned");
  assert.equal(body.total, 1);
  assert.equal(body.issues[0].name, "Anmol");
});
