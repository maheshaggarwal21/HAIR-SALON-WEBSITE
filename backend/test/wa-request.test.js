/**
 * @file test/wa-request.test.js
 * @description WhatsApp request booking and offer landing pages (D62).
 *
 * What must hold: a request from an ad link makes an UNPAID "requested" booking with no payment,
 * no OTP and no held slot; bad times and spam are refused; reception's Confirm and Decline send
 * the existing WhatsApp templates; a confirmed unpaid booking gets the 24 h and 2 h reminders from
 * the existing cron; /offers/now picks the offer whose dates contain today (the one ending sooner
 * wins); an offer's services are booked from the server's copy; and no discount is ever applied.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const time = require("../utils/time");

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.META_WA_TOKEN = "";
process.env.PUBLIC_TOKEN_SECRET = "t";

let Service, Appointment, Customer, Campaign, NotificationLog, SlotLock, OtpChallenge, SiteSettings, User, evictPermissionCache, booking;
let server;
let base;
let caller;
let ip;
let ipN = 0;
let svc;

before(async () => {
  await startDb();
  Service = require("../models/Service");
  Appointment = require("../models/Appointment");
  Customer = require("../models/Customer");
  Campaign = require("../models/Campaign");
  NotificationLog = require("../models/NotificationLog");
  SlotLock = require("../models/SlotLock");
  OtpChallenge = require("../models/OtpChallenge");
  SiteSettings = require("../models/SiteSettings");
  User = require("../models/User");
  booking = require("../utils/booking");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  await Promise.all([Campaign, Appointment, Customer].map((m) => m.init()));

  const app = express();
  app.use(express.json());
  app.use("/api/public", require("../routes/public"));
  app.use((req, _res, next) => {
    req.session = { ...caller };
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

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };

async function call(method, path, data, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const post = (path, data) => call("POST", path, data);

/** A day inside the next fortnight that the salon is open (not Tuesday), `min` days ahead at least. */
async function openDay(min = 3) {
  const s = (await SiteSettings.getSingleton()).toObject();
  for (let n = min; n < min + 14; n++) {
    const d = time.addDays(time.salonDate(), n);
    if ((s.openingHours[time.weekdayKey(d)] || []).length && !s.holidays.includes(d)) return d;
  }
  throw new Error("no open day");
}
let DAY;
let phoneN;
const phone = () => `98${String(76500000 + ++phoneN)}`;
const request = (over = {}) => post("/public/requests/wa", { services: [String(svc._id)], date: DAY, time: "11:00", name: "Asha Kaur", phone: phone(), campaign: "karwa", ...over });

beforeEach(async () => {
  await clearDb();
  caller = OWNER;
  ip = `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`;
  phoneN = 0;
  svc = await Service.create({ name: "Hair Spa", price: 1600, publicPrice: 800, slug: "hair-spa", isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Hair", durationMinutes: 60, durationConfirmed: true });
  await SiteSettings.getSingleton();
  DAY = await openDay();
});

// ─── the request ────────────────────────────────────────────────────────────

test("a request from an ad link: unpaid, no OTP, no payment, no held slot, tagged with the campaign", async () => {
  const r = await request();
  assert.equal(r.status, 201);
  const a = await Appointment.findOne({ ref: r.body.ref }).lean();
  assert.deepEqual([a.mode, a.status, a.source.channel, a.source.campaign], ["request", "requested", "wa_ad", "karwa"]);
  assert.deepEqual([a.requestedWindow.date, a.requestedWindow.time, a.requestedWindow.window], [DAY, "11:00", "morning"]);
  assert.deepEqual([a.deposit.status, a.deposit.amount, a.pricing.total, a.pricing.discount], ["none", 0, 800, 0]);
  assert.equal(a.startAt, null);
  assert.equal(await SlotLock.countDocuments(), 0);
  assert.equal(await OtpChallenge.countDocuments(), 0);
  assert.equal(a.source.utm.source, "whatsapp");
  const c = await Customer.findOne({ phone: a.contact }).lean();
  assert.equal(c.marketing.whatsappOptIn, false, "asking for a booking is not agreeing to promotions");
  const sent = await NotificationLog.findOne({ key: `${a._id}:request_received` }).lean();
  assert.ok(sent, "the existing request_received message is sent");
  assert.equal(sent.to, a.contact);
});

test("the customer cannot set the price: it comes from the menu", async () => {
  const r = await post("/public/requests/wa", { services: [String(svc._id)], date: DAY, time: "11:00", name: "Asha", phone: phone(), total: 1, price: 1 });
  assert.equal(r.status, 400, "unknown fields are refused");
  const ok = await request();
  assert.equal((await Appointment.findOne({ ref: ok.body.ref })).pricing.total, 800);
});

test("phone numbers are normalised and a repeat of the same slot is one request, not two", async () => {
  const a = await request({ phone: "+91 98765-43210" });
  const b = await request({ phone: "09876543210" });
  const c = await request({ phone: "9876543210" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.ref, a.body.ref);
  assert.equal(c.body.ref, a.body.ref);
  assert.equal(await Appointment.countDocuments(), 1);
  assert.equal((await Appointment.findOne()).contact, "9876543210");
  assert.equal(await Customer.countDocuments(), 1);
});

test("the honeypot: a bot that fills the hidden box is told 'sent' and nothing is stored", async () => {
  const r = await request({ website: "http://spam.example" });
  assert.equal(r.status, 201);
  assert.equal(await Appointment.countDocuments(), 0);
  assert.equal(await Customer.countDocuments(), 0);
  assert.equal(await NotificationLog.countDocuments(), 0);
});

test("limits: 3 new requests per phone a day, 10 per address an hour", async () => {
  const p = phone();
  for (const t of ["10:00", "11:00", "12:00"]) assert.equal((await request({ phone: p, time: t })).status, 201, t);
  const fourth = await request({ phone: p, time: "13:00" });
  assert.ok([429, 409].includes(fourth.status), "the phone is stopped");

  ip = "10.9.9.9";
  for (let i = 0; i < 10; i++) assert.equal((await request()).status, 201);
  assert.equal((await request()).status, 429, "the 11th from one address is stopped");
});

test("times that cannot work are refused: past, too soon, closed, off the grid, too late for the services", async () => {
  const bad = async (over, re) => {
    const r = await request(over);
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.body.message, re);
  };
  await bad({ date: time.addDays(time.salonDate(), -1) }, /passed/);
  await bad({ time: "10:10" }, /quarter hour/);
  await bad({ time: "07:00" }, /closed at that time/);
  await bad({ time: "21:30" }, /closed at that time/);
  await bad({ time: "20:30" }, /too late/);
  await bad({ time: "25:00" }, /Choose a time/);
  await bad({ date: time.addDays(time.salonDate(), 90) }, /within the next/);
  const s = await SiteSettings.getSingleton();
  const closed = [...Array(14).keys()].map((n) => time.addDays(time.salonDate(), n + 3)).find((d) => !(s.openingHours[time.weekdayKey(d)] || []).length);
  if (closed) await bad({ date: closed }, /closed that day/);
  await SiteSettings.updateOne({ key: "default" }, { $set: { holidays: [DAY] } });
  await bad({}, /closed that day/);
  await bad({ services: [] }, /at least one service/);
  assert.equal(await Appointment.countDocuments(), 0);
});

test("today: a time sooner than the salon's minimum lead is refused", async () => {
  const soon = new Date(Date.now() + 20 * 60_000);
  const date = time.salonDate(soon);
  const hhmm = new Date(soon.getTime() + 330 * 60_000).toISOString().slice(11, 16);
  const [h, m] = hhmm.split(":").map(Number);
  const slot = `${String(h).padStart(2, "0")}:${String(Math.ceil(m / 15) * 15 % 60).padStart(2, "0")}`;
  const r = await request({ date, time: slot });
  assert.equal(r.status, 400);
});

test("walk-in only, hidden and inactive services cannot be requested", async () => {
  const walk = await Service.create({ name: "Head Massage", price: 400, publicPrice: 200, slug: "head-massage", isActive: true, showOnWebsite: true, bookingMode: "walkin_only", audience: "him", displayCategory: "Grooming", durationMinutes: 20 });
  assert.equal((await request({ services: [String(walk._id)] })).status, 400);
  await Service.updateOne({ _id: svc._id }, { isActive: false });
  assert.equal((await request()).status, 400);
});

test("the campaign tag is tidied; junk becomes no tag", async () => {
  const a = await request({ campaign: "  KARWA " });
  assert.equal((await Appointment.findOne({ ref: a.body.ref })).source.campaign, "karwa");
  const b = await request({ campaign: "bad tag!<script>", time: "12:00" });
  assert.equal((await Appointment.findOne({ ref: b.body.ref })).source.campaign, null);
});

// ─── reception ──────────────────────────────────────────────────────────────

test("the staff list shows the source, campaign and that it is unpaid", async () => {
  await request();
  const list = await call("GET", "/bookings/requests?status=requested");
  const r = list.body.requests[0];
  assert.deepEqual([r.channel, r.campaign, r.unpaid, r.requestedWindow.time], ["wa_ad", "karwa", true, "11:00"]);
  assert.equal(r.offer, null);
});

test("Confirm (with the time edited) sends booking_confirmed; the booking is then a normal confirmed one", async () => {
  const a = (await request()).body;
  const id = (await Appointment.findOne({ ref: a.ref }))._id;
  const r = await call("POST", `/bookings/${id}/confirm`, { date: DAY, time: "12:30" });
  assert.equal(r.status, 200);
  const done = await Appointment.findById(id).lean();
  assert.equal(done.status, "confirmed");
  assert.equal(time.salonDate(done.startAt), DAY);
  const log = await NotificationLog.findOne({ key: `${id}:booking_confirmed` }).lean();
  assert.ok(log);
  assert.match(log.params.when, /12:30 pm/i);
  assert.equal((await call("POST", `/bookings/${id}/confirm`, { date: DAY, time: "12:30" })).status, 409, "confirming twice is refused");
  assert.equal(await NotificationLog.countDocuments({ type: "booking_confirmed" }), 1);
});

test("Decline sends booking_declined once", async () => {
  const a = (await request()).body;
  const id = (await Appointment.findOne({ ref: a.ref }))._id;
  assert.equal((await call("POST", `/bookings/${id}/decline`, { reason: "Fully booked" })).status, 200);
  assert.equal((await Appointment.findById(id)).status, "declined");
  assert.equal(await NotificationLog.countDocuments({ appointmentId: id, type: "booking_declined" }), 1);
  assert.equal((await call("POST", `/bookings/${id}/decline`, {})).status, 409);
  assert.equal(await NotificationLog.countDocuments({ type: "booking_declined" }), 1);
});

test("a website request-lite booking is still handled by phone: confirming it sends no WhatsApp", async () => {
  const lite = await Appointment.create({
    ref: Appointment.generateRef(), mode: "request", status: "requested", contact: "9812345678", name: "Web Person",
    guests: [{ guestKey: "g1", items: [{ serviceId: svc._id, name: "Hair Spa", publicPrice: 800 }] }],
    requestedWindow: { date: DAY, window: "morning" }, pricing: { subtotal: 800, total: 800 }, source: { channel: "web" },
  });
  assert.equal((await call("POST", `/bookings/${lite._id}/confirm`, { date: DAY, time: "11:00" })).status, 200);
  assert.equal(await NotificationLog.countDocuments(), 0);
  const l2 = await Appointment.create({
    ref: Appointment.generateRef(), mode: "request", status: "requested", contact: "9812345679", name: "Web Two",
    guests: [{ guestKey: "g1", items: [{ serviceId: svc._id, name: "Hair Spa", publicPrice: 800 }] }],
    requestedWindow: { date: DAY, window: "morning" }, pricing: { subtotal: 800, total: 800 }, source: { channel: "web" },
  });
  assert.equal((await call("POST", `/bookings/${l2._id}/decline`, {})).status, 200);
  assert.equal(await NotificationLog.countDocuments(), 0);
});

test("a confirmed UNPAID booking gets the 24 h and 2 h reminders from the existing cron", async () => {
  const a = (await request()).body;
  const id = (await Appointment.findOne({ ref: a.ref }))._id;
  await call("POST", `/bookings/${id}/confirm`, { date: DAY, time: "11:00" });
  // Move it to "tomorrow-ish", booked days ago, the way a real one would be when the cron reaches it.
  const now = new Date();
  const start = new Date(now.getTime() + 20 * 3600_000);
  await Appointment.collection.updateOne({ _id: id }, { $set: { startAt: start, endAt: new Date(start.getTime() + 3600_000), createdAt: new Date(now.getTime() - 5 * 86_400_000) } });
  assert.equal((await booking.sendReminders(now)).reminder24h, 1);
  await Appointment.collection.updateOne({ _id: id }, { $set: { startAt: new Date(now.getTime() + 90 * 60_000) } });
  assert.equal((await booking.sendReminders(now)).reminder2h, 1);
  assert.ok(await NotificationLog.findOne({ key: `${id}:reminder_24h` }));
  assert.ok(await NotificationLog.findOne({ key: `${id}:reminder_2h` }));
  assert.equal((await Appointment.findById(id)).deposit.status, "none", "still unpaid throughout");
});

// ─── offer landing pages ────────────────────────────────────────────────────

async function owner() {
  caller = OWNER;
}
const today = () => time.salonDate();
const offerBody = (over = {}) => ({
  name: "Karva Chauth 2026",
  startDate: today(),
  endDate: time.addDays(today(), 5),
  content: { headline: "Karva Chauth glow", ctaHref: "/offers/karva-chauth" },
  page: { slug: "karwa", headline: "Karva Chauth glow", offerText: "Hair spa plus a blow dry, done in an hour.", price: 999, priceNote: "for both", serviceIds: [String(svc._id)] },
  ...over,
});
const make = async (over) => {
  const r = await call("POST", "/website/campaigns", offerBody(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const page = (slug) => call("GET", `/public/offer-pages/${slug}`);

test("/offers/now: the offer whose dates contain today; with two, the one that ends sooner", async () => {
  assert.equal((await page("now")).body.offer, null, "nothing live: no offer, no error");
  await make({ name: "Long", page: { slug: "long-one", serviceIds: [String(svc._id)] }, endDate: time.addDays(today(), 20) });
  await make({ name: "Short", page: { slug: "short-one", serviceIds: [String(svc._id)] }, endDate: time.addDays(today(), 2) });
  await make({ name: "Later", page: { slug: "later-one", serviceIds: [String(svc._id)] }, startDate: time.addDays(today(), 3), endDate: time.addDays(today(), 4) });
  assert.equal((await page("now")).body.offer.slug, "short-one");
  assert.equal((await page("long-one")).body.offer.state, "live");
});

test("/offers/<slug> works directly and says if the offer is scheduled or has ended; paused or unknown is 404", async () => {
  const future = await make({ page: { slug: "future-one", serviceIds: [String(svc._id)] }, startDate: time.addDays(today(), 3), endDate: time.addDays(today(), 6) });
  assert.equal((await page("future-one")).body.offer.state, "scheduled");
  await make({ name: "Past", page: { slug: "past-one", serviceIds: [String(svc._id)] }, startDate: time.addDays(today(), -9), endDate: time.addDays(today(), -2) });
  assert.equal((await page("past-one")).body.offer.state, "ended");
  assert.equal((await page("nonsense-slug")).status, 404);
  await call("PATCH", `/website/campaigns/${future._id}`, { active: false });
  assert.equal((await page("future-one")).status, 404);
});

test("the page shows only public facts: words, price, services; no internal name, no staff data", async () => {
  await make();
  const o = (await page("karwa")).body.offer;
  assert.deepEqual(Object.keys(o).sort(), ["endDate", "eyebrow", "headline", "image", "images", "offerText", "packages", "price", "priceNote", "reel", "services", "slug", "startDate", "state", "theme"]);
  assert.deepEqual(o.services, [{ id: String(svc._id), name: "Hair Spa" }]);
  assert.ok(!JSON.stringify(o).includes("Karva Chauth 2026"));
});

test("the owner's editor refuses a page with no services, a reserved address, and a taken address", async () => {
  const noSvc = await call("POST", "/website/campaigns", offerBody({ page: { slug: "empty-one", serviceIds: [] } }));
  assert.equal(noSvc.status, 400);
  assert.match(noSvc.body.error, /at least one service/);
  const reserved = await call("POST", "/website/campaigns", offerBody({ page: { slug: "now", serviceIds: [String(svc._id)] } }));
  assert.equal(reserved.status, 400);
  await make();
  const taken = await call("POST", "/website/campaigns", offerBody({ name: "Other" }));
  assert.equal(taken.status, 409);
  const hidden = await Service.create({ name: "Secret", price: 100, publicPrice: 50, slug: "secret", isActive: true, showOnWebsite: false });
  const notPublic = await call("POST", "/website/campaigns", offerBody({ page: { slug: "hidden-one", serviceIds: [String(hidden._id)] } }));
  assert.equal(notPublic.status, 400);
});

test("a request from an offer page books the OFFER's services, records the offer, and applies no discount", async () => {
  const blow = await Service.create({ name: "Blow Dry", price: 600, publicPrice: 300, slug: "blow-dry", isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Hair", durationMinutes: 30, durationConfirmed: true });
  const other = await Service.create({ name: "Facial", price: 1800, publicPrice: 900, slug: "facial", isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Skin", durationMinutes: 60, durationConfirmed: true });
  await make({ page: { slug: "karwa", headline: "Karva Chauth glow", price: 999, priceNote: "for both", serviceIds: [String(svc._id), String(blow._id)] } });

  const r = await post("/public/requests/wa", { offerSlug: "karwa", services: [String(other._id)], date: DAY, time: "11:00", name: "Asha Kaur", phone: phone() });
  assert.equal(r.status, 201);
  const a = await Appointment.findOne({ ref: r.body.ref }).lean();
  assert.deepEqual(a.guests[0].items.map((i) => i.name).sort(), ["Blow Dry", "Hair Spa"], "the offer's services, not the browser's");
  assert.deepEqual([a.source.offerSlug, a.source.campaign, a.source.offerHeadline, a.source.offerPrice, a.source.offerPriceNote], ["karwa", "karwa", "Karva Chauth glow", 999, "for both"]);
  assert.deepEqual([a.pricing.subtotal, a.pricing.discount, a.pricing.total], [1100, 0, 1100], "the menu price: reception applies the offer by hand");

  const list = (await call("GET", "/bookings/requests?status=requested")).body.requests[0];
  assert.deepEqual(list.offer, { slug: "karwa", headline: "Karva Chauth glow", price: 999, priceNote: "for both" });
});

test("a request against an offer that has ended, not started, is paused or unknown is refused", async () => {
  const c = await make({ page: { slug: "gone-one", serviceIds: [String(svc._id)] }, startDate: time.addDays(today(), -9), endDate: time.addDays(today(), -2) });
  assert.equal((await request({ offerSlug: "gone-one", services: undefined })).status, 400);
  assert.equal((await request({ offerSlug: "never-heard-of-it", services: undefined })).status, 400);
  await call("PATCH", `/website/campaigns/${c._id}`, { startDate: today(), endDate: time.addDays(today(), 3), active: false });
  assert.equal((await request({ offerSlug: "gone-one", services: undefined })).status, 400);
  assert.equal(await Appointment.countDocuments(), 0);
});

test("the paid booking's data and rules are untouched: an unpaid wa request holds no slot and charges nothing", async () => {
  await request();
  assert.equal(await SlotLock.countDocuments(), 0);
  const a = await Appointment.findOne().lean();
  assert.equal(a.deposit.razorpayOrderId, null);
  assert.equal(a.holdExpiresAt, null);
  assert.equal(a.manageTokenHash, null);
});

// ─── the picture slideshow (D63) ────────────────────────────────────────────

test("an offer page keeps up to 5 pictures in order; a 6th is refused; older single-picture offers still show one", async () => {
  const pics = [1, 2, 3, 4, 5].map((n) => `https://blob.example/p${n}.jpg`);
  const made = await make({ page: { slug: "gallery-one", serviceIds: [String(svc._id)], images: pics } });
  const o = (await page("gallery-one")).body.offer;
  assert.deepEqual(o.images, pics);
  assert.equal(o.image, pics[0]);

  const six = await call("POST", "/website/campaigns", offerBody({ name: "Six", page: { slug: "gallery-six", serviceIds: [String(svc._id)], images: [...pics, "https://blob.example/p6.jpg"] } }));
  assert.equal(six.status, 400);
  const bad = await call("POST", "/website/campaigns", offerBody({ name: "Bad", page: { slug: "gallery-bad", serviceIds: [String(svc._id)], images: ["javascript:alert(1)"] } }));
  assert.equal(bad.status, 400);

  // reorder and remove through the editor's save
  const re = await call("PATCH", `/website/campaigns/${made._id}`, { page: { images: [pics[4], pics[0]] } });
  assert.equal(re.status, 200);
  assert.deepEqual((await page("gallery-one")).body.offer.images, [pics[4], pics[0]]);

  // an older offer with only the single picture fields
  await make({ name: "Old", page: { slug: "old-one", serviceIds: [String(svc._id)], image: "https://blob.example/old.jpg" } });
  assert.deepEqual((await page("old-one")).body.offer.images, ["https://blob.example/old.jpg"]);
  await make({ name: "Bare", page: { slug: "bare-one", serviceIds: [String(svc._id)] } });
  assert.deepEqual((await page("bare-one")).body.offer.images, []);
});

// ─── poster packages on an offer page (D64) ─────────────────────────────────

const PKGS = [
  { name: "Package 1", price: 3500, services: ["Hair Spa", "Blow Dry", "Kanpeki Facial", "Upperlips", "Hair Spa"], durationMinutes: 180 },
  { name: "Package 2", price: 4500, services: ["Pedicure", "Haircut"] },
];
async function seedPackageMenu() {
  const c = { isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Hair", durationMinutes: 30, durationConfirmed: true };
  const blow = await Service.create({ ...c, name: "Blow Dry", price: 600, publicPrice: 300, slug: "blow-dry" });
  const upper = await Service.create({ ...c, name: "Upper Lip Threading", price: 60, publicPrice: 30, slug: "upper-lip" });
  return { blow, upper };
}
const makePk = (over = {}) => make({ page: { slug: "pkgs", packages: PKGS, ...over } });

test("packages: one price each, the services as listed, no price rule, no per-service prices; the server finds which are on the service list", async () => {
  const { blow, upper } = await seedPackageMenu();
  const made = await makePk({ packages: [{ ...PKGS[0], serviceIds: ["000000000000000000000001"], price: 1 }, { ...PKGS[1], price: 999999 }] });
  assert.equal(made.page.packages.length, 2);
  const saved = await Campaign.findById(made._id).lean();
  const p1 = saved.page.packages[0];
  assert.equal(p1.price, 1, "any price is accepted: it is not tied to the menu");
  assert.deepEqual(p1.services, ["Hair Spa", "Blow Dry", "Kanpeki Facial", "Upperlips"], "blanks and repeats dropped, wording kept");
  assert.deepEqual(p1.serviceIds.map(String).sort(), [String(svc._id), String(blow._id), String(upper._id)].sort(), "the server found the ones on the list; a browser-sent id was ignored");
  assert.equal(p1.slug, "package-1");
  const o = (await page("pkgs")).body.offer;
  assert.deepEqual(o.packages, [{ slug: "package-1", name: "Package 1", price: 1, services: ["Hair Spa", "Blow Dry", "Kanpeki Facial", "Upperlips"], durationMinutes: 180 }, { slug: "package-2", name: "Package 2", price: 999999, services: ["Pedicure", "Haircut"], durationMinutes: 120 }]);
  assert.ok(!JSON.stringify(o).match(/serviceIds/), "the public page carries no service ids");
});

test("packages: bad ones are refused plainly; an offer page needs a package OR a service", async () => {
  const bad = (packages) => call("POST", "/website/campaigns", offerBody({ name: `x${Math.random()}`, page: { slug: `bad-${Math.floor(Math.random() * 1e6)}`, packages } }));
  assert.equal((await bad([{ name: "", price: 100, services: ["A"] }])).status, 400);
  assert.equal((await bad([{ name: "P", price: 0, services: ["A"] }])).status, 400);
  assert.equal((await bad([{ name: "P", price: 12.5, services: ["A"] }])).status, 400);
  assert.equal((await bad([{ name: "P", price: 100, services: [] }])).status, 400);
  assert.equal((await bad(Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, price: 100, services: ["A"] })))).status, 400);
  const none = await call("POST", "/website/campaigns", offerBody({ page: { slug: "nothing", serviceIds: [] } }));
  assert.equal(none.status, 400);
  const ok = await call("POST", "/website/campaigns", offerBody({ page: { slug: "pkonly", serviceIds: [], packages: [{ name: "P", price: 100, services: ["A"] }] } }));
  assert.equal(ok.status, 201, "packages alone are enough for a page");
});

test("a request names the package the customer chose: its name, ONE price and the services as listed; the browser sets none of it", async () => {
  await seedPackageMenu();
  await makePk();
  const forged = await post("/public/requests/wa", { offerSlug: "pkgs", packageSlug: "package-1", date: DAY, time: "11:00", name: "Asha Kaur", phone: phone(), total: 1, price: 1, services: ["x"] });
  assert.equal(forged.status, 400, "a browser cannot send a price, a total or its own services");
  const r = await post("/public/requests/wa", { offerSlug: "pkgs", packageSlug: "package-1", date: DAY, time: "11:00", name: "Asha Kaur", phone: phone() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.package, { name: "Package 1", price: 3500 });
  assert.deepEqual(r.body.items.map((i) => i.name), ["Hair Spa", "Blow Dry", "Kanpeki Facial", "Upperlips"]);
  const a = await Appointment.findOne({ ref: r.body.ref }).lean();
  assert.deepEqual([a.pricing.subtotal, a.pricing.discount, a.pricing.total], [3500, 0, 3500], "the package price, nothing discounted");
  assert.deepEqual(a.source.offerPackage, { slug: "package-1", name: "Package 1", price: 3500, services: ["Hair Spa", "Blow Dry", "Kanpeki Facial", "Upperlips"], durationMinutes: 180 });
  assert.deepEqual(a.guests[0].items.map((i) => i.name).sort(), ["Blow Dry", "Hair Spa", "Upper Lip Threading"], "only the ones on the service list become scheduled items (so the Today board can show them); Kanpeki Facial stays text");
  const row = (await call("GET", "/bookings/requests?status=requested")).body.requests[0];
  assert.deepEqual(row.package, { name: "Package 1", price: 3500, services: ["Hair Spa", "Blow Dry", "Kanpeki Facial", "Upperlips"], durationMinutes: 180 });
  assert.equal(row.total, 3500);
});

test("a package must be chosen, and only a real one", async () => {
  await seedPackageMenu();
  await makePk();
  const base = { offerSlug: "pkgs", date: DAY, time: "11:00", name: "Asha Kaur" };
  assert.equal((await post("/public/requests/wa", { ...base, phone: phone() })).status, 400, "none chosen");
  assert.equal((await post("/public/requests/wa", { ...base, phone: phone(), packageSlug: "package-9" })).status, 400, "unknown");
  await make({ name: "Plain", page: { slug: "plain", serviceIds: [String(svc._id)] } });
  const stray = await post("/public/requests/wa", { offerSlug: "plain", packageSlug: "package-1", date: DAY, time: "11:00", name: "Asha Kaur", phone: phone() });
  assert.equal(stray.status, 400, "a package named on an offer that has none");
  assert.equal(await Appointment.countDocuments(), 0);
});

test("a package's own time decides which start times work, and how long the confirmed booking lasts", async () => {
  await seedPackageMenu();
  await makePk();
  const late = await post("/public/requests/wa", { offerSlug: "pkgs", packageSlug: "package-1", date: DAY, time: "19:00", name: "Asha Kaur", phone: phone() });
  assert.equal(late.status, 400, "3 hours from 7 pm runs past closing");
  assert.match(late.body.message, /too late/);
  const r = await post("/public/requests/wa", { offerSlug: "pkgs", packageSlug: "package-1", date: DAY, time: "10:00", name: "Asha Kaur", phone: phone() });
  const id = (await Appointment.findOne({ ref: r.body.ref }))._id;
  assert.equal((await call("POST", `/bookings/${id}/confirm`, { date: DAY, time: "10:00" })).status, 200);
  const done = await Appointment.findById(id).lean();
  assert.ok(done.endAt - done.startAt >= 180 * 60_000, "the booking lasts the package's 3 hours even though only 2 services are scheduled items");
});

test("a package with no service recognised still books: nothing scheduled, the package text carries everything", async () => {
  await make({ page: { slug: "unknown-only", packages: [{ name: "Mystery", price: 1999, services: ["Zzyzx Ritual", "Quux Glow"], durationMinutes: 90 }] } });
  const r = await post("/public/requests/wa", { offerSlug: "unknown-only", packageSlug: "mystery", date: DAY, time: "11:00", name: "Asha Kaur", phone: phone() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await Appointment.findOne({ ref: r.body.ref }).lean();
  assert.deepEqual([a.guests[0].items.length, a.pricing.total, a.source.offerPackage.services], [0, 1999, ["Zzyzx Ritual", "Quux Glow"]]);
  const id = a._id;
  assert.equal((await call("POST", `/bookings/${id}/confirm`, { date: DAY, time: "11:00" })).status, 200);
  const done = await Appointment.findById(id).lean();
  assert.equal(done.endAt - done.startAt, 90 * 60_000);
});

test("the old Karva Chauth page is gone, so its address is free for an offer; the site's other own addresses stay reserved", async () => {
  const ok = await call("POST", "/website/campaigns", offerBody({ page: { slug: "karva-chauth", serviceIds: [String(svc._id)] } }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await page("karva-chauth")).body.offer.slug, "karva-chauth");
  for (const slug of ["now", "api", "new", "edit"]) {
    const r = await call("POST", "/website/campaigns", offerBody({ name: `x-${slug}`, page: { slug, serviceIds: [String(svc._id)] } }));
    assert.equal(r.status, 400, slug);
    assert.match(r.body.error, /already a page on the website/);
  }
});
