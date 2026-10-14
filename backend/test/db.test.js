/**
 * @file test/db.test.js
 * @description Proves the test database supports what the booking engine needs.
 *
 * Double-booking protection (CF §5.1, decision D4) rests on one MongoDB
 * behaviour: a duplicate-key error inside `withTransaction` aborts the WHOLE
 * transaction, so the appointment written earlier in it disappears too. If this
 * test ever fails, no SlotLock test built on top of it can be trusted.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

// Minimal stand-ins, local to this file, so the test does not depend on models
// that have not been built yet.
const Lock = mongoose.model(
  "TestLock",
  new mongoose.Schema({ artistId: String, blockStart: Date }).index(
    { artistId: 1, blockStart: 1 },
    { unique: true }
  )
);
const Booking = mongoose.model("TestBooking", new mongoose.Schema({ ref: String }));

before(startDb);
after(stopDb);
beforeEach(clearDb);

async function book(ref, artistId, blockStart) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Booking.create([{ ref }], { session });
      await Lock.create([{ artistId, blockStart }], { session });
    });
  } finally {
    await session.endSession();
  }
}

test("connects to a replica set (transactions available)", async () => {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.ok(hello.setName, "expected a replica set name");
});

test("duplicate lock aborts the whole transaction", async () => {
  const slot = new Date("2026-10-29T05:30:00Z"); // 11:00 IST
  await book("EXP-AAAAA", "artist-1", slot);

  await assert.rejects(book("EXP-BBBBB", "artist-1", slot), { code: 11000 });

  assert.equal(await Lock.countDocuments(), 1);
  // The losing booking must not survive its failed lock.
  assert.deepEqual((await Booking.find().lean()).map((b) => b.ref), ["EXP-AAAAA"]);
});
