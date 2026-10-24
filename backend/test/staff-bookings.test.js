/**
 * @file test/staff-bookings.test.js
 * @description Staff side of Phase 1: the shared rate limiter across instances
 * (T1.6), the Requests API (T1.10, T1.11) and owner website editing (T1.2, T1.5).
 *
 * Routers are mounted behind a stub session so each test chooses who is
 * calling: the owner (bypasses PBAC) or a receptionist with explicit permissions.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let Appointment, AuditLog, Artist, Service, SiteSettings, User, evictPermissionCache;
let server;
let base;
/** Who the stub session says is calling. Set per test. */
let caller;

before(async () => {
  await startDb();
  Appointment = require("../models/Appointment");
  AuditLog = require("../models/AuditLog");
  Artist = require("../models/Artist");
  Service = require("../models/Service");
  SiteSettings = require("../models/SiteSettings");
  User = require("../models/User");
  ({ evictPermissionCache } = require("../middleware/authMiddleware"));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...caller };
    next();
  });
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/website", require("../routes/website"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const OWNER = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };

beforeEach(async () => {
  await clearDb();
  caller = OWNER;
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

let userN = 0;
async function receptionist(permissions) {
  const u = await User.collection.insertOne({
    name: "Reena",
    email: `reena${++userN}@example.com`,
    role: "receptionist",
    isActive: true,
    permissions,
  });
  evictPermissionCache?.(String(u.insertedId));
  caller = { userId: u.insertedId, name: "Reena", role: "receptionist" };
}

/** Confirming a request needs an artist (audit item 3). */
async function theArtist() {
  return (await Artist.findOne({ phone: "9888800001" })) || Artist.create({ name: "Mansi", phone: "9888800001" });
}

let refN = 0;
async function makeRequest(over = {}) {
  return Appointment.create({
    ref: `EXP-T${String(++refN).padStart(4, "2")}`,
    mode: "request",
    status: "requested",
    contact: "9876543210",
    name: "Asha",
    guests: [
      {
        guestKey: "g1",
        name: "Asha",
        gender: "female",
        items: [
          { serviceId: new mongoose.Types.ObjectId(), name: "Hydra Facial", publicPrice: 1550, listPrice: 3100, durationMin: 60, bufferMin: 0 },
          { serviceId: new mongoose.Types.ObjectId(), name: "Eyebrows", publicPrice: 50, listPrice: 100, durationMin: 15, bufferMin: 5 },
        ],
      },
    ],
    requestedWindow: { date: "2026-10-29", window: "afternoon" },
    pricing: { subtotal: 1600, total: 1600 },
    source: { channel: "web", utm: { source: "instagram", campaign: "kc26" } },
    statusHistory: [{ from: null, to: "requested", at: new Date(), by: "customer" }],
    ...over,
  });
}

// ── T1.6: the limit holds across instances ───────────────────────────────────

test("rate limit is enforced across two app instances sharing the database", async () => {
  const { mongoRateLimit } = require("../middleware/mongoRateLimit");
  const makeInstance = async () => {
    const app = express();
    app.get("/x", mongoRateLimit({ name: "cross", windowMs: 60_000, max: 5, keyBy: () => "same-visitor" }), (_req, res) =>
      res.json({ ok: true })
    );
    const s = await new Promise((r) => {
      const srv = app.listen(0, () => r(srv));
    });
    return s;
  };
  const a = await makeInstance();
  const b = await makeInstance();
  try {
    const urls = [a, b].map((s) => `http://127.0.0.1:${s.address().port}/x`);
    const statuses = await Promise.all(Array.from({ length: 10 }, (_, i) => fetch(urls[i % 2]).then((r) => r.status)));
    assert.equal(statuses.filter((s) => s === 200).length, 5);
    assert.equal(statuses.filter((s) => s === 429).length, 5);
  } finally {
    await Promise.all([a, b].map((s) => new Promise((r) => s.close(r))));
  }
});

// ── T1.11: permissions ───────────────────────────────────────────────────────

test("bookings.view lets reception see requests; confirming needs bookings.manage", async () => {
  const appt = await makeRequest();

  await receptionist([]);
  assert.equal((await call("GET", "/bookings/requests")).status, 403);

  await receptionist(["bookings.view"]);
  const list = await call("GET", "/bookings/requests");
  assert.equal(list.status, 200);
  assert.equal(list.body.requests.length, 1);
  assert.equal(list.body.counts.requested, 1);
  assert.equal(list.body.requests[0].utm.campaign, "kc26");
  assert.equal(list.body.requests[0].items[0].price, 1550);
  assert.equal(JSON.stringify(list.body).includes("3100"), false, "list price stays out of the staff list");

  const denied = await call("POST", `/bookings/${appt._id}/confirm`, { date: "2026-10-29", time: "14:30" });
  assert.equal(denied.status, 403);
});

test("new permissions are registered with labels and groups for the editor", () => {
  const { PERMISSIONS, PERMISSION_LABELS, PERMISSION_GROUPS, ROLE_DEFAULTS } = require("../constants/permissions");
  for (const key of [PERMISSIONS.BOOKINGS_VIEW, PERMISSIONS.BOOKINGS_MANAGE, PERMISSIONS.WEBSITE_MANAGE]) {
    assert.ok(PERMISSION_LABELS[key], key);
    assert.ok(PERMISSION_GROUPS.some((g) => g.keys.includes(key)), key);
  }
  assert.ok(ROLE_DEFAULTS.receptionist.includes("bookings.manage"));
  assert.ok(!ROLE_DEFAULTS.receptionist.includes("website.manage"));
});

// ── T1.10: confirm with time ─────────────────────────────────────────────────

test("confirm with time: IST time stored as UTC, items chained, artist assigned, audited", async () => {
  const appt = await makeRequest();
  const artist = await theArtist();

  const res = await call("POST", `/bookings/${appt._id}/confirm`, { date: "2026-10-29", time: "14:30", artistId: String(artist._id) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.request.status, "confirmed");

  const saved = await Appointment.findById(appt._id).lean();
  assert.equal(saved.startAt.toISOString(), "2026-10-29T09:00:00.000Z"); // 14:30 IST
  const [facial, brows] = saved.guests[0].items;
  assert.equal(facial.endAt.toISOString(), "2026-10-29T10:00:00.000Z");
  assert.equal(brows.startAt.toISOString(), "2026-10-29T10:00:00.000Z");
  assert.equal(brows.endAt.toISOString(), "2026-10-29T10:15:00.000Z");
  // 15 min + 5 min buffer, rounded up to the 15-minute blocks a slot lock is made of (audit item 3).
  assert.equal(saved.endAt.toISOString(), "2026-10-29T10:30:00.000Z");
  assert.equal(facial.artistName, "Mansi");
  assert.equal(facial.listPrice, 3100); // snapshot untouched
  assert.deepEqual(saved.statusHistory.map((h) => h.to), ["requested", "confirmed"]);
  assert.equal(saved.statusHistory[1].by, "Owner");

  const log = await AuditLog.findOne({ action: "booking.confirmed" }).lean();
  assert.equal(log.meta.ref, appt.ref);
});

test("two people confirming at once: one wins, the other is told it's already handled", async () => {
  const appt = await makeRequest();
  const artistId = String((await theArtist())._id);
  const [a, b] = await Promise.all([
    call("POST", `/bookings/${appt._id}/confirm`, { date: "2026-10-29", time: "11:00", artistId }),
    call("POST", `/bookings/${appt._id}/confirm`, { date: "2026-10-29", time: "17:00", artistId }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const saved = await Appointment.findById(appt._id).lean();
  assert.equal(saved.statusHistory.filter((h) => h.to === "confirmed").length, 1);
});

test("decline and cancel follow the state machine; nothing is deleted", async () => {
  const appt = await makeRequest();
  assert.equal((await call("POST", `/bookings/${appt._id}/cancel`, {})).status, 409); // not confirmed yet

  const declined = await call("POST", `/bookings/${appt._id}/decline`, { reason: "Fully booked that day" });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.request.status, "declined");
  const artistId = String((await theArtist())._id);
  assert.equal((await call("POST", `/bookings/${appt._id}/confirm`, { date: "2026-10-29", time: "11:00", artistId })).status, 409);

  const other = await makeRequest();
  await call("POST", `/bookings/${other._id}/confirm`, { date: "2026-10-29", time: "11:00", artistId });
  const cancelled = await call("POST", `/bookings/${other._id}/cancel`, { reason: "Customer called" });
  assert.equal(cancelled.body.request.status, "cancelled");
  const saved = await Appointment.findById(other._id).lean();
  assert.equal(saved.cancelledBy, "salon");
  assert.equal(await Appointment.countDocuments(), 2);
  assert.equal(await AuditLog.countDocuments({ action: { $in: ["booking.declined", "booking.cancelled"] } }), 2);
});

test("staff note is saved, audited once, and validated", async () => {
  const appt = await makeRequest();
  const res = await call("PATCH", `/bookings/${appt._id}/note`, { note: "Wants Mansi; called, no answer" });
  assert.equal(res.body.request.internalNote, "Wants Mansi; called, no answer");
  await call("PATCH", `/bookings/${appt._id}/note`, { note: "Wants Mansi; called, no answer" });
  assert.equal(await AuditLog.countDocuments({ action: "booking.note_changed" }), 1);
  assert.equal((await call("PATCH", `/bookings/${appt._id}/note`, { note: "x".repeat(501) })).status, 400);
});

test("confirm rejects a bad date or time", async () => {
  const appt = await makeRequest();
  assert.equal((await call("POST", `/bookings/${appt._id}/confirm`, { date: "2026-02-30", time: "11:00" })).status, 400);
  assert.equal((await call("POST", `/bookings/${appt._id}/confirm`, { date: "2026-10-29", time: "7pm" })).status, 400);
});

// ── Website editing (website.manage) ─────────────────────────────────────────

test("website settings: owner sets contact and hours; bad values refused; changes audited", async () => {
  const ok = await call("PATCH", "/website/settings", {
    contact: { whatsapp: "9876500000", instagram: "@theexperts" },
    openingHours: { tue: [] },
    holidays: ["2026-11-08", "2026-11-08"],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const s = await SiteSettings.getSingleton();
  assert.equal(s.contact.whatsapp, "9876500000");
  assert.equal(s.contact.instagram, "theexperts");
  assert.deepEqual(s.toObject().openingHours.tue, []);
  assert.deepEqual(s.holidays, ["2026-11-08"]);
  const log = await AuditLog.findOne({ action: "website.settings_changed" }).lean();
  assert.ok(log.meta.changes["contact.whatsapp"]);

  assert.equal((await call("PATCH", "/website/settings", { contact: { phone: "+91 98765" } })).status, 400);
  assert.equal((await call("PATCH", "/website/settings", { openingHours: { mon: [{ open: "20:00", close: "09:00" }] } })).status, 400);
  assert.equal((await call("PATCH", "/website/settings", { contact: { mapUrl: "https://evil.example" } })).status, 400);
});

test("website editing needs website.manage", async () => {
  await receptionist(["bookings.view", "bookings.manage"]);
  assert.equal((await call("GET", "/website/settings")).status, 403);
});

test("artist public profile: editable, hide / unhide, audited (T1.2, K6)", async () => {
  const a = await Artist.create({ name: "Mansi Kumari", phone: "9888800001", commission: 40 });
  const hide = await call("PATCH", `/website/artists/${a._id}/public`, { publicProfile: { visible: false } });
  assert.equal(hide.status, 200);
  assert.equal((await Artist.findById(a._id).lean()).publicProfile.visible, false);
  const follow = await call("PATCH", `/website/artists/${a._id}/public`, { publicProfile: { visible: null } });
  assert.equal(follow.status, 200);
  assert.equal((await Artist.findById(a._id).lean()).publicProfile.visible, null);

  const ok = await call("PATCH", `/website/artists/${a._id}/public`, {
    gender: "female",
    level: "senior",
    publicProfile: { slug: "mansi", displayName: "Mansi", specialties: ["Colour", "Bridal"], visible: true },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = await Artist.findById(a._id).lean();
  assert.equal(saved.publicProfile.visible, true);
  assert.equal(saved.commission, 40); // untouched
  assert.ok(await AuditLog.findOne({ action: "website.artist_profile_changed" }));

  const b = await Artist.create({ name: "Other", phone: "9888800002" });
  assert.equal((await call("PATCH", `/website/artists/${b._id}/public`, { publicProfile: { slug: "mansi" } })).status, 409);

  const list = await call("GET", "/website/artists");
  assert.equal(list.body[0].commission, undefined);
  assert.equal(list.body[0].phone, undefined);
});

test("service website fields: needs price + slug to go live; instant needs a duration", async () => {
  const s = await Service.create({ name: "Hydra Facial", price: 3100 });
  assert.equal((await call("PATCH", `/website/services/${s._id}/public`, { showOnWebsite: true })).status, 400);

  const ok = await call("PATCH", `/website/services/${s._id}/public`, {
    showOnWebsite: true,
    slug: "hydra-facial",
    publicPrice: 1550,
    audience: "her",
    displayCategory: "Skin",
    bookingMode: "request",
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const instant = await call("PATCH", `/website/services/${s._id}/public`, { bookingMode: "instant" });
  assert.equal(instant.status, 400);
  assert.match(instant.body.error, /duration/i);
  assert.equal((await call("PATCH", `/website/services/${s._id}/public`, { displayCategory: "Spa" })).status, 400);
});
