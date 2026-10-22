/**
 * @file counter.js
 * @description Staff side of counter UPI payments (D60, part A). Mounted at /api/counter.
 *
 *   GET  /status                 is the feature on, and is a tablet online (the chip)
 *   POST /sessions               price the sale on the server, make the QR
 *   GET  /sessions/:id           status (asks Razorpay at most once per 2 s per session)
 *   POST /sessions/:id/target    { target: "pc" } show the QR on the staff screen instead
 *   POST /sessions/:id/cancel    close the QR
 *   — owner / counter.manage only —
 *   POST   /pairings             { name } → a one-time 6-digit code, valid 5 minutes
 *   GET    /devices              paired tablets and whether each is online
 *   PATCH  /devices/:id          { name }
 *   DELETE /devices/:id          revoke (the tablet stops working at once)
 *
 * The whole router answers 404 unless COUNTER_DISPLAY_ENABLED=true; /status then
 * says {enabled:false} so the visit form falls back to Razorpay Checkout.
 *
 * Money rules (CLAUDE.md): the server prices the sale; the browser never sends an
 * amount. The Visit is saved by POST /visits/v2 with only `counterSessionId`.
 */

const express = require("express");
const crypto = require("crypto");
const connectDB = require("../db");
const CounterSession = require("../models/CounterSession");
const CounterDevice = require("../models/CounterDevice");
const CounterPairing = require("../models/CounterPairing");
const { authorizePermission } = require("../middleware/authMiddleware");
const { mongoRateLimit } = require("../middleware/mongoRateLimit");
const { PERMISSIONS } = require("../constants/permissions");
const counter = require("../utils/counter");
const audit = require("../utils/audit");

const router = express.Router();
const PAIRING_MINUTES = 5;
const STATUS_POLL_MS = 20_000;

router.use(async (req, res, next) => {
  if (!counter.isEnabled()) {
    if (req.method === "GET" && req.path === "/status") return res.json({ enabled: false });
    return res.status(404).json({ error: "Counter payments are switched off", enabled: false });
  }
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[counter] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

const forVisits = authorizePermission(PERMISSIONS.VISIT_CREATE);
const forOwner = authorizePermission(PERMISSIONS.COUNTER_MANAGE);
const who = (req) => ({ id: req.session.userId, name: req.session.name, role: req.session.role });

router.get("/status", forVisits, async (_req, res) => {
  try {
    const now = new Date();
    const devices = await CounterDevice.find({ revokedAt: null }, { name: 1, lastPollAt: 1, lastPollIntervalMs: 1 }).lean();
    const tablets = devices.map((d) => ({ id: String(d._id), name: d.name, online: counter.isOnline(d, now) }));
    res.set("Cache-Control", "no-store");
    res.json({ enabled: true, tablets, anyOnline: tablets.some((t) => t.online), nextPollMs: STATUS_POLL_MS });
  } catch (err) {
    console.error("[counter] status error:", err.message);
    res.status(500).json({ error: "Could not check the tablet" });
  }
});

router.post(
  "/sessions",
  forVisits,
  mongoRateLimit({ name: "counter-session", windowMs: 60_000, max: 20, keyBy: (req) => req.session?.userId && String(req.session.userId) }),
  async (req, res) => {
    try {
      const out = await counter.createSession({ user: who(req), body: req.body });
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error("[counter] create session error:", err.message);
      res.status(500).json({ error: "Could not start the payment" });
    }
  }
);

/** Load a session this person may see (their own, or any for the owner). */
async function mine(req, res) {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
    res.status(400).json({ error: "Invalid session" });
    return null;
  }
  const s = await CounterSession.findById(req.params.id);
  if (!s || (req.session.role !== "owner" && String(s.createdBy) !== String(req.session.userId))) {
    res.status(404).json({ error: "Payment session not found" });
    return null;
  }
  return s;
}

router.get("/sessions/:id", forVisits, async (req, res) => {
  try {
    const found = await mine(req, res);
    if (!found) return;
    const s = await counter.syncSession(found);
    res.set("Cache-Control", "no-store");
    res.json({ session: counter.view(s, { withQr: s.target === "pc" && s.status === "pending" }) });
  } catch (err) {
    console.error("[counter] get session error:", err.message);
    res.status(500).json({ error: "Could not check the payment" });
  }
});

router.post("/sessions/:id/target", forVisits, async (req, res) => {
  try {
    const s = await mine(req, res);
    if (!s) return;
    if (req.body?.target !== "pc") return res.status(400).json({ error: "target must be pc" });
    if (s.status !== "pending") return res.status(409).json({ error: "That payment is no longer waiting" });
    const updated = await CounterSession.findOneAndUpdate({ _id: s._id, status: "pending" }, { $set: { target: "pc" } }, { returnDocument: "after" });
    res.json({ session: counter.view(updated || s, { withQr: !!updated }) });
  } catch (err) {
    console.error("[counter] target error:", err.message);
    res.status(500).json({ error: "Could not switch screens" });
  }
});

router.post("/sessions/:id/cancel", forVisits, async (req, res) => {
  try {
    const s = await mine(req, res);
    if (!s) return;
    const after = await counter.cancelSession(s, "staff");
    res.json({ session: counter.view(after) });
  } catch (err) {
    console.error("[counter] cancel error:", err.message);
    res.status(500).json({ error: "Could not cancel the payment" });
  }
});

// ─── Owner: tablets ─────────────────────────────────────────────────────────

router.post("/pairings", forOwner, async (req, res) => {
  try {
    const name = String(req.body?.name || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Counter tablet";
    const now = new Date();
    let code;
    for (let i = 0; i < 5; i++) {
      code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const clash = await CounterPairing.exists({ codeHash: counter.sha256(`pair:${code}`), usedAt: null, expiresAt: { $gt: now } });
      if (!clash) break;
    }
    const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
    await CounterPairing.create({
      codeHash: counter.sha256(`pair:${code}`),
      deviceName: name,
      createdBy: req.session.userId,
      createdByName: req.session.name,
      expiresAt,
    });
    // The only time the code is ever shown.
    res.status(201).json({ code, name, expiresAt });
  } catch (err) {
    console.error("[counter] pairing error:", err.message);
    res.status(500).json({ error: "Could not create a pairing code" });
  }
});

router.get("/devices", forOwner, async (_req, res) => {
  try {
    const now = new Date();
    const devices = await CounterDevice.find({ revokedAt: null }).sort({ createdAt: 1 }).lean();
    res.json({
      devices: devices.map((d) => ({
        id: String(d._id),
        name: d.name,
        pairedBy: d.pairedByName,
        pairedAt: d.createdAt,
        lastSeenAt: d.lastPollAt,
        online: counter.isOnline(d, now),
      })),
    });
  } catch (err) {
    console.error("[counter] devices error:", err.message);
    res.status(500).json({ error: "Could not load tablets" });
  }
});

router.patch("/devices/:id", forOwner, async (req, res) => {
  try {
    const name = String(req.body?.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "Give the tablet a name" });
    const d = await CounterDevice.findOneAndUpdate({ _id: req.params.id, revokedAt: null }, { $set: { name } }, { returnDocument: "after" });
    if (!d) return res.status(404).json({ error: "Tablet not found" });
    res.json({ id: String(d._id), name: d.name });
  } catch (err) {
    console.error("[counter] rename error:", err.message);
    res.status(500).json({ error: "Could not rename" });
  }
});

router.delete("/devices/:id", forOwner, async (req, res) => {
  try {
    const d = await CounterDevice.findOneAndUpdate(
      { _id: req.params.id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedByName: req.session.name } },
      { returnDocument: "after" }
    );
    if (!d) return res.status(404).json({ error: "Tablet not found" });
    await audit.record({ action: "counter.device_revoked", req, target: { name: d.name }, meta: { deviceId: String(d._id) } });
    res.json({ revoked: true });
  } catch (err) {
    console.error("[counter] revoke error:", err.message);
    res.status(500).json({ error: "Could not revoke" });
  }
});

module.exports = router;
