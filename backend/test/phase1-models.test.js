/**
 * @file test/phase1-models.test.js
 * @description Phase 1 foundations (T1.2–T1.5, M1): IST time helpers, the new
 * models' invariants, and the customer backfill.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MIGRATION_REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "m1-reports-"));

const { startDb, stopDb, clearDb } = require("./helpers/db");
const time = require("../utils/time");
const Customer = require("../models/Customer");
const Appointment = require("../models/Appointment");
const SiteSettings = require("../models/SiteSettings");
const Artist = require("../models/Artist");
const Visit = require("../models/Visit");
const { groupVisitsByPhone, maskPhone } = require("../migrations/lib/customers");
const { runMigration } = require("../migrations/lib/runner");
const M1 = require("../migrations/m1-customers");

before(startDb);
after(async () => {
  await stopDb();
  fs.rmSync(process.env.MIGRATION_REPORT_DIR, { recursive: true, force: true });
});
beforeEach(clearDb);

// ── Time (E20: the server runs in UTC) ───────────────────────────────────────

test("salonDate rolls over at IST midnight, not UTC midnight", () => {
  // 18:29 UTC = 23:59 IST same day; 18:31 UTC = 00:01 IST next day.
  assert.equal(time.salonDate(new Date("2026-10-28T18:29:00Z")), "2026-10-28");
  assert.equal(time.salonDate(new Date("2026-10-28T18:31:00Z")), "2026-10-29");
});

test("salonInstant turns IST wall clock into the right UTC instant", () => {
  assert.equal(time.salonInstant("2026-10-29", "14:30").toISOString(), "2026-10-29T09:00:00.000Z");
  assert.equal(time.salonInstant("2026-10-29", "00:15").toISOString(), "2026-10-28T18:45:00.000Z");
  assert.equal(time.salonInstant("2026-02-30", "10:00"), null);
  assert.equal(time.salonInstant("2026-10-29", "25:00"), null);
});

test("date helpers", () => {
  assert.equal(time.isValidDate("2026-10-29"), true);
  assert.equal(time.isValidDate("2026-13-01"), false);
  assert.equal(time.isValidDate("29-10-2026"), false);
  assert.equal(time.daysBetween("2026-10-28", "2026-11-02"), 5);
  assert.equal(time.weekdayKey("2026-10-29"), "thu");
});

// ── Customer ─────────────────────────────────────────────────────────────────

test("normalisePhone accepts the formats the desk types and rejects the rest", () => {
  const n = Customer.normalisePhone;
  assert.equal(n("9876543210"), "9876543210");
  assert.equal(n("+91 98765-43210"), "9876543210");
  assert.equal(n("919876543210"), "9876543210");
  assert.equal(n("09876543210"), "9876543210");
  assert.equal(n("5876543210"), null); // Indian mobiles start 6–9
  assert.equal(n("98765"), null);
  assert.equal(n(null), null);
});

test("one customer per phone", async () => {
  await Customer.create({ phone: "9876543210", name: "Asha", createdFrom: "web" });
  await assert.rejects(Customer.create({ phone: "9876543210", name: "Asha K", createdFrom: "desk" }), /duplicate key/);
});

// ── Appointment ──────────────────────────────────────────────────────────────

test("booking refs use the unambiguous alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const ref = Appointment.generateRef();
    assert.match(ref, /^EXP-[23456789ABCDEFGHJKMNPQRSTWXYZ]{5}$/);
  }
});

test("an appointment ref is unique", async () => {
  const base = {
    mode: "request",
    status: "requested",
    contact: "9876543210",
    name: "Asha",
    pricing: { subtotal: 500, total: 500 },
    source: { channel: "web" },
  };
  await Appointment.create({ ...base, ref: "EXP-AAAAA" });
  await assert.rejects(Appointment.create({ ...base, ref: "EXP-AAAAA" }), /duplicate key/);
});

// ── SiteSettings ─────────────────────────────────────────────────────────────

test("settings singleton: concurrent first reads create exactly one document with defaults", async () => {
  const docs = await Promise.all(Array.from({ length: 5 }, () => SiteSettings.getSingleton().catch((e) => e)));
  const ok = docs.filter((d) => !(d instanceof Error));
  assert.ok(ok.length >= 1);
  assert.equal(await SiteSettings.countDocuments(), 1);

  const s = await SiteSettings.getSingleton();
  assert.deepEqual(s.toObject().openingHours.mon, [{ open: "09:00", close: "21:00" }]);
  assert.deepEqual(s.toObject().openingHours.tue, []); // weekly off
  assert.equal(s.contact.whatsapp, "9814830550"); // owner's number (K1)
  assert.equal(s.contact.mapUrl, "https://maps.app.goo.gl/3crtqx58iqAG4S568");
  assert.equal(s.requestWindows.evening.end, "21:00");
  const pub = s.toPublic();
  assert.equal(pub.contact.placeId, undefined);
  assert.equal(pub.maxActiveBookingsPerPhone, undefined);
});

test("settings: owner edits survive a later getSingleton()", async () => {
  const s = await SiteSettings.getSingleton();
  s.contact.whatsapp = "9876500000";
  await s.save();
  assert.equal((await SiteSettings.getSingleton()).contact.whatsapp, "9876500000");
});

// ── Artist public layer ──────────────────────────────────────────────────────

test("artists without a slug don't collide on the sparse unique index; duplicate slugs do", async () => {
  await Artist.create({ name: "A", phone: "9000000001" });
  await Artist.create({ name: "B", phone: "9000000002" });
  await Artist.create({ name: "C", phone: "9000000003", publicProfile: { slug: "mansi" } });
  await assert.rejects(
    Artist.create({ name: "D", phone: "9000000004", publicProfile: { slug: "mansi" } }),
    /duplicate key/
  );
  const a = await Artist.findOne({ name: "A" });
  assert.equal(a.publicProfile.visible, null); // null = shown while active (K6)
  assert.equal(a.onlineBookable, false);
});

// ── M1 backfill ──────────────────────────────────────────────────────────────

test("groupVisitsByPhone merges spellings of one number and keeps the latest name", () => {
  const { customers, invalid } = groupVisitsByPhone([
    { contact: "9876543210", name: "asha", gender: "female", date: "2025-01-10" },
    { contact: "+91 98765 43210", name: "Asha Kaur", gender: "female", date: "2026-09-01" },
    { contact: "09876543210", name: "A", gender: "female", date: "2025-06-01" },
    { contact: "12345", name: "Typo", gender: "male", date: "2026-01-01" },
  ]);
  assert.equal(invalid, 1);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, "Asha Kaur");
  assert.equal(customers[0].visits, 3);
  assert.equal(customers[0].firstVisitAt.toISOString().slice(0, 10), "2025-01-10");
  assert.equal(customers[0].lastVisitAt.toISOString().slice(0, 10), "2026-09-01");
  assert.equal(maskPhone("9876543210"), "98•••••210");
});

async function seedVisit(contact, name, date) {
  return Visit.collection.insertOne({ contact, name, gender: "female", date: new Date(date), services: [] });
}

test("M1 is insert-only: an existing web customer is left exactly as it was", async () => {
  await seedVisit("9876543210", "Asha (desk)", "2026-01-01");
  await seedVisit("9811111111", "Neha", "2026-02-01");
  const web = await Customer.create({
    phone: "9876543210",
    name: "Asha (web)",
    createdFrom: "web",
    marketing: { whatsappOptIn: true, at: new Date(), source: "web_request" },
  });
  const before = (await Customer.findById(web._id).lean()).updatedAt;

  const dry = await runMigration({ ...M1, argv: [] });
  assert.equal(dry.planned, 1);
  assert.equal(await Customer.countDocuments(), 1);

  const out = await runMigration({ ...M1, argv: ["--apply"] });
  assert.equal(out.result.upserted, 1);

  const asha = await Customer.findById(web._id).lean();
  assert.equal(asha.name, "Asha (web)");
  assert.equal(asha.marketing.whatsappOptIn, true);
  assert.equal(asha.updatedAt.getTime(), before.getTime());

  const neha = await Customer.findOne({ phone: "9811111111" }).lean();
  assert.equal(neha.createdFrom, "backfill");
  assert.equal(neha.stats.visits, 1);
  assert.equal(neha.marketing.whatsappOptIn, false);
  assert.ok(neha.createdAt instanceof Date);

  // Re-run: nothing left to do.
  assert.equal((await runMigration({ ...M1, argv: ["--apply"] })).planned, 0);

  // The report never contains a full phone number or a name.
  const report = fs.readFileSync(out.file, "utf8");
  assert.doesNotMatch(report, /9811111111|Neha/);
});
