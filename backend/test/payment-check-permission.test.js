/**
 * @file test/payment-check-permission.test.js
 * @description `paymentcheck.manage`: a permission the owner can tick per person (staff permission checklist) to use the
 * "Payment ID check: Log only / Enforce" switch and the Payment log errors tab (D70). It is IN ADDITION to the
 * permissions that already opened those (visit.create / datafixes.manage), so nobody loses access they have today.
 * With only the new permission a person gets the switch and the Payment log errors tab, not the other Fix Numbers tabs.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb } = require("./helpers/db");
const { PERMISSIONS, PERMISSION_LABELS, PERMISSION_GROUPS, ROLE_DEFAULTS } = require("../constants/permissions");

let shim, shimBase, caller, User, AuditLog, evictPermissionCache;

before(async () => {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "", META_WA_TOKEN: "", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", PUBLIC_TOKEN_SECRET: "t" });
  await startDb();
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
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
  await new Promise((r) => shim.close(r));
  await stopDb();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), AuditLog.deleteMany({}), require("../models/DataFix").deleteMany({})]);
});

const as = async (role, permissions) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, name: "Tester", email: `${_id}@t.example`, role, isActive: true, permissions });
  evictPermissionCache(String(_id));
  caller = { userId: _id, name: "Tester", role };
};
const call = (method, p, body) =>
  fetch(`${shimBase}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const KEY = PERMISSIONS.PAYMENT_CHECK_MANAGE;
const OTHER_KINDS = ["duplicate", "invalid", "payment", "unassigned", "reference"];

test("the permission exists, is labelled so it shows in the checklist, sits in a group, and new managers and receptionists get it", () => {
  assert.equal(KEY, "paymentcheck.manage");
  assert.match(PERMISSION_LABELS[KEY], /Payment ID check/);
  assert.ok(PERMISSION_GROUPS.some((g) => g.keys.includes(KEY)), "listed in a checklist group");
  assert.ok(ROLE_DEFAULTS.receptionist.includes(KEY));
  assert.ok(ROLE_DEFAULTS.manager.includes(KEY));
  assert.ok(!ROLE_DEFAULTS.artist.includes(KEY));
});

test("the switch: the new permission alone is enough; the old ones still work; nothing at all is refused", async () => {
  await as("receptionist", [KEY]);
  assert.equal((await call("GET", "/api/payment-id-check")).status, 200);
  assert.equal((await call("PUT", "/api/payment-id-check", { mode: "enforce" })).status, 200);
  assert.equal((await call("PUT", "/api/payment-id-check", { mode: "log" })).status, 200);
  assert.ok(await AuditLog.findOne({ action: "payment.id_check_mode_changed", actorRole: "receptionist" }), "audited with who");
  for (const old of ["visit.create", "datafixes.manage"]) {
    await as("receptionist", [old]);
    assert.equal((await call("GET", "/api/payment-id-check")).status, 200, `${old} still works (no one loses access)`);
  }
  await as("receptionist", ["bookings.view"]);
  assert.equal((await call("GET", "/api/payment-id-check")).status, 403);
  await as("artist", []);
  assert.equal((await call("PUT", "/api/payment-id-check", { mode: "enforce" })).status, 403);
});

test("Payment log errors: the new permission alone can list, check, dismiss with a note and reopen", async () => {
  await as("receptionist", [KEY]);
  assert.equal((await call("GET", "/api/data-fixes?kind=payment_id&status=open")).status, 200);
  const done = await call("POST", "/api/data-fixes/resolve", { key: "pid:pay_x:none:not_found", kind: "payment_id", status: "fixed", note: "checked in Razorpay" });
  assert.equal(done.status, 200);
  assert.ok(await AuditLog.findOne({ action: "datafix.resolved", "meta.kind": "payment_id" }));
  assert.equal((await call("POST", "/api/data-fixes/resolve", { key: "pid:pay_x:none:not_found", kind: "payment_id", status: "open" })).status, 200);
  assert.equal((await call("POST", "/api/data-fixes/resolve", { key: "pid:pay_x:none:not_found", kind: "payment_id", status: "fixed" })).status, 400, "the note is still required");
});

test("with ONLY the new permission, the other Fix Numbers tabs and corrections stay closed (403)", async () => {
  await as("receptionist", [KEY]);
  for (const kind of OTHER_KINDS) assert.equal((await call("GET", `/api/data-fixes?kind=${kind}`)).status, 403, kind);
  assert.equal((await call("POST", "/api/data-fixes/resolve", { key: "dup:1:2", kind: "duplicate", status: "dismissed" })).status, 403);
  assert.equal((await call("POST", "/api/data-fixes/correct-contact", { from: "9876543210", to: "9876543211" })).status, 403);
});

test("a payment_id decision must use a payment-id key, so the new permission cannot write other kinds of rows", async () => {
  await as("receptionist", [KEY]);
  const r = await call("POST", "/api/data-fixes/resolve", { key: "dup:9876543210:9876543211", kind: "payment_id", status: "dismissed", note: "x" });
  assert.equal(r.status, 400);
  assert.equal(await require("../models/DataFix").countDocuments(), 0);
});

test("datafixes.manage alone keeps everything it had, including Payment log errors (no one loses access)", async () => {
  await as("receptionist", ["datafixes.manage"]);
  for (const kind of [...OTHER_KINDS.filter((k) => k !== "payment" && k !== "reference"), "payment_id"]) assert.equal((await call("GET", `/api/data-fixes?kind=${kind}`)).status, 200, kind);
});

test("no permission at all: everything is refused", async () => {
  await as("receptionist", ["visit.create"]);
  assert.equal((await call("GET", "/api/data-fixes?kind=payment_id")).status, 403, "visit.create opens the switch but not the Fix Numbers page");
  await as("artist", []);
  assert.equal((await call("GET", "/api/data-fixes?kind=payment_id")).status, 403);
});

test("the owner is never blocked", async () => {
  await as("owner", []);
  assert.equal((await call("GET", "/api/data-fixes?kind=duplicate")).status, 200);
  assert.equal((await call("GET", "/api/payment-id-check")).status, 200);
});
