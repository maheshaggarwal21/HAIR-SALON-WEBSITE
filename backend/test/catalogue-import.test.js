/**
 * @file test/catalogue-import.test.js
 * @description M6 (T0.3): the owner's signed-off sheet goes live exactly as
 * signed, and never overwrites anything set since the export.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MIGRATION_REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "m6-reports-"));
const sheetDir = fs.mkdtempSync(path.join(os.tmpdir(), "m6-sheet-"));

const { startDb, stopDb, clearDb } = require("./helpers/db");
const Service = require("../models/Service");
const { parseCsv, planCatalogueImport } = require("../migrations/lib/catalogueImport");
const { runMigration } = require("../migrations/lib/runner");
const M6 = require("../migrations/m6-import-catalogue");

before(startDb);
after(async () => {
  await stopDb();
  fs.rmSync(process.env.MIGRATION_REPORT_DIR, { recursive: true, force: true });
  fs.rmSync(sheetDir, { recursive: true, force: true });
});
beforeEach(clearDb);

const HEADER =
  "id,name,category,price,isActive,proposed_publicPrice,proposed_displayCategory,proposed_audience,audience_reason,proposed_publicName,proposed_slug,proposed_variantGroup,proposed_variantLabel,flags,owner_showOnWebsite,owner_publicPrice,owner_displayCategory,owner_audience,owner_publicName,owner_notes";

function csvRow(s, over = {}) {
  const r = {
    id: String(s._id),
    name: s.name,
    category: s.category || "",
    price: s.price,
    isActive: "true",
    proposed_publicPrice: Math.round(s.price / 2),
    proposed_displayCategory: "Skin",
    proposed_audience: "her",
    audience_reason: "",
    proposed_publicName: s.name,
    proposed_slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    proposed_variantGroup: "",
    proposed_variantLabel: "",
    flags: "",
    owner_showOnWebsite: "",
    owner_publicPrice: "",
    owner_displayCategory: "",
    owner_audience: "",
    owner_publicName: "",
    owner_notes: "",
    ...over,
  };
  return HEADER.split(",")
    .map((k) => {
      const v = String(r[k] ?? "");
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(",");
}

test("parseCsv handles the BOM, quotes, commas and CRLF Excel writes", () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,,z\r\n');
  assert.deepEqual(rows, [
    { a: "1", b: "x, y", c: 'say "hi"' },
    { a: "2", b: "", c: "z" },
  ]);
});

test("sheet values: yes switches a service on; blanks accept the proposal; owner cells win", async () => {
  const [facial, wax] = await Service.create([
    { name: "Hydra Facial", price: 3100 },
    { name: "Back wax (rica)", price: 1100 },
  ]);
  const rows = parseCsv(
    [HEADER, csvRow(facial, { owner_showOnWebsite: "Yes", owner_publicPrice: "₹1,499", owner_publicName: "Hydra facial" }), csvRow(wax)].join("\n")
  );
  const plan = planCatalogueImport(rows, await Service.find({}).lean());
  assert.equal(plan.summary.shownOnWebsite, 1);
  assert.deepEqual(plan.problems, []);

  const f = plan.changes.find((c) => c.summary.name === "Hydra Facial").update.$set;
  assert.equal(f.showOnWebsite, true);
  assert.equal(f.bookingMode, "request");
  assert.equal(f.publicPrice, 1499);
  assert.equal(f.publicName, "Hydra facial");
  const w = plan.changes.find((c) => c.summary.name === "Back wax (rica)").update.$set;
  assert.equal(w.showOnWebsite, undefined); // blank = not on the website
  assert.equal(w.publicPrice, 550);
});

test("bad cells, renamed rows and slug clashes are refused, not guessed", async () => {
  const [a, b, c] = await Service.create([
    { name: "A one", price: 100 },
    { name: "B two", price: 200 },
    { name: "C three", price: 300 },
  ]);
  await Service.updateOne({ _id: c._id }, { $set: { name: "C renamed" } });
  const rows = parseCsv(
    [
      HEADER,
      csvRow(a, { owner_showOnWebsite: "yes", owner_displayCategory: "Spa" }),
      csvRow(b, { owner_showOnWebsite: "yes", owner_publicPrice: "abc" }),
      csvRow(c, { owner_showOnWebsite: "yes" }),
    ].join("\n")
  );
  const plan = planCatalogueImport(rows, await Service.find({}).lean());
  assert.equal(plan.changes.length, 0);
  assert.match(plan.problems.find((p) => p.name === "A one").problem, /category "Spa"/);
  assert.match(plan.problems.find((p) => p.name === "B two").problem, /not whole rupees/);
  assert.match(plan.problems.find((p) => p.name === "C three").problem, /renamed/);
});

test("M6 apply: fills empty fields, keeps values set since the export, re-run is a no-op", async () => {
  const [facial, brows] = await Service.create([
    { name: "Hydra Facial", price: 3100 },
    { name: "Eyebrows (Thread)", price: 100 },
  ]);
  // Owner set a website price in the staff app after the export.
  await Service.updateOne({ _id: brows._id }, { $set: { publicPrice: 40 } });

  const file = path.join(sheetDir, "services-public.csv");
  fs.writeFileSync(
    file,
    "﻿" + [HEADER, csvRow(facial, { owner_showOnWebsite: "yes" }), csvRow(brows, { owner_showOnWebsite: "yes", proposed_displayCategory: "Threading" })].join("\r\n")
  );
  process.argv.push(`--file=${file}`);
  try {
    const dry = await runMigration({ ...M6, argv: [] });
    assert.equal(dry.planned, 2);
    assert.equal((await Service.findById(facial._id).lean()).showOnWebsite, false);

    const out = await runMigration({ ...M6, argv: ["--apply"] });
    assert.equal(out.result.modified, 2);

    const f = await Service.findById(facial._id).lean();
    assert.deepEqual([f.showOnWebsite, f.bookingMode, f.publicPrice, f.slug, f.displayCategory], [true, "request", 1550, "hydra-facial", "Skin"]);
    assert.equal(f.price, 3100); // internal list price untouched

    const b = await Service.findById(brows._id).lean();
    assert.equal(b.publicPrice, 40); // owner's later edit kept
    assert.equal(b.showOnWebsite, true);
    const report = JSON.parse(fs.readFileSync(out.file, "utf8"));
    assert.deepEqual(report.conflicts, [{ name: "Eyebrows (Thread)", field: "publicPrice", inDatabase: 40, inSheet: 50 }]);

    assert.equal((await runMigration({ ...M6, argv: ["--apply"] })).planned, 0);
  } finally {
    process.argv.pop();
  }
});
