/**
 * @file reportUnlockedRequests.js
 * @description READ-ONLY. Lists confirmed FUTURE requests that hold no slot lock, so
 * reception can sort them out (audit item 3).
 *
 * Before audit item 3, confirming a request only changed its status and times: no SlotLock
 * rows were written, so the website could sell the same artist at the same time, and a
 * request confirmed with no artist never showed in any artist's column on the Today board.
 * This lists every such request, and says which ones have NO ARTIST (reception must
 * assign one: move the booking to an artist on the Today board, or ask the customer).
 *
 * Run from backend/:   node scripts/reportUnlockedRequests.js
 * It writes nothing. To create the missing locks for requests that DO have an artist,
 * see scripts/backfillRequestLocks.js (dry run unless --apply).
 */

require("dotenv").config();
const mongoose = require("mongoose");

/**
 * @param {Date} [now]
 * @returns {Promise<{ref: string, name: string, contact: string, startAt: Date, status: string, package: string|null, hasArtist: boolean, artists: string[]}[]>}
 */
async function findUnlocked(now = new Date()) {
  const Appointment = require("../models/Appointment");
  const SlotLock = require("../models/SlotLock");
  const rows = await Appointment.find({ mode: "request", status: "confirmed", startAt: { $gt: now } }).sort({ startAt: 1 }).lean();
  const owning = new Set((await SlotLock.distinct("appointmentId", { appointmentId: { $in: rows.map((r) => r._id) } })).map(String));
  return rows
    .filter((a) => !owning.has(String(a._id)))
    .map((a) => {
      const items = a.guests.flatMap((g) => g.items);
      const artists = [...new Set(items.filter((i) => i.artistId).map((i) => i.artistName || String(i.artistId)))];
      return {
        ref: a.ref,
        name: a.name,
        contact: a.contact,
        status: a.status,
        startAt: a.startAt,
        package: a.source?.offerPackage?.name || null,
        hasArtist: artists.length > 0,
        artists,
      };
    });
}

async function main() {
  await require("../db")();
  const out = await findUnlocked();
  console.log(`\n${out.length} confirmed future request(s) without a slot lock:`);
  console.table(out.map((r) => ({ ...r, startAt: new Date(r.startAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), artists: r.artists.join(", ") })));
  const noArtist = out.filter((r) => !r.hasArtist);
  console.log(`${noArtist.length} of them have NO ARTIST — reception must assign one: ${noArtist.map((r) => r.ref).join(", ") || "none"}`);
  console.log("Read-only: nothing was changed.");
}

if (require.main === module) {
  main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error("Failed:", err.message);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { findUnlocked };
