/**
 * @file cashClose.js
 * @description Daily cash close — count the drawer, then see how it compares (D60, part C).
 *
 *   GET  /day/:day         what the screen needs BEFORE counting: whether the day is
 *                          closed, the suggested opening float. Never the expected cash.
 *   POST /                 { day, countedCash, openingFloat?, leftInDrawer, cashTakenOut?, note? }
 *                          closes the day, once; answers with expected cash and the difference
 *   GET  /?days=14         recent closes (and which days are still open)
 *   POST /:day/adjustments { delta, reason }   owner only; appends, never edits
 *
 * Needs cashclose.manage (receptionist and manager by default; the owner always).
 *
 * The blind count: the "before counting" answer deliberately carries no cash figure
 * for the day, and a closed record can never be resubmitted or edited by anyone through
 * this API. The day is the IST calendar day of Visit.date, like every revenue report.
 */

const express = require("express");
const connectDB = require("../db");
const Visit = require("../models/Visit");
const DailyCashClose = require("../models/DailyCashClose");
const { authorize, authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const audit = require("../utils/audit");
const { salonDate, addDays, isValidDate } = require("../utils/time");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[cash-close] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});
router.use(authorizePermission(PERMISSIONS.CASHCLOSE_MANAGE));

const MAX_RUPEES = 10_000_000;
const MAX_TAKEN_OUT_LINES = 10;

/** What a record looks like to the screen: the original, the adjustments, and the effective figures. */
function present(r) {
  const adjusted = (r.adjustments || []).reduce((n, a) => n + a.delta, 0);
  return {
    day: r.day,
    openingFloat: r.openingFloat,
    openingFloatSource: r.openingFloatSource,
    countedCash: r.countedCash,
    cashSales: r.cashSales,
    cashSalesVisits: r.cashSalesVisits,
    cashTakenOut: r.cashTakenOut,
    takenOutTotal: r.takenOutTotal,
    expectedCash: r.expectedCash,
    difference: r.difference,
    leftInDrawer: r.leftInDrawer,
    banked: r.countedCash - r.leftInDrawer,
    note: r.note,
    closedBy: r.closedByName,
    closedAt: r.closedAt,
    adjustments: (r.adjustments || []).map((a) => ({ delta: a.delta, reason: a.reason, by: a.byName, at: a.at })),
    effectiveCountedCash: r.countedCash + adjusted,
    effectiveDifference: r.difference + adjusted,
  };
}

/** Cash taken in the drawer for one IST day: the cash part of paid visits, nothing else. */
async function cashSalesFor(day) {
  const [row] = await Visit.aggregate([
    { $match: { paymentStatus: "success", date: { $gte: new Date(day), $lt: new Date(addDays(day, 1)) } } },
    { $group: { _id: null, cash: { $sum: "$cashAmount" }, visits: { $sum: { $cond: [{ $gt: ["$cashAmount", 0] }, 1, 0] } } } },
  ]);
  return { cash: Math.round(row?.cash || 0), visits: row?.visits || 0 };
}

const rupees = (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_RUPEES ? v : null);

/** The previous close's "left in drawer": tomorrow's suggested opening float. */
async function suggestedFloat(day) {
  const prev = await DailyCashClose.findOne({ day: { $lt: day } }).sort({ day: -1 }).lean();
  return prev ? { amount: prev.leftInDrawer, from: prev.day } : { amount: 0, from: null };
}

router.get("/day/:day", async (req, res) => {
  try {
    const { day } = req.params;
    if (!isValidDate(day) || day > salonDate()) return res.status(400).json({ error: "Pick a real day that is not in the future" });
    const closed = await DailyCashClose.findOne({ day }).lean();
    if (closed) return res.json({ day, closed: true, record: present(closed) });
    // Deliberately NOTHING about the day's cash here: the count comes first.
    const f = await suggestedFloat(day);
    res.set("Cache-Control", "no-store");
    return res.json({ day, closed: false, suggestedOpeningFloat: f.amount, suggestedFrom: f.from });
  } catch (err) {
    console.error("[cash-close] day error:", err);
    return res.status(500).json({ error: "Could not load the day" });
  }
});

router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    const day = String(b.day || "");
    if (!isValidDate(day) || day > salonDate()) return res.status(400).json({ error: "Pick a real day that is not in the future" });

    const counted = rupees(b.countedCash);
    if (counted === null) return res.status(400).json({ error: "Enter the counted cash in whole rupees (0 or more)" });
    const left = rupees(b.leftInDrawer);
    if (left === null) return res.status(400).json({ error: "Enter how much stays in the drawer, in whole rupees" });
    if (left > counted) return res.status(400).json({ error: "You cannot leave more in the drawer than you counted" });

    const lines = Array.isArray(b.cashTakenOut) ? b.cashTakenOut : [];
    if (lines.length > MAX_TAKEN_OUT_LINES) return res.status(400).json({ error: `At most ${MAX_TAKEN_OUT_LINES} cash-out lines` });
    const takenOut = [];
    for (const l of lines) {
      const reason = String(l?.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const amount = rupees(l?.amount);
      if (!reason) return res.status(400).json({ error: "Every cash taken out needs a reason" });
      if (amount === null || amount < 1) return res.status(400).json({ error: "Cash taken out must be 1 rupee or more, in whole rupees" });
      takenOut.push({ reason, amount });
    }

    const suggested = await suggestedFloat(day);
    let openingFloat = suggested.amount;
    let source = "previous_close";
    if (b.openingFloat !== undefined && b.openingFloat !== null && b.openingFloat !== "") {
      const typed = rupees(b.openingFloat);
      if (typed === null) return res.status(400).json({ error: "Opening float must be in whole rupees (0 or more)" });
      if (typed !== suggested.amount || suggested.from === null) source = "entered";
      openingFloat = typed;
    } else if (suggested.from === null) {
      source = "entered";
    }

    const sales = await cashSalesFor(day);
    const takenOutTotal = takenOut.reduce((n, l) => n + l.amount, 0);
    const expectedCash = openingFloat + sales.cash - takenOutTotal;

    let record;
    try {
      record = await DailyCashClose.create({
        day,
        openingFloat,
        openingFloatSource: source,
        countedCash: counted,
        cashTakenOut: takenOut,
        leftInDrawer: left,
        note: String(b.note ?? "").trim().slice(0, 300) || null,
        cashSales: sales.cash,
        cashSalesVisits: sales.visits,
        takenOutTotal,
        expectedCash,
        difference: counted - expectedCash,
        closedById: req.session.userId,
        closedByName: req.session.name,
      });
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: `${day} is already closed. A closed day cannot be changed; ask the owner to add an adjustment.` });
      throw err;
    }
    await audit.record({
      action: "cash_close.closed",
      req,
      meta: { day, counted, expected: expectedCash, difference: record.difference },
    });
    return res.status(201).json({ record: present(record) });
  } catch (err) {
    console.error("[cash-close] close error:", err);
    return res.status(500).json({ error: "Could not close the day" });
  }
});

router.get("/", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 120);
    const today = salonDate();
    const from = addDays(today, -(days - 1));
    const rows = await DailyCashClose.find({ day: { $gte: from, $lte: today } }).sort({ day: -1 }).lean();
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const list = [];
    for (let d = today; d >= from; d = addDays(d, -1)) {
      const r = byDay.get(d);
      list.push(r ? { day: d, closed: true, record: present(r) } : { day: d, closed: false });
    }
    res.set("Cache-Control", "no-store");
    return res.json({ days: list });
  } catch (err) {
    console.error("[cash-close] list error:", err);
    return res.status(500).json({ error: "Could not load the history" });
  }
});

router.post("/:day/adjustments", authorize("owner"), async (req, res) => {
  try {
    const { day } = req.params;
    const delta = Number(req.body?.delta);
    const reason = String(req.body?.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!isValidDate(day)) return res.status(400).json({ error: "Not a real day" });
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_RUPEES) return res.status(400).json({ error: "The adjustment must be a whole number of rupees, not zero" });
    if (!reason) return res.status(400).json({ error: "An adjustment needs a reason" });

    const record = await DailyCashClose.findOneAndUpdate(
      { day },
      { $push: { adjustments: { delta, reason, byId: req.session.userId, byName: req.session.name, at: new Date() } } },
      { returnDocument: "after" }
    );
    if (!record) return res.status(404).json({ error: "That day has not been closed" });
    await audit.record({ action: "cash_close.adjusted", req, meta: { day, delta, reason } });
    return res.status(201).json({ record: present(record) });
  } catch (err) {
    console.error("[cash-close] adjust error:", err);
    return res.status(500).json({ error: "Could not add the adjustment" });
  }
});

module.exports = router;
