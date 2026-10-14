/**
 * @file test/migration-runner.test.js
 * @description The migration harness runs against the LIVE database, so the
 * properties that keep it safe are tested, not assumed:
 *   - without --apply nothing is written;
 *   - with --apply the guarded updates land and an audit line is recorded;
 *   - a guard that no longer matches (owner edited the row) is skipped, not forced.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MIGRATION_REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "migration-reports-"));

const Service = require("../models/Service");
const AuditLog = require("../models/AuditLog");
const { runMigration, parseArgs } = require("../migrations/lib/runner");
const { startDb, stopDb, clearDb } = require("./helpers/db");

before(startDb);
after(async () => {
  await stopDb();
  fs.rmSync(process.env.MIGRATION_REPORT_DIR, { recursive: true, force: true });
});
beforeEach(clearDb);

/** A plan shaped like M3: fill publicPrice only where it is still empty. */
const halfPricePlan = async () => {
  const services = await Service.find({ publicPrice: null }).lean();
  return {
    model: Service,
    report: {},
    changes: services.map((s) => ({
      filter: { _id: s._id, publicPrice: null },
      update: { $set: { publicPrice: Math.round(s.price / 2) } },
      summary: { name: s.name },
    })),
  };
};

test("dry run is the default and writes nothing but a report", async () => {
  await Service.create({ name: "Keratin (Women) Medium", price: 9000 });

  const out = await runMigration({ id: "T1", title: "t", plan: halfPricePlan, argv: [] });

  assert.equal(out.mode, "dry-run");
  assert.equal(out.planned, 1);
  assert.equal((await Service.findOne().lean()).publicPrice, null);
  assert.equal(await AuditLog.countDocuments(), 0);
  assert.ok(fs.existsSync(out.file));
});

test("--dry-run is accepted and still writes nothing", async () => {
  await Service.create({ name: "Facial", price: 2000 });
  const out = await runMigration({ id: "T2", title: "t", plan: halfPricePlan, argv: ["--dry-run"] });
  assert.equal(out.mode, "dry-run");
  assert.equal((await Service.findOne().lean()).publicPrice, null);
});

test("--apply writes and is audited; a second run changes nothing", async () => {
  await Service.create({ name: "Keratin (Women) Medium", price: 9000 });

  const first = await runMigration({ id: "T3", title: "t", plan: halfPricePlan, argv: ["--apply"] });
  assert.equal(first.result.modified, 1);
  assert.equal((await Service.findOne().lean()).publicPrice, 4500);
  assert.equal(await AuditLog.countDocuments({ action: "migration.applied" }), 1);

  const second = await runMigration({ id: "T3", title: "t", plan: halfPricePlan, argv: ["--apply"] });
  assert.equal(second.planned, 0);
});

test("an owner edit made after planning is not overwritten", async () => {
  await Service.create({ name: "Hydra Facial", price: 10000 });

  const racingPlan = async () => {
    const planned = await halfPricePlan();
    // The owner sets an exception between the read and the write.
    await Service.updateOne({ name: "Hydra Facial" }, { $set: { publicPrice: 4000 } });
    return planned;
  };

  const out = await runMigration({ id: "T4", title: "t", plan: racingPlan, argv: ["--apply"] });
  assert.equal(out.result.modified, 0);
  assert.equal((await Service.findOne().lean()).publicPrice, 4000);
});

test("passing both flags is refused", () => {
  assert.throws(() => parseArgs(["--apply", "--dry-run"]), /not both/);
});
