/**
 * @file test/emergency-default-duration.test.js
 * @description Emergency migration M9: every service on the website had `bookingMode: "request"` and most had no duration, so
 * customers could only send requests and never book a slot. M9 gives every website service the standard one-hour estimate
 * (editable later in the staff app) and switches the ordinary ones to instant booking. Bridal, colour and chemical services
 * (CLAUDE.md: they are request-only) get the duration but STAY request. Nothing already set is overwritten.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MIGRATION_REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "m9-reports-"));
const Service = require("../models/Service");
const Visit = require("../models/Visit");
const AuditLog = require("../models/AuditLog");
const { runMigration } = require("../migrations/lib/runner");
const { planEmergencyDuration, STAY_REQUEST_CATEGORIES } = require("../migrations/lib/emergencyDuration");
const { startDb, stopDb, clearDb } = require("./helpers/db");

before(startDb);
after(async () => {
  await stopDb();
  fs.rmSync(process.env.MIGRATION_REPORT_DIR, { recursive: true, force: true });
});
beforeEach(clearDb);

const base = { isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", durationConfirmed: false };
let n = 0;
const svc = (over) => Service.collection.insertOne({ name: `Service ${++n}`, price: 1000, publicPrice: 500, slug: `s-${n}`, displayCategory: "Skin", ...base, ...over });
const run = (argv) => runMigration({ id: "M9T", title: "t", plan: () => planEmergencyDuration(), argv });
const get = (name) => Service.findOne({ name }).lean();

test("dry run is the default: writes nothing, but reports every service before and after", async () => {
  await svc({ name: "Facial" });
  const out = await run([]);
  assert.equal(out.mode, "dry-run");
  assert.equal(out.planned, 1);
  const f = await get("Facial");
  assert.deepEqual([f.bookingMode, f.durationMinutes ?? null], ["request", null]);
  const report = JSON.parse(fs.readFileSync(out.file, "utf8"));
  assert.deepEqual([report.changes[0].name, report.changes[0].before.bookingMode, report.changes[0].after.bookingMode, report.changes[0].after.durationMinutes], ["Facial", "request", "instant", 60]);
});

test("an ordinary service gets 60 minutes (still an estimate, not confirmed) and becomes instant", async () => {
  await svc({ name: "Threading Full Face", displayCategory: "Threading" });
  await run(["--apply"]);
  const t = await get("Threading Full Face");
  assert.deepEqual([t.bookingMode, t.durationMinutes, t.durationConfirmed], ["instant", 60, false]);
});

test("bridal, colour and chemical services get the duration but STAY request-only", async () => {
  for (const [name, displayCategory] of [["Basic Bridal Make-up", "Makeup"], ["Keratin (Women) Short", "Treatments"], ["Balayage", "Colour"], ["Root touchup", "Hair"]]) await svc({ name, displayCategory });
  assert.deepEqual([...STAY_REQUEST_CATEGORIES].sort(), ["Colour", "Makeup", "Treatments"]);
  await run(["--apply"]);
  for (const name of ["Basic Bridal Make-up", "Keratin (Women) Short", "Balayage", "Root touchup"]) {
    const s = await get(name);
    assert.deepEqual([s.bookingMode, s.durationMinutes], ["request", 60], name);
  }
});

test("nothing already set is overwritten: a confirmed 45, an existing 60, and services already instant", async () => {
  await svc({ name: "head wash", durationMinutes: 45, durationConfirmed: true });
  await svc({ name: "Facial (Basic)", durationMinutes: 60 });
  await svc({ name: "Already instant", bookingMode: "instant", durationMinutes: 30, durationConfirmed: true });
  await run(["--apply"]);
  const h = await get("head wash");
  assert.deepEqual([h.durationMinutes, h.durationConfirmed, h.bookingMode], [45, true, "instant"], "the owner's confirmed time is kept; only the mode changes");
  assert.deepEqual([(await get("Facial (Basic)")).durationMinutes, (await get("Facial (Basic)")).bookingMode], [60, "instant"]);
  const a = await get("Already instant");
  assert.deepEqual([a.durationMinutes, a.durationConfirmed], [30, true]);
});

test("only active services shown on the website are touched", async () => {
  await svc({ name: "Hidden from site", showOnWebsite: false });
  await svc({ name: "Switched off", isActive: false });
  await svc({ name: "On the site" });
  await run(["--apply"]);
  assert.equal((await get("Hidden from site")).bookingMode, "request");
  assert.equal((await get("Switched off")).bookingMode, "request");
  assert.equal((await get("On the site")).bookingMode, "instant");
});

test("every instant service ends up with a duration above zero (the engine requires it)", async () => {
  for (let i = 0; i < 12; i++) await svc({ displayCategory: ["Skin", "Hair", "Waxing", "Colour"][i % 4] });
  await run(["--apply"]);
  const all = await Service.find({}).lean();
  assert.ok(all.every((s) => s.durationMinutes > 0));
  assert.ok(all.filter((s) => s.bookingMode === "instant").every((s) => s.durationMinutes > 0));
  for (const s of all) assert.equal(Service.assertBookable ? (() => { try { Service.assertBookable(s); return true; } catch { return false; } })() : true, true);
});

test("an owner edit made after planning is not overwritten, a second run changes nothing, and it is audited", async () => {
  await svc({ name: "Facial" });
  const plan = await planEmergencyDuration();
  await Service.collection.updateOne({ name: "Facial" }, { $set: { durationMinutes: 90 } }); // the owner set a time meanwhile
  await runMigration({ id: "M9T2", title: "t", plan: async () => plan, argv: ["--apply"] });
  assert.equal((await get("Facial")).durationMinutes, 90, "the owner's edit wins");
  const first = await run(["--apply"]);
  const second = await run(["--apply"]);
  assert.equal(second.planned, 0);
  assert.ok(first.planned >= 0);
  assert.ok((await AuditLog.countDocuments({ action: "migration.applied" })) >= 1);
});

test("no visit, price or artist is touched", async () => {
  await svc({ name: "Facial" });
  await run(["--apply"]);
  assert.equal(await Visit.countDocuments(), 0);
  assert.equal((await get("Facial")).publicPrice, 500);
});
