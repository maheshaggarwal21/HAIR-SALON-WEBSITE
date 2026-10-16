/**
 * @file test/desk-customer-history.test.js
 * @description The front desk's customer lookup and payment history (CF D39).
 *
 * The owner's ask, 14 Oct 2026: regulars don't want to read out their number
 * every visit, so the receptionist must be able to find them BY NAME, see what
 * that one client has paid since their first visit, and see yesterday's
 * payments as well as today's — and the totals for just those two days, never older revenue.
 *
 * Everything that keeps the receptionist away from revenue is enforced by the
 * server, so that is what these tests pin down: the date clamp, the per-client
 * exception to it, and the missing summary.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const { salonDate, addDays } = require("../utils/time");

let Visit, User, evictPermissionCache;
let server;
let base;
/** Who the stub session says is calling. Set per test. */
let caller;

before(async () => {
  await startDb();
  Visit = require("../models/Visit");
  User = require("../models/User");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/visits", require("../routes/visits"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/visits`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
const TODAY = salonDate();
const YESTERDAY = addDays(TODAY, -1);
const LAST_MONTH = addDays(TODAY, -30);

beforeEach(async () => {
  await clearDb();
  caller = OWNER;
});

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

let userN = 0;
async function staff(role, permissions) {
  const u = await User.collection.insertOne({
    name: "Reena",
    email: `reena${++userN}@example.com`,
    role,
    isActive: true,
    permissions,
  });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name: "Reena", role };
}

/** The receptionist as the owner has set them up: payments, but the front-desk view. */
const DESK = ["payments.view", "payments.today_only", "visit.create"];

/** A paid visit on an IST calendar day, stored the way the visit form stores it. */
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

// ── Name lookup ──────────────────────────────────────────────────────────────

test("name search finds a returning client by any word of their name", async () => {
  await visit("Rahul Sharma", "9876500001", LAST_MONTH, 500);
  await visit("Rahul Sharma", "9876500001", YESTERDAY, 700);
  await visit("Amit Rahul", "9876500002", TODAY, 300);
  await visit("Neeraj Kumar", "9876500003", TODAY, 300);
  await staff("receptionist", DESK);

  const { status, body } = await get("/customers/search?name=rah");
  assert.equal(status, 200);
  // "rah" starts a word in both Rahuls; it is inside "Neeraj" but starts no word.
  assert.deepEqual(body.customers.map((c) => c.contact).sort(), ["9876500001", "9876500002"]);

  const rahul = body.customers.find((c) => c.contact === "9876500001");
  assert.equal(rahul.name, "Rahul Sharma");
  assert.equal(rahul.visitCount, 2);
  assert.equal(new Date(rahul.firstVisitDate).toISOString().slice(0, 10), LAST_MONTH);
  assert.equal(new Date(rahul.lastVisitDate).toISOString().slice(0, 10), YESTERDAY);
  // A lookup, not a ledger: no money in the result.
  assert.deepEqual(
    Object.keys(rahul).sort(),
    ["contact", "firstVisitDate", "gender", "lastSeenAt", "lastVisitDate", "name", "visitCount"]
  );
});

test("every word typed must match, so 'rahul sh' narrows to one person", async () => {
  await visit("Rahul Sharma", "9876500001", TODAY, 500);
  await visit("Rahul Verma", "9876500002", TODAY, 500);
  await staff("receptionist", DESK);

  const { body } = await get("/customers/search?name=" + encodeURIComponent("rahul  SH"));
  assert.deepEqual(body.customers.map((c) => c.contact), ["9876500001"]);
});

test("name search treats regex characters as text and rejects one-letter queries", async () => {
  await visit("Rahul Sharma", "9876500001", TODAY, 500);
  await staff("receptionist", DESK);

  assert.equal((await get("/customers/search?name=" + encodeURIComponent(".*"))).body.customers.length, 0);
  assert.equal((await get("/customers/search?name=r")).status, 400);
});

test("an unpaid or unassigned visit is not a returning client", async () => {
  await visit("Rahul Sharma", "9876500001", TODAY, 500, { paymentStatus: "pending" });
  await visit("Rahul Sharma", "9876500002", TODAY, 500, { assignmentStatus: "pending" });
  await staff("receptionist", DESK);

  assert.equal((await get("/customers/search?name=rahul")).body.customers.length, 0);
});

test("phone search still works and reports the visit count", async () => {
  await visit("Rahul Sharma", "9876500001", LAST_MONTH, 500);
  await visit("Rahul Sharma", "9876500001", TODAY, 500);
  await staff("receptionist", DESK);

  const { body } = await get("/customers/search?phone=98765");
  assert.equal(body.customers.length, 1);
  assert.equal(body.customers[0].visitCount, 2);
});

test("lookup is open to payments.view (Payment History) as well as visit.create", async () => {
  await visit("Rahul Sharma", "9876500001", TODAY, 500);

  await staff("manager", ["payments.view"]);
  assert.equal((await get("/customers/search?name=rahul")).status, 200);

  await staff("artist", ["artist_dashboard.view"]);
  assert.equal((await get("/customers/search?name=rahul")).status, 403);
});

// ── Payment history, front-desk view ─────────────────────────────────────────

test("front desk sees today and yesterday, nothing older, whatever dates it asks for", async () => {
  await visit("Today Client", "9876500001", TODAY, 100);
  await visit("Yesterday Client", "9876500002", YESTERDAY, 200);
  await visit("Old Client", "9876500003", LAST_MONTH, 400);
  await staff("receptionist", DESK);

  const wide = await get(`/history?from=${LAST_MONTH}&to=${TODAY}`);
  assert.equal(wide.status, 200);
  assert.deepEqual(wide.body.visits.map((v) => v.name).sort(), ["Today Client", "Yesterday Client"]);
  assert.equal(wide.body.restricted, true);
  assert.deepEqual(wide.body.window, { from: YESTERDAY, to: TODAY });

  const onlyYesterday = await get(`/history?from=${YESTERDAY}&to=${YESTERDAY}`);
  assert.deepEqual(onlyYesterday.body.visits.map((v) => v.name), ["Yesterday Client"]);

  const onlyOld = await get(`/history?from=${LAST_MONTH}&to=${LAST_MONTH}`);
  assert.equal(onlyOld.body.visits.length, 0);
});

test("front desk gets totals for today and yesterday only, never older money", async () => {
  await visit("Today Client", "9876500001", TODAY, 100);
  await visit("Yesterday Client", "9876500002", YESTERDAY, 250);
  await visit("Old Client", "9876500003", LAST_MONTH, 9000);
  await staff("receptionist", DESK);

  const { body } = await get(`/history?from=${LAST_MONTH}&to=${TODAY}`);
  assert.equal(body.visits.length, 2);
  assert.equal(body.summary.totalRevenue, 350);
  assert.equal(body.summary.count, 2);
});

test("front desk sees ONE client's history since their first visit, without totals", async () => {
  await visit("Rahul Sharma", "9876500001", LAST_MONTH, 500);
  await visit("Rahul Sharma", "9876500001", TODAY, 700);
  await visit("Someone Else", "9876500002", LAST_MONTH, 900);
  await staff("receptionist", DESK);

  const { status, body } = await get(`/history?contact=9876500001&from=${TODAY}&to=${TODAY}`);
  assert.equal(status, 200);
  // Dates are ignored for a client's history: last month's visit is included.
  assert.deepEqual(body.visits.map((v) => v.finalTotal), [700, 500]);
  assert.equal(body.summary, null);
  assert.equal(body.range, null);
});

test("a contact filter is an exact match, not a pattern", async () => {
  await visit("Rahul Sharma", "9876500001", LAST_MONTH, 500);
  await staff("receptionist", DESK);

  assert.equal((await get("/history?contact=98765")).body.visits.length, 0);
  assert.equal((await get("/history?contact=" + encodeURIComponent(".*"))).body.visits.length, 0);
});

test("the owner and unrestricted accounts keep full history and totals", async () => {
  await visit("Today Client", "9876500001", TODAY, 100);
  await visit("Old Client", "9876500003", LAST_MONTH, 400);

  for (const who of [() => (caller = OWNER), () => staff("manager", ["payments.view"])]) {
    await who();
    const { body } = await get(`/history?from=${LAST_MONTH}&to=${TODAY}`);
    assert.equal(body.restricted, false);
    assert.equal(body.visits.length, 2);
    assert.equal(body.summary.totalRevenue, 500);
  }

  // The owner is never restricted, even holding the key.
  await staff("owner", DESK);
  const { body } = await get(`/history?from=${LAST_MONTH}&to=${TODAY}`);
  assert.equal(body.summary.totalRevenue, 500);
});

test("dates must be YYYY-MM-DD", async () => {
  assert.equal((await get("/history?from=yesterday")).status, 400);
  assert.equal((await get("/history?from=2026-02-30")).status, 400);
});
