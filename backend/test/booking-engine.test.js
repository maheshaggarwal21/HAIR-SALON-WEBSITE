/**
 * @file test/booking-engine.test.js
 * @description Phase 2 online booking end to end (T2.5–T2.8, T2.10, CF §5, §21).
 *
 * Through the REAL app (index.js) for the HTTP surface and the Razorpay
 * webhook; straight into utils/booking.js for the concurrency test, where 50
 * HTTP requests would mostly measure rate limits.
 *
 * Edge cases covered: E1 (50 parallel confirms → exactly 1), E3, E4, E5,
 * E6 (price snapshot), E11, E12, E19, plus OTP limits, server-side prices,
 * hold expiry, request approval and salon-side refunds.
 *
 * Nothing leaves the machine: Razorpay is a fake client, Wati and Telegram a
 * local stub server, and every secret is set here before index.js loads
 * backend/.env (dotenv never overrides a variable that is already set).
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const crypto = require("crypto");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub;
let watiCalls = [];
let server;
let base;
let Service, Artist, Appointment, SlotLock, NotificationLog, PaymentEvent, time, booking, payments, bookingToken, Customer;

const WEBHOOK_SECRET = "test-webhook-secret";
const KEY_SECRET = "test-key-secret";
let orderSeq = 0;
let capturedByOrder = new Map();
let refundsSent = [];
let refundFails = false;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/turnstile") {
        const token = new URLSearchParams(raw).get("response");
        return res.end(JSON.stringify({ success: token === "good" }));
      }
      if (req.url.startsWith("/api/v1/sendTemplateMessage")) {
        watiCalls.push({ url: req.url, body: JSON.parse(raw) });
        return res.end(JSON.stringify({ result: true, id: `w${watiCalls.length}` }));
      }
      return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(process.env, {
    TURNSTILE_SECRET_KEY: "test-secret",
    TURNSTILE_VERIFY_URL: `${stubBase}/turnstile`,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_API_BASE: stubBase,
    WHATSAPP_PROVIDER: "wati", // these tests assert Wati's request shape; whatsapp-meta.test.js covers Meta
    WATI_API_URL: stubBase,
    WATI_API_TOKEN: "test-wati",
    WATI_TEMPLATE_OTP: "otp_code",
    WATI_TEMPLATE_BOOKING_CONFIRMED: "booking_confirmed_v1",
    WATI_TEMPLATE_REQUEST_RECEIVED: "",
    WATI_TEMPLATE_BOOKING_REFUND: "",
    WATI_TEMPLATE_BOOKING_DECLINED: "",
    WATI_TEMPLATE_BOOKING_CANCELLED: "",
    RAZORPAY_KEY_ID: "rzp_test_fake",
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_TOKEN_SECRET: "test-public-token-secret",
    CUSTOMER_SITE_URL: "https://www.example.test",
  });

  await startDb();
  assert.match(process.env.MONGODB_URI, /^mongodb:\/\/127\.0\.0\.1/);
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;

  Service = require("../models/Service");
  Artist = require("../models/Artist");
  Appointment = require("../models/Appointment");
  SlotLock = require("../models/SlotLock");
  NotificationLog = require("../models/NotificationLog");
  PaymentEvent = require("../models/PaymentEvent");
  Customer = require("../models/Customer");
  time = require("../utils/time");
  booking = require("../utils/booking");
  payments = require("../utils/payments");
  bookingToken = require("../utils/bookingToken");

  payments.setClientForTests({
    orders: {
      create: async (o) => ({ id: `order_${++orderSeq}`, amount: o.amount, currency: o.currency, notes: o.notes }),
      fetchPayments: async (id) => ({ items: capturedByOrder.get(id) || [] }),
    },
    payments: {
      refund: async (paymentId, o) => {
        if (refundFails) throw { error: { description: "Insufficient balance" } };
        refundsSent.push({ paymentId, ...o });
        return { id: `rfnd_${refundsSent.length}`, status: "processed" };
      },
    },
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await stopDb();
});

let ipCounter = 0;
let ip;
let ids;
let DATE;

/** A bookable day 2+ days ahead (not the Tuesday off), so lead time never interferes. */
function bookableDate() {
  let d = time.addDays(time.salonDate(), 2);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  return d;
}
const at = (hhmm, date = DATE) => time.salonInstant(date, hhmm).toISOString();

beforeEach(async () => {
  await clearDb();
  watiCalls = [];
  capturedByOrder = new Map();
  refundsSent = [];
  refundFails = false;
  ip = `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  DATE = bookableDate();
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true };
  const [cut, facial, colour] = await Service.create([
    { ...common, name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", audience: "her", displayCategory: "Hair", durationMinutes: 45 },
    { ...common, name: "Hydra Facial", price: 3000, publicPrice: 1500, slug: "hydra-facial", audience: "her", displayCategory: "Skin", durationMinutes: 60 },
    { ...common, name: "Global Colour", price: 6000, publicPrice: 3000, slug: "global-colour", audience: "her", displayCategory: "Colour", durationMinutes: 90, bookingMode: "request" },
  ]);
  const [mansi] = await Artist.create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female", onlineBookable: true, publicProfile: { slug: "mansi", displayName: "Mansi", visible: true } },
    { name: "Walk In Only", phone: "9888800002", commission: 30, gender: "male", onlineBookable: false },
  ]);
  ids = { cut: String(cut._id), facial: String(facial._id), colour: String(colour._id), mansi: String(mansi._id) };
});

async function call(method, path, payload, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...headers },
    body: payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

function tokenFor(phone) {
  return bookingToken.issue(phone).token;
}

function bookingBody(phone, overrides = {}) {
  return {
    bookingToken: tokenFor(phone),
    phone,
    name: "Asha Rani",
    guests: [{ for: "her", services: [ids.cut] }],
    startAt: at("11:00"),
    payment: "full",
    policyAccepted: true,
    turnstileToken: "good",
    ...overrides,
  };
}

async function selectionOf(serviceIds) {
  return booking.prepareSelection([{ for: "her", services: serviceIds }]);
}

test("group: a chosen artist is ignored — each guest gets a different free artist at the same time (D46)", async () => {
  await Artist.updateOne({ name: "Walk In Only" }, { $set: { onlineBookable: true, gender: "female" } });
  const selection = await booking.prepareSelection([{ for: "her", services: [ids.cut] }, { for: "her", services: [ids.cut] }]);
  const withMansi = await booking.findSlots({ date: DATE, selection, artistId: ids.mansi });
  const anyone = await booking.findSlots({ date: DATE, selection, artistId: null });
  assert.ok(anyone.slots.length > 0, "two artists are free: a pair can be booked");
  assert.equal(withMansi.slots.length, anyone.slots.length, "naming Mansi must not shrink or empty a group's times");

  const { appt } = await booking.createBooking({ phone: "9876500070", name: "Asha", selection, startAt: at("11:00"), paymentKind: "full", artistId: ids.mansi });
  const who = appt.guests.map((g) => g.items[0].artistName);
  assert.equal(new Set(who).size, 2, "two guests, two different artists");
  assert.equal(appt.guests[0].items[0].startAt.getTime(), appt.guests[1].items[0].startAt.getTime(), "in parallel");
});

/** Pull a booking's start to a few hours from now, i.e. inside the free-cancellation window. */
async function soonish(id) {
  const start = new Date(Date.now() + 3 * 3600e3);
  await Appointment.updateOne({ _id: id }, { $set: { startAt: start, endAt: new Date(start.getTime() + 3600e3) } });
}

function webhook(payment) {
  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return call("POST", "/api/razorpay/webhook", raw, { "x-razorpay-signature": sig });
}

function paymentFor(appt, id = `pay_${appt.ref}`) {
  return {
    id,
    order_id: appt.deposit.razorpayOrderId,
    amount: appt.deposit.amount * 100,
    currency: "INR",
    status: "captured",
    method: "upi",
    contact: `+91${appt.contact}`,
    notes: { kind: "booking", appointmentId: String(appt._id), ref: appt.ref },
  };
}

const FORBIDDEN = new Set(["listPrice", "commission", "internalNote", "manageTokenHash", "price"]);
function assertPublicOnly(payload) {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "price" && path.includes("items")) continue; // the public price of a booked item
        if (k === "price" && path.includes("lines")) continue;
        assert.ok(!FORBIDDEN.has(k), `staff-only key "${k}" at ${path}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(payload, "$");
}

// ─── Availability and quote ──────────────────────────────────────────────────

test("availability lists start times for online-bookable artists only, inside opening hours (E9)", async () => {
  const r = await call("GET", `/api/public/availability?date=${DATE}&g=${ids.cut},${ids.facial}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "instant");
  assert.ok(r.body.slots.length > 10);
  const first = r.body.slots[0];
  assert.equal(first.time, "09:00");
  assert.equal(first.period, "morning");
  // cut 45 → 3 blocks, facial 60 → 4 blocks: chain ends 1h45 later.
  assert.equal(Date.parse(first.endAt) - Date.parse(first.startAt), 105 * 60_000);
  assert.ok(first.guests[0].items.every((i) => i.artistName === "Mansi"));
  // The last start still finishes by 21:00 closing.
  const last = r.body.slots[r.body.slots.length - 1];
  assert.ok(Date.parse(last.endAt) <= Date.parse(at("21:00")));
  assert.equal(last.time, "19:15");
  assertPublicOnly(r.body);

  await Artist.updateMany({}, { $set: { onlineBookable: false } });
  const none = await call("GET", `/api/public/availability?date=${DATE}&g=${ids.cut}`);
  assert.equal(none.body.slots.length, 0);
});

test("availability rejects dates outside the horizon and unknown services", async () => {
  const past = await call("GET", `/api/public/availability?date=${time.addDays(time.salonDate(), -1)}&g=${ids.cut}`);
  assert.equal(past.body.error, "OUTSIDE_HOURS");
  const bad = await call("GET", `/api/public/availability?date=${DATE}&g=nope`);
  assert.equal(bad.status, 400);
});

test("quote is computed by the server and never shows list prices", async () => {
  const r = await call("POST", "/api/public/quote", { guests: [{ for: "her", services: [ids.cut, ids.facial] }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2000);
  assert.deepEqual(r.body.payment.options.map((o) => [o.kind, o.amount]), [["full", 2000], ["deposit", 600]]); // deposit = the 30% fee (D47)
  assertPublicOnly(r.body);
  const sneaky = await call("POST", "/api/public/quote", { guests: [{ services: [ids.cut] }], total: 1 });
  assert.equal(sneaky.status, 400, "unknown fields such as a price are rejected");
});

// ─── OTP ─────────────────────────────────────────────────────────────────────

test("OTP: WhatsApp code, wrong guesses counted, right code gives a booking token, code works once", async () => {
  const phone = "9876500001";
  const sent = await call("POST", "/api/public/otp/send", { phone, turnstileToken: "good" });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.channel, "whatsapp");
  const code = watiCalls[0].body.parameters.find((p) => p.name === "code").value;
  assert.match(code, /^\d{6}$/);
  assert.match(watiCalls[0].url, /whatsappNumber=919876500001/);

  const wrong = code === "000000" ? "111111" : "000000";
  const bad = await call("POST", "/api/public/otp/verify", { phone, code: wrong });
  assert.equal(bad.body.error, "OTP_INVALID");
  assert.equal(bad.body.attemptsLeft, 4);

  const ok = await call("POST", "/api/public/otp/verify", { phone, code });
  assert.equal(ok.status, 200);
  assert.ok(bookingToken.verify(ok.body.bookingToken, phone));
  assert.equal(bookingToken.verify(ok.body.bookingToken, "9876500002"), false, "token is bound to the phone");

  const again = await call("POST", "/api/public/otp/verify", { phone, code });
  assert.equal(again.body.error, "OTP_EXPIRED");
});

test("OTP: Turnstile required and 3 codes per phone per 15 minutes", async () => {
  const phone = "9876500003";
  assert.equal((await call("POST", "/api/public/otp/send", { phone, turnstileToken: "bad" })).body.error, "TURNSTILE_FAILED");
  for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/api/public/otp/send", { phone, turnstileToken: "good" })).status, 200);
  assert.equal((await call("POST", "/api/public/otp/send", { phone, turnstileToken: "good" })).body.error, "LIMIT_REACHED");
});

test("booking token: tampered, expired or missing tokens are refused", () => {
  const phone = "9876500004";
  const { token } = bookingToken.issue(phone, new Date(Date.now() - 31 * 60_000));
  assert.equal(bookingToken.verify(token, phone), false);
  const fresh = bookingToken.issue(phone).token;
  const [payload, sig] = fresh.split(".");
  assert.equal(bookingToken.verify(`${payload}x.${sig}`, phone), false);
  assert.equal(bookingToken.verify("", phone), false);
  assert.equal(bookingToken.verify(null, phone), false);
});

// ─── Create, pay, confirm ────────────────────────────────────────────────────

test("create: hold locks + Razorpay order for the server's amount; webhook confirms; replays change nothing (E5)", async () => {
  const phone = "9876500010";
  const r = await call("POST", "/api/public/appointments", bookingBody(phone, { guests: [{ for: "her", services: [ids.cut, ids.facial] }], payment: "deposit" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assertPublicOnly(r.body);
  assert.equal(r.body.booking.status, "pending_payment");
  assert.equal(r.body.order.amount, 600 * 100, "deposit = 30% of ₹2,000, computed by the server, in paise");
  assert.ok(r.body.manageToken);

  const appt = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  assert.equal(appt.deposit.amount, 600);
  assert.equal(appt.deposit.forfeitable, 600);
  assert.equal(appt.pricing.total, 2000);
  assert.equal(appt.manageTokenHash, bookingToken.hashManageToken(r.body.manageToken));
  const holds = await SlotLock.find({ appointmentId: appt._id }).lean();
  assert.equal(holds.length, 7, "45 + 60 min = 7 blocks");
  assert.ok(holds.every((l) => l.state === "hold" && l.expiresAt));

  const hook = await webhook(paymentFor(appt));
  assert.equal(hook.status, 200);
  assert.equal(hook.body.booking, "confirmed");
  const confirmed = await Appointment.findById(appt._id).lean();
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.deposit.status, "paid");
  const firm = await SlotLock.find({ appointmentId: appt._id }).lean();
  assert.equal(firm.length, 7);
  assert.ok(firm.every((l) => l.state === "firm" && !l.expiresAt));
  const ev = await PaymentEvent.findOne({ razorpayPaymentId: `pay_${appt.ref}` }).lean();
  assert.equal(ev.purpose, "booking");
  assert.equal(ev.reconcileStatus, "matched_appointment");

  // E5: webhook replay and a late browser verify.
  assert.equal((await webhook(paymentFor(appt))).body.booking, "already");
  const sig = crypto.createHmac("sha256", KEY_SECRET).update(`${appt.deposit.razorpayOrderId}|pay_${appt.ref}`).digest("hex");
  const verify = await call("POST", `/api/public/appointments/${appt.ref}/verify-payment`, {
    razorpay_order_id: appt.deposit.razorpayOrderId,
    razorpay_payment_id: `pay_${appt.ref}`,
    razorpay_signature: sig,
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.outcome, "already");
  assert.equal(verify.body.booking.status, "confirmed");

  const sends = await NotificationLog.find({ appointmentId: appt._id }).lean();
  assert.equal(sends.length, 1, "one confirmation however many times payment is reported");
  assert.equal(sends[0].status, "sent");
  const msg = watiCalls.find((c) => c.body.template_name === "booking_confirmed_v1");
  assert.ok(msg.body.parameters.find((p) => p.name === "link").value.startsWith("https://www.example.test/booking/"));
});

test("verify-payment confirms when the browser is first, and refuses a forged signature", async () => {
  const phone = "9876500011";
  const r = await call("POST", "/api/public/appointments", bookingBody(phone));
  const appt = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  const forged = await call("POST", `/api/public/appointments/${appt.ref}/verify-payment`, {
    razorpay_order_id: appt.deposit.razorpayOrderId, razorpay_payment_id: "pay_x", razorpay_signature: "00",
  });
  assert.equal(forged.body.error, "PAYMENT_INVALID");
  const sig = crypto.createHmac("sha256", KEY_SECRET).update(`${appt.deposit.razorpayOrderId}|pay_x`).digest("hex");
  const ok = await call("POST", `/api/public/appointments/${appt.ref}/verify-payment`, {
    razorpay_order_id: appt.deposit.razorpayOrderId, razorpay_payment_id: "pay_x", razorpay_signature: sig,
  });
  assert.equal(ok.body.outcome, "confirmed");
  assert.equal((await webhook(paymentFor(appt, "pay_x"))).body.booking, "already");
});

test("create refuses without a valid booking token, without policy consent, and with a price in the body", async () => {
  const phone = "9876500012";
  assert.equal((await call("POST", "/api/public/appointments", bookingBody(phone, { bookingToken: tokenFor("9876500099") }))).body.error, "OTP_EXPIRED");
  assert.equal((await call("POST", "/api/public/appointments", bookingBody(phone, { policyAccepted: false }))).status, 400);
  assert.equal((await call("POST", "/api/public/appointments", { ...bookingBody(phone), total: 1 })).status, 400);
});

test("E6: the booking keeps its price and duration snapshot when the owner edits the service", async () => {
  const r = await call("POST", "/api/public/appointments", bookingBody("9876500013"));
  await Service.updateOne({ _id: ids.cut }, { $set: { publicPrice: 900, durationMinutes: 90 } });
  const appt = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  assert.equal(appt.guests[0].items[0].publicPrice, 500);
  assert.equal(appt.guests[0].items[0].listPrice, 1000);
  assert.equal(appt.guests[0].items[0].durationMin, 45);
});

// ─── Concurrency and limits ──────────────────────────────────────────────────

test("E1: 50 parallel bookings for the only artist's 11:00 → exactly one wins, the rest get SLOT_TAKEN + alternatives", async () => {
  const selection = await selectionOf([ids.cut]);
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      booking.createBooking({
        phone: `98765${String(10000 + i).slice(-5)}`,
        name: `Guest ${i}`,
        selection,
        startAt: at("11:00"),
        paymentKind: "full",
      })
    )
  );
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.ok(lost.every((r) => r.reason.code === "SLOT_TAKEN"), lost.map((r) => r.reason.message).join("; "));
  assert.ok(lost[0].reason.alternatives.length > 0);
  assert.equal(await SlotLock.countDocuments({ blockStart: new Date(at("11:00")) }), 1);
});

test("E11 / E12: a 4th open booking and an overlapping time are refused for the same phone", async () => {
  const phone = "9876500020";
  const selection = await selectionOf([ids.cut]);
  await booking.createBooking({ phone, name: "Asha", selection, startAt: at("10:00"), paymentKind: "full" });
  await assert.rejects(
    booking.createBooking({ phone, name: "Asha", selection: await booking.prepareSelection([{ services: [ids.facial] }]), startAt: at("10:30"), paymentKind: "full" }),
    (e) => e.code === "SLOT_TAKEN" || e.code === "OVERLAP"
  );
  await booking.createBooking({ phone, name: "Asha", selection, startAt: at("13:00"), paymentKind: "full" });
  await booking.createBooking({ phone, name: "Asha", selection, startAt: at("15:00"), paymentKind: "full" });
  await assert.rejects(
    booking.createBooking({ phone, name: "Asha", selection, startAt: at("17:00"), paymentKind: "full" }),
    (e) => e.code === "LIMIT_REACHED"
  );
});

test("E12: overlap with the same phone's booking on another artist is refused", async () => {
  await Artist.create({ name: "Second", phone: "9888800003", gender: "female", onlineBookable: true });
  const phone = "9876500021";
  await booking.createBooking({ phone, name: "Asha", selection: await selectionOf([ids.cut]), startAt: at("12:00"), paymentKind: "full" });
  await assert.rejects(
    booking.createBooking({ phone, name: "Asha", selection: await selectionOf([ids.facial]), startAt: at("12:15"), paymentKind: "full" }),
    (e) => e.code === "OVERLAP"
  );
});

test("E19: an expired hold the TTL monitor hasn't removed yet doesn't block a new booking", async () => {
  await SlotLock.create({
    kind: "artist", artistId: ids.mansi, blockStart: new Date(at("16:00")), state: "hold",
    expiresAt: new Date(Date.now() - 60_000), appointmentId: null,
  });
  const out = await booking.createBooking({ phone: "9876500030", name: "Asha", selection: await selectionOf([ids.cut]), startAt: at("16:00"), paymentKind: "full" });
  assert.equal(out.appt.status, "pending_payment");
});

// ─── Hold expiry and late payments ───────────────────────────────────────────

async function lapse(apptId) {
  const past = new Date(Date.now() - 20 * 60_000);
  await Appointment.updateOne({ _id: apptId }, { $set: { holdExpiresAt: past } });
  await SlotLock.updateMany({ appointmentId: apptId }, { $set: { expiresAt: past } });
}

test("expiry: an unpaid hold past its time is expired and its time is free again", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500040", name: "Asha", selection: await selectionOf([ids.cut]), startAt: at("11:00"), paymentKind: "full" });
  await lapse(appt._id);
  const out = await booking.expireBookings();
  assert.equal(out.holdsExpired, 1);
  assert.equal((await Appointment.findById(appt._id).lean()).status, "expired");
  assert.equal(await SlotLock.countDocuments({ appointmentId: appt._id }), 0);
  assert.equal((await booking.expireBookings()).holdsExpired, 0, "idempotent");
});

test("expiry asks Razorpay first: a captured payment with a slow webhook is confirmed, not expired", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500041", name: "Asha", selection: await selectionOf([ids.cut]), startAt: at("11:00"), paymentKind: "full" });
  await lapse(appt._id);
  capturedByOrder.set(appt.deposit.razorpayOrderId, [{ id: "pay_late", status: "captured", amount: 50000 }]);
  const out = await booking.expireBookings();
  assert.equal(out.paidLate, 1);
  assert.equal((await Appointment.findById(appt._id).lean()).status, "confirmed");
});

test("E3: paid after the hold expired, slot still free → confirmed with the same blocks", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500042", name: "Asha", selection: await selectionOf([ids.cut]), startAt: at("11:00"), paymentKind: "full" });
  await lapse(appt._id);
  await booking.expireBookings(); // expired, locks deleted
  const fresh = await Appointment.findById(appt._id).lean();
  const hook = await webhook(paymentFor(fresh));
  assert.equal(hook.body.booking, "confirmed");
  const locks = await SlotLock.find({ appointmentId: appt._id }).lean();
  assert.equal(locks.length, 3);
  assert.ok(locks.every((l) => l.state === "firm"));
});

test("E4: paid after the hold expired and someone else took the slot → cancelled by system, full refund sent automatically", async () => {
  const selection = await selectionOf([ids.cut]);
  const { appt } = await booking.createBooking({ phone: "9876500043", name: "Asha", selection, startAt: at("11:00"), paymentKind: "full" });
  await lapse(appt._id);
  const other = await booking.createBooking({ phone: "9876500044", name: "Bina", selection, startAt: at("11:00"), paymentKind: "full" });
  assert.equal(other.appt.status, "pending_payment");

  const hook = await webhook(paymentFor(await Appointment.findById(appt._id).lean()));
  assert.equal(hook.body.booking, "refund_queued");
  const lost = await Appointment.findById(appt._id).lean();
  assert.equal(lost.status, "cancelled");
  assert.equal(lost.cancelledBy, "system");
  assert.equal(lost.cancelReason, "paid_after_hold_expired");
  assert.equal(lost.deposit.status, "refunded");
  assert.equal(lost.refund.status, "processed", "the salon's doing, nothing to judge: sent at once");
  assert.equal(lost.refund.amount, 500);
  assert.equal(refundsSent.length, 1);
  assert.equal(refundsSent[0].amount, 50000);
  assert.equal(await SlotLock.countDocuments({ appointmentId: appt._id }), 0);
  assert.equal(await SlotLock.countDocuments({ appointmentId: other.appt._id }), 3, "the winner keeps the time");
  assert.equal((await webhook(paymentFor(lost))).body.booking, "already");
});

// ─── Requests and the salon side ─────────────────────────────────────────────

/**
 * D49: the engine no longer creates requests, but ones made before it changed
 * (and the approve/expire code that serves them) still exist. Turn a confirmed
 * booking into such a legacy request.
 */
async function makeLegacyRequest(id, expiresAt = new Date(Date.now() + 2 * 3600e3)) {
  await Appointment.updateOne({ _id: id }, { $set: { status: "requested", mode: "request", requestExpiresAt: expiresAt } });
  await SlotLock.updateMany({ appointmentId: id }, { $set: { state: "hold", expiresAt } });
}

test("D49: colour and every other service books instantly — paid → confirmed, firm locks, same rules", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500050", name: "Asha", selection: await selectionOf([ids.colour]), startAt: at("12:00"), paymentKind: "deposit" });
  assert.equal(appt.mode, "instant");
  assert.equal(appt.deposit.amount, 900, "30% of ₹3,000");
  const hook = await webhook(paymentFor(appt));
  assert.equal(hook.body.booking, "confirmed");
  const done = await Appointment.findById(appt._id).lean();
  assert.equal(done.status, "confirmed");
  assert.equal(done.requestExpiresAt, null);
  const locks = await SlotLock.find({ appointmentId: appt._id }).lean();
  assert.equal(locks.length, 6);
  assert.ok(locks.every((l) => l.state === "firm"));
  const q = await call("POST", "/api/public/quote", { guests: [{ for: "her", services: [ids.colour] }] });
  assert.equal(q.body.mode, "instant");
  assert.equal(q.body.payment.noticeHours, 24, "one notice window for every service");
});

test("legacy requests (made before D49) can still be approved by staff", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500054", name: "Asha", selection: await selectionOf([ids.colour]), startAt: at("12:00"), paymentKind: "deposit" });
  await webhook(paymentFor(appt));
  await makeLegacyRequest(appt._id);
  const ok = await booking.approveRequest(appt._id, { by: "Reception" });
  assert.equal(ok.ok, true);
  assert.equal(ok.appt.status, "confirmed");
  assert.ok((await SlotLock.find({ appointmentId: appt._id }).lean()).every((l) => l.state === "firm"));
  assert.equal((await booking.approveRequest(appt._id)).error, "CONFLICT", "second approve loses");
});

test("salon decline/cancel frees the time and refunds in FULL automatically (D18, D45)", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500051", name: "Asha", selection: await selectionOf([ids.cut, ids.facial]), startAt: at("14:00"), paymentKind: "full" });
  await webhook(paymentFor(appt));
  const out = await booking.releaseBySalon(appt._id, { from: "confirmed", to: "cancelled", reason: "artist ill", by: "Owner" });
  assert.equal(out.ok, true);
  assert.equal(out.appt.refund.amount, 2000);
  assert.equal(out.appt.refund.status, "processed");
  assert.equal(out.appt.deposit.status, "refunded");
  assert.equal(refundsSent.length, 1);
  assert.equal(out.appt.cancelledBy, "salon");
  assert.equal(await SlotLock.countDocuments({ appointmentId: appt._id }), 0);
  const again = await booking.createBooking({ phone: "9876500052", name: "Bina", selection: await selectionOf([ids.cut]), startAt: at("14:00"), paymentKind: "full" });
  assert.equal(again.appt.status, "pending_payment", "time is sellable again");
});

test("an unanswered legacy request past its approval window → expired by the cron with a full refund", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500053", name: "Asha", selection: await selectionOf([ids.colour]), startAt: at("12:00"), paymentKind: "full" });
  await webhook(paymentFor(appt));
  await makeLegacyRequest(appt._id, new Date(Date.now() - 1000));
  const out = await booking.expireBookings();
  assert.equal(out.requestsExpired, 1);
  const done = await Appointment.findById(appt._id).lean();
  assert.equal(done.status, "expired");
  assert.equal(done.refund.amount, 3000);
  assert.equal(done.refund.status, "processed");
  assert.equal(await SlotLock.countDocuments({ appointmentId: appt._id }), 0);
});

test("auto refund: a Razorpay failure stays queued, the tick retries it, then stops after 3 and leaves it to the owner", async () => {
  const { appt } = await booking.createBooking({ phone: "9876500061", name: "Asha", selection: await selectionOf([ids.cut]), startAt: at("15:00"), paymentKind: "full" });
  await webhook(paymentFor(appt));
  refundFails = true;
  const out = await booking.releaseBySalon(appt._id, { from: "confirmed", to: "cancelled", reason: "power cut", by: "Owner" });
  assert.equal(out.ok, true, "the cancellation itself never fails because the refund did");
  let row = await Appointment.findById(appt._id).lean();
  assert.equal(row.refund.status, "failed");
  assert.equal(row.refund.attempts, 1);
  assert.match(row.refund.error, /Insufficient balance/);

  const old = new Date(Date.now() - 10 * 60_000);
  await Appointment.updateOne({ _id: appt._id }, { $set: { "refund.requestedAt": old } });
  await booking.retryAutoRefunds(); // fails again
  await booking.retryAutoRefunds(); // and again
  row = await Appointment.findById(appt._id).lean();
  assert.equal(row.refund.attempts, 3);
  await booking.retryAutoRefunds();
  assert.equal((await Appointment.findById(appt._id).lean()).refund.attempts, 3, "gives up after 3: the owner decides");

  refundFails = false;
  assert.equal((await booking.sendRefund(appt._id)).ok, true, "the owner's Send still works");
  assert.equal(refundsSent.length, 1);
});

test("auto refund: customer cancellations and no-shows always wait for the owner; the switch turns automatic refunds off", async () => {
  const mine = await booking.createBooking({ phone: "9876500062", name: "Asha", selection: await selectionOf([ids.cut, ids.facial]), startAt: at("11:00"), paymentKind: "full" });
  await webhook(paymentFor(mine.appt));
  const c = await booking.cancelByCustomer(await Appointment.findById(mine.appt._id).lean());
  assert.equal(c.ok, true);
  assert.equal(c.appt.refund.status, "pending", "customer side: manual review");
  assert.equal(refundsSent.length, 0);
  await booking.retryAutoRefunds();
  assert.equal(refundsSent.length, 0, "the tick never touches customer refunds");

  const SiteSettings = require("../models/SiteSettings");
  await SiteSettings.updateOne({}, { $set: { autoRefundSalonSide: false } });
  const other = await booking.createBooking({ phone: "9876500063", name: "Bina", selection: await selectionOf([ids.cut]), startAt: at("16:00"), paymentKind: "full" });
  await webhook(paymentFor(other.appt));
  const s = await booking.releaseBySalon(other.appt._id, { from: "confirmed", to: "cancelled", reason: "x", by: "Owner" });
  assert.equal(s.appt.refund.status, "pending", "switch off → everything waits for the owner");
  assert.equal(refundsSent.length, 0);
});

test("customer record: created inside the booking, consent only when ticked", async () => {
  await call("POST", "/api/public/appointments", bookingBody("9876500060", { whatsappOptIn: true }));
  await call("POST", "/api/public/appointments", bookingBody("9876500061", { startAt: at("13:00") }));
  const yes = await Customer.findOne({ phone: "9876500060" }).lean();
  const no = await Customer.findOne({ phone: "9876500061" }).lean();
  assert.equal(yes.marketing.whatsappOptIn, true);
  assert.equal(no.marketing?.whatsappOptIn ?? false, false);
  assert.equal(yes.createdFrom, "web");
});

test("addWorkingMinutes counts opening hours only (SLA across the Tuesday off)", () => {
  const settings = { openingHours: { mon: [{ open: "09:00", close: "21:00" }], tue: [], wed: [{ open: "09:00", close: "21:00" }] }, holidays: [] };
  // Find a Monday.
  let d = time.salonDate();
  while (time.weekdayKey(d) !== "mon") d = time.addDays(d, 1);
  const from = time.salonInstant(d, "20:00");
  const end = time.addWorkingMinutes(settings, from, 120);
  assert.equal(end.toISOString(), time.salonInstant(time.addDays(d, 2), "10:00").toISOString());
});

// ─── Manage link (§9, T2.11) ─────────────────────────────────────────────────

async function paidBooking(phone, hhmm, services = [ids.cut]) {
  const r = await call("POST", "/api/public/appointments", bookingBody(phone, { guests: [{ for: "her", services }], startAt: at(hhmm) }));
  const appt = await Appointment.findOne({ ref: r.body.booking.ref }).lean();
  await webhook(paymentFor(appt));
  return { token: r.body.manageToken, appt: await Appointment.findById(appt._id).lean() };
}

test("manage link: view shows the booking, rules and fee; unknown links 404; calendar file", async () => {
  const { token, appt } = await paidBooking("9876500070", "11:00", [ids.cut, ids.facial]);
  const v = await call("GET", `/api/public/booking/${token}`);
  assert.equal(v.status, 200);
  assertPublicOnly(v.body);
  assert.equal(v.body.booking.ref, appt.ref);
  assert.equal(v.body.rules.canCancel, true);
  assert.equal(v.body.rules.canReschedule, true);
  assert.deepEqual(v.body.rules.cancel, { refund: 2000, kept: 0 }, "more than 24h ahead: free");
  await soonish(appt._id);
  const late = await call("GET", `/api/public/booking/${token}`);
  assert.deepEqual(late.body.rules.cancel, { refund: 1400, kept: 600 }, "inside 24h: 30% of ₹2,000 kept");
  assert.equal(late.body.rules.canReschedule, false, "moving is free only until the notice period too");
  assert.equal(v.body.phoneHint.endsWith("70"), true);
  assert.ok(!JSON.stringify(v.body).includes("9876500070"), "full phone never returned");

  assert.equal((await call("GET", `/api/public/booking/${"x".repeat(43)}`)).status, 404);
  const ics = await fetch(`${base}/api/public/booking/${token}/calendar.ics`, { headers: { "x-forwarded-for": ip } });
  const text = await ics.text();
  assert.match(text, /BEGIN:VEVENT/);
  assert.match(text, new RegExp(`UID:${appt.ref}@`));
});

test("manage link: reschedule moves the locks and keeps the payment; limited to maxOnlineReschedules", async () => {
  const { token, appt } = await paidBooking("9876500071", "11:00");
  const free = await call("GET", `/api/public/booking/${token}/availability?date=${DATE}`);
  assert.ok(free.body.slots.some((s) => s.time === "11:00"), "own time counts as free when moving");

  const r1 = await call("POST", `/api/public/booking/${token}/reschedule`, { startAt: at("15:00") });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const moved = await Appointment.findById(appt._id).lean();
  assert.equal(new Date(moved.startAt).toISOString(), at("15:00"));
  assert.equal(moved.deposit.status, "paid");
  assert.equal(moved.rescheduleCount, 1);
  assert.equal(await SlotLock.countDocuments({ appointmentId: appt._id, blockStart: new Date(at("15:00")) }), 1);
  assert.equal(await SlotLock.countDocuments({ blockStart: new Date(at("11:00")) }), 0);

  assert.equal((await call("POST", `/api/public/booking/${token}/reschedule`, { startAt: at("16:00") })).status, 200);
  const third = await call("POST", `/api/public/booking/${token}/reschedule`, { startAt: at("17:00") });
  assert.equal(third.status, 409);
});

test("manage link: cancelling early is free; cancelling late keeps 30% and queues the rest for review", async () => {
  const early = await paidBooking("9876500074", "12:00", [ids.cut, ids.facial]);
  const free = await call("POST", `/api/public/booking/${early.token}/cancel`, {});
  assert.deepEqual(free.body.refund, { amount: 2000, status: "pending" }, "everything back, still reviewed by the owner");
  assert.equal(refundsSent.length, 0, "customer-side refunds are never automatic");

  const { token, appt } = await paidBooking("9876500072", "13:00", [ids.cut, ids.facial]);
  await soonish(appt._id);
  const r = await call("POST", `/api/public/booking/${token}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.booking.status, "cancelled");
  assert.deepEqual(r.body.refund, { amount: 1400, status: "pending" }, "₹2,000 − 30%");
  const done = await Appointment.findById(appt._id).lean();
  assert.equal(done.cancelledBy, "customer");
  assert.equal(await SlotLock.countDocuments({ appointmentId: appt._id }), 0);
  assert.equal((await call("POST", `/api/public/booking/${token}/cancel`, {})).status, 409);
});

test("manage link: a link older than a day needs a fresh WhatsApp code to cancel", async () => {
  const { token, appt } = await paidBooking("9876500073", "13:00");
  await Appointment.collection.updateOne({ _id: appt._id }, { $set: { createdAt: new Date(Date.now() - 25 * 3600e3) } });
  const r = await call("POST", `/api/public/booking/${token}/cancel`, {});
  assert.equal(r.body.error, "OTP_REQUIRED");
  const ok = await call("POST", `/api/public/booking/${token}/cancel`, { bookingToken: tokenFor("9876500073") });
  assert.equal(ok.status, 200);
});
