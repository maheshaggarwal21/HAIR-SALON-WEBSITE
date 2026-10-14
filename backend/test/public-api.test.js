/**
 * @file test/public-api.test.js
 * @description `/api/public/*` through the REAL app (index.js), so mount order
 * is tested too: public routes sit before the session and the global limiter.
 *
 * CP1 items covered here:
 *   - public API returns no list price, commission, staff phone or other
 *     customers' data (key scan on every response);
 *   - a request creates an Appointment `requested` with services, date, window, UTM;
 *   - every customer-facing response says "request", never "booked/confirmed";
 *   - rate limits and Turnstile stop 20 rapid requests from one IP;
 *   - the owner's Telegram alert is sent before the response.
 *
 * Turnstile and Telegram are a local stub server — nothing leaves the machine.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub;
let stubCalls = [];
let server;
let base;
let Service, Artist, Appointment, Customer, SiteSettings, User, packages, time;

const LIST_PRICES = [3100, 6100, 8100, 310, 410];

before(async () => {
  // Stub for Cloudflare siteverify and the Telegram Bot API.
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      stubCalls.push({ url: req.url, body: raw });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/turnstile") {
        const token = new URLSearchParams(raw).get("response");
        return res.end(JSON.stringify(token === "good" ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }));
      }
      return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  process.env.TURNSTILE_VERIFY_URL = `${stubBase}/turnstile`;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_API_BASE = stubBase;

  await startDb();
  // The app loads backend/.env; make sure it can only ever see the test DB.
  assert.match(process.env.MONGODB_URI, /^mongodb:\/\/127\.0\.0\.1/);
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/public`;

  Service = require("../models/Service");
  Artist = require("../models/Artist");
  Appointment = require("../models/Appointment");
  Customer = require("../models/Customer");
  SiteSettings = require("../models/SiteSettings");
  User = require("../models/User");
  packages = require("../config/packages");
  time = require("../utils/time");
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await stopDb();
});

let ipCounter = 0;
/** Each test gets its own client IP so per-IP limits don't leak between tests. */
let ip;
beforeEach(async () => {
  await clearDb();
  stubCalls = [];
  packages.length = 0;
  ip = `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  await seed();
});

async function seed() {
  const common = { isActive: true, showOnWebsite: true, bookingMode: "request" };
  await Service.create([
    { ...common, name: "Hydra Facial", price: 3100, publicPrice: 1550, slug: "hydra-facial", audience: "her", displayCategory: "Skin", durationMinutes: 60, durationConfirmed: false },
    { ...common, name: "Smoothening (Women) Short", price: 6100, publicPrice: 3050, slug: "smoothening-short", variantGroup: "smoothening-women", variantLabel: "Short", publicName: "Smoothening", audience: "her", displayCategory: "Treatments", durationMinutes: 150, durationConfirmed: true, description: "Frizz-free for months." },
    { ...common, name: "Smoothening (Women) Medium", price: 8100, publicPrice: 4050, slug: "smoothening-medium", variantGroup: "smoothening-women", variantLabel: "Medium", publicName: "Smoothening", audience: "her", displayCategory: "Treatments" },
    { ...common, name: "Beard Trim", price: 310, publicPrice: 155, slug: "beard-trim", audience: "him", displayCategory: "Grooming" },
    { ...common, name: "Head Massage", price: 410, publicPrice: 205, slug: "head-massage", audience: "unisex", displayCategory: "Treatments", bookingMode: "walkin_only" },
    { name: "Any item", price: 50, publicPrice: 25, isActive: true, showOnWebsite: false, slug: "any-item" },
    { ...common, name: "Secret Service", price: 999, publicPrice: 500, slug: "secret", bookingMode: "hidden" },
  ]);
  await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", email: "mansi@example.com", commission: 40, registrationId: "R-1", gender: "female", level: "senior", publicProfile: { slug: "mansi", displayName: "Mansi", visible: true, specialties: ["Colour"] } },
    { name: "Hidden Artist", phone: "9888800002", commission: 30, publicProfile: { slug: "hidden", visible: false } },
    // No public profile at all: listed automatically because they're active (K6).
    { name: "Ravi Kumar", phone: "9888800003", commission: 35 },
    { name: "Gone Artist", phone: "9888800004", isActive: false },
  ]);
  await User.collection.insertOne({ name: "Owner", role: "owner", isActive: true, telegramChatId: "111" });
}

async function get(path) {
  const res = await fetch(base + path, { headers: { "x-forwarded-for": ip } });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function post(path, payload, { fromIp = ip } = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": fromIp },
    body: JSON.stringify(payload),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const FORBIDDEN_KEYS = new Set([
  "listPrice",
  "commission",
  "registrationId",
  "email",
  "internalNote",
  "contact_phone",
  "userId",
  "isActive",
  "category", // internal category
]);

/** Walk every key in a response and fail on anything staff-only. */
function assertPublicOnly(payload, where) {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        assert.ok(!FORBIDDEN_KEYS.has(k), `${where}: staff-only key "${k}" at ${path}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(payload, "$");
  const json = JSON.stringify(payload);
  for (const p of LIST_PRICES) assert.doesNotMatch(json, new RegExp(`\\b${p}\\b`), `${where}: list price ${p} leaked`);
  assert.doesNotMatch(json, /98888000\d\d/, `${where}: staff phone leaked`);
}

/** The next day the salon is open, starting tomorrow (Tuesdays are closed by default). */
const tomorrow = () => {
  for (let i = 1; i < 8; i++) {
    const d = time.salonDate(new Date(Date.now() + i * 24 * 60 * 60 * 1000));
    if (time.weekdayKey(d) !== "tue") return d;
  }
  throw new Error("no open day in the next week");
};

function requestBody(over = {}) {
  return {
    services: [],
    date: tomorrow(),
    window: "evening",
    for: "her",
    name: "Asha Kaur",
    phone: "98765 43210",
    turnstileToken: "good",
    ...over,
  };
}

async function serviceId(slug) {
  return String((await Service.findOne({ slug }).lean())._id);
}

// ── Reads ────────────────────────────────────────────────────────────────────

test("menu: public services only, variants grouped, list prices never shown", async () => {
  const { status, body } = await get("/services");
  assert.equal(status, 200);
  assertPublicOnly(body, "/services");

  const slugs = body.services.map((c) => c.slug).sort();
  assert.deepEqual(slugs, ["beard-trim", "head-massage", "hydra-facial", "smoothening-women"]);

  const smoothening = body.services.find((c) => c.slug === "smoothening-women");
  assert.equal(smoothening.name, "Smoothening");
  assert.deepEqual(smoothening.options.map((o) => [o.label, o.price]), [["Short", 3050], ["Medium", 4050]]);
  assert.equal(smoothening.fromPrice, 3050);
  // Confirmed duration shows; the one-hour estimate does not (D14).
  assert.equal(smoothening.options[0].durationMinutes, 150);
  assert.equal(body.services.find((c) => c.slug === "hydra-facial").options[0].durationMinutes, null);
});

test("menu: for=him shows men's and unisex services", async () => {
  const { body } = await get("/services?for=him");
  assert.deepEqual(body.services.map((c) => c.slug).sort(), ["beard-trim", "head-massage"]);
  assert.equal((await get("/services?for=kids")).status, 400);
});

test("service detail: any variant's slug returns the whole group with its description", async () => {
  const { status, body } = await get("/services/smoothening-medium");
  assert.equal(status, 200);
  assertPublicOnly(body, "/services/:slug");
  assert.equal(body.service.slug, "smoothening-women");
  assert.equal(body.service.options.length, 2);
  assert.equal(body.service.description, "Frizz-free for months.");
  assert.equal((await get("/services/any-item")).status, 404);
  assert.equal((await get("/services/secret")).status, 404);
});

test("artists: every active artist unless hidden, with automatic URLs; no phone, email or commission", async () => {
  const { body } = await get("/artists");
  assertPublicOnly(body, "/artists");
  assert.deepEqual(body.artists.map((a) => a.slug), ["mansi", "ravi-kumar"]);
  assert.equal(body.artists[0].name, "Mansi");
  assert.equal(body.artists[1].name, "Ravi Kumar");
  assert.equal((await get("/artists/hidden")).status, 404); // hidden by the owner
  assert.equal((await get("/artists/gone-artist")).status, 404); // deactivated
  assertPublicOnly((await get("/artists/ravi-kumar")).body, "/artists/:slug");
});

test("artists sharing a name get distinct, stable URLs", async () => {
  await Artist.create({ name: "Ravi Kumar", phone: "9888800005" });
  const { body } = await get("/artists");
  const ravis = body.artists.filter((a) => a.name === "Ravi Kumar").map((a) => a.slug);
  assert.equal(ravis.length, 2);
  assert.equal(new Set(ravis).size, 2);
  assert.ok(ravis.includes("ravi-kumar"));
  assert.deepEqual((await get("/artists")).body.artists.map((a) => a.slug), body.artists.map((a) => a.slug));
});

test("a request can name any listed artist as a preference", async () => {
  const res = await post("/requests", requestBody({ services: [await serviceId("hydra-facial")], artistSlug: "ravi-kumar" }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const appt = await Appointment.findOne({ ref: res.body.ref }).lean();
  assert.equal(appt.preferredArtistName, "Ravi Kumar");
  assert.equal(appt.guests[0].items[0].artistId, null); // a wish, not an assignment

  const hidden = await post("/requests", requestBody({ services: [await serviceId("hydra-facial")], artistSlug: "hidden", phone: "9811122233" }));
  assert.equal(hidden.status, 201);
  assert.equal((await Appointment.findOne({ ref: hidden.body.ref }).lean()).preferredArtistName, null);
});

test("site: settings subset, and no session cookie on any public response", async () => {
  const res = await get("/site");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.body.contact.address, "Green Park Colony, near Sunrise Hotel, Sirhind–Patiala Rd, Patiala");
  assert.equal(res.body.contact.whatsapp, "9814830550");
  assert.equal(res.body.requestWindows.morning.start, "09:00");
  assert.equal(res.body.maxActiveBookingsPerPhone, undefined);
});

// ── Request-lite ─────────────────────────────────────────────────────────────

test("a request is saved as `requested` with server prices, and the owner is alerted first", async () => {
  const res = await post(
    "/requests",
    requestBody({
      services: [await serviceId("hydra-facial"), await serviceId("smoothening-medium")],
      notes: "First time here",
      utm: { source: "instagram", campaign: "kc26" },
    })
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.headers.get("set-cookie"), null);
  assertPublicOnly(res.body, "POST /requests");
  assert.equal(res.body.status, "requested");
  assert.equal(res.body.total, 1550 + 4050);
  // Honest wording: a request is never "booked" or "confirmed".
  assert.doesNotMatch(JSON.stringify(res.body), /book|confirm/i);

  const appt = await Appointment.findOne({ ref: res.body.ref }).lean();
  assert.equal(appt.status, "requested");
  assert.equal(appt.mode, "request");
  assert.deepEqual(appt.requestedWindow, { date: tomorrow(), window: "evening" });
  assert.deepEqual(appt.guests[0].items.map((i) => [i.publicPrice, i.listPrice]), [[1550, 3100], [4050, 8100]]);
  assert.equal(appt.contact, "9876543210");
  assert.equal(appt.source.channel, "web");
  assert.equal(appt.source.utm.campaign, "kc26");
  assert.equal(appt.startAt, null); // no time, no slot until staff confirm
  assert.equal(appt.statusHistory[0].to, "requested");

  const customer = await Customer.findOne({ phone: "9876543210" }).lean();
  assert.equal(customer.createdFrom, "web");
  assert.equal(customer.gender, "female");
  assert.equal(customer.marketing.whatsappOptIn, false); // unticked by default
  assert.equal(customer.firstTouch.utm.source, "instagram");

  const tg = stubCalls.find((c) => c.url === "/bottest-token/sendMessage");
  assert.ok(tg, "Telegram alert sent before the response");
  assert.equal(JSON.parse(tg.body).chat_id, "111");
  assert.match(JSON.parse(tg.body).text, new RegExp(res.body.ref));
});

test("the browser cannot send a price, total or discount", async () => {
  const id = await serviceId("hydra-facial");
  for (const field of ["total", "price", "discount", "pricing"]) {
    const res = await post("/requests", { ...requestBody({ services: [id] }), [field]: 1 });
    assert.equal(res.status, 400, field);
    assert.deepEqual(res.body.fields, [field]);
  }
  assert.equal(await Appointment.countDocuments(), 0);
});

test("services that aren't requestable online are refused", async () => {
  for (const slug of ["head-massage", "any-item", "secret"]) {
    const res = await post("/requests", requestBody({ services: [await serviceId(slug)] }));
    assert.equal(res.status, 400, slug);
    assert.equal(res.body.error, "SERVICE_UNAVAILABLE", slug);
  }
  const none = await post("/requests", requestBody({ services: [] }));
  assert.equal(none.body.error, "VALIDATION");
});

test("dates: past, too far ahead, the weekly off and holidays are refused", async () => {
  const id = await serviceId("hydra-facial");
  const yesterday = time.salonDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const farAway = time.salonDate(new Date(Date.now() + 45 * 24 * 60 * 60 * 1000));
  assert.equal((await post("/requests", requestBody({ services: [id], date: yesterday }))).body.error, "OUTSIDE_HOURS");
  assert.equal((await post("/requests", requestBody({ services: [id], date: farAway }))).body.error, "OUTSIDE_HOURS");

  let tuesday = tomorrow();
  for (let i = 1; time.weekdayKey(tuesday) !== "tue"; i++) tuesday = time.salonDate(new Date(Date.now() + i * 864e5));
  assert.equal((await post("/requests", requestBody({ services: [id], date: tuesday }))).body.error, "OUTSIDE_HOURS");

  const s = await SiteSettings.getSingleton();
  s.holidays = [tomorrow()];
  await s.save();
  const holiday = await post("/requests", requestBody({ services: [id] }));
  assert.equal(holiday.body.error, "OUTSIDE_HOURS");
  assert.match(holiday.body.message, /closed/);
});

test("Turnstile: a failed check writes nothing", async () => {
  const res = await post("/requests", requestBody({ services: [await serviceId("hydra-facial")], turnstileToken: "bot" }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "TURNSTILE_FAILED");
  assert.equal(await Appointment.countDocuments(), 0);
  assert.equal(await Customer.countDocuments(), 0);
});

test("20 rapid requests from one IP: at most 10 get through", async () => {
  const id = await serviceId("hydra-facial");
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      post("/requests", requestBody({ services: [id], phone: `98000000${String(i).padStart(2, "0")}` }))
    )
  );
  const created = results.filter((r) => r.status === 201).length;
  const limited = results.filter((r) => r.status === 429 && r.body.error === "LIMIT_REACHED").length;
  assert.ok(created <= 10, `created ${created}`);
  assert.equal(created + limited, 20);
  assert.equal(await Appointment.countDocuments(), created);
});

test("one phone can hold at most 3 open requests (E11)", async () => {
  const id = await serviceId("hydra-facial");
  for (let i = 0; i < 3; i++) {
    assert.equal((await post("/requests", requestBody({ services: [id] }), { fromIp: `10.9.9.${i}` })).status, 201);
  }
  const fourth = await post("/requests", requestBody({ services: [id] }), { fromIp: "10.9.9.9" });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error, "LIMIT_REACHED");
});

test("WhatsApp opt-in is recorded only when ticked, and an unticked box never withdraws it", async () => {
  const id = await serviceId("hydra-facial");
  await post("/requests", requestBody({ services: [id], whatsappOptIn: true }), { fromIp: "10.8.0.1" });
  let c = await Customer.findOne({ phone: "9876543210" }).lean();
  assert.equal(c.marketing.whatsappOptIn, true);
  assert.equal(c.marketing.source, "web_request");

  await post("/requests", requestBody({ services: [id], whatsappOptIn: false, name: "Asha K" }), { fromIp: "10.8.0.2" });
  c = await Customer.findOne({ phone: "9876543210" }).lean();
  assert.equal(c.marketing.whatsappOptIn, true);
  assert.equal(c.name, "Asha K"); // latest name wins
});

test("packages: live ones are listed with server prices; requesting one derives the discount", async () => {
  const today = time.salonDate();
  const ids = async (...slugs) => Promise.all(slugs.map(serviceId));
  packages.push({
    slug: "kc-glow",
    name: "KC Glow",
    audience: "her",
    // "any-item" isn't on the menu by itself; a package may still include it.
    serviceIds: await ids("hydra-facial", "beard-trim", "any-item"),
    packagePrice: 1500,
    validFrom: today,
    validTo: tomorrow(),
  });
  packages.push({ slug: "no-dates", name: "Always on", serviceIds: await ids("hydra-facial"), packagePrice: 1400 });
  packages.push({ slug: "expired", name: "Old", serviceIds: await ids("hydra-facial"), packagePrice: 1, validFrom: "2020-01-01", validTo: "2020-01-02" });
  packages.push({ slug: "draft", name: "Not yet", serviceIds: await ids("hydra-facial"), packagePrice: 1, draft: true });
  packages.push({ slug: "walkin", name: "Has walk-in item", serviceIds: await ids("head-massage"), packagePrice: 1 });

  const list = await get("/packages");
  assertPublicOnly(list.body, "/packages");
  assert.deepEqual(list.body.packages.map((p) => [p.slug, p.price]), [["kc-glow", 1500], ["no-dates", 1400]]);

  // More package items than the 8-service limit would be fine too: only extras count.
  const res = await post("/requests", requestBody({ packageSlug: "kc-glow", services: [await serviceId("smoothening-short")] }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const appt = await Appointment.findOne({ ref: res.body.ref }).lean();
  // items 1550 + 155 + 25 = 1730 → package 1500 (discount 230), plus smoothening 3050.
  assert.deepEqual([appt.pricing.subtotal, appt.pricing.discount, appt.pricing.total], [4780, 230, 4550]);
  assert.equal(res.body.total, 4550);

  for (const slug of ["expired", "draft", "walkin"]) {
    assert.equal((await post("/requests", requestBody({ packageSlug: slug, phone: "9822200011" }))).body.error, "PACKAGE_UNAVAILABLE", slug);
  }
});

test("menu groups (D34): one card per group, detail by group URL or a member's old URL", async () => {
  const common = { category: "Hair", isActive: true, showOnWebsite: true, bookingMode: "request", audience: "unisex", displayCategory: "Hands & feet" };
  await Service.create([
    { ...common, name: "Mini Pedicure", price: 1000, publicPrice: 500, slug: "mini-pedicure" },
    { ...common, name: "Pedicure", price: 1500, publicPrice: 750, slug: "pedicure" },
    { ...common, name: "Luxury Pedicure", price: 3000, publicPrice: 1500, slug: "luxury-pedicure" },
  ]);
  const menu = (await get("/services?for=her")).body.services;
  const pedi = menu.filter((c) => c.name === "Pedicure" || c.slug === "pedicure");
  assert.equal(pedi.length, 1);
  assert.equal(pedi[0].slug, "pedicure");
  assert.deepEqual(pedi[0].options.map((o) => o.label), ["Mini", "Classic", "Luxury"]);
  assertPublicOnly({ services: menu }, "/services");

  const byGroup = await get("/services/pedicure");
  assert.equal(byGroup.status, 200);
  assert.equal(byGroup.body.service.options.length, 3);
  const byMember = await get("/services/luxury-pedicure");
  assert.equal(byMember.body.service.slug, "pedicure");
  assert.equal(byMember.body.service.options.length, 3);
  assert.equal((await get("/services/manicure")).status, 404, "a group with no live services is not a page");
});
