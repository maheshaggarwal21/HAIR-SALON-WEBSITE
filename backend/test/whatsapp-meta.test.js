/**
 * @file test/whatsapp-meta.test.js
 * @description D52: messages go out through Meta's WhatsApp Cloud API by default.
 * A local stub plays Graph API, so nothing leaves the machine. Checks the
 * request shape (template name, language, variables IN ORDER, the OTP copy-code
 * button), failure mapping, the development fallback and that every notification
 * carries the salon's tap-to-chat link.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub;
let calls = [];
let respond;
let whatsapp, notify, NotificationLog, SiteSettings;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call = { url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      const out = respond(call);
      res.statusCode = out.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  Object.assign(process.env, {
    NODE_ENV: "development",
    META_WA_API_BASE: `http://127.0.0.1:${stub.address().port}`,
    META_WA_TOKEN: "test-token",
    META_WA_PHONE_NUMBER_ID: "555000111",
    WHATSAPP_TEMPLATE_OTP: "otp_code",
    WHATSAPP_TEMPLATE_BOOKING_CONFIRMED: "booking_confirmed_v1",
    WHATSAPP_TEMPLATE_BOOKING_ARTIST_CHANGED: "artist_changed_v1",
  });
  await startDb();
  whatsapp = require("../utils/whatsapp");
  notify = require("../utils/notify").notify;
  NotificationLog = require("../models/NotificationLog");
  SiteSettings = require("../models/SiteSettings");
});

after(async () => {
  await new Promise((r) => stub.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  calls = [];
  respond = () => ({ status: 200, body: { messaging_product: "whatsapp", messages: [{ id: "wamid.ABC" }] } });
});

test("meta: a template message is posted to the Graph API with its variables in order", async () => {
  const out = await whatsapp.sendTemplate({
    phone: "9876543210",
    type: "booking_confirmed",
    params: { link: "https://x/booking/t", salon_link: "https://wa.me/919814830307", when: "Fri, 16 Oct, 11:00 am", ref: "EXP-ABCDE", name: "Asha" },
  });
  assert.deepEqual(out, { status: "sent", providerId: "wamid.ABC", channel: "whatsapp" });
  const c = calls[0];
  assert.equal(c.url, "/v21.0/555000111/messages");
  assert.equal(c.auth, "Bearer test-token");
  assert.equal(c.body.messaging_product, "whatsapp");
  assert.equal(c.body.to, "919876543210");
  assert.equal(c.body.type, "template");
  assert.deepEqual(c.body.template.language, { code: "en" });
  assert.equal(c.body.template.name, "booking_confirmed_v1");
  assert.deepEqual(
    c.body.template.components[0].parameters.map((p) => p.text),
    ["Asha", "EXP-ABCDE", "Fri, 16 Oct, 11:00 am", "https://x/booking/t", "https://wa.me/919814830307"],
    "{{1}}…{{5}} in the order documented in WHATSAPP_TEMPLATES.md, whatever order the caller built the object in"
  );
});

test("meta: the OTP uses the authentication format: code in the body and the copy-code button", async () => {
  await whatsapp.sendTemplate({ phone: "9876543210", type: "otp", params: { code: "123456" } });
  const comps = calls[0].body.template.components;
  assert.equal(comps[0].type, "body");
  assert.equal(comps[0].parameters[0].text, "123456");
  assert.deepEqual(comps[1], { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] });
});

test("meta: line breaks and long text are cleaned, empty values never go out empty", async () => {
  await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_artist_changed", params: { name: "A\nB", ref: "R", when: "W", oldArtist: "Mansi", newArtist: "Ravi", reason: "x".repeat(2000), link: "L", salon_link: "" } });
  const texts = calls[0].body.template.components[0].parameters.map((p) => p.text);
  assert.equal(texts[0], "A B");
  assert.ok(texts[5].length <= 900);
  assert.equal(texts[7], "-", "Meta rejects an empty variable");
});

test("meta: an API error is reported, not thrown", async () => {
  respond = () => ({ status: 400, body: { error: { message: "Template name does not exist", code: 132001 } } });
  const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: {} });
  assert.equal(out.status, "failed");
  assert.match(out.error, /Template name does not exist \(132001\)/);
});

test("meta: no credentials → development fallback; production → skipped", async () => {
  const saved = process.env.META_WA_TOKEN;
  process.env.META_WA_TOKEN = "";
  const dev = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: {} });
  assert.deepEqual([dev.status, dev.channel], ["skipped", "dev"]);
  assert.equal(whatsapp.isConfigured(), false);
  process.env.NODE_ENV = "production";
  const prod = await whatsapp.sendTemplate({ phone: "9876543210", type: "booking_confirmed", params: {} });
  assert.deepEqual([prod.status, prod.channel], ["skipped", "whatsapp"]);
  process.env.NODE_ENV = "development";
  process.env.META_WA_TOKEN = saved;
  assert.equal(calls.length, 0);
});

test("meta: a type with no approved template is skipped, not sent", async () => {
  const out = await whatsapp.sendTemplate({ phone: "9876543210", type: "reminder_24h", params: {} });
  assert.equal(out.status, "skipped");
  assert.match(out.error, /no template for reminder_24h/);
  assert.equal(calls.length, 0);
});

test("notify: every message carries the salon's tap-to-chat link, and is recorded once", async () => {
  await SiteSettings.getSingleton();
  await SiteSettings.updateOne({}, { $set: { "contact.whatsapp": "9814830307" } });
  const r = await notify({ key: "a1:booking_confirmed", type: "booking_confirmed", to: "9876543210", params: { name: "Asha", ref: "EXP-ABCDE", when: "W", link: "L" } });
  assert.equal(r.status, "sent");
  assert.equal(calls[0].body.template.components[0].parameters.at(-1).text, "https://wa.me/919814830307");
  const row = await NotificationLog.findOne({ key: "a1:booking_confirmed" }).lean();
  assert.equal(row.status, "sent");
  assert.equal(row.providerId, "wamid.ABC");
  assert.equal((await notify({ key: "a1:booking_confirmed", type: "booking_confirmed", to: "9876543210", params: {} })).status, "duplicate");
  assert.equal(calls.length, 1);
});
