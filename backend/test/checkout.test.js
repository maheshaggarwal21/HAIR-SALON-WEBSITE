/**
 * @file test/checkout.test.js
 * @description Check-in → Visit for online bookings (CF §8, T2.16), with the
 * spec's worked examples as tests:
 *   A — deposit ₹500 online, desk adds a service, rest in cash
 *   B — same, rest by UPI
 *   C — deposit bigger than the bill → excess queued as a refund (E16)
 *   D — paid in full online, desk adds a service paid in cash
 * plus: the invariant cash + card + online === finalTotal on every visit,
 * one booking → one visit, and the booking closes in the same write.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let Appointment, Service, Visit, Customer;
let server;
let base;

before(async () => {
  await startDb();
  Appointment = require("../models/Appointment");
  Service = require("../models/Service");
  Visit = require("../models/Visit");
  Customer = require("../models/Customer");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: new mongoose.Types.ObjectId(), name: "Reena", role: "owner" };
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

let ids;
beforeEach(async () => {
  await clearDb();
  const [smooth, brows, massage] = await Service.create([
    { name: "Smoothening Medium", price: 9000, publicPrice: 4500, isActive: true, durationMinutes: 150 },
    { name: "Eyebrows", price: 100, publicPrice: 50, isActive: true, durationMinutes: 15 },
    { name: "Head Massage", price: 700, publicPrice: 350, isActive: true, durationMinutes: 30 },
  ]);
  ids = { smooth: String(smooth._id), brows: String(brows._id), massage: String(massage._id) };
});

let refN = 0;
async function bookedAndPaid({ kind = "deposit", amount = 500, items = ["smooth", "brows"], status = "checked_in", discount = 0 } = {}) {
  const customer = await Customer.findOneAndUpdate({ phone: "9876500001" }, { $setOnInsert: { name: "Asha", createdFrom: "web" } }, { upsert: true, returnDocument: "after" });
  const docs = await Service.find({ _id: { $in: items.map((k) => ids[k]) } }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const start = new Date("2026-11-10T05:30:00Z");
  const gItems = items.map((k) => {
    const s = byId.get(ids[k]);
    return { serviceId: s._id, name: s.name, publicPrice: s.publicPrice, listPrice: s.price, durationMin: s.durationMinutes, artistId: new mongoose.Types.ObjectId(), artistName: "Mansi", startAt: start, endAt: new Date(start.getTime() + s.durationMinutes * 60000) };
  });
  const subtotal = gItems.reduce((n, i) => n + i.publicPrice, 0);
  return Appointment.create({
    ref: `EXP-T${String(++refN).padStart(4, "0")}`,
    mode: "instant",
    status,
    customerId: customer._id,
    contact: "9876500001",
    name: "Asha",
    guests: [{ guestKey: "g1", name: "Asha", gender: "female", items: gItems }],
    startAt: start,
    endAt: new Date(start.getTime() + 4 * 3600e3),
    pricing: { subtotal, discount, total: subtotal - discount },
    deposit: { required: true, kind, amount, status: "paid", razorpayPaymentId: "pay_A" },
    source: { channel: "web" },
  });
}

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

const visitBody = (appt, extra = {}) => ({
  appointmentId: String(appt._id),
  serviceIds: [ids.smooth, ids.brows, ids.massage],
  date: "2026-11-10",
  ...extra,
});

function assertInvariant(v) {
  assert.equal(v.cashAmount + v.cardAmount + v.onlineAmount, v.finalTotal, "cash + card + online must equal finalTotal");
}

test("bill preview: booked items at their snapshot price, desk extras at website price, deposit taken off", async () => {
  const appt = await bookedAndPaid();
  await Service.updateOne({ _id: ids.smooth }, { $set: { publicPrice: 6000 } }); // E6
  const r = await call("GET", `/appointment-bill/${appt._id}?serviceIds=${ids.smooth},${ids.brows},${ids.massage}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.finalTotal, 4900);
  assert.equal(r.body.depositApplied, 500);
  assert.equal(r.body.remainder, 4400);
  assert.equal(r.body.services[0].price, 4500, "snapshot, not today's ₹6,000");
  assert.equal(r.body.services[0].artistName, "Mansi");
  assert.equal(r.body.appointment.gender, "female");
});

test("assignment prefill: real check-in → Finished span, never the planned times", async () => {
  const none = await bookedAndPaid();
  const before = await call("GET", `/appointment-bill/${none._id}?serviceIds=${ids.smooth},${ids.brows}`);
  assert.equal(before.body.services[0].startTime, null, "planned times must not pose as actual ones");
  assert.equal(before.body.services[0].endTime, null);

  const appt = await bookedAndPaid();
  const start = new Date(appt.startAt);
  await Appointment.updateOne({ _id: appt._id }, { $set: { status: "checked_in", checkedInAt: start, finishedAt: new Date(start.getTime() + 2 * 3600e3) } });
  const r = await call("GET", `/appointment-bill/${appt._id}?serviceIds=${ids.smooth},${ids.brows}`);
  assert.equal(r.body.services[0].startTime, "11:00"); // 05:30Z = 11:00 IST
  const planned = (await Service.findById(ids.smooth).lean()).durationMinutes;
  const end = new Date(start.getTime() + planned * 0.5 * 60000);
  const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(end);
  assert.equal(r.body.services[0].endTime, hhmm, "2h actual over a 4h plan → half the planned length");
});

test("Example A: deposit ₹500 online, desk adds head massage, rest in cash", async () => {
  const appt = await bookedAndPaid();
  const r = await call("POST", "/v2", visitBody(appt, { paymentMethod: "cash" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.finalTotal, 4900);
  assert.equal(v.depositAmount, 500);
  assert.equal(v.depositPaymentId, "pay_A");
  assert.equal(v.cashAmount, 4400);
  assert.equal(v.onlineAmount, 500);
  assert.equal(v.paymentMethod, "partial");
  assert.equal(v.discountPercent, 0);
  assert.equal(v.services[0].listPrice, 9000);
  assertInvariant(v);

  const done = await Appointment.findById(appt._id).lean();
  assert.equal(done.status, "completed");
  assert.equal(String(done.visitId), String(v._id));
  assert.equal(done.deposit.status, "applied");
  assert.equal((await Customer.findById(appt.customerId).lean()).stats.visits, 1);
});

test("Example B: rest by UPI", async () => {
  const appt = await bookedAndPaid();
  const noPay = await call("POST", "/v2", visitBody(appt, { paymentMethod: "online" }));
  assert.equal(noPay.status, 400, "online remainder needs a Razorpay payment id");
  const r = await call("POST", "/v2", visitBody(appt, { paymentMethod: "online", razorpayPaymentId: "pay_B" }));
  assert.equal(r.status, 201);
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.onlineAmount, 4900);
  assert.equal(v.razorpayPaymentId, "pay_B");
  assert.equal(v.depositPaymentId, "pay_A");
  assertInvariant(v);
});

test("Example C / E16: deposit ₹500 covers a ₹50 bill — ₹50 taken, ₹450 queued for refund", async () => {
  const appt = await bookedAndPaid({ items: ["brows"], amount: 500 });
  const r = await call("POST", "/v2", { ...visitBody(appt), serviceIds: [ids.brows, ids.massage, ids.brows].slice(0, 1) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.finalTotal, 50);
  assert.equal(v.onlineAmount, 50);
  assert.equal(v.depositAmount, 50);
  assertInvariant(v);
  const done = await Appointment.findById(appt._id).lean();
  assert.equal(done.refund.amount, 450);
  assert.equal(done.refund.status, "pending");
  assert.equal(done.refund.reason, "deposit_exceeds_bill");
});

test("Example D: paid in full online, desk adds a service paid in cash; nothing extra → no payment step", async () => {
  const appt = await bookedAndPaid({ kind: "full", amount: 4550 });
  const r = await call("POST", "/v2", visitBody(appt, { paymentMethod: "cash" }));
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.finalTotal, 4900);
  assert.equal(v.cashAmount, 350);
  assert.equal(v.onlineAmount, 4550);
  assertInvariant(v);

  const other = await bookedAndPaid({ kind: "full", amount: 4550 });
  const r2 = await call("POST", "/v2", { appointmentId: String(other._id), serviceIds: [ids.smooth, ids.brows], date: "2026-11-10", paymentMethod: "online" });
  assert.equal(r2.status, 201, "remainder 0: no Razorpay id needed");
  const v2 = await Visit.findById(r2.body.visitId).lean();
  assert.equal(v2.onlineAmount, 4550);
  assert.equal(v2.razorpayPaymentId, null);
  assertInvariant(v2);
});

test("one booking → one visit: a retry returns the same visit; a cancelled booking can't be billed", async () => {
  const appt = await bookedAndPaid();
  const [a, b] = await Promise.all([
    call("POST", "/v2", visitBody(appt, { paymentMethod: "cash" })),
    call("POST", "/v2", visitBody(appt, { paymentMethod: "cash" })),
  ]);
  assert.ok([a.status, b.status].includes(201));
  assert.equal(await Visit.countDocuments({ appointmentId: appt._id }), 1);
  const again = await call("POST", "/v2", visitBody(appt, { paymentMethod: "cash" }));
  assert.equal(again.body.duplicate, true);

  const cancelled = await bookedAndPaid({ status: "cancelled" });
  const r = await call("POST", "/v2", visitBody(cancelled, { paymentMethod: "cash" }));
  assert.equal(r.status, 409);
  assert.equal(await Visit.countDocuments({ appointmentId: cancelled._id }), 0);
});

test("package discount from the booking is applied as an absolute amount", async () => {
  const appt = await bookedAndPaid({ discount: 300, amount: 500 });
  const r = await call("POST", "/v2", { appointmentId: String(appt._id), serviceIds: [ids.smooth, ids.brows], date: "2026-11-10", paymentMethod: "card" });
  const v = await Visit.findById(r.body.visitId).lean();
  assert.equal(v.discountAmount, 300);
  assert.equal(v.discountReason, "package");
  assert.equal(v.finalTotal, 4250);
  assert.equal(v.cardAmount, 3750);
  assertInvariant(v);
});
