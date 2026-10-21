/**
 * @file test/morning.test.js
 * @description The 08:15 morning push (D56): each artist's WhatsApp day sheet
 * and the owner's Telegram summary.
 *
 * Telegram is replaced by a recorder and WhatsApp runs in its development mode
 * (every message is logged to NotificationLog); nothing leaves the machine.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let Appointment, Artist, Service, User, NotificationLog, SiteSettings, time, telegram, morning;
let server;
let base;
let sent = [];
let telegramOk = true;

before(async () => {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "x", PUBLIC_TOKEN_SECRET: "t", META_WA_TOKEN: "", META_WA_PHONE_NUMBER_ID: "" });
  await startDb();
  Appointment = require("../models/Appointment");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  User = require("../models/User");
  NotificationLog = require("../models/NotificationLog");
  SiteSettings = require("../models/SiteSettings");
  time = require("../utils/time");
  telegram = require("../utils/telegram");
  telegram.isConfigured = () => true;
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return telegramOk ? { ok: true } : { ok: false, description: "chat not found" };
  };
  morning = require("../utils/morning");

  const app = express();
  app.use(express.json());
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
  await stopDb();
});

let ids;
let DATE;
const at = (hhmm) => time.salonInstant(DATE, hhmm).toISOString();
const morningOf = () => time.salonInstant(DATE, "08:15");

function bookableDate() {
  let d = time.addDays(time.salonDate(), 2);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  return d;
}

beforeEach(async () => {
  await clearDb();
  sent = [];
  telegramOk = true;
  DATE = bookableDate();
  const svc = await Service.create({ name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", audience: "her", displayCategory: "Hair", durationMinutes: 45, isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true });
  const [mansi, ravi] = await Artist.create([
    { name: "Mansi Kaur", phone: "9888800001", gender: "female" },
    { name: "Ravi", phone: "9888800002", gender: "male" },
  ]);
  // Old records can hold a number that today's validation would refuse; write one around it.
  const lata = (await Artist.collection.insertOne({ name: "Lata", phone: "123", gender: "female", isActive: true, commission: { type: "percentage", value: 0 }, createdAt: new Date(), updatedAt: new Date() })).insertedId;
  ids = { svc: String(svc._id), mansi: String(mansi._id), ravi: String(ravi._id), lata: String(lata) };
  await User.collection.insertOne({ name: "Owner", email: "o@example.com", role: "owner", isActive: true, permissions: [], telegramChatId: "555" });
});

async function book(name, phone, artistId, hhmm) {
  const res = await fetch(`${base}/bookings/staff`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, phone, for: "her", serviceIds: [ids.svc], startAt: at(hhmm), artistId }) });
  assert.equal(res.status, 201, await res.text());
}

test("an artist with bookings gets one day sheet; one with none gets nothing", async () => {
  await book("Sita Devi", "9876500031", ids.mansi, "11:00");
  await book("Kamla", "9876500030", ids.mansi, "15:00");

  const out = await morning.morningRun(morningOf());
  // WhatsApp is not configured in tests, so the one message is logged but not delivered.
  assert.equal(out.artistsMessaged + out.artistsNotSent, 1);

  const rows = await NotificationLog.find({ type: "artist_day_sheet" }).lean();
  assert.equal(rows.length, 1, "Ravi has no clients, so no message");
  assert.equal(rows[0].to, "9888800001");
  assert.equal(rows[0].params.name, "Mansi");
  assert.equal(rows[0].params.count, 2);
  assert.match(rows[0].params.list, /11:00am Sita \(Haircut Women\) \| 3:00pm Kamla/);
  assert.ok(!JSON.stringify(rows[0].params).includes("987650003"), "no client phone numbers in the artist's message");
});

test("running it twice sends nothing the second time", async () => {
  await book("Sita Devi", "9876500031", ids.mansi, "11:00");
  await morning.morningRun(morningOf());
  const first = { artists: await NotificationLog.countDocuments({ type: "artist_day_sheet" }), telegram: sent.length };
  const second = await morning.morningRun(morningOf());

  assert.equal(await NotificationLog.countDocuments({ type: "artist_day_sheet" }), first.artists);
  assert.equal(sent.length, first.telegram);
  assert.equal(second.ownerSummaries, 0);
  assert.equal(first.telegram, 1);
});

test("the owner's summary counts the bookings and what is waiting", async () => {
  await book("Sita Devi", "9876500031", ids.mansi, "11:00");
  await book("Gita", "9876500032", ids.ravi, "16:30");
  await morning.morningRun(morningOf());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "555");
  assert.match(sent[0].text, /2 bookings today \(0 from the website\), 11:00am to 4:30pm/);
  assert.doesNotMatch(sent[0].text, /refund/);
});

test("a refund still owed is listed in the owner's summary", async () => {
  await book("Sita Devi", "9876500031", ids.mansi, "11:00");
  await Appointment.updateOne({ name: "Sita Devi" }, { $set: { "refund.status": "pending", "refund.amount": 350 } });
  await morning.morningRun(morningOf());
  assert.match(sent[0].text, /1 refund owed \(₹350\)/);
});

test("if Telegram refuses, the next call sends the summary again", async () => {
  await book("Sita Devi", "9876500031", ids.mansi, "11:00");
  telegramOk = false;
  assert.equal((await morning.morningRun(morningOf())).ownerSummaries, 0);
  assert.equal((await NotificationLog.findOne({ type: "owner_morning" })).status, "failed");

  telegramOk = true;
  assert.equal((await morning.morningRun(morningOf())).ownerSummaries, 1);
  assert.equal((await NotificationLog.findOne({ type: "owner_morning" })).status, "sent");
  assert.equal((await morning.morningRun(morningOf())).ownerSummaries, 0, "and then it stays done");
});

test("an artist with no usable phone number is skipped, not an error", async () => {
  await book("Sita Devi", "9876500031", ids.lata, "11:00");
  const out = await morning.morningRun(morningOf());
  assert.equal(out.artistsMessaged, 0);
  assert.equal(out.artistsWithoutNumber, 1);
  assert.equal(await NotificationLog.countDocuments({ type: "artist_day_sheet" }), 0);
});

test("nothing is sent on a day the salon is closed", async () => {
  const closedDay = (() => {
    let d = time.addDays(time.salonDate(), 1);
    while (time.weekdayKey(d) !== "tue") d = time.addDays(d, 1);
    return d;
  })();
  const out = await morning.morningRun(time.salonInstant(closedDay, "08:15"));
  assert.equal(out.closed, true);
  assert.equal(sent.length, 0);
});
