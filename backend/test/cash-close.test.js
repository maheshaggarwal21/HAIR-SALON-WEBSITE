/**
 * @file test/cash-close.test.js
 * @description Daily cash close (D60, part C).
 *
 * What must hold: the count is blind (nothing about the day's cash is shown before it is
 * submitted), expected cash counts only the CASH part of paid visits, a day closes once and
 * cannot be edited by receptionist or manager, and the owner corrects by adding an audited
 * adjustment that leaves the original untouched.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const { salonDate, addDays } = require("../utils/time");

let Visit, User, DailyCashClose, AuditLog, evictPermissionCache;
let server;
let base;
let caller;

before(async () => {
  await startDb();
  Visit = require("../models/Visit");
  User = require("../models/User");
  DailyCashClose = require("../models/DailyCashClose");
  AuditLog = require("../models/AuditLog");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  await DailyCashClose.init();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/cash-close", require("../routes/cashClose"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/cash-close`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const TODAY = salonDate();
const YESTERDAY = addDays(TODAY, -1);
let userN = 0;
async function staff(name, role, permissions) {
  const u = await User.collection.insertOne({ name, email: `k${++userN}@example.com`, role, isActive: true, permissions });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name, role };
}
async function call(method, path, data) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function visit(day, parts, over = {}) {
  const finalTotal = (parts.cash || 0) + (parts.card || 0) + (parts.online || 0);
  return Visit.create({
    schemaVersion: 2,
    name: "A",
    contact: "9876543210",
    gender: "female",
    filledBy: "Reena",
    date: new Date(day),
    services: [{ name: "Cut", price: finalTotal }],
    subtotal: finalTotal,
    finalTotal,
    paymentMethod: parts.cash && !parts.card && !parts.online ? "cash" : parts.card ? "card" : parts.cash ? "partial" : "online",
    cashAmount: parts.cash || 0,
    cardAmount: parts.card || 0,
    onlineAmount: parts.online || 0,
    paymentStatus: "success",
    ...over,
  });
}

beforeEach(async () => {
  await clearDb();
  await staff("Reena", "receptionist", ["cashclose.manage"]);
});

test("before counting, the screen is told nothing about the day's cash", async () => {
  await visit(TODAY, { cash: 500 });
  const r = await call("GET", `/day/${TODAY}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["closed", "day", "suggestedFrom", "suggestedOpeningFloat"]);
  assert.ok(!/500|expected|cashSales/i.test(JSON.stringify(r.body)));
});

test("expected cash = opening float + the CASH part of paid visits − cash taken out; card and UPI never count", async () => {
  await visit(TODAY, { cash: 500 }); // cash only
  await visit(TODAY, { cash: 200, online: 300 }); // split: only 200 is in the drawer
  await visit(TODAY, { card: 400 });
  await visit(TODAY, { online: 300 });
  await visit(TODAY, { cash: 999 }, { paymentStatus: "failed" }); // never paid
  await visit(YESTERDAY, { cash: 111 }); // another day
  const r = await call("POST", "/", {
    day: TODAY,
    countedCash: 1590,
    openingFloat: 1000,
    cashTakenOut: [{ reason: "Tea and milk", amount: 100 }],
    leftInDrawer: 1000,
  });
  assert.equal(r.status, 201);
  const c = r.body.record;
  assert.deepEqual(
    [c.cashSales, c.cashSalesVisits, c.takenOutTotal, c.expectedCash, c.countedCash, c.difference, c.banked],
    [700, 2, 100, 1600, 1590, -10, 590]
  );
  assert.equal(c.closedBy, "Reena");
});

test("a day closes once: no resubmit, not even at the same moment", async () => {
  const body = { day: TODAY, countedCash: 100, leftInDrawer: 0 };
  const [a, b] = await Promise.all([call("POST", "/", body), call("POST", "/", body)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const again = await call("POST", "/", { ...body, countedCash: 999 });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already closed/);
  assert.equal((await DailyCashClose.findOne({ day: TODAY })).countedCash, 100);
  assert.equal(await DailyCashClose.countDocuments(), 1);
});

test("after closing, the day shows its record; there is no way to edit or delete it", async () => {
  await call("POST", "/", { day: TODAY, countedCash: 100, leftInDrawer: 0 });
  const r = await call("GET", `/day/${TODAY}`);
  assert.equal(r.body.closed, true);
  assert.equal(r.body.record.countedCash, 100);
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    assert.equal((await call(m, `/${TODAY}`, { countedCash: 5 })).status, 404, m);
  }
});

test("opening float defaults to the previous close's 'left in drawer', and can be overridden", async () => {
  await call("POST", "/", { day: YESTERDAY, countedCash: 2500, leftInDrawer: 1500, openingFloat: 0 });
  assert.equal((await call("GET", `/day/${TODAY}`)).body.suggestedOpeningFloat, 1500);

  await visit(TODAY, { cash: 300 });
  const a = await call("POST", "/", { day: TODAY, countedCash: 1800, leftInDrawer: 1500 });
  assert.equal(a.body.record.openingFloat, 1500);
  assert.equal(a.body.record.openingFloatSource, "previous_close");
  assert.equal(a.body.record.expectedCash, 1800);
  assert.equal(a.body.record.difference, 0);

  await DailyCashClose.deleteMany({ day: TODAY });
  const b = await call("POST", "/", { day: TODAY, countedCash: 1000, leftInDrawer: 0, openingFloat: 700 });
  assert.deepEqual([b.body.record.openingFloat, b.body.record.openingFloatSource, b.body.record.expectedCash], [700, "entered", 1000]);
});

test("the first ever close has a float of 0 unless one is entered", async () => {
  const r = await call("GET", `/day/${TODAY}`);
  assert.deepEqual([r.body.suggestedOpeningFloat, r.body.suggestedFrom], [0, null]);
});

test("a day with no cash at all closes with expected = the float", async () => {
  const r = await call("POST", "/", { day: TODAY, countedCash: 0, leftInDrawer: 0 });
  assert.deepEqual([r.body.record.cashSales, r.body.record.expectedCash, r.body.record.difference], [0, 0, 0]);
});

test("bad input is refused: paise, negatives, future days, reasonless or zero cash-outs, more left than counted", async () => {
  const ok = { day: TODAY, countedCash: 100, leftInDrawer: 0 };
  const bad = async (over, re) => {
    const r = await call("POST", "/", { ...ok, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.body.error, re);
  };
  await bad({ countedCash: 100.5 }, /whole rupees/);
  await bad({ countedCash: -1 }, /whole rupees/);
  await bad({ countedCash: "" }, /whole rupees/);
  await bad({ day: addDays(TODAY, 1) }, /not in the future/);
  await bad({ day: "2026-02-30" }, /real day/);
  await bad({ leftInDrawer: 500 }, /more in the drawer/);
  await bad({ openingFloat: -5 }, /Opening float/);
  await bad({ cashTakenOut: [{ reason: "", amount: 50 }] }, /reason/);
  await bad({ cashTakenOut: [{ reason: "Tea", amount: 0 }] }, /1 rupee or more/);
  await bad({ cashTakenOut: [{ reason: "Tea", amount: 10.5 }] }, /1 rupee or more/);
  await bad({ cashTakenOut: Array.from({ length: 11 }, () => ({ reason: "x", amount: 1 })) }, /At most/);
  assert.equal(await DailyCashClose.countDocuments(), 0);
});

test("a missed day can be closed afterwards, with that day's own cash", async () => {
  await visit(YESTERDAY, { cash: 400 });
  await visit(TODAY, { cash: 900 });
  const r = await call("POST", "/", { day: YESTERDAY, countedCash: 400, leftInDrawer: 0 });
  assert.deepEqual([r.body.record.cashSales, r.body.record.expectedCash], [400, 400]);
});

test("only people with cashclose.manage can use it; the owner always can", async () => {
  await staff("Meera", "manager", ["visit.create"]);
  assert.equal((await call("GET", `/day/${TODAY}`)).status, 403);
  assert.equal((await call("POST", "/", { day: TODAY, countedCash: 1, leftInDrawer: 0 })).status, 403);
  await staff("Owner", "owner", []);
  assert.equal((await call("GET", `/day/${TODAY}`)).status, 200);
  const { ROLE_DEFAULTS } = require("../constants/permissions");
  assert.ok(ROLE_DEFAULTS.receptionist.includes("cashclose.manage") && ROLE_DEFAULTS.manager.includes("cashclose.manage"));
});

test("only the owner can adjust; it needs a reason, is audited, and leaves the original numbers alone", async () => {
  await visit(TODAY, { cash: 500 });
  await call("POST", "/", { day: TODAY, countedCash: 450, leftInDrawer: 0 });

  assert.equal((await call("POST", `/${TODAY}/adjustments`, { delta: 50, reason: "recount" })).status, 403);
  await staff("Meera", "manager", ["cashclose.manage"]);
  assert.equal((await call("POST", `/${TODAY}/adjustments`, { delta: 50, reason: "recount" })).status, 403);

  await staff("Owner", "owner", []);
  assert.equal((await call("POST", `/${TODAY}/adjustments`, { delta: 50 })).status, 400);
  assert.equal((await call("POST", `/${TODAY}/adjustments`, { delta: 0, reason: "x" })).status, 400);
  assert.equal((await call("POST", `/${TODAY}/adjustments`, { delta: 1.5, reason: "x" })).status, 400);
  assert.equal((await call("POST", `/2020-01-01/adjustments`, { delta: 5, reason: "x" })).status, 404);

  const r = await call("POST", `/${TODAY}/adjustments`, { delta: 50, reason: "Found 50 in the cash box, recounted" });
  assert.equal(r.status, 201);
  const rec = r.body.record;
  assert.deepEqual([rec.countedCash, rec.difference, rec.effectiveCountedCash, rec.effectiveDifference], [450, -50, 500, 0]);
  assert.equal(rec.adjustments.length, 1);
  assert.equal(rec.adjustments[0].by, "Owner");

  const raw = await DailyCashClose.findOne({ day: TODAY }).lean();
  assert.deepEqual([raw.countedCash, raw.expectedCash, raw.difference], [450, 500, -50], "the original is untouched");
  const log = await AuditLog.findOne({ action: "cash_close.adjusted" }).lean();
  assert.deepEqual([log.meta.day, log.meta.delta], [TODAY, 50]);
  assert.ok(await AuditLog.findOne({ action: "cash_close.closed" }));
});

test("history lists every recent day, closed or not", async () => {
  await call("POST", "/", { day: YESTERDAY, countedCash: 10, leftInDrawer: 0 });
  const r = await call("GET", "/?days=3");
  assert.deepEqual(r.body.days.map((d) => [d.day, d.closed]), [[TODAY, false], [YESTERDAY, true], [addDays(TODAY, -2), false]]);
  assert.equal(r.body.days[1].record.countedCash, 10);
});
