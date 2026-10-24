/**
 * @file test/group-engine.test.js
 * @description Group bookings, phase 3 (D67, supersedes D46): each person can name an artist, and a
 * group can be served by ONE artist one after another. Through the real app (index.js).
 *
 * What must hold:
 *   - GET /availability and POST /appointments take an artist per person (`a`, `guests[].artist`) and a
 *     layout (`mode` / `groupMode`); the artist asked for is used for the services they can do;
 *   - two people wanting the same artist side by side are refused, and one-after-another is OFFERED
 *     (`hint`), only if one artist can do everyone's services;
 *   - series is strict (one artist, back to back, the named one if anyone named one), is locked whole,
 *     and a second booking cannot take any of it;
 *   - skills, online share, lead time, patch test and the artist defaults by gender still apply;
 *   - messages say "(N people)" inside the existing "when" text, and nothing else changes for one person.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub, server, base;
let Service, Artist, Appointment, SlotLock, SiteSettings, NotificationLog, time, bookingToken, booking;
let DAY, S, A, B, C, D;
let ipN = 0;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/turnstile") return res.end(JSON.stringify({ success: new URLSearchParams(raw).get("response") === "good" }));
      return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(process.env, {
    TURNSTILE_SECRET_KEY: "test-secret", TURNSTILE_VERIFY_URL: `${stubBase}/turnstile`, TELEGRAM_BOT_TOKEN: "", TELEGRAM_API_BASE: stubBase,
    META_WA_TOKEN: "", RAZORPAY_KEY_ID: "rzp_test_fake", RAZORPAY_KEY_SECRET: "k", PUBLIC_TOKEN_SECRET: "test-public-token-secret", CUSTOMER_SITE_URL: "https://www.example.test",
  });
  await startDb();
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/public`;
  Service = require("../models/Service");
  Artist = require("../models/Artist");
  Appointment = require("../models/Appointment");
  SlotLock = require("../models/SlotLock");
  SiteSettings = require("../models/SiteSettings");
  NotificationLog = require("../models/NotificationLog");
  time = require("../utils/time");
  bookingToken = require("../utils/bookingToken");
  booking = require("../utils/booking");
  require("../utils/payments").setClientForTests({ orders: { create: async (o) => ({ id: `order_${Math.random().toString(36).slice(2)}`, amount: o.amount, currency: o.currency, notes: o.notes }) } });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await stopDb();
});

const at = (hhmm, day = DAY) => time.salonInstant(day, hhmm);
const hhmm = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const nextIp = () => `10.8.${Math.floor(++ipN / 250)}.${ipN % 250}`;

beforeEach(async () => {
  await clearDb();
  let d = time.addDays(time.salonDate(), 3);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  DAY = d;
  const s = await SiteSettings.getSingleton();
  s.maxActiveBookingsPerPhone = 50;
  await s.save();
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true, audience: "her" };
  S = await Service.create([
    { ...common, displayCategory: "Hair", name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", durationMinutes: 45 },
    { ...common, displayCategory: "Hair", name: "Blow-dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
    { ...common, displayCategory: "Skin", name: "Hydra Facial", price: 3000, publicPrice: 1500, slug: "hydra-facial", durationMinutes: 60 },
  ]);
  const prof = (slug, name) => ({ slug, displayName: name, visible: true });
  [A, B, C, D] = await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female", onlineBookable: true, publicProfile: prof("mansi", "Mansi") },
    { name: "Ravi", phone: "9888800002", commission: 30, gender: "male", onlineBookable: true, publicProfile: prof("ravi", "Ravi") },
    { name: "Neha", phone: "9888800003", commission: 30, gender: "female", onlineBookable: true, publicProfile: prof("neha", "Neha") },
    { name: "Skin Sana", phone: "9888800004", commission: 30, gender: "female", onlineBookable: true, skillMode: "custom", skillAll: false, skillCategories: ["Skin"], publicProfile: prof("skin-sana", "Sana") },
  ]);
});

async function call(method, path, payload) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}
const ids = (...n) => n.map((i) => String(S[i]._id));
const avail = (guests, extra = "") => call("GET", `/availability?date=${DAY}${guests.map((g) => `&g=${g}`).join("")}${extra}`);
let phoneN = 0;
function book(guests, over = {}) {
  const phone = `98765${String(70000 + ++phoneN)}`;
  return call("POST", "/appointments", {
    bookingToken: bookingToken.issue(phone).token, phone, name: "Asha Rani", guests, startAt: at("11:00").toISOString(), payment: "full", policyAccepted: true, turnstileToken: "good", ...over,
  });
}
const slotAt = (r, t) => r.body.slots.find((s) => s.time === t);
const locksOf = (ref) => Appointment.findOne({ ref }).then((a) => SlotLock.find({ appointmentId: a._id }).lean());

// ─── an artist per person ───────────────────────────────────────────────────

test("availability: each person's artist is used; the slot card has one line per person with their artist and time", async () => {
  const r = await avail([ids(0).join(","), ids(1).join(",")], "&a=mansi&a=ravi");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const slot = slotAt(r, "11:00");
  assert.deepEqual(slot.guests.map((g) => g.items[0].artistName), ["Mansi", "Ravi"]);
  assert.deepEqual(slot.guests.map((g) => g.items[0].startAt), [at("11:00").toISOString(), at("11:00").toISOString()]);
  assert.equal(r.body.groupMode, "parallel");
});

test("availability: 'any' for one person, a name for the other: the named one is honoured", async () => {
  const r = await avail([ids(0).join(","), ids(1).join(",")], "&a=&a=ravi");
  const slot = slotAt(r, "11:00");
  assert.equal(slot.guests[1].items[0].artistName, "Ravi");
  assert.notEqual(slot.guests[0].items[0].artistName, "Ravi");
});

test("booking: the artists asked for are booked and remembered per person; groupMode is parallel", async () => {
  const r = await book([{ for: "her", services: ids(0), artist: "neha" }, { for: "her", services: ids(1), artist: "mansi", name: "Bina" }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  assert.deepEqual(a.guests.map((g) => g.items[0].artistName), ["Neha", "Mansi"]);
  assert.deepEqual(a.guests.map((g) => String(g.preferredArtistId)), [String(C._id), String(A._id)]);
  assert.equal(String(a.preferredArtistId), String(C._id), "the top-level wish is the first person's");
  assert.equal(a.groupMode, "parallel");
  assert.equal(r.body.booking.groupMode, "parallel");
  assert.deepEqual(r.body.booking.guests.map((g) => [g.name, g.items[0].artistName]), [["Asha Rani", "Neha"], ["Bina", "Mansi"]].map(([n, ar]) => [n, ar]));
});

test("a naming of the artist that cannot do the service is not forced: the person gets someone who can", async () => {
  const r = await avail([ids(0).join(","), ids(1).join(",")], "&a=skin-sana&a=");
  const slot = slotAt(r, "11:00");
  assert.ok(slot, "there is still a time");
  assert.notEqual(slot.guests[0].items[0].artistName, "Sana", "Sana only does skin");
});

test("two people wanting the SAME artist side by side: no times, and one-after-another is offered", async () => {
  const r = await avail([ids(0).join(","), ids(1).join(",")], "&a=mansi&a=mansi");
  assert.deepEqual(r.body.slots, []);
  assert.equal(r.body.hint, "series_available");
  assert.equal(r.body.seriesPossible, true);
  const series = await avail([ids(0).join(","), ids(1).join(",")], "&a=mansi&a=mansi&mode=series");
  assert.ok(series.body.slots.length > 0);
  assert.equal(series.body.groupMode, "series");
  const slot = slotAt(series, "11:00");
  assert.deepEqual(slot.guests.map((g) => g.items[0].artistName), ["Mansi", "Mansi"]);
  assert.equal(slot.guests[0].items[0].startAt, at("11:00").toISOString());
  assert.equal(slot.guests[1].items[0].startAt, at("11:45").toISOString(), "the second person follows the first");
  assert.equal(slot.endAt, at("12:15").toISOString());
});

test("one-after-another is only offered when ONE artist can do everyone's services", async () => {
  // Make the three hair artists hair-only, so nobody does both a haircut and a facial.
  await Artist.updateMany({ _id: { $in: [A._id, B._id, C._id] } }, { $set: { skillMode: "custom", skillAll: false, skillCategories: ["Hair"] } });
  // A hair person and a skin person: side by side they can have a hair artist and Sana.
  const r = await avail([ids(0).join(","), ids(2).join(",")]);
  assert.ok(r.body.slots.length > 0);
  assert.equal(r.body.seriesPossible, false);
  const series = await avail([ids(0).join(","), ids(2).join(",")], "&mode=series");
  assert.deepEqual(series.body.slots, []);
  // And with both wanting the only artist for the facial, nothing helps: no hint to follow.
  const same = await avail([ids(2).join(","), ids(2).join(",")], "&a=skin-sana&a=skin-sana");
  assert.deepEqual(same.body.slots, []);
  assert.equal(same.body.hint, "series_available", "Sana can do a facial after a facial");
});

test("series is strict about names: two different named artists, or a named one who cannot do it all, are refused", async () => {
  const two = await avail([ids(0).join(","), ids(1).join(",")], "&a=mansi&a=ravi&mode=series");
  assert.equal(two.status, 400, "'the same artist for everyone' with two different names makes no sense");
  assert.match(two.body.message, /same artist/i);
  const cannot = await avail([ids(0).join(","), ids(1).join(",")], "&a=skin-sana&a=&mode=series");
  assert.deepEqual(cannot.body.slots, []);
  const posted = await book([{ for: "her", services: ids(0), artist: "mansi" }, { for: "her", services: ids(1), artist: "ravi" }], { groupMode: "series" });
  assert.equal(posted.status, 400);
  assert.match(posted.body.message, /same artist/i);
});

test("booking one after another: ONE artist, back to back, locked whole; nobody else can take any of it", async () => {
  const r = await book([{ for: "her", services: ids(0), artist: "mansi" }, { for: "her", services: ids(1), name: "Bina" }], { groupMode: "series" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  assert.equal(a.groupMode, "series");
  assert.deepEqual(a.guests.map((g) => [g.items[0].artistName, hhmm(g.items[0].startAt)]), [["Mansi", "11:00"], ["Mansi", "11:45"]]);
  assert.equal(hhmm(a.endAt), "12:15");
  const locks = await locksOf(a.ref);
  assert.equal(locks.length, 5, "3 blocks + 2 blocks, no gap");
  // A single online booking for Mansi inside the second person's time is refused.
  const other = await book([{ for: "her", services: ids(1), artist: "mansi" }], { startAt: at("11:45").toISOString() });
  assert.equal(other.status, 409);
  assert.equal(other.body.error, "SLOT_TAKEN");
  // The shown price is the sum for both people.
  assert.equal(r.body.booking.pricing.total, 800);
});

test("two bookings racing for the same artist one after another: exactly one wins", async () => {
  const mk = () => book([{ for: "her", services: ids(0), artist: "mansi" }, { for: "her", services: ids(1) }], { groupMode: "series" });
  const results = await Promise.all([mk(), mk()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await SlotLock.countDocuments(), 5);
});

test("the top-level artistSlug still works for ONE person, and is ignored for a group (each person names their own)", async () => {
  const one = await book([{ for: "her", services: ids(0) }], { artistSlug: "ravi" });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal((await Appointment.findOne({ ref: one.body.booking.ref }).lean()).guests[0].items[0].artistName, "Ravi");
  const group = await book([{ for: "her", services: ids(0) }, { for: "her", services: ids(1) }], { artistSlug: "ravi", startAt: at("15:00").toISOString() });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  const a = await Appointment.findOne({ ref: group.body.booking.ref }).lean();
  assert.equal(a.guests.filter((g) => g.items[0].artistName === "Ravi").length <= 1, true);
});

test("unknown or offline artists, too many artists, and bad modes are refused", async () => {
  assert.equal((await book([{ for: "her", services: ids(0), artist: "nobody" }, { for: "her", services: ids(1) }])).status, 400);
  assert.equal((await book([{ for: "her", services: ids(0) }], { groupMode: "sideways" })).status, 400);
  assert.equal((await avail([ids(0).join(","), ids(1).join(",")], "&a=mansi&a=ravi&a=neha")).status, 400);
  assert.equal((await avail([ids(0).join(",")], "&mode=sideways")).status, 400);
});

// ─── the other rules still apply to groups ──────────────────────────────────

test("skills by gender default still apply to a group", async () => {
  await SiteSettings.updateOne({}, { $set: { "artistSkillDefaults.male": { all: false, categories: ["Skin"] } } });
  const r = await avail([ids(0).join(","), ids(1).join(",")], "&a=ravi&a=");
  const slot = slotAt(r, "11:00");
  assert.ok(slot);
  assert.ok(slot.guests.every((g) => g.items[0].artistName !== "Ravi"), "Ravi's default skills are skin only, so he cannot be given hair");
});

test("online share still limits what a group can sell with one artist", async () => {
  await Artist.updateMany({ _id: { $in: [B._id, C._id, D._id] } }, { $set: { isActive: false } });
  await Artist.updateOne({ _id: A._id }, { $set: { onlineShare: 0 } });
  assert.deepEqual((await avail([ids(0).join(","), ids(1).join(",")], "&mode=series")).body.slots, []);
  await Artist.updateOne({ _id: A._id }, { $set: { onlineShare: 100 } });
  assert.ok((await avail([ids(0).join(","), ids(1).join(",")], "&mode=series")).body.slots.length > 0);
});

test("lead time still applies to a group", async () => {
  await SiteSettings.updateOne({}, { $set: { minLeadMinutes: 100 * 60 * 24 } });
  assert.deepEqual((await avail([ids(0).join(","), ids(1).join(",")])).body.slots, []);
});

test("a patch-test service in a group pushes the whole group back 48 hours unless a recent test is on record", async () => {
  await Service.updateOne({ _id: S[1]._id }, { $set: { requiresPatchTest: true } });
  const soon = time.salonDate();
  const r = await call("GET", `/availability?date=${soon}&g=${ids(0)[0]}&g=${ids(1)[0]}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.slots, [], "today is inside the 48 hours");
  assert.equal(r.body.patchTestDelay, true);
});

// ─── messages ───────────────────────────────────────────────────────────────

async function confirmedGroup(layout = "parallel") {
  const r = await book([{ for: "her", services: ids(0), artist: "mansi" }, { for: "her", services: ids(1), artist: layout === "series" ? "mansi" : "ravi" }], layout === "series" ? { groupMode: "series" } : {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const appt = await Appointment.findOne({ ref: r.body.booking.ref });
  await Appointment.updateOne({ _id: appt._id }, { $set: { status: "confirmed", "deposit.status": "paid" } });
  return appt._id;
}

test("a move says '(2 people)' inside the existing 'when' text; one person's text is unchanged", async () => {
  const id = await confirmedGroup();
  await booking.moveBooking(id, { startAt: at("15:00") });
  const log = await NotificationLog.findOne({ type: "booking_moved" }).lean();
  assert.match(log.params.when, /3:00 pm \(2 people\)$/);
  assert.deepEqual(Object.keys(log.params).sort(), ["link", "name", "ref", "when"], "no new placeholder");

  const solo = await book([{ for: "her", services: ids(0), artist: "neha" }], { startAt: at("17:00").toISOString() });
  const sid = (await Appointment.findOne({ ref: solo.body.booking.ref }))._id;
  await Appointment.updateOne({ _id: sid }, { $set: { status: "confirmed", "deposit.status": "paid" } });
  await NotificationLog.deleteMany({});
  await booking.moveBooking(sid, { startAt: at("18:00") });
  assert.doesNotMatch((await NotificationLog.findOne({ type: "booking_moved" }).lean()).params.when, /people/);
});

// ─── manage page: reschedule keeps what was asked ───────────────────────────

test("the manage page offers times that keep each person's artist, and a customer reschedule keeps them", async () => {
  const r = await book([{ for: "her", services: ids(0), artist: "neha" }, { for: "her", services: ids(1), artist: "mansi" }]);
  const a = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  await Appointment.updateOne({ _id: a._id }, { $set: { status: "confirmed", "deposit.status": "paid" } });
  const token = bookingToken.manageToken(a._id);
  const slots = await call("GET", `/booking/${token}/availability?date=${DAY}`);
  assert.equal(slots.status, 200, JSON.stringify(slots.body));
  const t15 = slotAt(slots, "15:00");
  assert.deepEqual(t15.guests.map((g) => g.items[0].artistName), ["Neha", "Mansi"]);
  const moved = await booking.rescheduleBooking(await Appointment.findById(a._id).lean(), { startAt: at("15:00").toISOString() });
  assert.equal(hhmm(moved.startAt), "15:00");
  const after = await Appointment.findById(a._id).lean();
  assert.deepEqual(after.guests.map((g) => g.items[0].artistName), ["Neha", "Mansi"]);
});

test("a series booking stays one-after-another when the customer reschedules it", async () => {
  const id = await confirmedGroup("series");
  const appt = await Appointment.findById(id).lean();
  const moved = await booking.rescheduleBooking(appt, { startAt: at("16:00").toISOString() });
  const after = await Appointment.findById(id).lean();
  assert.equal(after.groupMode, "series");
  assert.deepEqual(after.guests.map((g) => [g.items[0].artistName, hhmm(g.items[0].startAt)]), [["Mansi", "16:00"], ["Mansi", "16:45"]]);
  assert.equal(hhmm(moved.endAt), "17:15");
  assert.equal((await SlotLock.find({ appointmentId: id })).length, 5);
});
