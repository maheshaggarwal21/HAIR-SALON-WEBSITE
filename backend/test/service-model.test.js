/**
 * @file test/service-model.test.js
 * @description T1.1 — the public layer on Service must not disturb the 182
 * existing catalogue rows or the staff flows that create and edit them.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Service = require("../models/Service");
const { startDb, stopDb, clearDb } = require("./helpers/db");

before(startDb);
after(stopDb);
beforeEach(clearDb);

test("a service shaped like today's staff-app rows still saves, hidden from the site", async () => {
  const s = await Service.create({ name: "Haircut (Men)", price: 300, category: "Hair" });
  assert.equal(s.showOnWebsite, false);
  assert.equal(s.bookingMode, "hidden");
  assert.equal(s.publicPrice, null);
  assert.equal(s.slug, undefined);
});

test("many services without a slug do not collide on the unique slug index", async () => {
  await Service.create([
    { name: "A", price: 1 },
    { name: "B", price: 2 },
    { name: "C", price: 3 },
  ]);
  assert.equal(await Service.countDocuments(), 3);
});

test("a duplicate slug is rejected", async () => {
  await Service.create({ name: "Keratin (Women) Medium", price: 6000, slug: "keratin-medium" });
  await assert.rejects(
    Service.create({ name: "Keratin Medium copy", price: 6000, slug: "keratin-medium" }),
    { code: 11000 }
  );
});

test("instant booking without a duration is rejected", async () => {
  await assert.rejects(
    Service.create({ name: "Facial", price: 1000, bookingMode: "instant" }),
    /Instant booking needs durationMinutes/
  );
  await Service.create({ name: "Facial", price: 1000, bookingMode: "instant", durationMinutes: 60 });
});

test("consultation forces request mode", async () => {
  const s = await Service.create({
    name: "Bridal Makeup",
    price: 20000,
    durationMinutes: 180,
    bookingMode: "instant",
    requiresConsultation: true,
  });
  assert.equal(s.effectiveBookingMode(), "request");
});

test("audience and displayCategory only accept known values", async () => {
  await assert.rejects(Service.create({ name: "X", price: 1, audience: "women" }));
  await assert.rejects(Service.create({ name: "Y", price: 1, displayCategory: "Hairs" }));
});

test("performanceDuration: only an owner-confirmed time reaches artist time-performance", () => {
  assert.equal(Service.performanceDuration({ durationMinutes: 45, durationConfirmed: true }), 45);
  assert.equal(Service.performanceDuration({ durationMinutes: 60, durationConfirmed: false }), null);
  // Lean doc written before the flag existed.
  assert.equal(Service.performanceDuration({ durationMinutes: 30 }), null);
  assert.equal(Service.performanceDuration({ durationMinutes: null, durationConfirmed: true }), null);
  assert.equal(Service.performanceDuration(null), null);
});
