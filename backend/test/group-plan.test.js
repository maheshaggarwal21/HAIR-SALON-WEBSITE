/**
 * @file test/group-plan.test.js
 * @description Group bookings, phase 1: one write path for a booking's plan
 * (applyGroupPlan), moving by a time shift, and changing ONE guest's artist.
 *
 * What must hold:
 *   - move SHIFTS every item by the same amount: a parallel group stays parallel, a group
 *     served by one artist one after another stays in series (the old "known limit");
 *   - changing one guest's artist re-picks only that guest's items, checks skills, goes
 *     through the one transaction, is audited, and is 409 naming who when the artist is busy;
 *   - two staff racing: exactly one wins, and nobody's change is lost or half written;
 *   - every way a group ends or changes releases or re-takes ALL its locks, none leak.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.META_WA_TOKEN = "";
process.env.PUBLIC_TOKEN_SECRET = "t";

let Appointment, Artist, Service, SlotLock, SiteSettings, AuditLog, time, booking, dayBoard, server, base;
let DAY, A, B, C, D, svcs;
const BLOCK = 15 * 60_000;

before(async () => {
  await startDb();
  Appointment = require("../models/Appointment");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  SlotLock = require("../models/SlotLock");
  SiteSettings = require("../models/SiteSettings");
  AuditLog = require("../models/AuditLog");
  time = require("../utils/time");
  booking = require("../utils/booking");
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

const at = (hhmm, day = DAY) => time.salonInstant(day, hhmm);
const hhmm = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

beforeEach(async () => {
  await clearDb();
  await SiteSettings.getSingleton();
  let d = time.addDays(time.salonDate(), 3);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  DAY = d;
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true, audience: "her" };
  svcs = await Service.create([
    { ...common, displayCategory: "Hair", name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", durationMinutes: 45 },
    { ...common, displayCategory: "Hair", name: "Blow-dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
    { ...common, displayCategory: "Skin", name: "Hydra Facial", price: 3000, publicPrice: 1500, slug: "hydra-facial", durationMinutes: 60 },
  ]);
  [A, B, C, D] = await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female", onlineBookable: true },
    { name: "Ravi", phone: "9888800002", commission: 30, gender: "male", onlineBookable: true },
    { name: "Neha", phone: "9888800003", commission: 30, gender: "female", onlineBookable: true },
    // Skin only: cannot do hair.
    { name: "Skin Sana", phone: "9888800004", commission: 30, gender: "female", onlineBookable: true, skillMode: "custom", skillAll: false, skillCategories: ["Skin"] },
  ]);
});

async function call(method, path, data) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let refN = 0;
const itemOf = (s, artist, startMs) => ({
  serviceId: s._id, name: s.name, publicPrice: s.publicPrice, listPrice: s.price,
  durationMin: s.durationMinutes, bufferMin: 0,
  artistId: artist._id, artistName: artist.name,
  startAt: new Date(startMs), endAt: new Date(startMs + s.durationMinutes * 60_000),
});

/**
 * A confirmed group booking with its locks.
 *  parallel: guest i is served by artists[i], everyone from `start`.
 *  series:   one artist, guest after guest.
 */
async function makeGroup({ layout = "parallel", artists = [A, B], services = [svcs[0], svcs[1]], start = "11:00", status = "confirmed", names = ["Asha", "Bina"] } = {}) {
  const startMs = at(start).getTime();
  let cursor = startMs;
  const guests = services.map((s, i) => {
    const artist = layout === "series" ? artists[0] : artists[i];
    const from = layout === "series" ? cursor : startMs;
    const it = itemOf(s, artist, from);
    cursor = from + Math.ceil(s.durationMinutes / 15) * BLOCK;
    return { guestKey: `g${i + 1}`, name: names[i] ?? null, gender: "female", items: [it] };
  });
  const endMs = Math.max(...guests.flatMap((g) => g.items.map((i) => i.endAt.getTime())));
  const appt = await Appointment.create({
    ref: `EXP-G${String(++refN).padStart(4, "2")}`, mode: "instant", status,
    contact: `98765${String(50000 + refN)}`, name: "Booker", guests,
    startAt: new Date(startMs), endAt: new Date(endMs),
    pricing: { subtotal: 800, total: 800 }, source: { channel: "web" },
    statusHistory: [{ from: null, to: status, at: new Date(), by: "customer" }],
  });
  await SlotLock.insertMany(booking.lockDocsFor(appt.toObject(), { state: "firm", expiresAt: null }));
  return appt;
}

const locksOf = (a) => SlotLock.find({ appointmentId: a._id }).sort({ artistId: 1, blockStart: 1 }).lean();
const fresh = (a) => Appointment.findById(a._id).lean();
const itemsOf = (appt) => appt.guests.flatMap((g) => g.items);
/** Blocks the items SHOULD hold: the invariant behind "no leaked locks". */
const expectedBlocks = (appt) => itemsOf(appt).reduce((n, i) => n + (i.artistId ? Math.ceil(((i.durationMin || 0) + (i.bufferMin || 0)) / 15) : 0), 0);
async function assertLocksMatch(a) {
  const cur = await fresh(a);
  const locks = await locksOf(a);
  assert.equal(locks.length, expectedBlocks(cur), "the locks are exactly the blocks the items hold");
  const owned = new Set(itemsOf(cur).flatMap((i) => Array.from({ length: Math.ceil((i.durationMin + (i.bufferMin || 0)) / 15) }, (_, n) => `${i.artistId}|${i.startAt.getTime() + n * BLOCK}`)));
  assert.deepEqual(new Set(locks.map((l) => `${l.artistId}|${l.blockStart.getTime()}`)), owned);
}

// ─── applyGroupPlan itself ──────────────────────────────────────────────────

test("applyGroupPlan: one transaction replaces the locks, saves the plan and bumps planRev", async () => {
  const a = await makeGroup();
  const out = await booking.applyGroupPlan(a._id, {
    statuses: ["confirmed"],
    plan: (cur) => {
      const guests = cur.guests.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, startAt: new Date(i.startAt.getTime() + 2 * 3600_000), endAt: new Date(i.endAt.getTime() + 2 * 3600_000) })) }));
      return { guests, startAt: new Date(cur.startAt.getTime() + 2 * 3600_000), endAt: new Date(cur.endAt.getTime() + 2 * 3600_000) };
    },
    reason: "test",
  });
  assert.equal(out.ok, true);
  const cur = await fresh(a);
  assert.equal(cur.planRev, 1);
  assert.equal(hhmm(cur.startAt), "13:00");
  assert.equal(cur.statusHistory.at(-1).reason, "test");
  await assertLocksMatch(a);
});

test("applyGroupPlan: a plan built from an out-of-date copy is refused, nothing written", async () => {
  const a = await makeGroup();
  await booking.applyGroupPlan(a._id, { statuses: ["confirmed"], plan: (cur) => ({ guests: cur.guests, startAt: cur.startAt, endAt: cur.endAt }) }); // planRev 0 → 1
  const stale = await booking.applyGroupPlan(a._id, { statuses: ["confirmed"], expectRev: 0, plan: (cur) => ({ guests: [], startAt: cur.startAt, endAt: cur.endAt }) });
  assert.deepEqual(stale, { ok: false, error: "CONFLICT" });
  await assertLocksMatch(a);
  assert.equal(itemsOf(await fresh(a)).length, 2);
});

test("applyGroupPlan: a status the caller did not expect is a CONFLICT", async () => {
  const a = await makeGroup({ status: "cancelled" });
  const out = await booking.applyGroupPlan(a._id, { statuses: ["confirmed"], plan: (cur) => cur });
  assert.deepEqual(out, { ok: false, error: "CONFLICT" });
});

// ─── move shifts, it does not re-chain ──────────────────────────────────────

test("move keeps a PARALLEL group parallel: every item shifts by the same amount", async () => {
  const a = await makeGroup({ layout: "parallel" });
  const out = await booking.moveBooking(a._id, { startAt: at("15:00") });
  assert.equal(out.ok, true);
  const cur = await fresh(a);
  assert.deepEqual(itemsOf(cur).map((i) => hhmm(i.startAt)), ["15:00", "15:00"]);
  assert.deepEqual(itemsOf(cur).map((i) => hhmm(i.endAt)), ["15:45", "15:30"]);
  assert.equal(hhmm(cur.endAt), "15:45");
  await assertLocksMatch(a);
  assert.equal(await SlotLock.countDocuments({ blockStart: at("11:00") }), 0, "the old time is free");
});

test("move keeps a ONE-ARTIST SERIES group in series (the old known limit)", async () => {
  const a = await makeGroup({ layout: "series", artists: [A], services: [svcs[0], svcs[1]] });
  const before = itemsOf(await fresh(a)).map((i) => hhmm(i.startAt));
  assert.deepEqual(before, ["11:00", "11:45"]);
  const out = await booking.moveBooking(a._id, { startAt: at("16:00") });
  assert.equal(out.ok, true);
  const cur = await fresh(a);
  assert.deepEqual(itemsOf(cur).map((i) => hhmm(i.startAt)), ["16:00", "16:45"], "the second guest still follows the first");
  assert.ok(itemsOf(cur).every((i) => String(i.artistId) === String(A._id)));
  await assertLocksMatch(a);
  assert.equal((await locksOf(a)).length, 5);
});

test("move backwards works too, and a single-guest booking still moves", async () => {
  const a = await makeGroup({ layout: "series", artists: [A], start: "15:00" });
  assert.equal((await booking.moveBooking(a._id, { startAt: at("10:00") })).ok, true);
  assert.deepEqual(itemsOf(await fresh(a)).map((i) => hhmm(i.startAt)), ["10:00", "10:45"]);
  const single = await makeGroup({ artists: [B], services: [svcs[2]], names: ["Solo"], start: "13:00" });
  assert.equal((await booking.moveBooking(single._id, { startAt: at("17:00") })).ok, true);
  await assertLocksMatch(single);
});

test("move onto a time where one guest's artist is busy: 409 SLOT_TAKEN naming who; the booking is untouched", async () => {
  const other = await makeGroup({ artists: [B, C], start: "15:00", names: ["Other One", "Other Two"] });
  const a = await makeGroup({ layout: "parallel", artists: [A, B] });
  await assert.rejects(booking.moveBooking(a._id, { startAt: at("15:00") }), (e) => {
    assert.equal(e.code, "SLOT_TAKEN");
    assert.equal(e.status, 409);
    assert.match(e.message, new RegExp(other.ref));
    assert.equal(e.conflicts[0].ref, other.ref);
    return true;
  });
  const cur = await fresh(a);
  assert.deepEqual(itemsOf(cur).map((i) => hhmm(i.startAt)), ["11:00", "11:00"]);
  await assertLocksMatch(a);
  await assertLocksMatch(other);
});

test("move with an artist for a booking of 2+ people is refused (use the per-person change); one person still can", async () => {
  const a = await makeGroup();
  await assert.rejects(booking.moveBooking(a._id, { startAt: at("15:00"), artistId: String(C._id) }), (e) => e.code === "VALIDATION");
  assert.equal(hhmm((await fresh(a)).startAt), "11:00");
  const solo = await makeGroup({ artists: [A], services: [svcs[0]], names: ["Solo"], start: "13:00" });
  assert.equal((await booking.moveBooking(solo._id, { startAt: at("13:00"), artistId: String(C._id) })).ok, true);
  assert.equal(String(itemsOf(await fresh(solo))[0].artistId), String(C._id));
  await assertLocksMatch(solo);
});

test("the move route says who is in the way", async () => {
  const other = await makeGroup({ artists: [A], services: [svcs[0]], names: ["Blocker"], start: "15:00" });
  const a = await makeGroup({ artists: [A, B] });
  const r = await call("POST", `/bookings/${a._id}/move`, { startAt: at("15:00").toISOString() });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "SLOT_TAKEN");
  assert.match(r.body.error, new RegExp(other.ref));
});

// ─── one guest's artist ─────────────────────────────────────────────────────

const changeArtist = (a, guestKey, artistId) => call("POST", `/bookings/${a._id}/guests/${guestKey}/artist`, { artistId });

test("change one guest's artist: only that guest's items and locks move; audited; planRev bumped", async () => {
  const a = await makeGroup({ artists: [A, B] });
  const r = await changeArtist(a, "g2", String(C._id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cur = await fresh(a);
  assert.equal(cur.guests[0].items[0].artistName, "Mansi Kumari", "guest 1 untouched");
  assert.equal(cur.guests[1].items[0].artistName, "Neha");
  assert.equal(hhmm(cur.guests[1].items[0].startAt), "11:00", "same time");
  assert.equal(cur.planRev, 1);
  await assertLocksMatch(a);
  assert.equal(await SlotLock.countDocuments({ artistId: B._id }), 0, "Ravi is free again");
  const log = await AuditLog.findOne({ action: "booking.guest_artist_changed" }).lean();
  assert.equal(log.meta.ref, a.ref);
  assert.equal(log.meta.guestKey, "g2");
});

test("change: the artist must be active, and able to do every service of that guest", async () => {
  const a = await makeGroup({ artists: [A, B] }); // guest 2 has a hair service
  const skin = await changeArtist(a, "g2", String(D._id));
  assert.equal(skin.status, 400);
  assert.match(skin.body.error, /Skin Sana/);
  await Artist.updateOne({ _id: C._id }, { $set: { isActive: false } });
  assert.equal((await changeArtist(a, "g2", String(C._id))).status, 400);
  assert.equal((await changeArtist(a, "g9", String(C._id))).status, 404, "unknown guest");
  assert.equal((await changeArtist(a, "g2", "not-an-id")).status, 400);
  await assertLocksMatch(a);
  assert.equal(String(itemsOf(await fresh(a))[1].artistId), String(B._id));
});

test("change: 409 naming who is in the way when the new artist is busy; nothing changes", async () => {
  const blocker = await makeGroup({ artists: [C], services: [svcs[0]], names: ["Blocker"], start: "11:15" });
  const a = await makeGroup({ artists: [A, B] });
  const r = await changeArtist(a, "g2", String(C._id));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "SLOT_TAKEN");
  assert.match(r.body.error, new RegExp(blocker.ref));
  assert.match(r.body.error, /Neha/);
  assert.equal(String(itemsOf(await fresh(a))[1].artistId), String(B._id));
  await assertLocksMatch(a);
});

test("change: giving a guest the artist who is already doing another guest at that time is refused, with a clear reason", async () => {
  const a = await makeGroup({ artists: [A, B] });
  const r = await changeArtist(a, "g2", String(A._id));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /one after another|same time/i);
  await assertLocksMatch(a);
});

test("change: no artist (null) = auto-pick, like the engine: a free artist who can do it, never one busy or doing the other guest", async () => {
  await makeGroup({ artists: [B, C], services: [svcs[0], svcs[0]], start: "11:00", names: ["x", "y"] }); // B and C busy at 11:00
  const a = await makeGroup({ artists: [A, D], services: [svcs[0], svcs[2]], start: "11:00" });
  // Guest 2 has a facial. B and C are busy; D (skin) is already doing it, A is doing guest 1.
  await Artist.updateOne({ _id: D._id }, { $set: { skillAll: true } });
  const r = await changeArtist(a, "g1", null);
  // Guest 1 (haircut): A is doing it now; B, C busy; D is doing guest 2 → nobody free
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /nobody|no one|free/i);
  await assertLocksMatch(a);

  await SlotLock.deleteMany({ artistId: C._id });
  const again = await changeArtist(a, "g1", null);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(itemsOf(await fresh(a))[0].artistName, "Neha");
  await assertLocksMatch(a);
});

test("change on a booking that is not live (cancelled) is a 409, not a silent write", async () => {
  const a = await makeGroup({ artists: [A, B], status: "cancelled" });
  await SlotLock.deleteMany({});
  assert.equal((await changeArtist(a, "g2", String(C._id))).status, 409);
});

test("groupMode follows the artists: series only while everyone has the same artist", async () => {
  const a = await makeGroup({ layout: "series", artists: [A], services: [svcs[0], svcs[1]] });
  await Appointment.updateOne({ _id: a._id }, { $set: { groupMode: "series" } });
  const r = await changeArtist(a, "g2", String(C._id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await fresh(a)).groupMode, "parallel");
  assert.deepEqual(itemsOf(await fresh(a)).map((i) => hhmm(i.startAt)), ["11:00", "11:45"], "the times stay as they were");
  await assertLocksMatch(a);
  const back = await changeArtist(a, "g2", String(A._id));
  assert.equal(back.status, 200);
  assert.equal((await fresh(a)).groupMode, "series");
});

// ─── racing ─────────────────────────────────────────────────────────────────

test("two staff changing different guests of one booking at once: both changes land, none is lost", async () => {
  const a = await makeGroup({ artists: [A, B] });
  const [x, y] = await Promise.all([changeArtist(a, "g1", String(C._id)), changeArtist(a, "g2", String(A._id))]);
  // g1 → Neha and g2 → Mansi at the same time: Mansi is freed by g1's change, so both can succeed in some order,
  // or the second is refused because Mansi was still busy when it ran. Either way the booking must be consistent.
  assert.ok([x.status, y.status].every((s) => [200, 409].includes(s)), `${x.status} ${y.status}`);
  await assertLocksMatch(a);
  const cur = await fresh(a);
  if (x.status === 200 && y.status === 200) assert.deepEqual(itemsOf(cur).map((i) => i.artistName), ["Neha", "Mansi Kumari"]);
});

test("two staff changing two guests of one booking to the SAME artist: exactly one wins", async () => {
  const a = await makeGroup({ artists: [A, B] });
  const [x, y] = await Promise.all([changeArtist(a, "g1", String(C._id)), changeArtist(a, "g2", String(C._id))]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  await assertLocksMatch(a);
  const names = itemsOf(await fresh(a)).map((i) => i.artistName);
  assert.equal(names.filter((n) => n === "Neha").length, 1);
});

test("two staff moving two bookings onto the same artist and time: exactly one wins", async () => {
  const a = await makeGroup({ artists: [A, B], start: "10:00" });
  const b = await makeGroup({ artists: [A, B], start: "13:00", names: ["P", "Q"] });
  const results = await Promise.allSettled([booking.moveBooking(a._id, { startAt: at("16:00") }), booking.moveBooking(b._id, { startAt: at("16:00") })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "SLOT_TAKEN");
  await assertLocksMatch(a);
  await assertLocksMatch(b);
});

// ─── every way out ──────────────────────────────────────────────────────────

test("cancel releases ALL of a group's locks", async () => {
  const a = await makeGroup();
  assert.equal((await call("POST", `/bookings/${a._id}/cancel`, {})).status, 200);
  assert.equal((await locksOf(a)).length, 0);
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("no-show releases ALL of a group's locks", async () => {
  const a = await makeGroup();
  const out = await booking.markNoShow(a._id, { now: new Date(at("11:00").getTime() + 3600_000) });
  assert.equal(out.ok, true);
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("leave: only the affected guest is re-picked; the other guest's lock stays; no leak", async () => {
  const a = await makeGroup({ artists: [A, B] });
  const out = await booking.reassignForLeave({ artistId: A._id, from: at("00:00"), to: at("23:59") });
  assert.equal(out.flagged.length, 0, JSON.stringify(out.flagged));
  assert.equal(out.moved.length, 1);
  const cur = await fresh(a);
  assert.equal(cur.guests[1].items[0].artistName, "Ravi", "guest 2 untouched");
  assert.notEqual(cur.guests[0].items[0].artistName, "Mansi Kumari");
  assert.equal(cur.planRev, 1);
  await assertLocksMatch(a);
});

test("leave: a series group on the artist who leaves is flagged when nobody can take them, and nothing changes", async () => {
  await Artist.updateMany({ _id: { $in: [B._id, C._id, D._id] } }, { $set: { isActive: false } });
  const a = await makeGroup({ layout: "series", artists: [A] });
  const out = await booking.reassignForLeave({ artistId: A._id, from: at("00:00"), to: at("23:59") });
  assert.equal(out.moved.length, 0);
  assert.equal(out.flagged.length, 1);
  await assertLocksMatch(a);
});

test("customer reschedule of a group moves every guest's locks together", async () => {
  const a = await makeGroup({ artists: [A, B] });
  await Appointment.updateOne({ _id: a._id }, { $set: { manageTokenHash: "x" } });
  const appt = await fresh(a);
  const out = await booking.rescheduleBooking(appt, { startAt: at("15:00").toISOString() });
  assert.equal(hhmm(out.startAt), "15:00");
  assert.deepEqual(itemsOf(await fresh(a)).map((i) => hhmm(i.startAt)), ["15:00", "15:00"]);
  assert.equal((await fresh(a)).planRev, 1);
  assert.equal((await fresh(a)).rescheduleCount, 1);
  await assertLocksMatch(a);
});

test("confirming a request still goes through the same path and still bumps planRev", async () => {
  const req = await Appointment.create({
    ref: `EXP-G${String(++refN).padStart(4, "2")}`, mode: "request", status: "requested", contact: "9876543210", name: "Web",
    guests: [{ guestKey: "g1", name: "Web", gender: "female", items: [{ serviceId: svcs[0]._id, name: "Haircut Women", publicPrice: 500, durationMin: 45, bufferMin: 0 }] }],
    requestedWindow: { date: DAY, window: "morning" }, pricing: { subtotal: 500, total: 500 }, source: { channel: "web" },
  });
  const r = await call("POST", `/bookings/${req._id}/confirm`, { date: DAY, time: "11:00", artistId: String(A._id) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await fresh(req)).planRev, 1);
  await assertLocksMatch(req);
});

// ─── the board ──────────────────────────────────────────────────────────────

test("the board gives every item its guest, so a group shows one row per person", async () => {
  const a = await makeGroup({ artists: [A, B], names: ["Asha", null] });
  const board = await dayBoard(DAY);
  const rows = board.artists.flatMap((r) => r.items).filter((i) => String(i.appointmentId) === String(a._id));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.guestKey).sort(), ["g1", "g2"]);
  assert.ok(rows.every((r) => r.groupSize === 2));
  const second = rows.find((r) => r.guestKey === "g2");
  assert.equal(second.guestName, null);
  assert.match(second.name, /Booker/);
  assert.match(second.name, /2/, "an unnamed second guest is not shown as the booker");
  assert.equal(rows.find((r) => r.guestKey === "g1").name, "Asha");
  assert.equal(rows.find((r) => r.guestKey === "g1").artistName, "Mansi Kumari");
});
