/**
 * @file test/website-menu.test.js
 * @description The owner's signed menu (CF D53): the sheet
 * (docs/customer-platform/data/website-menu.csv), the card config
 * (config/menuGroups.js) and migration M7 that puts it live.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MIGRATION_REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "m7-reports-"));
const sheetDir = fs.mkdtempSync(path.join(os.tmpdir(), "m7-sheet-"));

const { startDb, stopDb, clearDb } = require("./helpers/db");
const Service = require("../models/Service");
const { parseCsv } = require("../migrations/lib/catalogueImport");
const { planWebsiteMenu } = require("../migrations/lib/websiteMenu");
const { runMigration } = require("../migrations/lib/runner");
const M7 = require("../migrations/m7-website-menu");
const { GROUPS, groupFor, norm } = require("../config/menuGroups");
const { serviceCards } = require("../utils/publicCatalogue");

const DATA = path.join(__dirname, "..", "..", "docs", "customer-platform", "data");
const SHEET = parseCsv(fs.readFileSync(path.join(DATA, "website-menu.csv"), "utf8"));
const EXPORT = parseCsv(fs.readFileSync(path.join(DATA, "services-public.draft.csv"), "utf8"));

before(startDb);
after(async () => {
  await stopDb();
  fs.rmSync(process.env.MIGRATION_REPORT_DIR, { recursive: true, force: true });
  fs.rmSync(sheetDir, { recursive: true, force: true });
});
beforeEach(clearDb);

// ── The sheet and the config agree ───────────────────────────────────────────

test("sheet: 91 services, prices are half the owner's list price, ids still match the billing export", () => {
  assert.equal(SHEET.length, 91);
  const exported = new Map(EXPORT.map((r) => [r.id, r.name.trim()]));
  for (const r of SHEET) {
    assert.equal(Number(r.website_price) * 2, Number(r.list_price), `${r.website_name}: website price is half the list price`);
    if (r.billing_id) assert.equal(exported.get(r.billing_id), r.billing_name, `${r.website_name}: billing id and name agree`);
    else assert.ok(r.new_category, `${r.billing_name}: a new service says its billing category`);
  }
  assert.equal(SHEET.filter((r) => !r.billing_id).length, 13, "13 services are new to billing");
  assert.equal(new Set(SHEET.map((r) => r.slug)).size, 91, "slugs are unique");
});

test("config: every sheet row is in exactly its group, in that group's section; nothing else is listed", () => {
  const members = GROUPS.flatMap((g) => g.members.map(([name]) => name));
  assert.equal(new Set(members.map(norm)).size, members.length, "no service listed twice");
  assert.deepEqual([...members].sort(), SHEET.map((r) => r.billing_name).sort(), "config lists exactly the sheet's services");
  for (const r of SHEET) {
    const hit = groupFor({ name: r.billing_name, publicName: r.website_name });
    assert.equal(hit.group.slug, r.group, `${r.billing_name} → ${r.group}`);
    assert.equal(hit.group.category, r.section, `${r.group} is in ${r.section}`);
  }
  for (const g of GROUPS) {
    assert.ok(g.members.length >= 2 || g.keepTitle, `${g.slug} has two options or keeps its title`);
    for (const [, label] of g.members) assert.ok(label.length <= 40, `${g.slug}: "${label}" is short`);
  }
});

test("a website name never pulls a service into another group (internal name wins)", () => {
  // Both are called "Keratin" on the website; the billing name decides.
  assert.equal(groupFor({ name: "Keratin (Men)", publicName: "Keratin" }).group.slug, "hair-treatments-men");
  assert.equal(groupFor({ name: "Keratin (Women) Short", publicName: "Keratin" }).group.slug, "hair-treatments-women");
});

// ── What the website shows ───────────────────────────────────────────────────

const asServices = () =>
  SHEET.map((r, i) => ({
    _id: r.billing_id || `new${i}`,
    name: r.billing_name,
    publicName: r.website_name,
    publicPrice: Number(r.website_price),
    displayCategory: r.section,
    audience: r.audience,
    slug: r.slug,
    sortOrder: Number(r.order),
    bookingMode: "request",
  }));
const forTab = (who) => asServices().filter((s) => !who || s.audience === who || s.audience === "unisex");

test("Her / Him tabs: the owner's groups, in the owner's order, with the owner's prices", () => {
  const her = serviceCards(forTab("her"));
  assert.deepEqual(her.map((c) => c.name), [
    "Hair services", "Hair colour", "Hair treatments", "Clean-up", "Facials", "Bleach",
    "Waxing (honey)", "Waxing (Rica)", "Face wax", "Threading", "Manicure & pedicure", "Make-up",
  ]);
  const honey = her.find((c) => c.slug === "honey-waxing");
  assert.deepEqual(honey.options.slice(0, 3).map((o) => [o.label, o.price]), [["Full arms", 350], ["Full legs", 600], ["Half arms", 150]]);
  assert.equal(honey.pick, "many");
  const colour = her.find((c) => c.slug === "hair-colour-women");
  assert.match(colour.shortDescription, /^Starting prices/);
  assert.equal(colour.fromPrice, 3000);

  const him = serviceCards(forTab("him"));
  assert.deepEqual(him.map((c) => c.name), [
    "Hair services", "Hair colour", "Hair treatments", "Clean-up", "Facials", "Waxing & threading", "Manicure & pedicure", "Beard & moustache",
  ]);
  const colourHim = him.find((c) => c.name === "Hair colour");
  assert.equal(colourHim.slug, "hair-colour-men", "one-option group keeps its title and URL");
  assert.deepEqual(colourHim.options.map((o) => [o.label, o.price]), [["Global colour", 400]]);
  assert.ok(him.find((c) => c.slug === "hair-services-men").options.some((o) => o.label === "Baby boy haircut"));
});

test("Everyone tab: men's and women's cards of the same name merge, stay combinable and keep the note", () => {
  const all = serviceCards(forTab(null));
  const hair = all.filter((c) => c.name === "Hair services");
  assert.equal(hair.length, 1);
  assert.equal(hair[0].pick, "many");
  assert.equal(hair[0].options.length, 13);
  assert.ok(hair[0].options.some((o) => o.label === "Haircut (men)"));
  const treatments = all.find((c) => c.name === "Hair treatments");
  assert.match(treatments.shortDescription, /short hair/, "the women's note survives the merge");
  assert.equal(treatments.pick, "one");
  const total = all.reduce((n, c) => n + c.options.length, 0);
  assert.equal(total, 91, "every service is on the menu once");
});

// ── M7 ───────────────────────────────────────────────────────────────────────

const HEAD = Object.keys(SHEET[0]);
const line = (r) => HEAD.map((k) => (/[",\n]/.test(String(r[k] ?? "")) ? `"${String(r[k]).replace(/"/g, '""')}"` : String(r[k] ?? ""))).join(",");
const row = (over) => ({
  order: 1, section: "Skin", group: "facials", audience: "unisex", website_name: "Basic facial",
  website_price: 1200, list_price: 2400, slug: "basic-facial", billing_id: "", billing_name: "Facial (Basic)",
  billing_price: "", new_category: "Skin", owner_group: "Facial", owner_name: "Basic Facial", ...over,
});

test("M7 plan: refuses bad rows and renamed services; reports billing prices that differ", async () => {
  const [a, b] = await Service.create([{ name: "Clean-up (Basic)", price: 700 }, { name: "Old name", price: 100 }]);
  const plan = planWebsiteMenu(
    [
      row({ billing_id: String(a._id), billing_name: "Clean-up (Basic)", website_name: "Basic clean-up", slug: "basic-clean-up", website_price: 600, list_price: 1200 }),
      row({ billing_id: String(b._id), billing_name: "New name", slug: "x" }),
      row({ billing_name: "Spa thing", section: "Spa", slug: "spa" }),
    ],
    await Service.find({}).lean()
  );
  assert.deepEqual(plan.problems.map((p) => p.name), ["New name", "Spa thing"]);
  assert.match(plan.problems[0].problem, /renamed/);
  assert.match(plan.problems[1].problem, /section "Spa"/);
  assert.deepEqual(plan.listPriceDiffers, [{ name: "Clean-up (Basic)", billingPrice: 700, sheetListPrice: 1200, websitePrice: 600 }]);
});

test("M7 apply: lists, creates and hides; never changes a billing price; re-run is a no-op", async () => {
  const [cleanup, oldCard] = await Service.create([
    { name: "Clean-up (Basic)", price: 700, category: "Skin", variantGroup: "legacy", variantLabel: "Basic" },
    { name: "Fruit Facial", price: 2000, showOnWebsite: true, publicPrice: 1000, bookingMode: "request" },
  ]);
  const file = path.join(sheetDir, "website-menu.csv");
  fs.writeFileSync(
    file,
    [
      HEAD.join(","),
      line(row({ order: 7, group: "clean-up", billing_id: String(cleanup._id), billing_name: "Clean-up (Basic)", website_name: "Basic clean-up", slug: "basic-clean-up", website_price: 600, list_price: 1200, new_category: "" })),
      line(row({ order: 8 })),
    ].join("\r\n")
  );
  process.argv.push(`--file=${file}`);
  try {
    const dry = await runMigration({ ...M7, argv: [] });
    assert.equal(dry.planned, 3);
    assert.equal(await Service.countDocuments({ name: "Facial (Basic)" }), 0, "dry run writes nothing");

    const out = await runMigration({ ...M7, argv: ["--apply"] });
    assert.deepEqual(out.result, { matched: 2, modified: 2, upserted: 1 });

    const c = await Service.findById(cleanup._id).lean();
    assert.deepEqual(
      [c.showOnWebsite, c.publicPrice, c.publicName, c.slug, c.displayCategory, c.audience, c.sortOrder, c.bookingMode, c.variantGroup],
      [true, 600, "Basic clean-up", "basic-clean-up", "Skin", "unisex", 7, "request", null]
    );
    assert.equal(c.price, 700, "billing price untouched (website only)");

    const f = await Service.findOne({ name: "Facial (Basic)" }).lean();
    assert.deepEqual(
      [f.price, f.category, f.publicPrice, f.showOnWebsite, f.bookingMode, f.durationMinutes, f.durationConfirmed, f.isActive, f.featured],
      [2400, "Skin", 1200, true, "request", 60, false, true, false],
      "new service: billable at the owner's list price, with the usual defaults"
    );

    assert.equal((await Service.findById(oldCard._id).lean()).showOnWebsite, false, "a service not on the list leaves the website");
    assert.equal(await Service.countDocuments({}), 3, "nothing deleted");

    assert.equal((await runMigration({ ...M7, argv: ["--apply"] })).planned, 0, "re-run is a no-op");
  } finally {
    process.argv.pop();
  }
});

test("M7 guard: an edit made after planning is not overwritten", async () => {
  const s = await Service.create({ name: "Clean-up (Basic)", price: 700 });
  const plan = planWebsiteMenu(
    [row({ billing_id: String(s._id), billing_name: "Clean-up (Basic)", website_name: "Basic clean-up", slug: "basic-clean-up", website_price: 600, list_price: 1200 })],
    await Service.find({}).lean()
  );
  await Service.updateOne({ _id: s._id }, { $set: { publicPrice: 650 } }); // owner edits in between
  const res = await Service.bulkWrite(plan.changes.map((c) => ({ updateOne: { filter: c.filter, update: c.update } })));
  assert.equal(res.matchedCount, 0);
  assert.equal((await Service.findById(s._id).lean()).publicPrice, 650);
});
