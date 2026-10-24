/**
 * @file test/request-lock.test.js
 * @description Audit item 3: confirming a request with a date, a time and an artist
 * takes FIRM slot locks for the artist, for the whole package duration.
 *
 * Before: the confirm route only changed the status and wrote times. No SlotLock rows,
 * so the website could sell the same artist at the same time, and a confirmed request
 * with no artist did not appear on the Today board at all.
 *
 * What must hold:
 *   - the artist is required (400), and must be an active artist;
 *   - in ONE transaction: expired holds go, conflicts are checked, locks are inserted
 *     and the status changes. A conflict is 409 SLOT_TAKEN naming who is in the way;
 *   - the locks cover the package's whole time (rounded up to 15 minutes);
 *   - every way a confirmed request ends or changes releases or moves those locks;
 *   - a package with no stored time (or no matched services) still confirms, says
 *     "no lock taken", and takes no lock.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.META_WA_TOKEN = "";
process.env.PUBLIC_TOKEN_SECRET = "t";

let Appointment, Artist, Service, SlotLock, SiteSettings, time, booking, dayBoard, server, base;

before(async () => {
  await startDb();
  Appointment = require("../models/Appointment");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  SlotLock = require("../models/SlotLock");
  SiteSettings = require("../models/SiteSettings");
  time = require("../utils/time");
  booking = require("../utils/booking");
  // Online bookings in these tests are paid in full: Razorpay is a fake.
  require("../utils/payments").setClientForTests({ orders: { create: async (o) => ({ id: `order_${Math.random().toString(36).slice(2)}`, amount: o.amount, currency: o.currency, notes: o.notes }) } });
  process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
  process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
  ({ dayBoard } = require("../utils/board"));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: new mongoose.Types.ObjectId(), name: "Reena", role: "owner" };
    next();
  });
  app.use("/api/bookings", require("../routes/bookings"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

let DAY;
let A; // the artist who is onlineBookable
let B;
let svcs;
const at = (hhmm, day = DAY) => time.salonInstant(day, hhmm);

beforeEach(async () => {
  await clearDb();
  await SiteSettings.getSingleton();
  let d = time.addDays(time.salonDate(), 3);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  DAY = d;
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true, audience: "her", displayCategory: "Hair" };
  svcs = await Service.create([
    { ...common, name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", durationMinutes: 45 },
    { ...common, name: "Blow-dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
    { ...common, name: "Pedicure", price: 800, publicPrice: 400, slug: "pedicure", durationMinutes: 45 },
    { ...common, name: "Head wash", price: 400, publicPrice: 200, slug: "head-wash", durationMinutes: 15 },
  ]);
  [A, B] = await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female", onlineBookable: true, publicProfile: { slug: "mansi", displayName: "Mansi", visible: true } },
    { name: "Ravi", phone: "9888800002", commission: 30, gender: "male", onlineBookable: false },
  ]);
});

let refN = 0;
const item = (s, over = {}) => ({ serviceId: s._id, name: s.name, publicPrice: s.publicPrice, listPrice: s.price, durationMin: null, bufferMin: 0, ...over });

/** An offer-page package request (WhatsApp ad), unpaid, waiting for a time. Four matched services. */
function packageRequest({ minutes = 120, offerPackage = {}, ...over } = {}) {
  return Appointment.create({
    ref: `EXP-K${String(++refN).padStart(4, "2")}`,
    mode: "request",
    status: "requested",
    contact: `98765${String(40000 + refN)}`,
    name: `Guest ${refN}`,
    guests: [{ guestKey: "g1", name: `Guest ${refN}`, gender: "female", items: svcs.map((s) => item(s)) }],
    requestedWindow: { date: DAY, window: "morning", time: "11:00" },
    pricing: { subtotal: 2500, total: 2500 },
    source: { channel: "wa_ad", offerSlug: "karva-chauth", offerPackage: { slug: "p3", name: "Karva Chauth SPECIAL · PACKAGE 3", price: 2500, services: ["a", "b", "c", "d", "e"], ...(minutes === null ? {} : { durationMinutes: minutes }), ...offerPackage } },
    statusHistory: [{ from: null, to: "requested", at: new Date(), by: "customer" }],
    ...over,
  });
}

/** A website request for ordinary services (no package): items carry their own durations. */
function plainRequest() {
  return Appointment.create({
    ref: `EXP-K${String(++refN).padStart(4, "2")}`,
    mode: "request",
    status: "requested",
    contact: `98765${String(40000 + refN)}`,
    name: `Guest ${refN}`,
    guests: [{ guestKey: "g1", name: "Guest", gender: "female", items: [item(svcs[0], { durationMin: 45 }), item(svcs[3], { durationMin: 15, bufferMin: 5 })] }],
    requestedWindow: { date: DAY, window: "morning" },
    pricing: { subtotal: 700, total: 700 },
    source: { channel: "web" },
    statusHistory: [{ from: null, to: "requested", at: new Date(), by: "customer" }],
  });
}

async function call(method, path, data) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const confirm = (a, body) => call("POST", `/bookings/${a._id}/confirm`, { date: DAY, time: "11:00", artistId: String(A._id), ...body });
const locksOf = (a) => SlotLock.find({ appointmentId: a._id }).sort({ blockStart: 1 }).lean();
const hhmm = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

// ─── the rule: artist required ──────────────────────────────────────────────

test("an artist is required: confirming without one is a clear 400 and changes nothing", async () => {
  const a = await packageRequest();
  const none = await call("POST", `/bookings/${a._id}/confirm`, { date: DAY, time: "11:00" });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /artist/i);
  const nul = await call("POST", `/bookings/${a._id}/confirm`, { date: DAY, time: "11:00", artistId: null });
  assert.equal(nul.status, 400);
  assert.equal((await Appointment.findById(a._id)).status, "requested");
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("an inactive or unknown artist is refused", async () => {
  const a = await packageRequest();
  await Artist.updateOne({ _id: B._id }, { $set: { isActive: false } });
  assert.equal((await confirm(a, { artistId: String(B._id) })).status, 400);
  assert.equal((await confirm(a, { artistId: String(new mongoose.Types.ObjectId()) })).status, 400);
  assert.equal((await Appointment.findById(a._id)).status, "requested");
});

test("a time that is not on the quarter hour is refused (a lock is made of 15-minute blocks)", async () => {
  const a = await packageRequest();
  const r = await confirm(a, { time: "11:10" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /quarter|15/i);
  assert.equal((await Appointment.findById(a._id)).status, "requested");
});

// ─── the lock: whole package duration ───────────────────────────────────────

test("a 120-minute package takes 8 firm blocks for the artist, 11:00 to 13:00, in the same step as the confirm", async () => {
  const a = await packageRequest();
  const r = await confirm(a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lock, { taken: true, blocks: 8, minutes: 120 });

  const locks = await locksOf(a);
  assert.equal(locks.length, 8);
  assert.ok(locks.every((l) => l.state === "firm" && l.kind === "artist" && String(l.artistId) === String(A._id)));
  assert.deepEqual([hhmm(locks[0].blockStart), hhmm(locks[7].blockStart)], ["11:00", "12:45"]);

  const saved = await Appointment.findById(a._id).lean();
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.startAt.getTime(), at("11:00").getTime());
  assert.equal(saved.endAt.getTime(), at("13:00").getTime());
  const items = saved.guests.flatMap((g) => g.items);
  assert.ok(items.every((i) => String(i.artistId) === String(A._id) && i.artistName === "Mansi Kumari"));
  const minutes = items.reduce((n, i) => n + (i.durationMin || 0) + (i.bufferMin || 0), 0);
  assert.equal(minutes, 120, "the items together fill the package's whole time");
  assert.equal(items[0].startAt.getTime(), at("11:00").getTime());
});

test("a package time that is not a multiple of 15 is rounded UP (100 minutes → 7 blocks)", async () => {
  const a = await packageRequest({ minutes: 100 });
  const r = await confirm(a);
  assert.deepEqual(r.body.lock, { taken: true, blocks: 7, minutes: 105 });
  assert.equal((await locksOf(a)).length, 7);
  assert.equal((await Appointment.findById(a._id)).endAt.getTime(), at("12:45").getTime());
});

test("the owner's package time wins over the services' own times (long services are fitted into it)", async () => {
  const a = await packageRequest({ minutes: 60 });
  await Appointment.updateOne({ _id: a._id }, { $set: { "guests.0.items.0.durationMin": 90, "guests.0.items.1.durationMin": 90 } });
  const r = await confirm(a);
  assert.deepEqual(r.body.lock, { taken: true, blocks: 4, minutes: 60 });
  assert.equal((await locksOf(a)).length, 4);
});

test("an ordinary request (no package) locks its services back to back, with buffers", async () => {
  const a = await plainRequest();
  const r = await confirm(a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 45 min = 3 blocks, 15 + 5 buffer = 2 blocks
  assert.deepEqual(r.body.lock, { taken: true, blocks: 5, minutes: 75 });
  assert.equal((await locksOf(a)).length, 5);
});

// ─── conflicts ──────────────────────────────────────────────────────────────

test("a second online booking for the same artist and time is refused", async () => {
  const a = await packageRequest();
  assert.equal((await confirm(a)).status, 200);
  const selection = await booking.prepareSelection([{ for: "her", services: [String(svcs[0]._id)] }]);
  for (const hhmmAt of ["11:00", "12:00", "12:45"]) {
    await assert.rejects(
      booking.createBooking({ phone: "9876500777", name: "Online", selection, startAt: at(hhmmAt).toISOString(), paymentKind: "full", artistId: String(A._id) }),
      (e) => e.code === "SLOT_TAKEN",
      `online booking at ${hhmmAt} must be refused`
    );
  }
  const free = await booking.createBooking({ phone: "9876500778", name: "Online", selection, startAt: at("13:00").toISOString(), paymentKind: "full", artistId: String(A._id) });
  assert.equal(free.appt.status, "pending_payment", "the minute the package ends the artist is free again");
});

test("confirming over another booking is 409 SLOT_TAKEN and says who is in the way; nothing changes", async () => {
  const first = await packageRequest();
  assert.equal((await confirm(first, { time: "12:00" })).status, 200);
  const second = await packageRequest();
  const r = await confirm(second, { time: "11:00" }); // 11:00-13:00 overlaps 12:00-14:00
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "SLOT_TAKEN");
  assert.match(r.body.error, /Mansi/);
  assert.match(r.body.error, new RegExp(first.ref));
  assert.equal(r.body.conflicts[0].ref, first.ref);
  assert.equal((await Appointment.findById(second._id)).status, "requested", "still waiting");
  assert.equal(await locksOf(second).then((l) => l.length), 0, "no half-written locks");
  assert.equal(await SlotLock.countDocuments(), 8, "only the first request's blocks exist");
});

test("blocked time (lunch, leave) is named as such", async () => {
  await booking.blockTime({ artistId: A._id, startAt: at("12:00"), endAt: at("13:00"), note: "Lunch" });
  const a = await packageRequest();
  const r = await confirm(a);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Blocked time/);
});

test("a different artist at the same time is fine; so is the same artist right after", async () => {
  const one = await packageRequest();
  const two = await packageRequest();
  const three = await packageRequest();
  assert.equal((await confirm(one)).status, 200);
  assert.equal((await confirm(two, { artistId: String(B._id) })).status, 200);
  assert.equal((await confirm(three, { time: "13:00" })).status, 200);
});

test("an online customer's live hold is a conflict; an expired hold is not", async () => {
  const live = await SlotLock.create({ kind: "artist", artistId: A._id, resourceUnit: 0, blockStart: at("11:30"), state: "hold", expiresAt: new Date(Date.now() + 600_000), appointmentId: null });
  const a = await packageRequest();
  assert.equal((await confirm(a)).status, 409);
  await SlotLock.updateOne({ _id: live._id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  assert.equal((await confirm(a)).status, 200, "the lapsed hold the TTL has not removed yet does not block");
  assert.equal(await SlotLock.countDocuments({ appointmentId: null }), 0, "and it is cleaned up");
});

test("two receptionists confirming different requests for the same artist and time: exactly one wins", async () => {
  const [x, y] = await Promise.all([packageRequest(), packageRequest()]);
  const results = await Promise.all([confirm(x), confirm(y)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await SlotLock.countDocuments(), 8);
  assert.equal(await Appointment.countDocuments({ status: "confirmed" }), 1);
});

test("confirming twice is refused and does not double the locks", async () => {
  const a = await packageRequest();
  assert.equal((await confirm(a)).status, 200);
  assert.equal((await confirm(a)).status, 409);
  assert.equal(await SlotLock.countDocuments(), 8);
});

// ─── the Today board ────────────────────────────────────────────────────────

test("the confirmed request shows in the artist's own column for its whole window", async () => {
  const a = await packageRequest();
  await confirm(a);
  const board = await dayBoard(DAY);
  const mine = board.artists.find((r) => String(r._id) === String(A._id));
  const rows = mine.items.filter((i) => String(i.appointmentId) === String(a._id));
  assert.equal(rows.length, 4);
  assert.equal(new Date(rows[0].startAt).getTime(), at("11:00").getTime());
  assert.equal(Math.max(...rows.map((i) => new Date(i.busyUntil).getTime())), at("13:00").getTime());
  const other = board.artists.find((r) => String(r._id) === String(B._id));
  assert.equal(other.items.length, 0);
});

// ─── every way out releases or moves the lock ───────────────────────────────

test("cancel by reception releases the whole lock", async () => {
  const a = await packageRequest();
  await confirm(a);
  assert.equal((await call("POST", `/bookings/${a._id}/cancel`, { reason: "asked to cancel" })).status, 200);
  assert.equal(await locksOf(a).then((l) => l.length), 0);
});

test("cancel by the customer releases the lock", async () => {
  const a = await packageRequest();
  await confirm(a);
  const out = await booking.cancelByCustomer(await Appointment.findById(a._id).lean());
  assert.equal(out.ok, true);
  assert.equal(await locksOf(a).then((l) => l.length), 0);
});

test("no-show releases the lock", async () => {
  const a = await packageRequest();
  await confirm(a);
  const out = await booking.markNoShow(a._id, { now: new Date(at("11:00").getTime() + 3600_000) });
  assert.equal(out.ok, true);
  assert.equal(await locksOf(a).then((l) => l.length), 0);
  assert.equal((await Appointment.findById(a._id)).status, "no_show");
});

test("declining a request never took a lock; a confirmed one cannot be declined and keeps its lock", async () => {
  const waiting = await packageRequest();
  assert.equal((await call("POST", `/bookings/${waiting._id}/decline`, {})).status, 200);
  assert.equal(await SlotLock.countDocuments(), 0);

  const a = await packageRequest();
  await confirm(a);
  assert.equal((await call("POST", `/bookings/${a._id}/decline`, {})).status, 409);
  assert.equal(await locksOf(a).then((l) => l.length), 8, "refused, so nothing was released");
});

test("expiry: the hold sweep leaves a confirmed request and its lock alone", async () => {
  const a = await packageRequest();
  await confirm(a);
  const out = await booking.expireBookings(new Date(Date.now() + 30 * 24 * 3600_000));
  assert.equal(out.requestsExpired, 0);
  assert.equal((await Appointment.findById(a._id)).status, "confirmed");
  assert.equal(await locksOf(a).then((l) => l.length), 8);
});

test("move: the whole lock moves to the new time (still 8 blocks) and the old one is free", async () => {
  const a = await packageRequest();
  await confirm(a);
  const out = await booking.moveBooking(a._id, { startAt: at("15:00") });
  assert.equal(out.ok, true);
  const locks = await locksOf(a);
  assert.equal(locks.length, 8);
  assert.deepEqual([hhmm(locks[0].blockStart), hhmm(locks[7].blockStart)], ["15:00", "16:45"]);
  assert.equal(await SlotLock.countDocuments({ blockStart: at("11:00") }), 0);
  assert.equal((await Appointment.findById(a._id)).endAt.getTime(), at("17:00").getTime());
});

test("move onto someone else's time is refused and the original lock stays", async () => {
  const a = await packageRequest();
  const b = await packageRequest();
  await confirm(a);
  await confirm(b, { time: "15:00" });
  await assert.rejects(booking.moveBooking(a._id, { startAt: at("15:00") }), (e) => e.code === "SLOT_TAKEN");
  assert.deepEqual((await locksOf(a)).map((l) => hhmm(l.blockStart))[0], "11:00");
  assert.equal((await locksOf(a)).length, 8);
});

test("artist change: the lock goes to the new artist at the same time", async () => {
  const a = await packageRequest();
  await confirm(a);
  const out = await booking.moveBooking(a._id, { startAt: at("11:00"), artistId: String(B._id) });
  assert.equal(out.ok, true);
  const locks = await locksOf(a);
  assert.equal(locks.length, 8);
  assert.ok(locks.every((l) => String(l.artistId) === String(B._id)));
  assert.equal(await SlotLock.countDocuments({ artistId: A._id }), 0);
});

test("leave: reassigning for an artist's leave moves the whole lock to a free artist", async () => {
  const a = await packageRequest();
  await confirm(a);
  const out = await booking.reassignForLeave({ artistId: A._id, from: at("00:00"), to: at("23:59") });
  assert.equal(out.flagged.length, 0, JSON.stringify(out.flagged));
  assert.equal(out.moved.length, 1);
  const locks = await locksOf(a);
  assert.equal(locks.length, 8);
  assert.ok(locks.every((l) => String(l.artistId) === String(B._id)));
});

test("reschedule by the customer: not offered for a package (it would shrink to the services' own times); locks untouched", async () => {
  const a = await packageRequest();
  await confirm(a);
  const appt = await Appointment.findById(a._id).lean();
  const settings = (await SiteSettings.getSingleton()).toObject();
  assert.equal(booking.manageRules(appt, settings).canReschedule, false);
  await assert.rejects(booking.rescheduleBooking(appt, { startAt: at("15:00").toISOString() }), (e) => e.code === "LIMIT_REACHED");
  assert.equal(await locksOf(a).then((l) => l.length), 8);
});

test("reschedule by the customer: an ordinary confirmed request still moves its locks", async () => {
  await Artist.updateOne({ _id: A._id }, { $set: { onlineBookable: true } });
  const a = await plainRequest();
  await confirm(a);
  const before = await locksOf(a);
  assert.equal(before.length, 5);
  const appt = await Appointment.findById(a._id).lean();
  const settings = (await SiteSettings.getSingleton()).toObject();
  assert.equal(booking.manageRules(appt, settings).canReschedule, true);
  const out = await booking.rescheduleBooking(appt, { startAt: at("15:00").toISOString() });
  assert.equal(out.startAt.getTime(), at("15:00").getTime());
  const after = await locksOf(a);
  assert.ok(after.length > 0);
  assert.equal(hhmm(after[0].blockStart), "15:00");
  assert.equal(await SlotLock.countDocuments({ blockStart: at("11:00") }), 0);
});

// ─── safety net ─────────────────────────────────────────────────────────────

test("a package with no stored time still confirms, says no lock was taken, and takes none", async () => {
  const a = await packageRequest({ minutes: null });
  const r = await confirm(a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lock.taken, false);
  assert.match(r.body.lock.warning, /no lock taken/i);
  assert.equal((await Appointment.findById(a._id)).status, "confirmed");
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("a package with no matched services still confirms, with the same warning and no lock", async () => {
  const a = await packageRequest({ guests: [{ guestKey: "g1", name: "G", gender: "female", items: [] }] });
  const r = await confirm(a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lock.taken, false);
  assert.match(r.body.lock.warning, /no lock taken/i);
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("the warning is on the request itself, so reception sees it later on the Requests page", async () => {
  const a = await packageRequest({ minutes: null });
  await confirm(a);
  const list = await call("GET", "/bookings/requests?status=confirmed");
  const row = list.body.requests.find((x) => x._id === String(a._id));
  assert.equal(row.noLock, true);
});

// ─── existing data: the report and the backfill (read-only / dry-run) ───────

test("the report lists confirmed future requests with no locks and no artist, and writes nothing", async () => {
  const { findUnlocked } = require("../scripts/reportUnlockedRequests");
  const lacking = await packageRequest();
  await Appointment.updateOne({ _id: lacking._id }, { $set: { status: "confirmed", startAt: at("11:00"), endAt: at("13:00") } });
  const locked = await packageRequest();
  await confirm(locked, { time: "15:00" });
  const out = await findUnlocked(new Date());
  assert.deepEqual(out.map((r) => r.ref), [lacking.ref]);
  assert.equal(out[0].hasArtist, false);
  assert.equal(await SlotLock.countDocuments({ appointmentId: lacking._id }), 0, "report is read-only");
});

test("the backfill is a dry run unless asked; with --apply it locks requests that have an artist and skips the rest", async () => {
  const { backfill } = require("../scripts/backfillRequestLocks");
  const withArtist = await packageRequest();
  await confirm(withArtist, { time: "15:00" });
  await SlotLock.deleteMany({ appointmentId: withArtist._id }); // simulate "confirmed before this change"
  const noArtist = await packageRequest();
  await Appointment.updateOne({ _id: noArtist._id }, { $set: { status: "confirmed", startAt: at("11:00"), endAt: at("13:00") } });

  const dry = await backfill({ apply: false, now: new Date() });
  assert.deepEqual(dry.wouldLock.map((r) => r.ref), [withArtist.ref]);
  assert.deepEqual(dry.skipped.map((r) => r.ref), [noArtist.ref]);
  assert.equal(await SlotLock.countDocuments(), 0, "dry run wrote nothing");

  const done = await backfill({ apply: true, now: new Date() });
  assert.deepEqual(done.locked.map((r) => r.ref), [withArtist.ref]);
  assert.equal(await locksOf(withArtist).then((l) => l.length), 8);
  assert.equal(await locksOf(noArtist).then((l) => l.length), 0);
});
