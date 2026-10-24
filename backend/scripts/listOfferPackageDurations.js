/**
 * @file listOfferPackageDurations.js
 * @description READ-ONLY. Lists every offer-page package with the time it takes,
 * and every request that has already been made for one (audit item 3, Step A).
 *
 * Why: when reception confirms a package request, the artist's chair has to be
 * held for the package's WHOLE duration. That number lives in each package
 * (Campaign.page.packages[].durationMinutes), where the staff app's "Time
 * needed" box starts at 120 minutes and the server fills in 120 when nothing
 * was set. So a package never looks "empty" — it can be a guess. This script
 * shows which packages carry a number somebody actually stored and which are
 * running on the 120-minute assumption, so the owner can confirm real times.
 *
 * Run from backend/:   node scripts/listOfferPackageDurations.js
 * It never writes to the database.
 */

require("dotenv").config();
const mongoose = require("mongoose");

/**
 * @param {object[]} campaigns  lean Campaign documents (raw — defaults NOT applied)
 * @param {object[]} requests   lean Appointments with source.offerPackage
 * @returns {{packages: object[], requests: object[]}}
 */
function describePackages(campaigns, requests = []) {
  const packages = [];
  for (const c of campaigns) {
    for (const p of c.page?.packages || []) {
      const stored = Number.isFinite(p.durationMinutes);
      packages.push({
        campaign: c.name,
        dates: `${c.startDate} → ${c.endDate}`,
        active: c.active !== false,
        package: p.name,
        price: p.price,
        durationMinutes: stored ? p.durationMinutes : null,
        status: stored ? "stored" : "NOT STORED (the system assumes 120)",
      });
    }
  }
  const reqs = requests.map((a) => ({
    ref: a.ref,
    status: a.status,
    package: a.source?.offerPackage?.name || null,
    durationMinutes: Number.isFinite(a.source?.offerPackage?.durationMinutes) ? a.source.offerPackage.durationMinutes : null,
    startAt: a.startAt || null,
    hasArtist: (a.guests || []).some((g) => (g.items || []).some((i) => i.artistId)),
  }));
  return { packages, requests: reqs };
}

async function main() {
  const connectDB = require("../db");
  await connectDB();
  const Campaign = require("../models/Campaign");
  const Appointment = require("../models/Appointment");
  const campaigns = await Campaign.collection.find({ "page.packages.0": { $exists: true } }).toArray();
  const requests = await Appointment.find({ "source.offerPackage.name": { $exists: true } }, { ref: 1, status: 1, startAt: 1, source: 1, guests: 1 }).lean();
  const out = describePackages(campaigns, requests);
  console.log("\nPACKAGES");
  console.table(out.packages);
  console.log("\nREQUESTS ALREADY MADE FOR A PACKAGE");
  console.table(out.requests);
  const unsure = out.packages.filter((p) => p.durationMinutes == null).length;
  console.log(`\n${out.packages.length} package(s); ${unsure} without a stored time. Read-only: nothing was changed.`);
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

module.exports = { describePackages };
