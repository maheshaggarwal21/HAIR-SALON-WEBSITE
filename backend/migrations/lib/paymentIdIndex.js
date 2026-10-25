/**
 * @file migrations/lib/paymentIdIndex.js
 * @description M8 (audit #2, D70) — one Razorpay payment id may sit on only ONE visit, enforced by the database.
 *
 * What it creates: a UNIQUE index on `visits.razorpayPaymentId` that ignores visits with no real payment id
 * (null, missing, and ""), so any number of cash and card visits coexist:
 *
 *     partialFilterExpression: { razorpayPaymentId: { $type: "string", $gt: "" } }
 *
 * It also adds a plain (non-unique) lookup index on the same field. The partial one is not used by a bare
 * `{ razorpayPaymentId: "pay_x" }` query (checked with explain: the planner cannot prove a bare id is
 * non-empty), so without this the webhook, the Unreconciled list and the duplicate guards would keep scanning
 * the whole collection.
 *
 * Why only here, not in models/Visit.js: Mongoose builds every schema-declared index the first time a model
 * is used, in production too. An index that would fail on existing duplicates must never be built by a
 * deploy; it is created once, deliberately, by this migration after the dry run has been read.
 *
 * ── The safe path is the default ───────────────────────────────────────────────────────────────────────
 *   npm run migrate:m8               DRY RUN (default). Read-only. Writes a report, nothing else.
 *   npm run migrate:m8 -- --apply    Creates the index. REFUSES while any payment id is on more than one
 *                                    visit, and says which. Idempotent: a second run changes nothing.
 *
 * The report holds payment ids, visit ids and dates only. No names, phone numbers or amounts of customers.
 * It never edits, merges or deletes a visit: duplicates, if there are any, are for a person to look at.
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../../db");
const Visit = require("../../models/Visit");
const { parseArgs } = require("./runner");

const INDEX_NAME = "razorpayPaymentId_real_unique";
/** A plain index for lookups: MongoDB does not use the partial one for `{razorpayPaymentId: "pay_x"}` (the planner cannot prove a bare id is non-empty). */
const LOOKUP_INDEX_NAME = "razorpayPaymentId_lookup";
const PARTIAL = { razorpayPaymentId: { $type: "string", $gt: "" } };
const REPORT_DIR = () => process.env.MIGRATION_REPORT_DIR || path.join(__dirname, "..", "reports");

/** Read-only. Everything the dry run reports. */
async function scan() {
  const col = Visit.collection;
  const grouped = await col
    .aggregate([
      { $match: { razorpayPaymentId: PARTIAL.razorpayPaymentId } },
      { $group: { _id: "$razorpayPaymentId", count: { $sum: 1 }, visits: { $push: { visitId: "$_id", date: "$date" } } } },
    ])
    .toArray();
  const duplicates = grouped
    .filter((g) => g.count > 1)
    .sort((a, b) => b.count - a.count || String(a._id).localeCompare(String(b._id)))
    .map((g) => ({
      paymentId: g._id,
      count: g.count,
      visits: g.visits.map((v) => ({ visitId: String(v.visitId), date: v.date ? new Date(v.date).toISOString().slice(0, 10) : null })).sort((a, b) => String(a.date).localeCompare(String(b.date))),
    }));
  const empties = await col.find({ razorpayPaymentId: "" }, { projection: { _id: 1, date: 1 } }).toArray();
  const all = await col.indexes();
  const existing = all.find((i) => i.name === INDEX_NAME) || null;
  const lookup = all.find((i) => i.name === LOOKUP_INDEX_NAME) || null;
  return {
    summary: {
      visitsWithRealId: grouped.reduce((n, g) => n + g.count, 0),
      distinctRealIds: grouped.length,
      idsOnMoreThanOneVisit: duplicates.length,
      visitsWithEmptyStringId: empties.length,
    },
    duplicates,
    emptyStringVisits: empties.map((v) => ({ visitId: String(v._id), date: v.date ? new Date(v.date).toISOString().slice(0, 10) : null })),
    indexExists: Boolean(existing),
    lookupIndexExists: Boolean(lookup),
  };
}

function writeReport(report) {
  fs.mkdirSync(REPORT_DIR(), { recursive: true });
  const file = path.join(REPORT_DIR(), `m8-${report.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

/**
 * @param {{argv?: string[]}} [opts]
 * @returns {Promise<object>} the scan plus `{mode, created, file}`. Rejects (after writing a report) when --apply is refused.
 */
async function runM8({ argv } = {}) {
  const { apply } = parseArgs(argv);
  const mode = apply ? "apply" : "dry-run";
  console.log(`\n[M8] one payment id, one visit (unique index) — ${mode.toUpperCase()}`);
  await connectDB();
  console.log(`[M8] database: ${mongoose.connection.db.databaseName}`);

  const found = await scan();
  const { summary } = found;
  console.log(`[M8] ${summary.visitsWithRealId} visit(s) carry a real payment id (${summary.distinctRealIds} distinct); ${summary.idsOnMoreThanOneVisit} id(s) are on more than one visit; ${summary.visitsWithEmptyStringId} visit(s) have an empty-string id (ignored by the index).`);
  for (const d of found.duplicates) console.log(`[M8]   ${d.paymentId}: ${d.count} visits (${d.visits.map((v) => `${v.visitId} ${v.date}`).join(", ")})`);
  console.log(`[M8] unique index ${INDEX_NAME}: ${found.indexExists ? "already exists" : "does not exist"}; lookup index ${LOOKUP_INDEX_NAME}: ${found.lookupIndexExists ? "already exists" : "does not exist"}`);

  const out = { id: "M8", mode, database: mongoose.connection.db.databaseName, ranAt: new Date().toISOString(), ...found, created: false, status: "dry-run" };

  if (!apply) {
    out.file = writeReport(out);
    console.log(`[M8] report: ${out.file}\n[M8] nothing written. Re-run with --apply after the report is reviewed.`);
    return out;
  }

  if (found.duplicates.length) {
    out.status = "refused";
    out.file = writeReport(out);
    const ids = found.duplicates.map((d) => d.paymentId).join(", ");
    throw new Error(`Index NOT created: ${found.duplicates.length} payment id(s) are on more than one visit (${ids}). See ${out.file}. Look at those visits, then run the dry run again.`);
  }

  if (found.indexExists && found.lookupIndexExists) {
    out.status = "already-exists";
  } else {
    try {
      if (!found.indexExists) await Visit.collection.createIndex({ razorpayPaymentId: 1 }, { name: INDEX_NAME, unique: true, partialFilterExpression: PARTIAL });
      // Second, so that an older server refusing two indexes on one field can never cost us the unique one.
      if (!found.lookupIndexExists) await Visit.collection.createIndex({ razorpayPaymentId: 1 }, { name: LOOKUP_INDEX_NAME });
    } catch (err) {
      out.status = "failed";
      out.file = writeReport({ ...out, error: err.message });
      if (err?.code === 11000 || /E11000|duplicate key/i.test(err.message)) {
        throw new Error("Index NOT created: a duplicate payment id appeared while the index was being built. Run the dry run again.");
      }
      throw err;
    }
    out.created = true;
    out.status = "created";
    await require("../../utils/audit").record({
      action: "migration.applied",
      actor: { id: null, name: "migration M8", role: "system" },
      meta: { id: "M8", title: "unique index on visits.razorpayPaymentId", index: INDEX_NAME, lookupIndex: LOOKUP_INDEX_NAME },
    });
    console.log(`[M8] index ${INDEX_NAME} and ${LOOKUP_INDEX_NAME} created.`);
  }
  out.file = writeReport(out);
  console.log(`[M8] report: ${out.file}`);
  return out;
}

function main() {
  runM8()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error("[M8] FAILED:", err.message);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { INDEX_NAME, LOOKUP_INDEX_NAME, PARTIAL, scan, runM8, main };
