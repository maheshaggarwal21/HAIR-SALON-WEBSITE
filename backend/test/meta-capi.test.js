/**
 * @file test/meta-capi.test.js
 * @description Meta Conversions API (D65, T3.7). A local stub plays the Graph API, so
 * nothing leaves the machine.
 *
 * What must hold: an offer-page request sends Lead and reception's Confirm sends Schedule,
 * both with the booking ref as event_id (the browser pixel's eventID, so Meta counts each
 * once); no name, phone or note is ever sent; pixel ids are taken only when well formed and
 * kept on the booking for the later Schedule; desk bookings and bookings with nothing to
 * match on are not sent; unconfigured is a no-op; and a Meta error never breaks a booking.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const time = require("../utils/time");

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.META_WA_TOKEN = "";
process.env.PUBLIC_TOKEN_SECRET = "t";

const FBP = "fb.1.1792855069606.409293516407271416";
const FBC = "fb.1.1792855069606.IwAR2abc_DEF-123";
const UA = "Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36";

let stub;
let calls = [];
let respond;
let metaCapi, Service, Appointment, SiteSettings;
let server;
let base;
let svc;
let DAY;
let ipN = 0;

const CONFIG = { META_PIXEL_ID: "1752148512565227", META_CAPI_TOKEN: "capi-token", META_CAPI_TEST_CODE: "" };

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call = { url: req.url, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      const out = respond(call);
      res.statusCode = out.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  Object.assign(process.env, { META_CAPI_BASE: `http://127.0.0.1:${stub.address().port}`, ...CONFIG });

  await startDb();
  metaCapi = require("../utils/metaCapi");
  Service = require("../models/Service");
  Appointment = require("../models/Appointment");
  SiteSettings = require("../models/SiteSettings");
  await Appointment.init();

  const app = express();
  app.use(express.json());
  app.use("/api/public", require("../routes/public"));
  app.use((req, _res, next) => {
    req.session = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
    next();
  });
  app.use("/api/bookings", require("../routes/bookings"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  calls = [];
  respond = () => ({ status: 200, body: { events_received: 1 } });
  Object.assign(process.env, CONFIG);
  svc = await Service.create({ name: "Hair Spa", price: 1600, publicPrice: 800, slug: "hair-spa", isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Hair", durationMinutes: 60, durationConfirmed: true });
  const s = (await SiteSettings.getSingleton()).toObject();
  for (let n = 3; n < 17; n++) {
    const d = time.addDays(time.salonDate(), n);
    if ((s.openingHours[time.weekdayKey(d)] || []).length && !s.holidays.includes(d)) {
      DAY = d;
      break;
    }
  }
});

async function call(method, path, data, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${++ipN % 250}`, "user-agent": UA, ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const waRequest = (headers) =>
  call("POST", "/public/requests/wa", { services: [String(svc._id)], date: DAY, time: "11:00", name: "Asha Kaur", phone: "9876543210", campaign: "karwa" }, headers);

const events = () => calls.map((c) => c.body.data[0]);

/** Nothing that identifies the customer may appear anywhere in what Meta receives. */
function assertNoContactDetails(body) {
  const text = JSON.stringify(body);
  for (const bad of ["Asha", "9876543210", "Kaur", "\"ph\"", "\"em\"", "\"fn\"", "\"ln\""]) {
    assert.ok(!text.includes(bad), `Meta must not receive ${bad}`);
  }
}

// ─── end to end ──────────────────────────────────────────────────────────────

test("an offer-page request sends Lead, and reception's Confirm sends Schedule, both keyed by the booking ref", async () => {
  const r = await waRequest({ "x-meta-fbp": FBP, "x-meta-fbc": FBC });
  assert.equal(r.status, 201);
  const appt = await Appointment.findOne({ ref: r.body.ref }).lean();
  assert.deepEqual(appt.source.pixel, { fbp: FBP, fbc: FBC, userAgent: UA }, "the ids are kept for the later Schedule; no IP is stored");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v21.0/1752148512565227/events");
  assert.equal(calls[0].body.access_token, "capi-token", "the token travels in the body, not the address");
  const lead = events()[0];
  assert.equal(lead.event_name, "Lead");
  assert.equal(lead.event_id, r.body.ref, "same id as the browser pixel's eventID, so Meta counts it once");
  assert.equal(lead.action_source, "website");
  assert.deepEqual(lead.user_data, { client_user_agent: UA, client_ip_address: lead.user_data.client_ip_address, fbp: FBP, fbc: FBC });
  assert.match(lead.user_data.client_ip_address, /^10\.9\.0\./);
  assert.deepEqual(lead.custom_data, { currency: "INR", value: 800, content_name: "Hair Spa" });
  assertNoContactDetails(calls[0].body);

  const done = await call("POST", `/bookings/${appt._id}/confirm`, { date: DAY, time: "12:30" });
  assert.equal(done.status, 200);
  assert.equal(calls.length, 2);
  const schedule = events()[1];
  assert.equal(schedule.event_name, "Schedule");
  assert.equal(schedule.event_id, r.body.ref);
  assert.equal(schedule.user_data.fbp, FBP, "matched on the ids saved with the request");
  assert.equal(schedule.user_data.client_ip_address, undefined, "staff's IP is never sent as the customer's");
  assertNoContactDetails(calls[1].body);
});

test("without the headers, the pixel's own cookies are used; junk values are dropped, never stored", async () => {
  await waRequest({ cookie: `other=1; _fbp=${FBP}; _fbc=${FBC}` });
  let appt = await Appointment.findOne().lean();
  assert.equal(appt.source.pixel.fbp, FBP);
  assert.equal(appt.source.pixel.fbc, FBC);

  await clearDb();
  await Service.create({ _id: svc._id, name: "Hair Spa", price: 1600, publicPrice: 800, slug: "hair-spa", isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Hair", durationMinutes: 60, durationConfirmed: true });
  await waRequest({ "x-meta-fbp": "<script>alert(1)</script>", "x-meta-fbc": "fb.1.123.not valid!" });
  appt = await Appointment.findOne().lean();
  assert.deepEqual(appt.source.pixel, { userAgent: UA });
});

test("a website request-lite booking confirmed by reception sends Schedule too", async () => {
  const lite = await Appointment.create({
    ref: Appointment.generateRef(), mode: "request", status: "requested", contact: "9812345678", name: "Web Person",
    guests: [{ guestKey: "g1", items: [{ serviceId: svc._id, name: "Hair Spa", publicPrice: 800 }] }],
    requestedWindow: { date: DAY, window: "morning" }, pricing: { subtotal: 800, total: 800 },
    source: { channel: "web", pixel: { fbp: FBP, userAgent: UA } },
  });
  assert.equal((await call("POST", `/bookings/${lite._id}/confirm`, { date: DAY, time: "11:00" })).status, 200);
  assert.deepEqual(events().map((e) => [e.event_name, e.event_id]), [["Schedule", lite.ref]]);
});

test("a Meta error or outage never breaks the booking", async () => {
  respond = () => ({ status: 400, body: { error: { message: "Invalid parameter", code: 100 } } });
  const r = await waRequest({ "x-meta-fbp": FBP });
  assert.equal(r.status, 201);
  assert.ok(await Appointment.findOne({ ref: r.body.ref }));

  process.env.META_CAPI_BASE = "http://127.0.0.1:1"; // nothing listens there
  const out = await metaCapi.send("Lead", { ref: "EXP-AAAAA", source: { channel: "web", pixel: { fbp: FBP, userAgent: UA } } });
  assert.equal(out.status, "failed");
  process.env.META_CAPI_BASE = `http://127.0.0.1:${stub.address().port}`;
});

// ─── rules ───────────────────────────────────────────────────────────────────

test("unconfigured is a no-op: no pixel id or no token, nothing is sent", async () => {
  process.env.META_CAPI_TOKEN = "";
  assert.equal((await waRequest({ "x-meta-fbp": FBP })).status, 201);
  assert.equal(calls.length, 0);
  assert.deepEqual(await metaCapi.send("Lead", { ref: "EXP-AAAAA", source: { channel: "web", pixel: { fbp: FBP, userAgent: UA } } }), { status: "skipped", error: "not_configured" });
});

test("only web and offer/ad bookings, with something to match on, become events", () => {
  const appt = (source) => ({ ref: "EXP-AAAAA", pricing: { total: 2500 }, source });
  assert.equal(metaCapi.buildEvent("Schedule", appt({ channel: "desk", pixel: { fbp: FBP, userAgent: UA } })), null, "desk bookings were not caused by a web visit");
  assert.equal(metaCapi.buildEvent("Schedule", appt({ channel: "phone", pixel: { fbp: FBP, userAgent: UA } })), null);
  assert.equal(metaCapi.buildEvent("Schedule", appt({ channel: "web", pixel: { fbp: FBP } })), null, "Meta refuses a website event without a user agent");
  assert.equal(metaCapi.buildEvent("Schedule", appt({ channel: "web", pixel: { userAgent: UA } })), null, "a user agent alone matches nobody");
  assert.equal(metaCapi.buildEvent("Purchase", appt({ channel: "web", pixel: { fbp: FBP, userAgent: UA } })), null, "only Lead and Schedule");
  assert.ok(metaCapi.buildEvent("Lead", appt({ channel: "web", pixel: { userAgent: UA } }), { ip: "1.2.3.4" }), "the live request's IP is enough with the user agent");
});

test("an offer package is named and priced from the booking; the event points at the offer page", () => {
  const e = metaCapi.buildEvent("Lead", {
    ref: "EXP-BBBBB",
    pricing: { total: 2500 },
    guests: [{ items: [{ name: "Bleach" }] }],
    source: { channel: "wa_ad", offerSlug: "karva-chauth", offerPackage: { name: "Karva Chauth SPECIAL · PACKAGE 3", price: 2500 }, pixel: { fbp: FBP, userAgent: UA } },
  });
  assert.deepEqual(e.custom_data, { currency: "INR", value: 2500, content_name: "Karva Chauth SPECIAL · PACKAGE 3" });
  assert.equal(e.event_source_url, "https://www.thexpertshair.com/offers/karva-chauth");
});

test("an ad click's fbclid stands in for the _fbc cookie when the pixel was blocked", () => {
  const at = new Date("2026-10-25T05:00:00Z");
  const e = metaCapi.buildEvent("Lead", { ref: "EXP-CCCCC", createdAt: at, pricing: { total: 800 }, source: { channel: "web", utm: { fbclid: "IwAR2xyz" }, pixel: { userAgent: UA } } });
  assert.equal(e.user_data.fbc, `fb.1.${at.getTime()}.IwAR2xyz`);
  assert.equal(metaCapi.fbcFromFbclid("bad value!", at), null);
});

test("a test event code sends events to Events Manager's test view", async () => {
  process.env.META_CAPI_TEST_CODE = "TEST92177";
  await metaCapi.send("Lead", { ref: "EXP-DDDDD", pricing: { total: 800 }, source: { channel: "web", pixel: { fbp: FBP, userAgent: UA } } });
  assert.equal(calls[0].body.test_event_code, "TEST92177");
});
