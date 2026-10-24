/**
 * @file test/poster-reader.test.js
 * @description "Read a poster" (D63). The Claude call is replaced by a stub, so these tests cost
 * nothing and never touch the network.
 *
 * What must hold: the poster picture goes to the model as a link with a fixed answer shape;
 * the answer is tidied and each printed line is matched to the real menu (clear ones
 * pre-selected, ambiguous ones left for the owner, unknown ones never forced); NOTHING is saved
 * by reading; the route is owner-only work (website.manage), off without a key, capped per
 * person per day, and survives a refusal, a cut-off answer and garbage.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

process.env.TELEGRAM_BOT_TOKEN = "";

let Service, Campaign, AuditLog, reader, matcher;
let server;
let base;
let who;
let calls;
let reply;

const POSTER = {
  title: "Karva Chauth Special",
  packages: [
    { name: "Package 1", price: 3500, regularPrice: 7000, services: ["Bleach", "Paragon Facial", "Full Arm Wax", "Full Leg Wax", "Pedicure", "Head Wash", "Blowdry", "Threading", "Upperlips", "Forehead"] },
    { name: "Package 2", price: 4500, regularPrice: 9000, services: ["Kanpeki Facial", "Bleach / D-tan", "Full Arm Wax (Rica)", "Half Leg Wax (Rica)", "Manicure", "Pedicure", "Hairspa", "Haircut", "Headwash", "Blowdry"] },
    { name: "Package 3", price: 2500, regularPrice: 5000, services: ["Bleach", "Facial", "Half Arm Wax", "Pedicure"] },
  ],
  notes: ["Threading may be several areas."],
};

before(async () => {
  await startDb();
  Service = require("../models/Service");
  Campaign = require("../models/Campaign");
  AuditLog = require("../models/AuditLog");
  reader = require("../utils/posterReader");
  matcher = require("../utils/posterMatch");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...who };
    next();
  });
  app.use("/api/website", require("../routes/website"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/website`;
});

after(async () => {
  reader.setClientForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  await new Promise((r) => server.close(r));
  await stopDb();
});

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
const post = async (data) => {
  const res = await fetch(base + "/campaigns/read-poster", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const stub = () => ({
  messages: {
    create: async (args) => {
      calls.push(args);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  },
});
const answer = (obj, extra = {}) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }], ...extra });

beforeEach(async () => {
  await clearDb();
  who = OWNER;
  calls = [];
  reply = answer(POSTER);
  reader.setClientForTests(stub());
  const mk = (name, publicPrice, extra = {}) => ({ name, price: publicPrice * 2, publicPrice, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), isActive: true, showOnWebsite: true, bookingMode: "request", audience: "her", displayCategory: "Hair", durationMinutes: 30, ...extra });
  await Service.create([
    mk("Bleach (Face & Neck)", 400), mk("Bleach (Full Body)", 1500), mk("Paragon Facial", 1200), mk("Facial (Basic)", 700),
    mk("Full Arms Wax (Rica)", 600), mk("Full Arms Wax (Honey)", 400), mk("Half Leg Wax (Rica)", 500), mk("Pedicure", 700),
    mk("Head Wash", 200), mk("Blow Dry", 300), mk("Threading (Eyebrows)", 50), mk("Upper Lip Threading", 30), mk("Forehead Threading", 30),
    mk("Hair Spa", 800), mk("Haircut Women", 500), mk("Manicure", 500), mk("Retired Facial", 900, { isActive: false }), mk("Hidden Price", 100, { publicPrice: null }),
  ]);
});

test("the poster goes to the model as a link with a fixed answer shape, and the answer comes back as a draft", async () => {
  const r = await post({ imageUrl: "https://blob.example/karwa-poster.png" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(calls.length, 1);
  const a = calls[0];
  assert.equal(a.model, "claude-opus-5-5");
  assert.deepEqual(a.messages[0].content[0], { type: "image", source: { type: "url", url: "https://blob.example/karwa-poster.png" } });
  assert.equal(a.output_config.format.type, "json_schema");
  assert.equal(a.output_config.format.schema.additionalProperties, false);
  assert.equal(a.thinking, undefined, "thinking is left on its default");
  assert.equal(r.body.title, "Karva Chauth Special");
  assert.deepEqual(r.body.packages.map((p) => [p.name, p.price, p.regularPrice, p.lines.length]), [["Package 1", 3500, 7000, 10], ["Package 2", 4500, 9000, 10], ["Package 3", 2500, 5000, 4]]);
  assert.deepEqual(r.body.notes, ["Threading may be several areas."]);
});

test("clear lines are pre-matched to the menu; ambiguous or unknown ones are left for the owner, never forced", async () => {
  const r = await post({ imageUrl: "https://blob.example/p.png" });
  const p1 = r.body.packages[0];
  const by = (line) => p1.lines.find((l) => l.line === line);
  assert.equal(by("Paragon Facial").match.name, "Paragon Facial");
  assert.equal(by("Pedicure").match.name, "Pedicure");
  assert.equal(by("Head Wash").match.name, "Head Wash");
  assert.equal(by("Blowdry").match.name, "Blow Dry");
  assert.equal(by("Upperlips").match.name, "Upper Lip Threading");
  assert.equal(by("Bleach").match, null, "two bleaches on the menu: the owner chooses");
  assert.ok(by("Bleach").candidates.length >= 2);
  assert.equal(by("Full Arm Wax").match, null, "Rica or Honey: the owner chooses");
  assert.ok(by("Full Arm Wax").candidates.every((c) => /wax/i.test(c.name)));
  const p2 = r.body.packages[1];
  assert.equal(p2.lines.find((l) => l.line === "Kanpeki Facial").match, null, "not on the menu: never forced onto Paragon");
  assert.equal(p2.lines.find((l) => l.line === "Half Leg Wax (Rica)").match.name, "Half Leg Wax (Rica)");
  assert.equal(p2.lines.find((l) => l.line === "Hairspa").match.name, "Hair Spa");
  // only services that are on the website menu can ever be offered
  const offered = JSON.stringify(r.body);
  assert.ok(!offered.includes("Retired Facial") && !offered.includes("Hidden Price"));
  assert.equal(p1.separatelyTotal, p1.lines.filter((l) => l.match).reduce((n, l) => n + l.match.price, 0));
});

test("reading saves nothing and is audited", async () => {
  await post({ imageUrl: "https://blob.example/p.png" });
  assert.equal(await Campaign.countDocuments(), 0);
  const rows = await AuditLog.find({ action: "website.poster_read" }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.packages, 3);
  assert.ok(!JSON.stringify(rows[0]).includes("blob.example"), "the audit row holds counts, not the picture link");
});

test("only a clean https link is accepted", async () => {
  for (const bad of ["", "http://blob.example/p.png", "ftp://x/p.png", "javascript:alert(1)", "not a link", null, 5]) {
    assert.equal((await post({ imageUrl: bad })).status, 400, String(bad));
  }
  assert.equal(calls.length, 0, "the model is never called for a bad link");
});

test("without a key the route says so plainly and calls nothing", async () => {
  reader.setClientForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  const r = await post({ imageUrl: "https://blob.example/p.png" });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /isn't set up/);
  assert.equal(calls.length, 0);
});

test("a refusal, a cut-off answer, garbage, an API error and an unreadable picture each give a calm message", async () => {
  const ask = async () => post({ imageUrl: "https://blob.example/p.png" });
  reply = { stop_reason: "refusal", content: [] };
  assert.equal((await ask()).status, 422);
  reply = answer(POSTER, { stop_reason: "max_tokens" });
  assert.equal((await ask()).status, 422);
  reply = { stop_reason: "end_turn", content: [{ type: "text", text: "sorry, here is a poem" }] };
  assert.equal((await ask()).status, 502);
  reply = Object.assign(new Error("overloaded"), { status: 529 });
  const down = await ask();
  assert.equal(down.status, 502);
  assert.doesNotMatch(JSON.stringify(down.body), /overloaded/, "no provider detail reaches the browser");
  reply = Object.assign(new Error("bad image"), { status: 400 });
  assert.equal((await ask()).status, 422);
});

test("a picture with no packages on it is told so", async () => {
  reply = answer({ title: null, packages: [], notes: ["This looks like a photo of a salon chair, not an offer poster."] });
  const r = await post({ imageUrl: "https://blob.example/p.png" });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /salon chair/);
});

test("the answer is tidied: whole rupees, sane sizes, junk dropped", async () => {
  reply = answer({
    title: "  Diwali   Offer ",
    packages: [
      { name: "", price: 2999.6, regularPrice: -5, services: ["  Hair   Spa ", "", "x".repeat(300)] },
      { name: "Empty", price: null, regularPrice: null, services: [] },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, price: 100, regularPrice: null, services: ["Pedicure"] })),
    ],
    notes: Array.from({ length: 30 }, (_, i) => `note ${i}`),
  });
  const r = await post({ imageUrl: "https://blob.example/p.png" });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, "Diwali Offer");
  assert.equal(r.body.packages.length, 12);
  assert.deepEqual([r.body.packages[0].name, r.body.packages[0].price, r.body.packages[0].regularPrice], ["Package 1", 3000, null]);
  assert.equal(r.body.packages[0].lines[0].line, "Hair Spa");
  assert.equal(r.body.packages[0].lines[1].line.length, 80);
  assert.ok(r.body.packages.every((p) => p.name !== "Empty"));
  assert.equal(r.body.notes.length, 10);
});

test("20 reads per person per day, then a calm stop", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await post({ imageUrl: "https://blob.example/p.png" })).status, 200, `read ${i + 1}`);
  const r = await post({ imageUrl: "https://blob.example/p.png" });
  assert.equal(r.status, 429);
  assert.equal(calls.length, 20);
  who = { userId: new mongoose.Types.ObjectId(), name: "Other owner", role: "owner" };
  assert.equal((await post({ imageUrl: "https://blob.example/p.png" })).status, 200, "another person has their own allowance");
});

test("word matching: spelling variants, plurals and one-letter slips agree; different words do not", () => {
  const t = matcher.tokens;
  assert.deepEqual(t("Headwash"), t("Head Wash"));
  assert.deepEqual(t("Upper lips"), t("Upper Lip"));
  assert.deepEqual(t("Blow-dry"), t("Blow Dry"));
  assert.ok(matcher.score(t("Manicur"), t("Manicure")) >= 0.9, "a one-letter slip in a long word is forgiven");
  assert.ok(matcher.score(t("Half Leg Wax"), t("Full Leg Wax")) < 0.9, "half is not full");
  assert.equal(matcher.score(t("Pedicure"), t("Facial")), 0);
});
