/**
 * @file test/artist-day.test.js
 * @description The artist's own day sheet (D55): GET /api/artist-dashboard/my-day.
 *
 * What matters: an artist sees their own firm bookings and nobody else's, in
 * time order, with no phone number or money, and not the unpaid or unapproved
 * ones that may never happen.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let Appointment, Artist, Service, User, time;
let server;
let base;
let caller;

before(async () => {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "", META_WA_TOKEN: "", META_WA_PHONE_NUMBER_ID: "", PUBLIC_TOKEN_SECRET: "t" });
  await startDb();
  Appointment = require("../models/Appointment");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  User = require("../models/User");
  time = require("../utils/time");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/artist-dashboard", require("../routes/artistDashboard"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
let ids;
let DATE;
const at = (hhmm) => time.salonInstant(DATE, hhmm).toISOString();

function bookableDate() {
  let d = time.addDays(time.salonDate(), 2);
  while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1);
  return d;
}

beforeEach(async () => {
  await clearDb();
  DATE = bookableDate();
  const svc = await Service.create({ name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", audience: "her", displayCategory: "Hair", durationMinutes: 45, isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true });
  const mansiUser = new mongoose.Types.ObjectId();
  const raviUser = new mongoose.Types.ObjectId();
  const [mansi, ravi] = await Artist.create([
    { name: "Mansi", phone: "9888800001", gender: "female", userId: mansiUser },
    { name: "Ravi", phone: "9888800002", gender: "male", userId: raviUser },
  ]);
  ids = { svc: String(svc._id), mansi: String(mansi._id), ravi: String(ravi._id), mansiUser, raviUser };
  caller = OWNER;
});

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const book = (name, phone, artistId, hhmm) => call("POST", "/bookings/staff", { name, phone, for: "her", serviceIds: [ids.svc], startAt: at(hhmm), artistId });
const asArtist = (userId) => (caller = { userId, name: "Artist", role: "artist" });

test("an artist sees only their own bookings, in time order, with no phone or money", async () => {
  assert.equal((await book("Kamla", "9876500030", ids.mansi, "15:00")).status, 201);
  assert.equal((await book("Sita", "9876500031", ids.mansi, "11:00")).status, 201);
  assert.equal((await book("Gita", "9876500032", ids.ravi, "11:00")).status, 201);

  asArtist(ids.mansiUser);
  const { status, body } = await call("GET", `/artist-dashboard/my-day?date=${DATE}`);
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((i) => i.name), ["Sita", "Kamla"]);
  assert.equal(body.items[0].service, "Haircut Women");

  const text = JSON.stringify(body);
  assert.ok(!text.includes("9876500030") && !text.includes("9876500031"), "no client phone numbers");
  assert.ok(!text.includes("Gita"), "another artist's client");
  for (const i of body.items) {
    assert.equal(i.price, undefined);
    assert.equal(i.deposit, undefined);
    assert.equal(i.contact, undefined);
  }
});

test("a booking that is only a request or an unpaid hold is not on the sheet", async () => {
  await book("Kamla", "9876500030", ids.mansi, "11:00");
  await book("Sita", "9876500031", ids.mansi, "15:00");
  await Appointment.updateOne({ name: "Sita" }, { $set: { status: "pending_payment" } });

  asArtist(ids.mansiUser);
  const { body } = await call("GET", `/artist-dashboard/my-day?date=${DATE}`);
  assert.deepEqual(body.items.map((i) => i.name), ["Kamla"]);
});

test("a day with nothing booked is an empty sheet, and dates far away are refused", async () => {
  asArtist(ids.mansiUser);
  const empty = await call("GET", `/artist-dashboard/my-day?date=${DATE}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);

  assert.equal((await call("GET", "/artist-dashboard/my-day?date=2030-01-01")).status, 400);
  assert.equal((await call("GET", "/artist-dashboard/my-day?date=nonsense")).status, 400);
});

test("a login with no artist profile gets a clear answer, not someone else's day", async () => {
  asArtist(new mongoose.Types.ObjectId());
  assert.equal((await call("GET", `/artist-dashboard/my-day?date=${DATE}`)).status, 404);
});
