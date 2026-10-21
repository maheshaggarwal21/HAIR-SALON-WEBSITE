/**
 * @file test/today-board.test.js
 * @description Phase 2 staff side (T2.1, T2.14–T2.18, T2.22): artist switches
 * and leave, the Today board, walk-ins (E2), phone bookings (E22), move,
 * check-in, no-show, blocked time and refunds (E24).
 *
 * Routers behind a stub session (same pattern as staff-bookings.test.js);
 * Razorpay is a fake client. Nothing leaves the machine.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let NotificationLog, Appointment, AuditLog, Artist, Service, SlotLock, TimeOff, User, Customer, time, booking, payments, evictPermissionCache;
let server;
let base;
let caller;
let refundCalls = [];
let refundFails = false;

before(async () => {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "", META_WA_TOKEN: "", META_WA_PHONE_NUMBER_ID: "", PUBLIC_TOKEN_SECRET: "t" });
  await startDb();
  NotificationLog = require("../models/NotificationLog");
  Appointment = require("../models/Appointment");
  AuditLog = require("../models/AuditLog");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  SlotLock = require("../models/SlotLock");
  TimeOff = require("../models/TimeOff");
  User = require("../models/User");
  Customer = require("../models/Customer");
  time = require("../utils/time");
  booking = require("../utils/booking");
  payments = require("../utils/payments");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  payments.setClientForTests({
    orders: { create: async (o) => ({ id: `order_${Date.now()}_${Math.random()}`, amount: o.amount, currency: "INR" }), fetchPayments: async () => ({ items: [] }) },
    payments: {
      refund: async (paymentId, o) => {
        if (refundFails) throw { error: { description: "Insufficient balance" } };
        refundCalls.push({ paymentId, ...o });
        return { id: `rfnd_${refundCalls.length}`, status: "processed" };
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/schedules", require("../routes/schedules"));
  app.use("/api/artists", require("../routes/artists"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
let ids;
let DATE;
const at = (hhmm, date = DATE) => time.salonInstant(date, hhmm).toISOString();

function bookableDate() {
  let d = time.addDays(time.salonDate(), 2);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  return d;
}

beforeEach(async () => {
  await clearDb();
  caller = OWNER;
  refundCalls = [];
  refundFails = false;
  DATE = bookableDate();
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true };
  const [cut, facial, offMenu] = await Service.create([
    { ...common, name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", audience: "her", displayCategory: "Hair", durationMinutes: 45 },
    { ...common, name: "Hydra Facial", price: 3000, publicPrice: 1500, slug: "hydra-facial", audience: "her", displayCategory: "Skin", durationMinutes: 60 },
    { name: "Any item", price: 200, isActive: true, showOnWebsite: false, slug: "any-item", durationMinutes: 30 },
  ]);
  const [mansi, ravi] = await Artist.create([
    { name: "Mansi", phone: "9888800001", gender: "female", onlineBookable: true },
    { name: "Ravi", phone: "9888800002", gender: "male", onlineBookable: false },
  ]);
  ids = { cut: String(cut._id), facial: String(facial._id), offMenu: String(offMenu._id), mansi: String(mansi._id), ravi: String(ravi._id) };
});

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

let userN = 0;
async function receptionist(permissions) {
  const u = await User.collection.insertOne({ name: "Reena", email: `reena${++userN}@example.com`, role: "receptionist", isActive: true, permissions });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name: "Reena", role: "receptionist" };
}

/** An online booking paid in full and confirmed, as the webhook would leave it. */
async function paidOnline(phone, startHHMM, serviceIds = [ids.cut]) {
  const selection = await booking.prepareSelection([{ for: "her", services: serviceIds }]);
  const { appt } = await booking.createBooking({ phone, name: "Asha", selection, startAt: at(startHHMM), paymentKind: "full" });
  await booking.confirmPayment({ orderId: appt.deposit.razorpayOrderId, paymentId: `pay_${appt.ref}` });
  return Appointment.findById(appt._id).lean();
}

// ─── Artist switches and leave ───────────────────────────────────────────────

test("schedules: switch an artist online, set share and own hours; bad hours refused; audited", async () => {
  const list = await call("GET", "/schedules");
  assert.equal(list.status, 200);
  assert.equal(list.body.artists.length, 2);

  const r = await call("PATCH", `/schedules/artists/${ids.ravi}`, { onlineBookable: true, onlineShare: 50, weekly: { mon: [{ start: "10:00", end: "18:00" }], tue: [] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.artist.onlineBookable, true);
  assert.equal(r.body.artist.onlineShare, 50);
  assert.deepEqual(r.body.artist.weekly.tue, []);
  assert.equal(await AuditLog.countDocuments({ action: "artist.schedule_changed" }), 1);

  assert.equal((await call("PATCH", `/schedules/artists/${ids.ravi}`, { weekly: { mon: [{ start: "18:00", end: "10:00" }] } })).status, 400);
  assert.equal((await call("PATCH", `/schedules/artists/${ids.ravi}`, { onlineShare: 150 })).status, 400);
});

test("schedules: reading needs bookings.view, changing needs schedules.manage", async () => {
  await receptionist(["bookings.view"]);
  assert.equal((await call("GET", "/schedules")).status, 200);
  assert.equal((await call("PATCH", `/schedules/artists/${ids.mansi}`, { onlineBookable: false })).status, 403);
  await receptionist(["bookings.view", "schedules.manage"]);
  assert.equal((await call("PATCH", `/schedules/artists/${ids.mansi}`, { onlineBookable: false })).status, 200);
});

test("E8/D48: leave over a booking moves it to a free artist for the same time; nothing is cancelled", async () => {
  const appt = await paidOnline("9876500001", "11:00"); // "any available" → Mansi, no named artist
  const r = await call("POST", "/schedules/time-off", { artistId: ids.mansi, startDate: DATE, endDate: DATE, reason: "ill" });
  assert.equal(r.status, 201);
  assert.equal(r.body.moved.length, 1);
  assert.equal(r.body.flagged.length, 0);
  assert.deepEqual(r.body.moved[0].to, ["Ravi"]);
  assert.equal(r.body.moved[0].customerTold, false);

  const after = await Appointment.findById(appt._id).lean();
  assert.equal(after.status, "confirmed", "bookings are never cancelled automatically");
  assert.equal(new Date(after.startAt).toISOString(), new Date(appt.startAt).toISOString(), "same time");
  assert.equal(after.guests[0].items[0].artistName, "Ravi");
  assert.ok(after.statusHistory.some((h) => /artist_reassigned: ill/.test(h.reason || "")));
  const locks = await SlotLock.find({ appointmentId: appt._id, kind: "artist" }).lean();
  assert.equal(locks.length, 3);
  assert.ok(locks.every((l) => String(l.artistId) === ids.ravi), "the blocks moved to the new artist");
  assert.equal(await NotificationLog.countDocuments({ type: "booking_artist_changed" }), 0, "'any available' customers aren't told");

  // Leave removes the artist's time online.
  const selection = await booking.prepareSelection([{ services: [ids.cut] }]);
  assert.equal((await booking.findSlots({ date: DATE, selection })).slots.length, 0);
  const del = await call("DELETE", `/schedules/time-off/${r.body.timeOff._id}`);
  assert.equal(del.status, 200);
  assert.ok((await booking.findSlots({ date: DATE, selection })).slots.length > 0);
});

test("D48: a customer who NAMED the artist is told on WhatsApp who they have instead, and why", async () => {
  const selection = await booking.prepareSelection([{ for: "her", services: [ids.cut] }]);
  const { appt } = await booking.createBooking({ phone: "9876500002", name: "Asha", selection, startAt: at("11:00"), paymentKind: "full", artistId: ids.mansi });
  await booking.confirmPayment({ orderId: appt.deposit.razorpayOrderId, paymentId: `pay_${appt.ref}` });
  const r = await call("POST", "/schedules/time-off", { artistId: ids.mansi, startDate: DATE, endDate: DATE, reason: "Mansi is on leave" });
  assert.equal(r.body.moved[0].customerTold, true);
  const log = await NotificationLog.findOne({ type: "booking_artist_changed", appointmentId: appt._id }).lean();
  assert.ok(log, "WhatsApp queued for the named-artist customer");
  assert.equal(await NotificationLog.countDocuments({ type: "booking_artist_changed" }), 1);

  // The same change again (idempotent key) never double-sends.
  await booking.moveBooking(appt._id, { startAt: appt.startAt, artistId: ids.ravi, reason: "test" });
  assert.equal(await NotificationLog.countDocuments({ type: "booking_artist_changed", appointmentId: appt._id }), 1);
});

test("D48: when nobody is free the booking stays put and is flagged for reception", async () => {
  const appt = await paidOnline("9876500003", "11:00");
  await call("POST", "/bookings/block", { artistId: ids.ravi, startAt: at("10:00"), endAt: at("13:00"), note: "Training" });
  const r = await call("POST", "/schedules/time-off", { artistId: ids.mansi, startDate: DATE, endDate: DATE, reason: "ill" });
  assert.equal(r.status, 201);
  assert.equal(r.body.moved.length, 0);
  assert.equal(r.body.flagged.length, 1);
  assert.equal(r.body.flagged[0].ref, appt.ref);
  const same = await Appointment.findById(appt._id).lean();
  assert.equal(same.guests[0].items[0].artistName, "Mansi");
  assert.equal(same.status, "confirmed");
  assert.equal(await SlotLock.countDocuments({ appointmentId: appt._id }), 3);
});

test("D51: deactivating an artist moves their coming bookings; one nobody can take stays visible on the board", async () => {
  const movable = await paidOnline("9876500004", "11:00");
  const r = await call("PATCH", `/artists/${ids.mansi}`, { isActive: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reassigned.moved.length, 1);
  assert.equal((await Appointment.findById(movable._id).lean()).guests[0].items[0].artistName, "Ravi");

  // Bring Mansi back, book her again, block Ravi so nobody can take it, then let her go.
  await Artist.updateOne({ _id: ids.mansi }, { $set: { isActive: true } });
  const stuck = await paidOnline("9876500005", "15:00");
  await call("POST", "/bookings/block", { artistId: ids.ravi, startAt: at("14:00"), endAt: at("17:00"), note: "Training" });
  const r2 = await call("PATCH", `/artists/${ids.mansi}`, { isActive: false });
  assert.equal(r2.body.reassigned.flagged.length, 1);
  assert.equal(r2.body.reassigned.flagged[0].ref, stuck.ref);

  const board = await call("GET", `/bookings/day?date=${DATE}`);
  const row = board.body.artists.find((a) => a.name === "Mansi");
  assert.ok(row, "the departed artist stays on the board while they still hold a booking");
  assert.equal(row.inactive, true);
  assert.ok(row.items.some((i) => i.ref === stuck.ref));
});

test("D51: a late customer cancellation records the fee kept; waiving it removes it; a no-show counts too", async () => {
  const a = await paidOnline("9876500006", "11:00", [ids.cut, ids.facial]);
  const soon = new Date(Date.now() + 3 * 3600e3);
  await Appointment.updateOne({ _id: a._id }, { $set: { startAt: soon, endAt: new Date(soon.getTime() + 3600e3) } });
  await call("POST", `/bookings/${a._id}/cancel`, { side: "customer" });
  const fees = await call("GET", "/bookings/fees");
  assert.equal(fees.status, 200);
  assert.equal(fees.body.total, 600, "30% of ₹2,000");
  assert.equal(fees.body.rows[0].ref, a.ref);

  const ns = await paidOnline("9876500007", "13:00");
  await booking.markNoShow(ns._id, { now: new Date(at("13:20")) });
  assert.equal((await call("GET", "/bookings/fees")).body.total, 750, "+ ₹150 from the no-show");
  assert.equal((await Appointment.findById(ns._id).lean()).feeKept, 150);

  await call("POST", `/bookings/${a._id}/refund/adjust`, { amount: 2000, reason: "waived" });
  const after = await call("GET", "/bookings/fees");
  assert.equal(after.body.total, 150, "a waived fee isn't income");
  assert.equal((await call("GET", "/bookings/fees?month=2020-01")).body.total, 0);

  await receptionist(["bookings.view", "bookings.manage"]);
  assert.equal((await call("GET", "/bookings/fees")).status, 403);
});

test("D51: when WE change the artist they named, cancelling is free whatever the notice", async () => {
  const selection = await booking.prepareSelection([{ for: "her", services: [ids.cut] }]);
  const { appt } = await booking.createBooking({ phone: "9876500008", name: "Asha", selection, startAt: at("11:00"), paymentKind: "full", artistId: ids.mansi });
  await booking.confirmPayment({ orderId: appt.deposit.razorpayOrderId, paymentId: `pay_${appt.ref}` });
  await call("POST", "/schedules/time-off", { artistId: ids.mansi, startDate: DATE, endDate: DATE, reason: "ill" });
  const soon = new Date(Date.now() + 3 * 3600e3);
  await Appointment.updateOne({ _id: appt._id }, { $set: { startAt: soon, endAt: new Date(soon.getTime() + 3600e3) } });
  const c = await call("POST", `/bookings/${appt._id}/cancel`, { side: "customer" });
  assert.equal(c.body.request.refund.amount, 500, "all of it, although it is inside 24h");
  assert.equal((await Appointment.findById(appt._id).lean()).feeKept, 0);
});

test("refund switch: needs bookings.refund, flips automatic refunds, is audited", async () => {
  const on = await call("GET", "/bookings/refunds");
  assert.equal(on.body.autoRefundSalonSide, true);
  const off = await call("PUT", "/bookings/refund-settings", { autoRefundSalonSide: false });
  assert.equal(off.status, 200);
  assert.equal((await call("GET", "/bookings/refunds")).body.autoRefundSalonSide, false);
  assert.ok(await AuditLog.findOne({ action: "booking.refund_setting_changed" }));
  assert.equal((await call("PUT", "/bookings/refund-settings", { autoRefundSalonSide: "no" })).status, 400);
  await receptionist(["bookings.view", "bookings.manage"]);
  assert.equal((await call("PUT", "/bookings/refund-settings", { autoRefundSalonSide: true })).status, 403);
});

test("part-day leave only blocks those hours", async () => {
  const r = await call("POST", "/schedules/time-off", { artistId: ids.mansi, startDate: DATE, endDate: DATE, startTime: "14:00", endTime: "16:00" });
  assert.equal(r.status, 201);
  const selection = await booking.prepareSelection([{ services: [ids.cut] }]);
  const times = (await booking.findSlots({ date: DATE, selection })).slots.map((s) => s.time);
  assert.ok(times.includes("13:00"));
  assert.ok(!times.includes("13:30"), "45 min from 13:30 runs into the leave");
  assert.ok(!times.includes("15:00"));
  assert.ok(times.includes("16:00"));
});

// ─── Walk-ins (T2.15, E2) ────────────────────────────────────────────────────

test("walk-in: checked in with firm locks, so the website can't sell that chair", async () => {
  const r = await call("POST", "/bookings/walkin", { name: "Neha", phone: "9876500010", gender: "female", artistId: ids.mansi, serviceIds: [ids.cut, ids.offMenu], startAt: at("11:00") });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const appt = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  assert.equal(appt.status, "checked_in");
  assert.equal(appt.source.channel, "walkin");
  assert.equal(appt.guests[0].items[1].publicPrice, 100, "off-menu service at half price");
  const locks = await SlotLock.find({ appointmentId: appt._id }).lean();
  assert.equal(locks.length, 5, "45 + 30 min");
  assert.ok(locks.every((l) => l.state === "firm"));

  const selection = await booking.prepareSelection([{ services: [ids.cut] }]);
  await assert.rejects(booking.createBooking({ phone: "9876500011", name: "Online", selection, startAt: at("11:00"), paymentKind: "full" }), (e) => e.code === "SLOT_TAKEN");
});

test("E2: a walk-in over an online booking is refused with who is in the way; forcing it is flagged", async () => {
  const online = await paidOnline("9876500020", "12:00");
  const r = await call("POST", "/bookings/walkin", { name: "Neha", artistId: ids.mansi, serviceIds: [ids.cut], startAt: at("12:15") });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflicts[0].ref, online.ref);

  const forced = await call("POST", "/bookings/walkin", { name: "Neha", artistId: ids.mansi, serviceIds: [ids.cut], startAt: at("12:15"), force: true });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.booking.lockConflict, true);
  const board = await call("GET", `/bookings/day?date=${DATE}`);
  assert.ok(board.body.attention.some((a) => a.kind === "conflict" && a.ref === forced.body.booking.ref));
  assert.ok(await AuditLog.findOne({ action: "booking.walkin_created", "meta.forcedOver": online.ref }));
  // The online booking still owns its blocks.
  assert.equal(await SlotLock.countDocuments({ appointmentId: online._id }), 3);
});

// ─── Phone bookings (E22), move, check-in, no-show, cancel ───────────────────

test("E22: the desk books a phone customer with any active artist, confirmed with no payment", async () => {
  const r = await call("POST", "/bookings/staff", { name: "Kamla", phone: "9876500030", for: "her", serviceIds: [ids.facial], startAt: at("10:00"), artistId: ids.ravi });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const appt = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  assert.equal(appt.status, "confirmed");
  assert.equal(appt.source.channel, "phone");
  assert.equal(appt.deposit.status, "none");
  assert.equal(appt.guests[0].items[0].artistName, "Ravi", "offline artists can still be booked by the desk");
  assert.ok((await SlotLock.find({ appointmentId: appt._id }).lean()).every((l) => l.state === "firm"));
  assert.equal((await Customer.findOne({ phone: "9876500030" }).lean()).createdFrom, "desk");

  const free = await call("GET", `/bookings/availability?date=${DATE}&services=${ids.facial}&artistId=${ids.ravi}`);
  assert.ok(!free.body.slots.some((s) => new Date(s.startAt).toISOString() === at("10:00")));
});

test("move: to a free time takes the new blocks and frees the old; onto a taken time changes nothing", async () => {
  const a = await paidOnline("9876500040", "11:00");
  const b = await paidOnline("9876500041", "15:00");
  const moved = await call("POST", `/bookings/${a._id}/move`, { startAt: at("13:00") });
  assert.equal(moved.status, 200);
  const locks = await SlotLock.find({ appointmentId: a._id }).sort({ blockStart: 1 }).lean();
  assert.equal(new Date(locks[0].blockStart).toISOString(), at("13:00"));
  assert.equal(await SlotLock.countDocuments({ blockStart: new Date(at("11:00")) }), 0);

  const clash = await call("POST", `/bookings/${a._id}/move`, { startAt: at("15:00") });
  assert.equal(clash.status, 409);
  assert.equal(new Date((await SlotLock.find({ appointmentId: a._id }).sort({ blockStart: 1 }).lean())[0].blockStart).toISOString(), at("13:00"));
  assert.equal(await SlotLock.countDocuments({ appointmentId: b._id }), 3);

  const toRavi = await call("POST", `/bookings/${a._id}/move`, { startAt: at("13:00"), artistId: ids.ravi });
  assert.equal(toRavi.status, 200);
  assert.equal(toRavi.body.booking.items[0].artistName, "Ravi");
});

test("check-in, then no-show only after the grace period; customer-side cancel keeps the fee", async () => {
  const a = await paidOnline("9876500050", "11:00");
  const early = await booking.markNoShow(a._id, { now: new Date(at("11:10")) });
  assert.equal(early.error, "TOO_EARLY");
  const late = await booking.markNoShow(a._id, { now: new Date(at("11:20")) });
  assert.equal(late.ok, true);
  assert.equal(late.appt.status, "no_show");
  assert.equal(late.appt.refund?.amount, 350, "₹500 paid in full, 30% (₹150) kept");
  assert.equal(late.appt.deposit.status, "paid", "part of it goes back, so it stays for the owner to review");
  assert.equal((await Customer.findOne({ phone: "9876500050" }).lean()).stats.noShows, 1);
  assert.equal(await SlotLock.countDocuments({ appointmentId: a._id }), 0);

  const b = await paidOnline("9876500051", "14:00", [ids.cut, ids.facial]); // ₹2,000 paid in full
  const soon = new Date(Date.now() + 3 * 3600e3);
  await Appointment.updateOne({ _id: b._id }, { $set: { startAt: soon, endAt: new Date(soon.getTime() + 3600e3) } });
  const c = await call("POST", `/bookings/${b._id}/cancel`, { side: "customer", reason: "called to cancel" });
  assert.equal(c.status, 200);
  assert.equal(c.body.request.refund.amount, 1400, "₹2,000 − 30% fee (cancelled inside 24h)");

  const d = await paidOnline("9876500052", "16:00");
  const ci = await call("POST", `/bookings/${d._id}/check-in`);
  assert.equal(ci.body.booking.status, "checked_in");
  assert.equal((await call("POST", `/bookings/${d._id}/check-in`)).status, 409);

  // "Finished": once, only while in the chair.
  const notYet = await paidOnline("9876500053", "17:00");
  assert.equal((await call("POST", `/bookings/${notYet._id}/finish`)).status, 409, "not checked in yet");
  const fin = await call("POST", `/bookings/${d._id}/finish`);
  assert.equal(fin.status, 200);
  assert.ok(fin.body.booking.finishedAt);
  assert.equal((await call("POST", `/bookings/${d._id}/finish`)).status, 409, "second tap changes nothing");
  assert.ok(await AuditLog.findOne({ action: "booking.finished" }));
});

// ─── Blocked time and the board ──────────────────────────────────────────────

test("block time: firm locks with no booking; refused over a booking; unblock frees it; board shows it", async () => {
  await paidOnline("9876500060", "11:00");
  const bad = await call("POST", "/bookings/block", { artistId: ids.mansi, startAt: at("10:30"), endAt: at("11:30"), note: "Training" });
  assert.equal(bad.status, 409);
  const ok = await call("POST", "/bookings/block", { artistId: ids.mansi, startAt: at("14:00"), endAt: at("15:00"), note: "Training" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.blocks, 4);

  const board = await call("GET", `/bookings/day?date=${DATE}`);
  assert.equal(board.status, 200);
  const mansi = board.body.artists.find((a) => a.name === "Mansi");
  assert.equal(mansi.items.length, 1);
  assert.equal(mansi.blocked[0].note, "Training");
  assert.equal(new Date(mansi.blocked[0].start).toISOString(), at("14:00"));
  assert.ok(mansi.working.length > 0);

  const un = await call("POST", "/bookings/unblock", { artistId: ids.mansi, startAt: at("14:00"), endAt: at("15:00") });
  assert.equal(un.body.blocks, 4);
});

// ─── Refunds (T2.17, E24) ────────────────────────────────────────────────────

test("refunds: queue → send once; a double send is refused; a Razorpay failure stays in the queue", async () => {
  const a = await paidOnline("9876500070", "11:00", [ids.cut, ids.facial]);
  await require("../models/SiteSettings").updateOne({}, { $set: { autoRefundSalonSide: false } }); // automatic sending has its own tests
  await call("POST", `/bookings/${a._id}/cancel`, { reason: "artist ill" }); // salon side: all ₹2,000 back

  const list = await call("GET", "/bookings/refunds");
  assert.equal(list.body.open.length, 1);
  assert.equal(list.body.open[0].refund.amount, 2000);

  refundFails = true;
  const failed = await call("POST", `/bookings/${a._id}/refund/send`);
  assert.equal(failed.status, 502);
  assert.equal((await Appointment.findById(a._id).lean()).refund.status, "failed");

  refundFails = false;
  const [one, two] = await Promise.all([call("POST", `/bookings/${a._id}/refund/send`), call("POST", `/bookings/${a._id}/refund/send`)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(refundCalls.length, 1);
  assert.equal(refundCalls[0].amount, 200000);
  const done = await Appointment.findById(a._id).lean();
  assert.equal(done.refund.status, "processed");
  assert.equal(done.deposit.status, "refunded");
  assert.ok(await AuditLog.findOne({ action: "booking.refund_failed" }));
  assert.ok(await AuditLog.findOne({ action: "booking.refund_sent" }));
  // The customer hears once that the money has left — not on the failed try.
  const sent = await require("../models/NotificationLog").find({ appointmentId: a._id, type: "booking_refund" }).lean();
  assert.equal(sent.length, 1);
});

test("refunds: owner can waive the fee before sending; refunds need bookings.refund", async () => {
  const a = await paidOnline("9876500071", "11:00", [ids.cut, ids.facial]);
  const soon = new Date(Date.now() + 3 * 3600e3);
  await Appointment.updateOne({ _id: a._id }, { $set: { startAt: soon, endAt: new Date(soon.getTime() + 3600e3) } });
  await call("POST", `/bookings/${a._id}/cancel`, { side: "customer" });
  assert.equal((await Appointment.findById(a._id).lean()).refund.amount, 1400);
  const waive = await call("POST", `/bookings/${a._id}/refund/adjust`, { amount: 2000, reason: "Regular client, waived" });
  assert.equal(waive.status, 200);
  assert.equal(waive.body.refund.amount, 2000);
  assert.equal((await call("POST", `/bookings/${a._id}/refund/adjust`, { amount: 2500, reason: "too much" })).status, 400);

  await receptionist(["bookings.view", "bookings.manage"]);
  assert.equal((await call("GET", "/bookings/refunds")).status, 403);
  assert.equal((await call("POST", `/bookings/${a._id}/refund/send`)).status, 403);
});

// ─── Reminders (T2.12) and Telegram approval (T2.10) ─────────────────────────

test("reminders: 24h and 2h messages go once each; walk-ins get none", async () => {
  const NotificationLog = require("../models/NotificationLog");
  const a = await paidOnline("9876500080", "11:00");
  await Appointment.collection.updateOne({ _id: a._id }, { $set: { createdAt: new Date(Date.parse(at("11:00")) - 3 * 24 * 3600e3) } });
  await call("POST", "/bookings/walkin", { name: "Walk", phone: "9876500081", artistId: ids.ravi, serviceIds: [ids.cut], startAt: at("11:00") });

  const dayBefore = new Date(Date.parse(at("11:00")) - 20 * 3600e3);
  const r1 = await booking.sendReminders(dayBefore);
  assert.equal(r1.reminder24h, 1);
  assert.equal((await booking.sendReminders(dayBefore)).reminder24h, 0, "idempotent");

  const twoHours = new Date(Date.parse(at("11:00")) - 90 * 60e3);
  const r2 = await booking.sendReminders(twoHours);
  assert.equal(r2.reminder2h, 1);
  const keys = (await NotificationLog.find({}, { key: 1 }).lean()).map((n) => n.key).sort();
  assert.ok(keys.includes(`${a._id}:reminder_24h`));
  assert.ok(keys.includes(`${a._id}:reminder_2h`));
  assert.equal(keys.filter((k) => k.includes("reminder")).length, 2, "walk-in got nothing");
});

test("Telegram: the owner approves a (legacy) request from the alert; another chat can't", async () => {
  await Service.create({ name: "Global Colour", price: 6000, publicPrice: 3000, slug: "global-colour", isActive: true, showOnWebsite: true, bookingMode: "request", durationMinutes: 90 });
  const colour = await Service.findOne({ slug: "global-colour" }).lean();
  const selection = await booking.prepareSelection([{ for: "her", services: [String(colour._id)] }]);
  const { appt } = await booking.createBooking({ phone: "9876500090", name: "Asha", selection, startAt: at("12:00"), paymentKind: "deposit" });
  await booking.confirmPayment({ orderId: appt.deposit.razorpayOrderId, paymentId: "pay_tg" });
  // D49: the engine books instantly now; this is a request made before that change.
  const until = new Date(Date.now() + 2 * 3600e3);
  await Appointment.updateOne({ _id: appt._id }, { $set: { status: "requested", mode: "request", requestExpiresAt: until } });
  await SlotLock.updateMany({ appointmentId: appt._id }, { $set: { state: "hold", expiresAt: until } });
  assert.equal((await Appointment.findById(appt._id).lean()).status, "requested");

  await User.collection.insertOne({ name: "Ajit", role: "owner", isActive: true, telegramChatId: "111", email: "owner@example.com" });
  const { processUpdate } = require("../routes/telegram");
  const tap = (chat, data) => processUpdate({ callback_query: { id: "cb1", data, from: { first_name: "Ajit" }, message: { chat: { id: chat }, message_id: 7, text: "request" } } }, { get: () => null, headers: {} });

  await tap("999", `bk:a:${appt._id}`);
  assert.equal((await Appointment.findById(appt._id).lean()).status, "requested", "a stranger's chat changes nothing");

  await tap("111", `bk:a:${appt._id}`);
  const done = await Appointment.findById(appt._id).lean();
  assert.equal(done.status, "confirmed");
  assert.ok((await SlotLock.find({ appointmentId: appt._id }).lean()).every((l) => l.state === "firm"));
  assert.ok(await AuditLog.findOne({ action: "booking.confirmed", "meta.via": "telegram" }));
});
