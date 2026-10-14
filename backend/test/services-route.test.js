/**
 * @file test/services-route.test.js
 * @description Service Management keeps the website fields in step with the
 * owner's rules (13 Oct 2026): website price = half the list price, a new
 * service starts at a one-hour ESTIMATE that artist time-performance ignores
 * until the owner types the real time, and every change is audited.
 *
 * The real router is mounted behind a stub session (owner), so these tests run
 * the same validation and update code the staff app hits.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let server;
let base;
let Service;
let AuditLog;

const OWNER_ID = new mongoose.Types.ObjectId();

before(async () => {
  await startDb();
  Service = require("../models/Service");
  AuditLog = require("../models/AuditLog");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: OWNER_ID, name: "Owner", role: "owner" };
    next();
  });
  app.use("/api/services", require("../routes/services"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/services`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopDb();
});

beforeEach(clearDb);

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test("a new service gets the half price and an unconfirmed one-hour estimate", async () => {
  const { status, body } = await call("POST", "/", { name: "Root Touch-up", price: 1599 });
  assert.equal(status, 201);
  assert.equal(body.publicPrice, 800); // round(799.5)
  assert.equal(body.durationMinutes, 60);
  assert.equal(body.durationConfirmed, false);
  assert.equal(Service.performanceDuration(body), null);

  const log = await AuditLog.findOne({ action: "service.created" }).lean();
  assert.equal(log.targetName, "Root Touch-up");
  assert.equal(log.meta.publicPrice, 800);
});

test("a duration the owner types in is kept and confirmed, including one under an hour", async () => {
  const { body } = await call("POST", "/", { name: "Eyebrows (Thread)", price: 100, durationMinutes: 15 });
  assert.equal(body.durationMinutes, 15);
  assert.equal(body.durationConfirmed, true);

  const edited = await call("PATCH", `/${body._id}`, { durationMinutes: 20 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.durationMinutes, 20);
  assert.equal(Service.performanceDuration(edited.body), 20);
});

test("editing other fields leaves an estimate unconfirmed; typing a time confirms it", async () => {
  const { body } = await call("POST", "/", { name: "Side Locks (Thread)", price: 400 });
  // The staff app omits durationMinutes when the estimate box is left blank.
  const renamed = await call("PATCH", `/${body._id}`, { name: "Side Locks", price: 400 });
  assert.equal(renamed.body.durationMinutes, 60);
  assert.equal(renamed.body.durationConfirmed, false);

  const timed = await call("PATCH", `/${body._id}`, { durationMinutes: 45 });
  assert.equal(timed.body.durationConfirmed, true);
  const log = await AuditLog.findOne({ action: "service.updated", "meta.changes.durationConfirmed": { $exists: true } }).lean();
  assert.deepEqual(log.meta.changes.durationMinutes, { from: 60, to: 45 });

  const cleared = await call("PATCH", `/${body._id}`, { durationMinutes: null });
  assert.equal(cleared.body.durationMinutes, null);
  assert.equal(cleared.body.durationConfirmed, false);
});

test("changing the list price moves the website price with it", async () => {
  const { body } = await call("POST", "/", { name: "Hair Spa", price: 2000 });
  const edited = await call("PATCH", `/${body._id}`, { price: 2400 });
  assert.equal(edited.body.publicPrice, 1200);

  const log = await AuditLog.findOne({ action: "service.updated" }).lean();
  assert.deepEqual(log.meta.changes.price, { from: 2000, to: 2400 });
  assert.deepEqual(log.meta.changes.publicPrice, { from: 1000, to: 1200 });
});

test("a website price the owner set by hand is not overwritten by a list-price change", async () => {
  const { body } = await call("POST", "/", { name: "Bridal Makeup", price: 20000 });
  await Service.updateOne({ _id: body._id }, { $set: { publicPrice: 12000 } });

  const edited = await call("PATCH", `/${body._id}`, { price: 22000 });
  assert.equal(edited.body.price, 22000);
  assert.equal(edited.body.publicPrice, 12000);
});

test("an edit that changes nothing writes no audit line", async () => {
  const { body } = await call("POST", "/", { name: "Head Massage", price: 500 });
  await call("PATCH", `/${body._id}`, { price: 500 });
  assert.equal(await AuditLog.countDocuments({ action: "service.updated" }), 0);
});

test("deactivating and deleting are audited", async () => {
  const { body } = await call("POST", "/", { name: "Any item", price: 0 });
  assert.equal((await call("DELETE", `/${body._id}`)).status, 200);
  assert.equal((await call("DELETE", `/${body._id}/permanent`)).status, 200);
  assert.equal(await AuditLog.countDocuments({ action: "service.deactivated" }), 1);
  assert.equal(await AuditLog.countDocuments({ action: "service.deleted" }), 1);
});
