/**
 * @file test/whatsapp-aisensy.test.js
 * @description The AiSensy adapter and the guard rails around it. A local stub plays
 * AiSensy's campaign API, so nothing leaves the machine. Covers: the request shape and
 * the variables in PARAMS order and count, phone formats, DRY_RUN and TEST_PHONE, and
 * that a held-back ("skipped") message is resent only while it still makes sense.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub;
let calls = [];
let respond;
let whatsapp, notify, NotificationLog;

const KEY = "test-aisensy-key";
const FULL = {
  name: "Asha", ref: "EXP-ABCDE", when: "Sat, 25 Oct, 11:00 am", link: "https://www.thexpertshair.com/booking/abc",
  map: "https://maps.example/x", salon_link: "https://wa.me/919000000000", refund: 0, amount: 250,
  date: "Sat, 25 Oct", count: 3, list: "10:00am Sita (Haircut)", oldArtist: "Ria", newArtist: "Mona", reason: "leave",
};

function live() {
  Object.assign(process.env, { WHATSAPP_PROVIDER: "aisensy", AISENSY_KEY: KEY, DRY_RUN: "false", NODE_ENV: "development" });
  delete process.env.TEST_PHONE;
}

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      const out = respond();
      res.statusCode = out.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  process.env.AISENSY_API_URL = `http://127.0.0.1:${stub.address().port}/campaign/t1/api`;
  await startDb();
  whatsapp = require("../utils/whatsapp");
  notify = require("../utils/notify");
  NotificationLog = require("../models/NotificationLog");
});

after(async () => {
  await new Promise((r) => stub.close(r));
  for (const k of ["WHATSAPP_PROVIDER", "AISENSY_KEY", "DRY_RUN", "TEST_PHONE", "AISENSY_API_URL"]) delete process.env[k];
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  calls = [];
  respond = () => ({ status: 200, body: { success: "true", submitted_message_id: "msg-1" } });
  live();
});

// ── params order and count ──

test("aisensy: every campaign gets its variables in PARAMS order, with the right count", async () => {
  for (const [type, spec] of Object.entries(whatsapp.PARAMS)) {
    calls = [];
    const out = await whatsapp.sendTemplate({ phone: "9876543210", type, params: FULL });
    assert.equal(out.status, "sent", `${type}: ${out.error}`);
    const body = calls[0].body;
    assert.equal(body.campaignName, spec.campaign);
    assert.equal(body.apiKey, KEY);
    assert.equal(body.destination, "+919876543210");
    assert.equal(body.templateParams.length, spec.vars.length, `${type} variable count`);
    assert.deepEqual(body.templateParams, spec.vars.map((v) => String(FULL[v])), `${type} variable order`);
  }
});

test("aisensy: request_cancelled is [name, ref, salon_link]", async () => {
  await whatsapp.sendTemplate({ phone: "9876543210", type: "request_cancelled", params: FULL });
  assert.deepEqual(calls[0].body.templateParams, ["Asha", "EXP-ABCDE", "https://wa.me/919000000000"]);
});

test("aisensy: line breaks are flattened, a blank map or reason becomes '-', a missing required variable fails without sending", async () => {
  await whatsapp.sendTemplate({ phone: "9876543210", type: "reminder_2h", params: { ...FULL, name: "Asha\nSharma", map: "" } });
  assert.equal(calls[0].body.templateParams[0], "Asha Sharma");
  assert.equal(calls[0].body.templateParams[4], "-");

  calls = [];
  const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: { ...FULL, when: "   " } });
  assert.equal(out.status, "failed");
  assert.match(out.error, /missing variable "when"/);
  assert.equal(calls.length, 0);
});

test("aisensy: an API error is reported with status and body, and never echoes the key", async () => {
  respond = () => ({ status: 400, body: { error: `bad template, key ${KEY}` } });
  const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: FULL });
  assert.equal(out.status, "failed");
  assert.match(out.error, /^HTTP 400/);
  assert.ok(!out.error.includes(KEY));
});

// ── phone format ──

test("phone: +91, 0 and spaces all reach AiSensy as +91 and 10 digits; a bad number is never sent", async () => {
  for (const raw of ["98765 43210", "+91 98765-43210", "09876543210", "919876543210"]) {
    calls = [];
    const out = await whatsapp.sendTemplate({ phone: raw, type: "booking_refund", params: FULL });
    assert.equal(out.status, "sent", raw);
    assert.equal(calls[0].body.destination, "+919876543210", raw);
  }
  calls = [];
  for (const bad of ["12345", "5876543210", "", "walk-in", null]) {
    const out = await whatsapp.sendTemplate({ phone: bad, type: "booking_refund", params: FULL });
    assert.deepEqual([out.status, out.error], ["failed", "invalid_phone"], String(bad));
  }
  assert.equal(calls.length, 0);
});

// ── DRY_RUN and TEST_PHONE ──

test("DRY_RUN: true sends nothing; unset is dry for AiSensy; false sends", async () => {
  process.env.DRY_RUN = "true";
  let out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: FULL });
  assert.deepEqual([out.status, out.error], ["skipped", "dry_run"]);
  assert.equal(calls.length, 0);

  delete process.env.DRY_RUN;
  out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: FULL });
  assert.equal(out.error, "dry_run", "new provider is dry unless DRY_RUN=false");

  process.env.DRY_RUN = "false";
  out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: FULL });
  assert.equal(out.status, "sent");
  assert.equal(calls.length, 1);
});

test("DRY_RUN: an unset value keeps Meta sending as before", () => {
  delete process.env.DRY_RUN;
  process.env.WHATSAPP_PROVIDER = "meta";
  assert.equal(whatsapp.isDryRun("booking_confirmed"), false);
  process.env.DRY_RUN = "true";
  assert.equal(whatsapp.isDryRun("booking_confirmed"), true);
  assert.equal(whatsapp.isDryRun("otp"), false, "the one-time code is never held back");
});

test("TEST_PHONE: every message goes to the test number; a bad value sends nothing", async () => {
  process.env.TEST_PHONE = "+91 91111 22222";
  let out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: FULL });
  assert.equal(out.status, "sent");
  assert.equal(calls[0].body.destination, "+919111122222");

  calls = [];
  process.env.TEST_PHONE = "12345";
  out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: FULL });
  assert.equal(out.status, "failed");
  assert.equal(calls.length, 0, "a bad TEST_PHONE must never fall back to the customer");
});

test("config status lists variable names only", () => {
  delete process.env.AISENSY_KEY;
  const s = whatsapp.configStatus();
  assert.ok(s.missing.includes("AISENSY_KEY"));
  assert.ok(s.missing.every((m) => /^[A-Z0-9_]+( \(.*\))?$/.test(m)), "names, not values");
});

// ── resending held-back messages ──

const HOUR = 3600_000;
const ago = (ms) => new Date(Date.now() - ms);

async function heldRow(key, type, { age = 0, status = "skipped", error = "aisensy_not_configured", appointmentId = null } = {}) {
  await NotificationLog.collection.insertOne({
    key, type, to: "9876543210", channel: "whatsapp", status, error, attempts: 1, appointmentId,
    params: FULL, createdAt: ago(age), updatedAt: ago(age),
  });
}
let refCounter = 0;
async function appointment(status, startInMs) {
  const { insertedId } = await require("../models/Appointment").collection.insertOne({ ref: `EXP-T${++refCounter}`, status, startAt: new Date(Date.now() + startInMs), contact: "9876543210" });
  return insertedId;
}
const statusOf = async (key) => (await NotificationLog.findOne({ key }).lean());

test("resend: a skipped message goes out once the provider is ready; a dry_run one never does", async () => {
  await heldRow("a:booking_cancelled", "booking_cancelled", { age: 2 * HOUR });
  await heldRow("b:booking_cancelled", "booking_cancelled", { age: 2 * HOUR, error: "dry_run" });
  const resent = await notify.retryFailed();
  assert.equal(resent, 1);
  assert.equal(calls.length, 1);
  assert.equal((await statusOf("a:booking_cancelled")).status, "sent");
  assert.equal((await statusOf("b:booking_cancelled")).status, "skipped");
});

test("resend: nothing is sent, and no attempt is used up, while the provider is not ready or in a dry run", async () => {
  await heldRow("a:booking_cancelled", "booking_cancelled", { age: HOUR });
  process.env.DRY_RUN = "true";
  assert.equal(await notify.retryFailed(), 0);
  delete process.env.AISENSY_KEY;
  process.env.DRY_RUN = "false";
  assert.equal(await notify.retryFailed(), 0);
  assert.equal(calls.length, 0);
  assert.equal((await statusOf("a:booking_cancelled")).attempts, 1);
});

test("resend: stale messages are closed with a note, never sent", async () => {
  const soon = await appointment("confirmed", 10 * 60_000); // starts in 10 minutes
  const later = await appointment("confirmed", 5 * HOUR);
  const gone = await appointment("cancelled", 5 * HOUR);
  await heldRow("old:booking_cancelled", "booking_cancelled", { age: 25 * HOUR }); // outside 24h
  await heldRow("req:request_received", "request_received", { age: 45 * 60_000, appointmentId: gone }); // short window
  await heldRow("r2:reminder_2h", "reminder_2h", { age: HOUR, appointmentId: soon }); // too close
  await heldRow("c:booking_confirmed", "booking_confirmed", { age: HOUR, appointmentId: gone }); // cancelled since
  await heldRow("ok:reminder_2h", "reminder_2h", { age: HOUR, appointmentId: later }); // still sensible
  await heldRow("ok2:reminder_24h", "reminder_24h", { age: HOUR, appointmentId: later });

  const resent = await notify.retryFailed();
  assert.equal(resent, 2);
  assert.deepEqual(calls.map((c) => c.body.campaignName).sort(), ["reminder_24h", "reminder_2h"]);
  for (const k of ["req:request_received", "r2:reminder_2h", "c:booking_confirmed"]) {
    const row = await statusOf(k);
    assert.equal(row.status, "skipped", k);
    assert.match(row.error, /not resent/, k);
  }
  // Past 24 hours it is outside the search altogether: untouched, and not sent.
  assert.deepEqual([(await statusOf("old:booking_cancelled")).status, (await statusOf("old:booking_cancelled")).attempts], ["skipped", 1]);

  calls = [];
  assert.equal(await notify.retryFailed(), 0, "closed rows are not looked at again");
  assert.equal(calls.length, 0);
});

test("resend: the attempts are capped", async () => {
  respond = () => ({ status: 500, body: {} });
  await heldRow("a:booking_cancelled", "booking_cancelled", { age: HOUR });
  for (let i = 0; i < 5; i++) await notify.retryFailed();
  const row = await statusOf("a:booking_cancelled");
  assert.equal(row.attempts, notify.MAX_ATTEMPTS);
  assert.equal(calls.length, notify.MAX_ATTEMPTS - 1);
  assert.equal(row.status, "failed");
});

// ── verified against the approved AiSensy templates ──

test("aisensy: the variable counts match all 12 approved templates exactly", async () => {
  const approved = {
    request_received: 5, booking_confirmed: 5, request_declined: 3, request_cancelled: 3,
    booking_declined: 4, booking_cancelled: 4, booking_refund: 4, booking_moved: 5,
    booking_artist_changed: 8, reminder_24h: 6, reminder_2h: 6, artist_day_sheet: 4,
  };
  assert.deepEqual(Object.keys(whatsapp.PARAMS).sort(), Object.keys(approved).sort(), "no template missing from PARAMS, none extra");
  for (const [type, count] of Object.entries(approved)) {
    assert.equal(whatsapp.PARAMS[type].vars.length, count, `${type} PARAMS`);
    calls = [];
    const out = await whatsapp.sendTemplate({ phone: "9876543210", type, params: FULL });
    assert.equal(out.status, "sent", `${type}: ${out.error}`);
    assert.equal(calls[0].body.templateParams.length, count, `${type} sent`);
  }
  assert.equal(whatsapp.PARAMS.booking_artist_changed.campaign, "artist_changed", "the campaign is named artist_changed");
});

test("artist_changed: a blank reason becomes 'The artist is unavailable'; a trailing full stop is stripped", async () => {
  const reasonSent = async (reason) => {
    calls = [];
    const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_artist_changed", params: { ...FULL, reason } });
    assert.equal(out.status, "sent", out.error);
    return calls[0].body.templateParams[5]; // {{6}}
  };
  for (const blank of ["", "   ", null, undefined, ".", " . "]) {
    assert.equal(await reasonSent(blank), "The artist is unavailable", JSON.stringify(blank));
  }
  assert.equal(await reasonSent("Sick leave."), "Sick leave");
  assert.equal(await reasonSent("  Training day.  "), "Training day");
  assert.equal(await reasonSent("Away on leave..."), "Away on leave");
  assert.equal(await reasonSent("Family function\nthis week."), "Family function this week", "one line");
  assert.equal(await reasonSent("Dr. Rao's clinic visit"), "Dr. Rao's clinic visit", "only the end is touched");
});

test("artist_day_sheet: {{4}} is one line joined with ' | ', at most ~600 characters, then '+X more'", () => {
  const { sheetLine } = require("../utils/morning");
  const at = (h) => new Date(Date.UTC(2026, 9, 24, h, 0)); // an IST morning/afternoon
  const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ startAt: at(4 + (i % 8)), name: `Client${i + 1} Kaur`, service: "Haircut Women", ...extra }));

  const few = sheetLine(mk(3));
  assert.equal(few.split(" | ").length, 3);
  assert.ok(!few.includes("more"), "a short list is shown whole");
  assert.ok(!few.includes("\n"));

  for (const n of [20, 60]) {
    const line = sheetLine(mk(n, { service: "Keratin smoothing treatment with deep conditioning" }));
    assert.ok(line.length <= 600, `${n} clients: ${line.length} chars`);
    assert.ok(!/[\r\n\t]/.test(line), "one line");
    const parts = line.split(" | ");
    const last = parts.pop();
    const [, hidden] = /^\+(\d+) more$/.exec(last) || [];
    assert.ok(hidden, `${n} clients: ends with '+X more'`);
    assert.equal(parts.length + Number(hidden), n, "every client is either shown or counted");
    assert.ok(parts.length >= 1);
  }

  // A name or service can neither add a line nor fake a separator.
  const odd = sheetLine([{ startAt: at(5), name: "Sita\nDevi", service: "Cut | Colour\nWash" }, { startAt: at(6), name: "Kamla", service: "Facial" }]);
  assert.ok(!/[\r\n]/.test(odd));
  assert.equal(odd.split(" | ").length, 2);
});

test("amounts: refunds go out as bare numbers (the template already prints ₹)", async () => {
  const sent = async (type, params) => {
    calls = [];
    const out = await whatsapp.sendTemplate({ phone: "9876543210", type, params: { ...FULL, ...params } });
    return out.status === "sent" ? calls[0].body.templateParams : out;
  };
  assert.equal((await sent("booking_cancelled", { refund: 250 }))[2], "250");
  assert.equal((await sent("booking_declined", { refund: 0 }))[2], "0");
  assert.equal((await sent("booking_refund", { amount: 1250.5 }))[2], "1250.50");
  assert.equal((await sent("booking_refund", { amount: 175.004 }))[2], "175");
  assert.equal((await sent("booking_refund", { amount: "₹1,250" }))[2], "1250", "a ₹ sign or comma never reaches the template");
  const bad = await sent("booking_refund", { amount: "a lot" });
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /not an amount/);
  assert.equal(whatsapp.bareAmount(undefined), undefined);
  assert.equal(whatsapp.bareAmount(""), "");
  assert.equal(whatsapp.bareAmount("1.2.3"), "1.2.3", "not a number: left for the check to refuse");
});

test("links: booking, map and salon links must be full https URLs; a blank map is allowed", async () => {
  for (const [name, value] of [["link", "www.thexpertshair.com/booking/abc"], ["link", "http://x.com/b"], ["salon_link", "wa.me/919000000000"], ["map", "maps.app.goo.gl/x"]]) {
    calls = [];
    const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "reminder_24h", params: { ...FULL, [name]: value } });
    assert.equal(out.status, "failed", `${name}=${value}`);
    assert.match(out.error, /not a full https link/);
    assert.equal(calls.length, 0);
  }
  const ok = await whatsapp.sendTemplate({ phone: "9876543210", type: "reminder_24h", params: { ...FULL, map: "" } });
  assert.equal(ok.status, "sent");
});

test("manage link: always a full https URL, even if CUSTOMER_SITE_URL was typed without it", () => {
  const { manageUrl } = require("../utils/booking");
  const id = new (require("mongoose").Types.ObjectId)();
  const saved = process.env.CUSTOMER_SITE_URL;
  try {
    for (const setting of [undefined, "https://www.thexpertshair.com/", "www.thexpertshair.com", " thexpertshair.com// "]) {
      if (setting === undefined) delete process.env.CUSTOMER_SITE_URL;
      else process.env.CUSTOMER_SITE_URL = setting;
      const url = manageUrl({ _id: id });
      assert.match(url, /^https:\/\/(www\.)?thexpertshair\.com\/booking\/\S+$/, String(setting));
      assert.ok(!url.includes("//booking"), String(setting));
    }
  } finally {
    if (saved === undefined) delete process.env.CUSTOMER_SITE_URL;
    else process.env.CUSTOMER_SITE_URL = saved;
  }
});

test("when: formatted like 'Fri, 16 Oct, 11:00 am' in IST, with plain spaces", () => {
  const { formatInstant } = require("../utils/bookingAlerts");
  const cases = [
    ["2026-10-16T05:30:00Z", "Fri, 16 Oct, 11:00 am"],
    ["2026-10-16T13:05:00Z", "Fri, 16 Oct, 6:35 pm"],
    ["2026-10-16T06:30:00Z", "Fri, 16 Oct, 12:00 pm"], // noon
    ["2026-10-15T18:30:00Z", "Fri, 16 Oct, 12:00 am"], // midnight IST is still the 15th in UTC
    ["2026-10-16T20:00:00Z", "Sat, 17 Oct, 1:30 am"], // late evening UTC is already tomorrow in IST
  ];
  for (const [iso, want] of cases) {
    const got = formatInstant(new Date(iso));
    assert.equal(got, want, iso);
    assert.match(got, /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm)$/, "ASCII only, lower-case am/pm");
  }
});
