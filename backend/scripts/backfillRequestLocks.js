/**
 * @file backfillRequestLocks.js
 * @description Creates the slot locks that confirmed FUTURE requests should have had
 * (audit item 3). DRY RUN BY DEFAULT: it writes only with an explicit --apply.
 *
 *     node scripts/backfillRequestLocks.js            # dry run: says what it would do
 *     node scripts/backfillRequestLocks.js --apply    # writes
 *
 * For each confirmed future request with no locks it works out the same plan as a new
 * confirm (utils/booking.js planRequestTime: a package's whole time, otherwise the
 * services' own times) for the artist already on the request, and takes the locks in one
 * transaction per request. Then:
 *   - NO ARTIST on the request          → skipped and listed (assign one first);
 *   - package with no time / no services → skipped and listed (nothing to lock);
 *   - someone else holds part of the time → skipped and listed with who (sort out by hand);
 *   - several different artists on it    → skipped and listed.
 * It never changes a request's status and never touches one that already has locks.
 * Re-running is safe: a request that now has locks is no longer a candidate.
 *
 * Applying also rewrites the items' times to the plan, so that a later move keeps the
 * whole duration. Run scripts/reportUnlockedRequests.js first and read it.
 */

require("dotenv").config();
const mongoose = require("mongoose");

/**
 * @param {{apply?: boolean, now?: Date}} [opts]
 * @returns {Promise<{wouldLock: object[], locked: object[], skipped: object[]}>}
 */
async function backfill({ apply = false, now = new Date() } = {}) {
  const Appointment = require("../models/Appointment");
  const SlotLock = require("../models/SlotLock");
  const booking = require("../utils/booking");
  const { findUnlocked } = require("./reportUnlockedRequests");

  const out = { wouldLock: [], locked: [], skipped: [] };
  for (const row of await findUnlocked(now)) {
    const brief = { ref: row.ref, name: row.name, startAt: row.startAt };
    const appt = await Appointment.findOne({ ref: row.ref, status: "confirmed" }).lean();
    if (!appt) continue;
    const artistIds = [...new Set(appt.guests.flatMap((g) => g.items.map((i) => (i.artistId ? String(i.artistId) : null))))];
    if (artistIds.length !== 1 || artistIds[0] === null) {
      out.skipped.push({ ...brief, reason: artistIds.includes(null) && artistIds.length === 1 ? "no artist" : "no artist or more than one artist" });
      continue;
    }
    const artist = { _id: new mongoose.Types.ObjectId(artistIds[0]), name: appt.guests.flatMap((g) => g.items).find((i) => i.artistName)?.artistName || "the artist" };
    const plan = booking.planRequestTime(appt, artist, new Date(appt.startAt).getTime());
    if (!plan.lock.taken) {
      out.skipped.push({ ...brief, reason: plan.lock.warning });
      continue;
    }
    const draft = { ...appt, guests: plan.guests, startAt: plan.startAt, endAt: plan.endAt };

    if (!apply) {
      const docs = booking.lockDocsFor(draft, { state: "firm", expiresAt: null }).filter((d) => d.kind === "artist");
      const taken = await SlotLock.find({ kind: "artist", artistId: artist._id, blockStart: { $in: docs.map((d) => d.blockStart) } }).lean();
      if (taken.length) out.skipped.push({ ...brief, reason: `${artist.name} is already booked in that time (${taken.length} block(s))` });
      else out.wouldLock.push({ ...brief, artist: artist.name, blocks: docs.length });
      continue;
    }

    const session = await mongoose.startSession();
    try {
      let blocks = 0;
      let blockedBy = 0;
      await session.withTransaction(async () => {
        blocks = 0;
        blockedBy = 0;
        const cur = await Appointment.findOne({ _id: appt._id, status: "confirmed" }, null, { session }).lean();
        if (!cur) return;
        const r = await booking.takePlannedLocks(draft, plan, artist, session, now);
        if (r.taken.length) { blockedBy = r.taken.length; return; }
        blocks = r.blocks;
        await Appointment.updateOne({ _id: appt._id }, { $set: { guests: plan.guests, startAt: plan.startAt, endAt: plan.endAt } }, { session });
      });
      if (blockedBy) out.skipped.push({ ...brief, reason: `${artist.name} is already booked in that time (${blockedBy} block(s))` });
      else if (blocks) out.locked.push({ ...brief, artist: artist.name, blocks });
    } catch (err) {
      out.skipped.push({ ...brief, reason: `could not lock: ${err.message}` });
    } finally {
      await session.endSession();
    }
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  await require("../db")();
  const out = await backfill({ apply });
  console.log(apply ? "APPLIED" : "DRY RUN (nothing written; add --apply to write)");
  if (!apply) console.log("\nWould lock:"), console.table(out.wouldLock);
  else console.log("\nLocked:"), console.table(out.locked);
  console.log("\nSkipped (sort out by hand):");
  console.table(out.skipped);
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

module.exports = { backfill };
