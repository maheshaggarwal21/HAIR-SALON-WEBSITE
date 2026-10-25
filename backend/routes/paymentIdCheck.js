/**
 * @file routes/paymentIdCheck.js
 * @description The "Payment ID check: Log only / Enforce" switch in the staff app sidebar (audit #1, D70).
 *
 *   GET /  -> { mode }
 *   PUT /  { mode: "log" | "enforce" } -> { mode }
 *
 * Who: the owner, and anyone holding `visit.create` (the desk, who are the ones blocked by a refused sale and
 * need to switch back) or `datafixes.manage` (who read the Payment log errors list). Permissions are stored
 * per account, so the route accepts either rather than assuming which one an account has.
 *
 * The mode lives in SiteSettings.paymentIdCheck ("log" by default). Every real change is audited as
 * `payment.id_check_mode_changed` with who changed it and tells the owner on Telegram at once. Saving the
 * mode it already has changes nothing and writes nothing. This route never changes a sale or a payment.
 */

const express = require("express");
const connectDB = require("../db");
const SiteSettings = require("../models/SiteSettings");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const audit = require("../utils/audit");
const paymentIdCheck = require("../utils/paymentIdCheck");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[payment-id-check] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});
router.use(authorizePermission([PERMISSIONS.VISIT_CREATE, PERMISSIONS.DATAFIXES_MANAGE]));

router.get("/", async (_req, res) => {
  try {
    return res.json({ mode: (await SiteSettings.getSingleton()).paymentIdCheck === "enforce" ? "enforce" : "log" });
  } catch (err) {
    console.error("[payment-id-check] read failed:", err);
    return res.status(500).json({ error: "Could not read the setting" });
  }
});

router.put("/", async (req, res) => {
  const mode = req.body?.mode;
  if (typeof mode !== "string" || !paymentIdCheck.MODES.includes(mode)) return res.status(400).json({ error: 'mode must be "log" or "enforce"' });
  try {
    const before = (await SiteSettings.getSingleton()).paymentIdCheck === "enforce" ? "enforce" : "log";
    await SiteSettings.updateOne({ key: "default" }, { $set: { paymentIdCheck: mode } });
    paymentIdCheck.clearModeCache();
    if (before !== mode) {
      await audit.record({ action: "payment.id_check_mode_changed", req, target: { name: "Payment ID check" }, meta: { from: before, to: mode } });
      await paymentIdCheck.alertModeChanged({ from: before, to: mode, who: req.session?.name });
    }
    return res.json({ mode });
  } catch (err) {
    console.error("[payment-id-check] save failed:", err);
    return res.status(500).json({ error: "Could not save the setting" });
  }
});

module.exports = router;
