/**
 * @file test/artist-skills-permission.test.js
 * @description `artistskills.manage`: a permission the owner can tick for a person (staff permission checklist) to see and change
 * "Artist Skills" (who can be booked for which services, D35) WITHOUT also getting the Artists directory. It is in
 * ADDITION to artists.view / artists.crud, which opened Artist Skills before, so nobody loses access. It is NOT on by
 * default for any role: it changes who customers can book, so the owner ticks it on purpose.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const { PERMISSIONS, PERMISSION_LABELS, PERMISSION_GROUPS, ROLE_DEFAULTS } = require("../constants/permissions");

let shim, base, caller, User, Artist, AuditLog, evictPermissionCache;
const KEY = PERMISSIONS.ARTIST_SKILLS_MANAGE;

before(async () => {
  await startDb();
  User = require("../models/User");
  Artist = require("../models/Artist");
  AuditLog = require("../models/AuditLog");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));
  const s = express();
  s.use(express.json());
  s.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  s.use("/api/artist-skills", require("../routes/artistSkills"));
  s.use("/api/artists", require("../routes/artists"));
  await new Promise((r) => (shim = s.listen(0, r)));
  base = `http://127.0.0.1:${shim.address().port}`;
});
after(async () => {
  await new Promise((r) => shim.close(r));
  await stopDb();
});
beforeEach(() => clearDb());

const as = async (role, permissions) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, name: "Reena", email: `${_id}@t.example`, role, isActive: true, permissions });
  evictPermissionCache(String(_id));
  caller = { userId: _id, name: "Reena", role };
};
const call = (method, p, body) =>
  fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const artist = () => Artist.create({ name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female" });

test("the permission exists, is labelled so it shows in the checklist under Artists, and is NOT on by default for any role", () => {
  assert.equal(KEY, "artistskills.manage");
  assert.match(PERMISSION_LABELS[KEY], /Artist Skills/);
  const group = PERMISSION_GROUPS.find((g) => g.keys.includes(KEY));
  assert.equal(group?.label, "Artists");
  for (const role of ["owner", "manager", "receptionist", "artist"]) assert.ok(!ROLE_DEFAULTS[role].includes(KEY), `${role} does not get it automatically`);
});

test("with ONLY the new permission a person can see Artist Skills, change the gender default and an artist's rule, and it is audited", async () => {
  const a = await artist();
  await as("receptionist", [KEY]);
  const view = await call("GET", "/api/artist-skills");
  assert.equal(view.status, 200);
  assert.equal(view.body.artists.length, 1);
  assert.equal((await call("PATCH", "/api/artist-skills/defaults/female", { rule: { all: false, categories: [], groups: [], services: [] } })).status, 200);
  assert.equal((await call("PATCH", `/api/artist-skills/${a._id}`, { mode: "custom", rule: { all: true } })).status, 200);
  const rows = await AuditLog.find({ action: { $in: ["artist.skills_changed", "artist.skills_default_changed"] } }).lean();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.actorName === "Reena" && r.actorRole === "receptionist"), "who changed it");
});

test("the new permission does NOT open the Artists directory (managing artists stays separate)", async () => {
  await as("receptionist", [KEY]);
  assert.equal((await call("GET", "/api/artists/all")).status, 403, "the full directory");
  assert.equal((await call("POST", "/api/artists", { name: "New Artist", phone: "9888800002", commission: 40, gender: "female" })).status, 403, "creating an artist");
  assert.equal((await call("DELETE", `/api/artists/${new mongoose.Types.ObjectId()}`)).status, 403, "deactivating an artist");
});

test("nobody loses access: artists.view still sees it but cannot change it; artists.crud can still change it", async () => {
  const a = await artist();
  await as("manager", ["artists.view"]);
  assert.equal((await call("GET", "/api/artist-skills")).status, 200);
  assert.equal((await call("PATCH", `/api/artist-skills/${a._id}`, { mode: "inherit" })).status, 403);
  await as("manager", ["artists.crud"]);
  assert.equal((await call("PATCH", `/api/artist-skills/${a._id}`, { mode: "inherit" })).status, 200);
});

test("without any of them, Artist Skills is closed (403); the owner is never blocked", async () => {
  const a = await artist();
  await as("receptionist", ["visit.create", "datafixes.manage"]);
  assert.equal((await call("GET", "/api/artist-skills")).status, 403);
  assert.equal((await call("PATCH", `/api/artist-skills/${a._id}`, { mode: "inherit" })).status, 403);
  assert.equal((await call("PATCH", "/api/artist-skills/defaults/female", { rule: { all: true } })).status, 403);
  await as("owner", []);
  assert.equal((await call("GET", "/api/artist-skills")).status, 200);
});
