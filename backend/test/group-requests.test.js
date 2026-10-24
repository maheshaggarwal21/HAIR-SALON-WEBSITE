/**
 * @file test/group-requests.test.js
 * @description Group bookings, phase 2 (D67): the offer page takes "how many people", and reception
 * confirms a group request with one artist per person.
 *
 * What must hold:
 *   - a request for N people makes N guests, each with the chosen package, and the price is
 *     computed on the server (package price x N), never taken from the browser;
 *   - a ONE-person request is exactly what it was: same response, same stored shape, same
 *     owner alert, same WhatsApp text (golden values below, captured before this change);
 *   - confirming a group locks the WHOLE package time for every person, each with their own
 *     artist; people given the same artist are done one after another; a clash is 409 naming who;
 *   - "Suggest artists" proposes free, skilled, working artists, or says why not, with nearer times.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.META_WA_TOKEN = "";
process.env.PUBLIC_TOKEN_SECRET = "t";

let Appointment, Artist, Service, SlotLock, SiteSettings, NotificationLog, time, booking, alerts, wa, server, base;
let DAY, A, B, C, D;
let ipN = 0;
let phoneN = 0;

before(async () => {
  await startDb();
  Appointment = require("../models/Appointment");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  SlotLock = require("../models/SlotLock");
  SiteSettings = require("../models/SiteSettings");
  NotificationLog = require("../models/NotificationLog");
  time = require("../utils/time");
  booking = require("../utils/booking");
  alerts = require("../utils/bookingAlerts");
  wa = require("../utils/waRequest");
  const app = express();
  app.use(express.json());
  app.use("/api/public", require("../routes/public"));
  app.use((req, _res, next) => {
    req.session = { userId: new mongoose.Types.ObjectId(), name: "Reena", role: "owner" };
    next();
  });
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/website", require("../routes/website"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const at = (hhmm, day = DAY) => time.salonInstant(day, hhmm);
const hhmm = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const phone = () => `98${String(76500000 + ++phoneN)}`;

async function call(method, path, data, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.4.${Math.floor(++ipN / 250)}.${ipN % 250}`, ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(async () => {
  await clearDb();
  await SiteSettings.getSingleton();
  const s = (await SiteSettings.getSingleton()).toObject();
  for (let n = 3; n < 17; n++) {
    const d = time.addDays(time.salonDate(), n);
    if ((s.openingHours[time.weekdayKey(d)] || []).length && !s.holidays.includes(d)) {
      DAY = d;
      break;
    }
  }
  const c = { isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Hair", durationConfirmed: true };
  await Service.create([
    { ...c, name: "Hair Spa", price: 1600, publicPrice: 800, slug: "hair-spa", durationMinutes: 60 },
    { ...c, name: "Blow Dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
  ]);
  [A, B, C, D] = await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female" },
    { name: "Ravi", phone: "9888800002", commission: 30, gender: "male" },
    { name: "Neha", phone: "9888800003", commission: 30, gender: "female" },
    { name: "Skin Sana", phone: "9888800004", commission: 30, gender: "female", skillMode: "custom", skillAll: false, skillCategories: ["Skin"] },
  ]);
  const made = await call("POST", "/website/campaigns", {
    name: "Karva Chauth 2026",
    startDate: time.salonDate(),
    endDate: time.addDays(time.salonDate(), 20),
    content: { headline: "Karva Chauth glow", ctaHref: "/offers/karva-chauth" },
    page: {
      slug: "pkgs",
      headline: "Karva Chauth glow",
      packages: [
        { name: "Package 1", price: 3500, services: ["Hair Spa", "Blow Dry", "Kanpeki Facial"], durationMinutes: 120 },
        { name: "Mystery", price: 1999, services: ["Zzyzx Ritual", "Quux Glow"], durationMinutes: 90 },
      ],
    },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
});

const wreq = (over = {}) =>
  call("POST", "/public/requests/wa", { offerSlug: "pkgs", packageSlug: "package-1", date: DAY, time: "11:00", name: "Asha Kaur", phone: phone(), campaign: "karwa", ...over });
const stored = (ref) => Appointment.findOne({ ref }).lean();

// ─── the one-person request is exactly what it was ──────────────────────────

test("one person: the response, the stored booking, the owner alert and the WhatsApp text are exactly as before", async () => {
  const r = await wreq({ phone: "9876500001" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body), ["ref", "status", "date", "time", "package", "items", "duplicate"]);
  assert.deepEqual({ ...r.body, ref: "REF" }, {
    ref: "REF", status: "requested", date: DAY, time: "11:00",
    package: { name: "Package 1", price: 3500 },
    items: [{ name: "Hair Spa" }, { name: "Blow Dry" }, { name: "Kanpeki Facial" }],
    duplicate: false,
  });
  const a = await stored(r.body.ref);
  assert.equal(a.guests.length, 1);
  assert.deepEqual([a.guests[0].guestKey, a.guests[0].name, a.guests[0].gender], ["g1", "Asha Kaur", null]);
  assert.deepEqual(a.guests[0].items.map((i) => [i.name, i.publicPrice, i.durationMin]), [["Blow Dry", 300, 30], ["Hair Spa", 800, 60]]);
  assert.deepEqual(a.pricing, { subtotal: 3500, discount: 0, total: 3500, packageId: null, promoCode: null, campaignId: null });
  assert.deepEqual(a.requestedWindow, { date: DAY, window: "morning", time: "11:00" });
  assert.deepEqual(a.source.offerPackage, { slug: "package-1", name: "Package 1", price: 3500, services: ["Hair Spa", "Blow Dry", "Kanpeki Facial"], durationMinutes: 120 });
  assert.equal(a.groupMode, "parallel");

  const day = new Date(`${DAY}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  assert.equal(
    alerts.requestAlertText(a),
    `🆕 WhatsApp ad request ${a.ref}\nAsha Kaur · 9876500001\n${day}, 11:00\nPackage: Package 1 — ₹3,500\n• Hair Spa\n• Blow Dry\n• Kanpeki Facial\nFrom: whatsapp / karwa\nOffer: Karva Chauth glow (apply it at billing; nothing is discounted yet)\nUnpaid request from a WhatsApp ad.\n\nConfirm a time in the staff app → Requests.`
  );
  assert.equal(wa.requestedWhen(a), `${day}, 11:00 am`);
  const log = await NotificationLog.findOne({ key: `${a._id}:request_received` }).lean();
  assert.equal(log.params.when, `${day}, 11:00 am`);
});

test("one person: people=1 and no people are the same request, and the staff list has no group fields", async () => {
  const one = await wreq({ people: 1 });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.deepEqual(Object.keys(one.body), ["ref", "status", "date", "time", "package", "items", "duplicate"]);
  const row = (await call("GET", "/bookings/requests?status=requested")).body.requests[0];
  assert.ok(!("guests" in row) && !("people" in row), "the one-person row has the shape it always had");
  assert.equal(row.total, 3500);
});

// ─── people count on the offer page ─────────────────────────────────────────

test("three people with a package: three guests, each with the package's services; price is package x 3", async () => {
  const r = await wreq({ people: 3, guestNames: ["Bina Devi", "Chaya"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.people, 3);
  assert.deepEqual(r.body.package, { name: "Package 1", price: 3500 }, "the package price is per person");
  assert.equal(r.body.total, 10500);
  const a = await stored(r.body.ref);
  assert.deepEqual(a.guests.map((g) => [g.guestKey, g.name]), [["g1", "Asha Kaur"], ["g2", "Bina Devi"], ["g3", "Chaya"]]);
  for (const g of a.guests) assert.deepEqual(g.items.map((i) => i.name).sort(), ["Blow Dry", "Hair Spa"]);
  assert.deepEqual([a.pricing.subtotal, a.pricing.discount, a.pricing.total], [10500, 0, 10500]);
  assert.equal(a.source.offerPackage.price, 3500, "the package as printed is still per person");
});

test("names are optional; a missing name is a person with no name of their own", async () => {
  const r = await wreq({ people: 2 });
  const a = await stored(r.body.ref);
  assert.deepEqual(a.guests.map((g) => g.name), ["Asha Kaur", null]);
  const few = await wreq({ people: 3, guestNames: ["Only Second"] });
  assert.deepEqual((await stored(few.body.ref)).guests.map((g) => g.name), ["Asha Kaur", "Only Second", null]);
});

test("people is validated: a whole number from 1 to the salon's limit; names are letters only; no price from the browser", async () => {
  for (const people of [0, 5, 2.5, "two", -1]) {
    const r = await wreq({ people });
    assert.equal(r.status, 400, `people=${JSON.stringify(people)}`);
  }
  assert.equal((await wreq({ people: 2, guestNames: ["Bina 123"] })).status, 400);
  assert.equal((await wreq({ people: 2, guestNames: ["a".repeat(61)] })).status, 400);
  assert.equal((await wreq({ people: 2, guestNames: "Bina" })).status, 400);
  assert.equal((await wreq({ people: 2, guestNames: ["A", "B", "C", "D", "E"] })).status, 400, "more names than people");
  assert.equal((await wreq({ people: 2, total: 1, price: 1 })).status, 400, "a total or a price is not accepted");
  assert.equal(await Appointment.countDocuments(), 0, "nothing was stored for any of those");
  await SiteSettings.updateOne({}, { $set: { maxGuests: 2 } });
  assert.equal((await wreq({ people: 3 })).status, 400, "the salon's own limit is used");
  assert.equal((await wreq({ people: 2 })).status, 201);
});

test("an offer of plain services (no package): the price is the services added up, times the people", async () => {
  const hairSpa = await Service.findOne({ slug: "hair-spa" });
  const made = await call("POST", "/website/campaigns", {
    name: "Plain", startDate: time.salonDate(), endDate: time.addDays(time.salonDate(), 5),
    content: { headline: "Plain", ctaHref: "/offers/plain" }, page: { slug: "plain", serviceIds: [String(hairSpa._id)] },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const r = await call("POST", "/public/requests/wa", { offerSlug: "plain", date: DAY, time: "11:00", name: "Asha Kaur", phone: phone(), people: 2 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await stored(r.body.ref);
  assert.equal(a.guests.length, 2);
  assert.equal(a.pricing.total, 1600);
});

test("a group is ONE request for the limits: one hit on the phone, one duplicate check", async () => {
  const p = phone();
  const first = await wreq({ people: 3, phone: p });
  assert.equal(first.status, 201);
  const again = await wreq({ people: 3, phone: p });
  assert.equal(again.status, 200, "same phone, same slot: the first request comes back");
  assert.equal(again.body.duplicate, true);
  assert.equal(await Appointment.countDocuments(), 1);
});

test("the honeypot still wins: a filled hidden box stores nothing, group or not", async () => {
  const r = await wreq({ people: 3, website: "http://spam.example" });
  assert.equal(r.status, 201);
  assert.equal(await Appointment.countDocuments(), 0);
});

test("the owner alert and the customer's WhatsApp say how many people; the group total is what Meta is told", async () => {
  const r = await wreq({ people: 3, phone: "9876500002" });
  const a = await stored(r.body.ref);
  const text = alerts.requestAlertText(a);
  assert.match(text, /People: 3/);
  assert.match(text, /₹10,500/);
  const day = new Date(`${DAY}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const log = await NotificationLog.findOne({ key: `${a._id}:request_received` }).lean();
  assert.equal(log.params.when, `${day}, 11:00 am (3 people)`, "the group is said inside the existing 'when' text");
  assert.deepEqual(Object.keys(log.params).sort(), ["link", "name", "ref", "when"], "no new placeholder");
});

// ─── reception confirms a group ─────────────────────────────────────────────

const confirm = (a, body) => call("POST", `/bookings/${a._id}/confirm`, { date: DAY, time: "11:00", ...body });
const locksOf = (a) => SlotLock.find({ appointmentId: a._id }).lean();
const groupReq = async (people = 2, over = {}) => {
  const r = await wreq({ people, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return stored(r.body.ref);
};
const ids = (...as) => Object.fromEntries(as.map((x, i) => [`g${i + 1}`, String(x._id)]));

test("the staff list shows the people on a group request", async () => {
  const a = await groupReq(2, { guestNames: ["Bina"] });
  const row = (await call("GET", "/bookings/requests?status=requested")).body.requests.find((x) => x._id === String(a._id));
  assert.deepEqual(row.guests, [{ guestKey: "g1", name: "Asha Kaur" }, { guestKey: "g2", name: "Bina" }]);
  assert.equal(row.total, 7000);
});

test("two people, two artists: both are locked for the WHOLE package time, side by side", async () => {
  const a = await groupReq(2);
  const r = await confirm(a, { artistIds: ids(A, B) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lock, { taken: true, blocks: 16, minutes: 240 }, "8 blocks (120 min) for each person");
  const cur = await stored(a.ref);
  assert.equal(cur.status, "confirmed");
  assert.equal(cur.groupMode, "parallel");
  assert.deepEqual(cur.guests.map((g) => [...new Set(g.items.map((i) => i.artistName))]), [["Mansi Kumari"], ["Ravi"]]);
  for (const g of cur.guests) {
    assert.equal(hhmm(g.items[0].startAt), "11:00");
    assert.equal(g.items.reduce((n, i) => n + i.durationMin, 0), 120, "each person's items fill the package time");
  }
  assert.equal(hhmm(cur.endAt), "13:00");
  const locks = await locksOf(a);
  assert.equal(locks.length, 16);
  assert.equal(locks.filter((l) => String(l.artistId) === String(A._id)).length, 8);
  assert.equal(locks.filter((l) => String(l.artistId) === String(B._id)).length, 8);
});

test("the same artist for two people: one after another, groupMode series, 16 blocks on one artist", async () => {
  const a = await groupReq(2);
  const r = await confirm(a, { artistIds: ids(A, A) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cur = await stored(a.ref);
  assert.equal(cur.groupMode, "series");
  assert.deepEqual(cur.guests.map((g) => hhmm(g.items[0].startAt)), ["11:00", "13:00"]);
  assert.equal(hhmm(cur.endAt), "15:00");
  assert.equal((await locksOf(a)).length, 16);
});

test("the old single artistId still works for a group: everyone with that artist, one after another", async () => {
  const a = await groupReq(2);
  const r = await confirm(a, { artistId: String(A._id) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await stored(a.ref)).groupMode, "series");
});

test("three people, mixed: two share an artist (in series), the third is alongside", async () => {
  const a = await groupReq(3);
  const r = await confirm(a, { artistIds: ids(A, A, B) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cur = await stored(a.ref);
  assert.deepEqual(cur.guests.map((g) => hhmm(g.items[0].startAt)), ["11:00", "13:00", "11:00"]);
  assert.equal(cur.groupMode, "parallel", "series only when everyone has the same artist");
  assert.equal((await locksOf(a)).length, 24);
});

test("every person needs an artist; unknown people and inactive artists are refused; nothing is saved", async () => {
  const a = await groupReq(2, { guestNames: ["Bina"] });
  const missing = await confirm(a, { artistIds: { g1: String(A._id) } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Bina/);
  assert.equal((await confirm(a, { artistIds: { g1: String(A._id), g2: String(B._id), g7: String(C._id) } })).status, 400, "no such person");
  await Artist.updateOne({ _id: B._id }, { $set: { isActive: false } });
  assert.equal((await confirm(a, { artistIds: ids(A, B) })).status, 400);
  assert.equal((await confirm(a, { artistIds: { g1: "nope", g2: String(A._id) } })).status, 400);
  assert.equal((await confirm(a, {})).status, 400);
  assert.equal((await stored(a.ref)).status, "requested");
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("a clash for one person's artist: 409 naming who; the whole confirm is refused, nothing half-saved", async () => {
  const first = await groupReq(1, { name: "Earlier Customer" });
  assert.equal((await confirm(first, { artistIds: ids(B), time: "12:00" })).status, 200);
  const g = await groupReq(2);
  const r = await confirm(g, { artistIds: ids(A, B) }); // Ravi is busy 12:00-14:00, the group needs him 11:00-13:00
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "SLOT_TAKEN");
  assert.match(r.body.error, /Ravi/);
  assert.match(r.body.error, new RegExp(first.ref));
  assert.equal((await stored(g.ref)).status, "requested");
  assert.equal((await locksOf(g)).length, 0, "Mansi's blocks were not kept either");
});

test("two receptionists confirming two groups onto the same artists and time: exactly one wins", async () => {
  const [x, y] = [await groupReq(2), await groupReq(2)];
  const results = await Promise.all([confirm(x, { artistIds: ids(A, B) }), confirm(y, { artistIds: ids(A, B) })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await SlotLock.countDocuments(), 16);
});

test("a group on a package with no matched services (or no stored time) still confirms, with the 'no lock' warning", async () => {
  const mystery = await groupReq(2, { packageSlug: "mystery" });
  const r = await confirm(mystery, { artistIds: ids(A, B) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lock.taken, false);
  assert.match(r.body.lock.warning, /no lock taken/i);
  const noTime = await groupReq(2);
  await Appointment.updateOne({ _id: noTime._id }, { $unset: { "source.offerPackage.durationMinutes": "" } });
  const r2 = await confirm(noTime, { artistIds: ids(C, D) });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.lock.taken, false);
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("a confirmed group is released whole when cancelled", async () => {
  const a = await groupReq(2);
  await confirm(a, { artistIds: ids(A, B) });
  assert.equal((await call("POST", `/bookings/${a._id}/cancel`, {})).status, 200);
  assert.equal(await SlotLock.countDocuments(), 0);
});

test("the confirmed group says '(2 people)' in the booker's WhatsApp, with no new placeholder", async () => {
  const a = await groupReq(2);
  await confirm(a, { artistIds: ids(A, B) });
  const log = await NotificationLog.findOne({ key: `${a._id}:booking_confirmed` }).lean();
  assert.match(log.params.when, /11:00 am \(2 people\)$/);
  assert.deepEqual(Object.keys(log.params).sort(), ["link", "name", "ref", "when"]);
});

test("a one-person confirm sends the same text as before: no suffix", async () => {
  const a = await groupReq(1);
  await confirm(a, { artistId: String(A._id) });
  const log = await NotificationLog.findOne({ key: `${a._id}:booking_confirmed` }).lean();
  assert.doesNotMatch(log.params.when, /people/);
});

// ─── suggest artists ────────────────────────────────────────────────────────

const suggest = (a, body) => call("POST", `/bookings/${a._id}/suggest-artists`, { date: DAY, time: "11:00", ...body });

test("suggest: a free, skilled artist for each person, all different", async () => {
  const a = await groupReq(3);
  const r = await suggest(a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.suggestions.map((s) => s.guestKey), ["g1", "g2", "g3"]);
  const named = r.body.suggestions.map((s) => s.artistName);
  assert.equal(new Set(named).size, 3);
  assert.ok(!named.includes("Skin Sana"), "a skin-only artist cannot do hair");
  assert.deepEqual(named, ["Mansi Kumari", "Neha", "Ravi"], "least booked first, then name");
});

test("suggest: leaves out artists who are busy, on leave or not working then", async () => {
  await booking.blockTime({ artistId: A._id, startAt: at("11:30"), endAt: at("12:00"), note: "Lunch" });
  const TimeOff = require("../models/TimeOff");
  await TimeOff.create({ artistId: C._id, startAt: at("00:00"), endAt: at("23:59"), reason: "Leave" });
  const a = await groupReq(2);
  const r = await suggest(a);
  assert.equal(r.body.ok, false, "only Ravi is free for the whole two hours");
  assert.deepEqual(r.body.suggestions.map((s) => s.artistName ?? null), ["Ravi", null]);
  assert.match(r.body.suggestions[1].reason, /no other artist|nobody/i);
});

test("suggest: when people outnumber free artists it says so and offers the nearest times that work", async () => {
  await booking.blockTime({ artistId: A._id, startAt: at("11:00"), endAt: at("13:00") });
  const a = await groupReq(3);
  const r = await suggest(a);
  assert.equal(r.body.ok, false);
  assert.ok(r.body.alternatives.length > 0 && r.body.alternatives.length <= 3);
  const first = r.body.alternatives[0];
  assert.equal(first.suggestions.length, 3);
  assert.ok(first.suggestions.every((s) => s.artistId));
  assert.ok(first.time >= "13:00" || first.time < "11:00", "not inside the blocked two hours");
  // Taking the first alternative really works.
  const ok = await confirm(a, { time: first.time, artistIds: Object.fromEntries(first.suggestions.map((s) => [s.guestKey, s.artistId])) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("suggest: a package with no stored time or no matched services gives the reason, not a guess", async () => {
  const a = await groupReq(2, { packageSlug: "mystery" });
  const r = await suggest(a);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /no lock|not on the service list|no time/i);
});

test("suggest: only for a request still waiting, with a real quarter-hour time", async () => {
  const a = await groupReq(2);
  assert.equal((await suggest(a, { time: "11:10" })).status, 400);
  await confirm(a, { artistIds: ids(A, B) });
  assert.equal((await suggest(a)).status, 409);
});

test("suggest writes nothing", async () => {
  const a = await groupReq(2);
  await suggest(a);
  assert.equal(await SlotLock.countDocuments(), 0);
  assert.equal((await stored(a.ref)).planRev, 0);
});
