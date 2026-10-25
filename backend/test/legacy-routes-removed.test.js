/**
 * @file test/legacy-routes-removed.test.js
 * @description Audit #11: the old "save a visit" (POST /api/visits) and "make a payment link"
 * (POST /api/create-payment-link) routes are gone: nothing called them, and the visit one skipped
 * the payment checks the current routes have. What stays: GET /api/verify-payment (old payment
 * links may still be in customers' hands), POST /api/visits/v2 and the order routes.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let server, base, cookie, User;

before(async () => {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "", META_WA_TOKEN: "", PUBLIC_TOKEN_SECRET: "t", RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" });
  await startDb();
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
  User = require("../models/User");
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  await User.collection.insertOne({ name: "Owner", email: "owner@test.example", passwordHash: await bcrypt.hash("Owner@12345", 4), role: "owner", isActive: true, permissions: [] });
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@test.example", password: "Owner@12345" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
});

const call = (method, path, body) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));

test("POST /api/visits (the old create) no longer exists", async () => {
  const r = await call("POST", "/visits", { name: "Asha", contact: "9876543210", gender: "female", date: "2026-10-26", startTime: "11:00", endTime: "12:00", artist: "x", serviceIds: [] });
  assert.equal(r.status, 404);
});

test("POST /api/create-payment-link no longer exists", async () => {
  const r = await call("POST", "/create-payment-link", { name: "Asha", phone: "9876543210", amount: 500 });
  assert.equal(r.status, 404);
});

test("what stays: verify-payment (old links), visits/v2, create-order, verify-order-payment and order-status still answer", async () => {
  const v = await call("GET", "/verify-payment");
  assert.equal(v.status, 400, "the old payment-link check is still there");
  assert.match(v.text, /Missing payment parameters/);
  const v2 = await call("POST", "/visits/v2", {});
  assert.equal(v2.status, 400, "visits/v2 is still there (validation, not 404)");
  assert.match(v2.text, /Name is required/);
  assert.notEqual((await call("POST", "/create-order", { name: "A", phone: "9876543210" })).status, 404);
  assert.equal((await call("POST", "/verify-order-payment", {})).status, 400);
  assert.notEqual((await call("GET", "/order-status/order_x")).status, 404);
});
