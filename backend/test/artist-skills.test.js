/**
 * @file test/artist-skills.test.js
 * @description Artist skills (CF D35): every artist can do everything by
 * default; the owner narrows it per gender or per artist, by section, menu
 * sub-group or single service; the booking engine follows it.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const { effectiveRule, ruleAllows, serviceKeys, ruleSets } = require("../utils/skills");
const { canDo } = require("../utils/availability");

let server, base, Artist, Service, AuditLog;

before(async () => {
  await startDb();
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  AuditLog = require("../models/AuditLog");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
    next();
  });
  app.use("/api/artist-skills", require("../routes/artistSkills"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/artist-skills`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});
beforeEach(() => clearDb());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test("rules: all by default; section, sub-group and single service each allow; gender default vs own rule", () => {
  const eyebrows = { _id: "s1", name: "Eyebrows", displayCategory: "Threading" };
  const beard = { _id: "s2", name: "Beard Trim", displayCategory: "Grooming" };
  const hd = { _id: "s3", name: "Basic Bridal Make-up", displayCategory: "Makeup" };
  const k = (s) => serviceKeys(s);
  const defaults = { female: { all: false, categories: ["Threading"], groups: ["makeup"] }, male: { all: false, categories: ["Grooming"] } };

  assert.ok(ruleAllows(effectiveRule({ gender: "female" }, {}), k(beard)), "no defaults saved = all services");
  const her = effectiveRule({ gender: "female" }, defaults);
  assert.ok(ruleAllows(her, k(eyebrows)) && ruleAllows(her, k(hd)) && !ruleAllows(her, k(beard)));
  const him = effectiveRule({ gender: "male" }, defaults);
  assert.ok(ruleAllows(him, k(beard)) && !ruleAllows(him, k(eyebrows)));
  const own = effectiveRule({ gender: "male", skillMode: "custom", skillAll: false, skills: ["s1"] }, defaults);
  assert.ok(ruleAllows(own, k(eyebrows)) && !ruleAllows(own, k(beard)), "own rule replaces the gender default");
  assert.ok(ruleAllows(effectiveRule({ gender: null }, { other: { all: true } }), k(hd)), "no gender → 'other' default");
});

test("engine: canDo follows the rule (all, section, sub-group)", () => {
  const item = { serviceId: "s9", category: "Waxing", group: "honey-waxing" };
  assert.ok(canDo({ ...ruleSets({ all: true, categories: [], groups: [], services: [] }) }, item));
  assert.ok(canDo({ ...ruleSets({ all: false, categories: [], groups: ["honey-waxing"], services: [] }) }, item));
  assert.ok(!canDo({ ...ruleSets({ all: false, categories: ["Threading"], groups: [], services: [] }) }, item));
});

test("staff screen: tree, gender default and artist rule are saved, counted and audited", async () => {
  const common = { category: "Hair", isActive: true, price: 100 };
  const [eyebrows, chin, beard] = await Service.create([
    { ...common, name: "Eyebrows", displayCategory: "Skin" },
    { ...common, name: "Chin (Thread)", displayCategory: "Threading" },
    { ...common, name: "Beard Trim", displayCategory: "Grooming" },
  ]);
  const [asha, ravi] = await Artist.create([
    { name: "Asha", phone: "9000000011", gender: "female" },
    { name: "Ravi", phone: "9000000012", gender: "male" },
  ]);

  let s = (await call("GET", "/")).body;
  assert.equal(s.totalServices, 3);
  assert.deepEqual(s.defaults.female, { all: true, categories: [], groups: [], services: [] });
  assert.ok(s.artists.every((a) => a.skillMode === "inherit" && a.allowed === 3), "everyone can do everything to start");
  const threading = s.tree.find((sec) => sec.category === "Threading");
  assert.deepEqual(threading.groups.map((g) => g.slug), ["threading"]);
  assert.equal(threading.groups[0].services.length, 2, "Eyebrows joins its sub-group under Threading");

  assert.equal((await call("PATCH", "/defaults/female", { rule: { all: false, categories: ["Unknown"] } })).status, 400);
  assert.equal((await call("PATCH", "/defaults/female", { rule: { all: false, groups: ["threading"] } })).status, 200);
  assert.equal((await call("PATCH", `/${ravi._id}`, { mode: "custom", rule: { all: false, services: [String(beard._id)] } })).status, 200);

  s = (await call("GET", "/")).body;
  const by = Object.fromEntries(s.artists.map((a) => [a.name, a]));
  assert.equal(by.Asha.allowed, 2, "female default: threading sub-group = Eyebrows + Chin");
  assert.equal(by.Ravi.allowed, 1);
  assert.equal(by.Ravi.skillMode, "custom");

  await call("PATCH", `/${ravi._id}`, { mode: "inherit" });
  s = (await call("GET", "/")).body;
  assert.equal(s.artists.find((a) => a.name === "Ravi").allowed, 3, "back to the male default (all)");

  const actions = (await AuditLog.find({}).lean()).map((l) => l.action).sort();
  assert.deepEqual(actions, ["artist.skills_changed", "artist.skills_changed", "artist.skills_default_changed"]);
  void eyebrows; void chin; void asha;
});
