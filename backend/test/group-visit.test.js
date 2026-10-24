/**
 * @file test/group-visit.test.js
 * @description Group bookings at billing (D67): each Visit service row of a 2+ person
 * booking says which person it is for, as DISPLAY ONLY. Money, artists and analytics must
 * be exactly what they were: the same bill, the same totals, the same analytics output.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.META_WA_TOKEN = "";
process.env.PUBLIC_TOKEN_SECRET = "t";

let Appointment, Artist, Service, Visit, time, server, base;
let svcs, A, B, DAY;

before(async () => {
  await startDb();
  Appointment = require("../models/Appointment");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  Visit = require("../models/Visit");
  time = require("../utils/time");
  require("../models/SiteSettings");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: new mongoose.Types.ObjectId(), name: "Reena", role: "owner" };
    next();
  });
  app.use("/api/visits", require("../routes/visits"));
  app.use("/api/analytics", require("../routes/analytics"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  DAY = time.salonDate();
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true, audience: "her", displayCategory: "Hair" };
  svcs = await Service.create([
    { ...common, name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", durationMinutes: 45 },
    { ...common, name: "Blow-dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
  ]);
  [A, B] = await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female" },
    { name: "Ravi", phone: "9888800002", commission: 30, gender: "male" },
  ]);
});

async function call(method, path, data) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let refN = 0;
async function booking(guestNames) {
  const start = time.salonInstant(DAY, "11:00").getTime();
  const guests = guestNames.map((name, i) => {
    const s = svcs[i % 2];
    const artist = i % 2 ? B : A;
    return {
      guestKey: `g${i + 1}`, name, gender: "female",
      items: [{ serviceId: s._id, name: s.name, publicPrice: s.publicPrice, listPrice: s.price, durationMin: s.durationMinutes, bufferMin: 0, artistId: artist._id, artistName: artist.name, startAt: new Date(start), endAt: new Date(start + s.durationMinutes * 60_000) }],
    };
  });
  return Appointment.create({
    ref: `EXP-V${String(++refN).padStart(4, "2")}`, mode: "instant", status: "checked_in",
    contact: "9876543210", name: "Booker Singh", guests,
    startAt: new Date(start), endAt: new Date(start + 45 * 60_000),
    pricing: { subtotal: 800, total: 800 }, deposit: { required: false, amount: 0, status: "none" },
    source: { channel: "web" }, statusHistory: [{ from: null, to: "checked_in", at: new Date(), by: "staff" }],
  });
}
const bill = (a) => call("POST", "/visits/v2", { appointmentId: String(a._id), paymentMethod: "cash", gender: "female" });

test("a 2-person booking: each Visit row says who it is for; a person with no name is not the booker", async () => {
  const a = await booking(["Asha", null]);
  const r = await bill(a);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.deepEqual(v.services.map((s) => s.guestName), ["Asha", "Booker Singh (guest 2)"]);
  const draft = await call("GET", `/visits/${v._id}/assignment-draft`);
  assert.deepEqual(draft.body.services.map((s) => s.guestName), ["Asha", "Booker Singh (guest 2)"]);
});

test("a one-person booking: the Visit rows have no guestName at all (shape unchanged)", async () => {
  const a = await booking(["Solo"]);
  const r = await bill(a);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const raw = await Visit.collection.findOne({ _id: new mongoose.Types.ObjectId(r.body.visitId) });
  assert.ok(raw.services.every((s) => !("guestName" in s)));
  const draft = await call("GET", `/visits/${raw._id}/assignment-draft`);
  assert.equal(draft.body.services[0].guestName, null);
});

test("money is untouched: same bill, same split, artists and times still prefilled per row", async () => {
  const a = await booking(["Asha", "Bina"]);
  const r = await bill(a);
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.subtotal, 800);
  assert.equal(v.finalTotal, 800);
  assert.equal(v.services.reduce((n, s) => n + s.price, 0), 800);
  assert.equal(v.cashAmount + v.cardAmount + v.onlineAmount, v.finalTotal, "CLAUDE.md invariant");
  assert.deepEqual(v.services.map((s) => s.artistName), ["Mansi Kumari", "Ravi"]);
  assert.equal((await Appointment.findById(a._id)).status, "completed");
});

test("analytics and revenue totals are identical with and without guestName", async () => {
  const a = await booking(["Asha", "Bina"]);
  const r = await bill(a);
  await Visit.updateOne({ _id: r.body.visitId }, { $set: { assignmentStatus: "completed" } });
  const range = (from, to) => `from=${from}&to=${to}`;
  const today = DAY;
  const day = (n) => time.addDays(today, n);
  const ask = async (qs) => ({
    summary: (await call("GET", `/analytics/summary?${qs}`)).body,
    top: (await call("GET", `/analytics/top-services?${qs}`)).body,
    employees: (await call("GET", `/analytics/employees?${qs}`)).body,
  });
  const withName = await ask(range(day(-1), day(1)));
  assert.equal(withName.summary.totalRevenue, 800);
  assert.equal(withName.summary.totalVisits, 1);
  assert.ok(JSON.stringify(withName.top).includes("Haircut Women"), "the service breakdown is not empty");
  assert.ok(JSON.stringify(withName.employees).includes("Mansi"), "the employee board is not empty");

  // Remove the field everywhere, and ask with a DIFFERENT range so the query cache cannot answer.
  await Visit.collection.updateMany({}, { $unset: { "services.$[].guestName": "" } });
  const without = await ask(range(day(-2), day(2)));
  const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === "from" || k === "to" ? undefined : v)));
  assert.deepEqual(strip(without), strip(withName));
});

test("confirming the assignment keeps guestName and changes no money", async () => {
  const a = await booking(["Asha", "Bina"]);
  const r = await bill(a);
  const v = await Visit.findById(r.body.visitId).lean();
  const out = await call("POST", `/visits/${v._id}/confirm-assignment`, {
    assignments: v.services.map((s) => ({ serviceEntryId: String(s._id), artistId: String(s.artistId), startTime: "11:00", endTime: "11:45" })),
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const after = await Visit.findById(v._id).lean();
  assert.deepEqual(after.services.map((s) => s.guestName), ["Asha", "Bina"]);
  assert.equal(after.finalTotal, 800);
});
