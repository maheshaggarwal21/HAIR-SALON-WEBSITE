/**
 * @file test/helpers/db.js
 * @description Throwaway MongoDB for tests — a single-node REPLICA SET, not a
 * standalone server.
 *
 * ── Why a replica set ─────────────────────────────────────────────────────────
 * The booking engine confirms appointments inside `session.withTransaction`, and
 * the SlotLock unique index aborting that transaction is the thing that stops a
 * double booking (CONTROL_FLOW_AND_DATA_LOGIC.md §5.1). MongoDB only supports
 * transactions on a replica set. A standalone in-memory server would make every
 * transaction test throw "Transaction numbers are only allowed on a replica set
 * member" — or worse, tempt someone to test the logic without the transaction.
 *
 * ── Why it goes through ../../db.js ───────────────────────────────────────────
 * Routes call the real connectDB() singleton. Pointing MONGODB_URI at the
 * in-memory server and connecting through the same function means tests run the
 * exact connection code production runs, instead of a parallel test-only path.
 *
 * Never point this at Atlas: stopDb() drops the database.
 */

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let replSet = null;

async function startDb() {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replSet.getUri("salon-test");

  const connectDB = require("../../db");
  await connectDB();

  // Mongoose builds indexes in the background on first model use. Tests that
  // depend on a unique index must not race that build, so wait for every
  // registered model's indexes before handing over.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}

async function stopDb() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  replSet = null;
}

/** Empty every collection but keep indexes — cheaper than a fresh server per test. */
async function clearDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

module.exports = { startDb, stopDb, clearDb };
