/**
 * @file test/otp-aisensy.test.js
 * @description The one-time code through AiSensy's `otp_code` campaign (OTP_PROVIDER=aisensy).
 * A local stub plays AiSensy; nothing leaves the machine. Covers the payload shape, that the
 * code ignores DRY_RUN and TEST_PHONE, that it is never logged, its 5-minute life, the
 * failure path and the setting that decides whether the site offers online booking.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub;
let calls = [];
let respond;
let whatsapp, otp, OtpChallenge;

const KEY = "test-aisensy-key";

function configure() {
  Object.assign(process.env, {
    NODE_ENV: "development",
    OTP_PROVIDER: "aisensy",
    WHATSAPP_PROVIDER: "aisensy",
    AISENSY_KEY: KEY,
    DRY_RUN: "true", // everything else is held back…
    TEST_PHONE: "9111122222", // …and redirected, but never the code
    AISENSY_API_URL: `http://127.0.0.1:${stub.address().port}/campaign/t1/api/v2`,
  });
}

/** Everything written to the console while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const saved = {};
  for (const m of ["log", "info", "warn", "error"]) {
    saved[m] = console[m];
    console[m] = (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

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
  await startDb();
  whatsapp = require("../utils/whatsapp");
  otp = require("../utils/otp");
  OtpChallenge = require("../models/OtpChallenge");
});

after(async () => {
  await new Promise((r) => stub.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  calls = [];
  respond = () => ({ status: 200, body: { success: "true", submitted_message_id: "m1" } });
  configure();
});

test("otp: the code goes in templateParams AND the copy-code button, as strings, in AiSensy's shape", async () => {
  const out = await whatsapp.sendTemplate({ phone: "98765 43210", type: "otp", params: { code: "042917" } });
  assert.equal(out.status, "sent");
  const b = calls[0].body;
  assert.equal(b.apiKey, KEY);
  assert.equal(b.campaignName, "otp_code");
  assert.equal(b.destination, "+919876543210");
  assert.deepEqual(b.templateParams, ["042917"]);
  assert.deepEqual(b.buttons, [{ type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: "042917" }] }]);
  assert.equal(typeof b.templateParams[0], "string", "a leading zero must survive");
  for (const k of ["media", "location", "attributes", "paramsFallbackValue"]) assert.deepEqual(b[k], {}, k);
  assert.deepEqual(b.carouselCards, []);
});

test("otp: ignores DRY_RUN and TEST_PHONE, so the customer always gets their own code", async () => {
  const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "otp", params: { code: "123456" } });
  assert.equal(out.status, "sent");
  assert.equal(calls[0].body.destination, "+919876543210", "not the TEST_PHONE");
  // while an ordinary message in the same settings is held back
  calls = [];
  const other = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_cancelled", params: { name: "A", ref: "EXP-1", refund: 0, salon_link: "https://wa.me/919000000000" } });
  assert.equal(other.error, "dry_run");
  assert.equal(calls.length, 0);
});

test("otp: uses AiSensy's v2 address; other messages keep the one they already use", async () => {
  delete process.env.AISENSY_API_URL;
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ success: "true" }), { status: 200 });
  };
  try {
    process.env.DRY_RUN = "false";
    delete process.env.TEST_PHONE;
    await whatsapp.sendTemplate({ phone: "9876543210", type: "otp", params: { code: "123456" } });
    await whatsapp.sendTemplate({ phone: "9876543210", type: "request_cancelled", params: { name: "A", ref: "EXP-1", salon_link: "https://wa.me/919000000000" } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(urls, ["https://backend.aisensy.com/campaign/t1/api/v2", "https://backend.aisensy.com/campaign/t1/api"]);
});

test("otp: a code that is not 6 digits is never sent", async () => {
  for (const code of ["", "12345", "1234567", "12345a", undefined]) {
    const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "otp", params: { code } });
    assert.equal(out.status, "failed", String(code));
  }
  assert.equal(calls.length, 0);
});

test("otp: the default provider is Meta, and the site switch follows the provider chosen", () => {
  delete process.env.OTP_PROVIDER;
  assert.equal(whatsapp.otpProvider(), "meta");
  const saved = { t: process.env.META_WA_TOKEN, p: process.env.META_WA_PHONE_NUMBER_ID };
  delete process.env.META_WA_TOKEN;
  assert.equal(whatsapp.canSendOtp(), false, "Meta chosen but not set up");
  process.env.OTP_PROVIDER = "aisensy";
  assert.equal(whatsapp.canSendOtp(), true, "AiSensy chosen and its key is set");
  delete process.env.AISENSY_KEY;
  assert.equal(whatsapp.canSendOtp(), false);
  Object.assign(process.env, { META_WA_TOKEN: saved.t ?? "", META_WA_PHONE_NUMBER_ID: saved.p ?? "" });
});

test("otp: health lists only what is missing for the chosen providers", () => {
  const ok = whatsapp.configStatus();
  assert.equal(ok.otpProvider, "aisensy");
  assert.ok(!ok.missing.some((m) => m.startsWith("META_") || m === "WHATSAPP_TEMPLATE_OTP"), "Meta is not needed when AiSensy sends everything");
  delete process.env.AISENSY_KEY;
  assert.ok(whatsapp.configStatus().missing.includes("AISENSY_KEY"));
  process.env.OTP_PROVIDER = "meta";
  process.env.WHATSAPP_PROVIDER = "aisensy";
  process.env.AISENSY_KEY = KEY;
  const m = whatsapp.configStatus().missing;
  assert.ok(m.includes("WHATSAPP_TEMPLATE_OTP") && m.includes("META_WA_TOKEN"), "Meta still sends the code, so it is needed");
});

test("otp.send: a real send is recorded for 5 minutes, works once, and is never logged", async () => {
  const before = Date.now();
  let result;
  const logs = await captureLogs(async () => {
    result = await otp.send("9876543210");
  });
  assert.equal(result.ok, true);
  assert.equal(result.channel, "whatsapp");
  const code = calls[0].body.templateParams[0];
  assert.match(code, /^\d{6}$/);
  assert.ok(!logs.includes(code), "the code is not in the logs");
  assert.ok(!logs.includes(KEY), "nor the key");

  assert.equal(otp.CODE_TTL_MS, 5 * 60 * 1000, "the template says it expires in 5 minutes");
  const row = await OtpChallenge.findOne().lean();
  const life = new Date(row.expiresAt).getTime() - before;
  assert.ok(life > 4.9 * 60_000 && life <= 5 * 60_000 + 1000, `lives ${Math.round(life / 1000)} s`);
  assert.equal(JSON.stringify(row).includes(code), false, "only a hash is stored");

  assert.deepEqual(await otp.check("9876543210", code), { ok: true });
  assert.equal((await otp.check("9876543210", code)).ok, false, "works once");
  assert.equal((await otp.check("9876543210", code, "booking", new Date(Date.now() + 6 * 60_000))).ok, false, "and not after 5 minutes");
});

test("otp.send: a failed send says so, stores nothing, and the logs hold a masked number, not the code or the key", async () => {
  respond = (call) => ({ status: 400, body: { error: `bad request for code ${call.body.templateParams[0]} using ${KEY}` } });
  let result;
  const logs = await captureLogs(async () => {
    result = await otp.send("9876543210");
  });
  assert.deepEqual(result, { ok: false, error: "OTP_UNAVAILABLE" });
  assert.equal(await OtpChallenge.countDocuments(), 0);
  const code = calls[0].body.templateParams[0];
  assert.ok(logs.includes("98******10"), "masked number");
  assert.ok(logs.includes("HTTP 400"), "the status");
  assert.ok(!logs.includes("bad request"), "only the status, not AiSensy's reply");
  assert.ok(!logs.includes(code), "the code, even when AiSensy echoes it");
  assert.ok(!logs.includes(KEY), "the key, even when AiSensy echoes it");
  assert.ok(!logs.includes("9876543210"), "the full number");
});

// ── the generated code itself ──

/** Run `fn` with crypto.randomInt returning `value`, then put the real one back. */
async function withRandom(value, fn) {
  const crypto = require("crypto");
  const real = crypto.randomInt;
  crypto.randomInt = () => value;
  try {
    return await fn();
  } finally {
    crypto.randomInt = real;
  }
}

test("otp.send: a code with leading zeros keeps them, as a string, in templateParams and in the button", async () => {
  for (const [n, code] of [[42, "000042"], [0, "000000"], [7, "000007"], [999_999, "999999"]]) {
    calls = [];
    await OtpChallenge.deleteMany({});
    const result = await withRandom(n, () => otp.send("9876543210"));
    assert.equal(result.ok, true);
    const b = calls[0].body;
    assert.equal(b.templateParams[0], code);
    assert.equal(b.buttons[0].parameters[0].text, code);
    assert.equal(typeof b.templateParams[0], "string");
    assert.equal(typeof b.buttons[0].parameters[0].text, "string");
    assert.equal(b.templateParams[0], b.buttons[0].parameters[0].text, "the same string in both places");
    assert.equal((await otp.check("9876543210", code)).ok, true, "and the stored hash matches that exact string");
  }
});

test("otp.send: a random code is 6 digits as a string, and different each time", async () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    calls = [];
    await otp.send("9876543210");
    const code = calls[0].body.templateParams[0];
    assert.match(code, /^\d{6}$/);
    assert.equal(typeof code, "string");
    seen.add(code);
  }
  assert.ok(seen.size > 1, "not a fixed value");
});

test("otp.send: a code that is not exactly 6 digits throws before anything is sent", async () => {
  for (const bad of [1_000_000, 12_345_678, -5]) {
    calls = [];
    await assert.rejects(() => withRandom(bad, () => otp.send("9876543210")), /exactly 6 digits/);
    assert.equal(calls.length, 0, `nothing sent for ${bad}`);
  }
  assert.equal(await OtpChallenge.countDocuments(), 0);
});

test("otp: no sample or placeholder text ever appears in the payload", async () => {
  await otp.send("9876543210");
  const json = JSON.stringify(calls[0].body);
  for (const forbidden of ["$FirstName", "FirstName", "TESTCODE", "$", "{{", "user\""]) {
    assert.ok(!json.includes(forbidden), `payload contains ${forbidden}`);
  }
  assert.deepEqual(calls[0].body.paramsFallbackValue, {}, "no fallback name that could be shown instead of the code");
  const code = calls[0].body.templateParams[0];
  assert.equal(json.split(code).length - 1, 2, "the code appears exactly twice: templateParams and the button");
});
