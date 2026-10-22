/**
 * @file counterDisplay.js
 * @description What the counter tablet may call (D60, part A). Mounted at /api/display,
 * ABOVE the session middleware: the tablet has no staff session and never gets a cookie.
 *
 *   POST /pair    { code }   redeem the owner's one-time code → the tablet's token (once)
 *   GET  /state              what to show now + how long to wait before asking again
 *
 * /pair is the one unauthenticated door, so it is the one with the strict limits:
 * 5 attempts a minute per IP, and each wrong guess counts against every live code
 * (5 wrong tries lock a code; it is single use and lasts 5 minutes). /state is
 * authenticated and throttled per device by middleware/deviceAuth.js.
 *
 * The tablet receives an amount and a QR. No customer name, phone or service
 * ever reaches it.
 */

const express = require("express");
const crypto = require("crypto");
const connectDB = require("../db");
const CounterPairing = require("../models/CounterPairing");
const CounterDevice = require("../models/CounterDevice");
const { mongoRateLimit } = require("../middleware/mongoRateLimit");
const { deviceAuth } = require("../middleware/deviceAuth");
const counter = require("../utils/counter");
const audit = require("../utils/audit");

const router = express.Router();
const MAX_WRONG_TRIES = 5;

router.use((_req, res, next) => {
  if (!counter.isEnabled()) return res.status(404).json({ error: "Counter display is switched off", enabled: false });
  next();
});

router.post("/pair", mongoRateLimit({ name: "display-pair", windowMs: 60_000, max: 5 }), async (req, res) => {
  try {
    await connectDB();
    const code = String(req.body?.code ?? "").replace(/\s+/g, "");
    const refuse = () => res.status(400).json({ error: "That code did not work. Check it, or ask the owner for a new one." });
    if (!/^\d{6}$/.test(code)) return refuse();

    const now = new Date();
    const live = { usedAt: null, expiresAt: { $gt: now }, wrongTries: { $lt: MAX_WRONG_TRIES } };
    const pairing = await CounterPairing.findOneAndUpdate(
      { codeHash: counter.sha256(`pair:${code}`), ...live },
      { $set: { usedAt: now } },
      { returnDocument: "after" }
    );
    if (!pairing) {
      // A wrong guess cannot be tied to one code, so it counts against every live one.
      await CounterPairing.updateMany(live, { $inc: { wrongTries: 1 } });
      return refuse(); // same answer for wrong, used, expired and locked: no oracle
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const device = await CounterDevice.create({
      name: pairing.deviceName,
      tokenHash: counter.sha256(token),
      pairedBy: pairing.createdBy,
      pairedByName: pairing.createdByName,
    });
    await CounterPairing.updateOne({ _id: pairing._id }, { $set: { deviceId: device._id } });
    await audit.record({
      action: "counter.device_paired",
      actor: { id: pairing.createdBy, name: pairing.createdByName, role: "owner" },
      target: { name: device.name },
      meta: { deviceId: String(device._id) },
      req,
    });
    return res.json({ token, name: device.name });
  } catch (err) {
    console.error("[display] pair error:", err.message);
    return res.status(500).json({ error: "Could not pair. Try again." });
  }
});

router.get("/state", deviceAuth, async (req, res) => {
  try {
    const state = await counter.displayState(new Date());
    // Remember how often we asked this tablet to come back, so "offline" means "missed its own schedule".
    if (req.device.lastPollIntervalMs !== state.nextPollMs) {
      await CounterDevice.updateOne({ _id: req.device._id }, { $set: { lastPollIntervalMs: state.nextPollMs } });
    }
    res.set("Cache-Control", "no-store");
    return res.json({ ...state, device: req.device.name });
  } catch (err) {
    console.error("[display] state error:", err.message);
    return res.status(500).json({ error: "Could not load the display" });
  }
});

module.exports = router;
