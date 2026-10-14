/**
 * @file migrations/lib/runner.js
 * @description Shared harness for data migrations (CF §20).
 *
 * ── Dry run is the DEFAULT ────────────────────────────────────────────────────
 * The doc asks for a `--dry-run` mode. This goes one step further and makes it
 * impossible to write by accident: nothing is written unless `--apply` is
 * passed. `--dry-run` is accepted too, so commands copied from the docs work,
 * but it changes nothing because dry run is already what happens.
 *
 * These scripts run against the LIVE salon database (there is no staging copy),
 * so an accidental write is a production incident. Making the safe path the
 * lazy path is cheaper than relying on everyone remembering a flag.
 *
 * ── Every run leaves a report ─────────────────────────────────────────────────
 * Dry runs and applied runs both write `migrations/reports/<id>-<mode>-<time>.json`.
 * CHECKPOINTS.md requires the dry-run output on the PR; this is that output.
 * Reports hold catalogue data only (names, prices, categories) — never customer
 * contacts — and are git-ignored so they are attached deliberately, not committed.
 *
 * Applied runs also write an AuditLog line so the owner's Management → Audit
 * view shows when the catalogue was changed in bulk, and by which migration.
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../../db");

// Overridable so tests do not litter the real reports folder.
const REPORT_DIR = process.env.MIGRATION_REPORT_DIR || path.join(__dirname, "..", "reports");

function parseArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) {
    throw new Error("Pass either --apply or --dry-run, not both");
  }
  return { apply };
}

/**
 * @param {object}   opts
 * @param {string}   opts.id        e.g. "M3"
 * @param {string}   opts.title     one line for the console and the report
 * @param {Function} opts.plan      async () => { model, changes: [{filter, update, summary, upsert?}], report: object }
 *                                  Must be read-only. `filter` MUST guard against
 *                                  overwriting a value someone has since set. An
 *                                  `upsert` change must only use $setOnInsert, so
 *                                  an existing document is never touched.
 * @param {string[]} [opts.argv]    defaults to the process arguments
 * @returns {Promise<{mode, planned, result, file}>}
 */
async function runMigration({ id, title, plan, argv }) {
  const { apply } = parseArgs(argv);
  const mode = apply ? "apply" : "dry-run";
  console.log(`\n[${id}] ${title} — ${mode.toUpperCase()}`);

  await connectDB();
  console.log(`[${id}] database: ${mongoose.connection.db.databaseName}`);

  const { changes, report, model } = await plan();
  console.log(`[${id}] ${changes.length} change(s) planned`);

  let result = null;
  if (apply && changes.length) {
    const res = await model.bulkWrite(
      changes.map((c) => ({
        updateOne: {
          filter: c.filter,
          update: c.update,
          upsert: c.upsert === true,
          // Mongoose would add `$set: {updatedAt}` to an upsert, touching the
          // existing documents an insert-only change promises to leave alone.
          // Upsert changes set their own createdAt/updatedAt in $setOnInsert.
          ...(c.upsert === true ? { timestamps: false } : {}),
        },
      })),
      { ordered: false }
    );
    result = { matched: res.matchedCount, modified: res.modifiedCount, upserted: res.upsertedCount };
    console.log(
      `[${id}] applied: ${result.modified} modified of ${result.matched} matched` +
        (result.upserted ? `, ${result.upserted} inserted` : "")
    );
    // A guard filter that no longer matches means someone edited the row after
    // the plan was read. That is the guard working, not a failure — but say so.
    if (result.matched + result.upserted < changes.length) {
      console.log(`[${id}] ${changes.length - result.matched - result.upserted} skipped: value already set since planning`);
    }

    const audit = require("../../utils/audit");
    await audit.record({
      action: "migration.applied",
      actor: { id: null, name: `migration ${id}`, role: "system" },
      meta: { id, title, planned: changes.length, ...result },
    });
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(REPORT_DIR, `${id.toLowerCase()}-${mode}-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        id,
        title,
        mode,
        database: mongoose.connection.db.databaseName,
        ranAt: new Date().toISOString(),
        planned: changes.length,
        result,
        changes: changes.map((c) => c.summary),
        ...report,
      },
      null,
      2
    )
  );
  console.log(`[${id}] report: ${path.relative(process.cwd(), file)}`);
  if (!apply) console.log(`[${id}] nothing written. Re-run with --apply after the report is reviewed.`);
  return { mode, planned: changes.length, result, file };
}

/** Entry point wrapper: run, disconnect, exit non-zero on failure. */
function main(opts) {
  runMigration(opts)
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error(`[${opts.id}] FAILED:`, err.message);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { runMigration, main, parseArgs };
