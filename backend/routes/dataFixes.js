/**
 * @file dataFixes.js
 * @description Fix Numbers — the receptionist's daily list of wrong numbers (D54).
 *
 * The client's ask (19 Oct 2026): numbers typed wrong at the desk, refunded or
 * failed online payments and visits that never got their artists were being
 * found by an occasional PDF review. This puts the same checks in the app, so
 * each day's mistakes can be corrected the next day.
 *
 * "After one full day": nothing from today is listed. Today's visits are still
 * being entered, and the desk would be "fixing" a number mid-conversation.
 *
 *   GET  /?kind=duplicate|invalid|payment|unassigned|reference&status=open|resolved|all&days=30&q=
 *   POST /correct-contact   { from, to, key?, note? }  re-file every visit under a wrong number
 *   POST /resolve           { key, kind, status: fixed|dismissed|open, note?, identified? }
 *
 * Detection is live over Visits. A correction changes `Visit.contact` only —
 * amounts, dates, payment buckets and revenue are untouched — and each change
 * is kept on the visit (`contactHistory`) and in the audit log, so it can be
 * undone by correcting back. Nothing here deletes a visit or touches money.
 */

const express = require("express");
const connectDB = require("../db");
const Visit = require("../models/Visit");
const DataFix = require("../models/DataFix");
const PaymentEvent = require("../models/PaymentEvent");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require("../constants/permissions");
const audit = require("../utils/audit");
const { salonDate, addDays } = require("../utils/time");
const { last10, isValidPhone, typoPair } = require("../utils/numberChecks");

const router = express.Router();

router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[data-fixes] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});
router.use(authorizePermission(PERMISSIONS.DATAFIXES_MANAGE));

const SETTLED = {
  paymentStatus: "success",
  $or: [{ assignmentStatus: { $exists: false } }, { assignmentStatus: "not_required" }, { assignmentStatus: "completed" }],
};
const KINDS = ["duplicate", "invalid", "payment", "unassigned", "reference"];
const KEY_RE = /^[a-z]{2,4}:[A-Za-z0-9_:.-]{1,90}$/;
const LIMIT = 200;

/** [from, today) as Dates; today is excluded (see header). */
function window(daysParam) {
  const days = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
  const today = salonDate();
  return { today, from: new Date(addDays(today, -days)), until: new Date(today), days };
}

/** Every contact with its visits; recent = inside the window. */
async function contactGroups({ from, until }) {
  const rows = await Visit.aggregate([
    // Today is left out entirely, so a typo from this morning is not matched
    // against last week's number until a full day has passed.
    { $match: { ...SETTLED, date: { $lt: until } } },
    { $sort: { date: -1, createdAt: -1 } },
    {
      $group: {
        _id: "$contact",
        name: { $first: "$name" },
        visits: { $sum: 1 },
        revenue: { $sum: "$finalTotal" },
        lastDate: { $first: "$date" },
        recent: { $sum: { $cond: [{ $and: [{ $gte: ["$date", from] }, { $lt: ["$date", until] }] }, 1, 0] } },
      },
    },
  ]);
  // Same person written two ways ("+9198…" and "98…") is one group.
  const byKey = new Map();
  for (const r of rows) {
    const key = isValidPhone(r._id) ? last10(r._id) : String(r._id);
    const g = byKey.get(key);
    if (!g) {
      byKey.set(key, { key, contact: key, raws: [r._id], name: r.name, visits: r.visits, revenue: r.revenue, lastDate: r.lastDate, recent: r.recent, valid: isValidPhone(r._id) });
    } else {
      g.raws.push(r._id);
      g.visits += r.visits;
      g.revenue += r.revenue;
      g.recent += r.recent;
      if (r.lastDate > g.lastDate) {
        g.lastDate = r.lastDate;
        g.name = r.name;
      }
    }
  }
  return [...byKey.values()];
}

const side = (g) => ({ contact: g.contact, name: g.name, visits: g.visits, revenue: Math.round(g.revenue), lastDate: g.lastDate, recent: g.recent });

function duplicates(groups) {
  const valid = groups.filter((g) => g.valid);
  const pairs = new Map();
  for (const a of groups) {
    if (!a.valid || a.recent === 0) continue;
    for (const b of valid) {
      if (b.key === a.key) continue;
      const hit = typoPair(a.key, a.name, b.key, b.name);
      if (!hit) continue;
      const [x, y] = a.key < b.key ? [a, b] : [b, a];
      const key = `dup:${x.key}:${y.key}`;
      if (pairs.has(key)) continue;
      // The number with fewer visits is the likelier typo.
      const likelyWrong = x.visits === y.visits ? null : x.visits < y.visits ? "a" : "b";
      pairs.set(key, { key, kind: "duplicate", confidence: hit.confidence, nameMatch: hit.name, diff: hit.diff.text, a: side(x), b: side(y), likelyWrong });
    }
  }
  return [...pairs.values()];
}

const invalid = (groups) =>
  groups
    .filter((g) => !g.valid && g.recent > 0)
    .map((g) => ({ key: `inv:${g.key}`.slice(0, 94), kind: "invalid", ...side(g), contact: String(g.raws[0]) }));

async function unassigned({ from, until }) {
  const rows = await Visit.find({ paymentStatus: "success", assignmentStatus: "pending", date: { $gte: from, $lt: until } })
    .sort({ date: -1 })
    .limit(LIMIT)
    .select("name contact date finalTotal")
    .lean();
  return rows.map((v) => ({ key: `un:${v._id}`, kind: "unassigned", visitId: String(v._id), name: v.name, contact: v.contact, date: v.date, amount: v.finalTotal }));
}

async function razorpayPayments(fromUnix) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error("Razorpay is not configured");
  const auth = "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const to = Math.floor(Date.now() / 1000);
  const items = [];
  for (let skip = 0, page = 0; page < 5; skip += 100, page++) {
    const res = await fetch(`https://api.razorpay.com/v1/payments?from=${fromUnix}&to=${to}&count=100&skip=${skip}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Razorpay answered ${res.status}`);
    const body = await res.json();
    items.push(...(body.items || []));
    if ((body.items || []).length < 100) break;
  }
  return items;
}

/** Refunded or failed online payments, named when a visit or payment event knows who paid. */
async function payments({ from, until }) {
  const items = (await razorpayPayments(Math.floor(from.getTime() / 1000))).filter(
    (p) => (p.amount_refunded > 0 || p.status === "failed" || p.status === "refunded") && new Date(p.created_at * 1000) < until
  );
  if (!items.length) return [];
  const ids = items.map((p) => p.id);
  const [visits, events] = await Promise.all([
    Visit.find({ $or: [{ razorpayPaymentId: { $in: ids } }, { "paymentSnapshot.razorpayPaymentId": { $in: ids } }] })
      .select("name contact razorpayPaymentId paymentSnapshot.razorpayPaymentId")
      .lean(),
    PaymentEvent.find({ razorpayPaymentId: { $in: ids } }).select("razorpayPaymentId customerName contact").lean(),
  ]);
  const visitBy = new Map(visits.map((v) => [v.razorpayPaymentId || v.paymentSnapshot?.razorpayPaymentId, v]));
  const eventBy = new Map(events.map((e) => [e.razorpayPaymentId, e]));
  return items
    .map((p) => {
      const v = visitBy.get(p.id);
      const e = eventBy.get(p.id);
      const full = p.amount_refunded >= p.amount || p.status === "refunded";
      return {
        key: `pay:${p.id}`,
        kind: "payment",
        paymentId: p.id,
        amount: Math.round(p.amount / 100),
        refunded: Math.round((p.amount_refunded || 0) / 100),
        what: p.status === "failed" ? "Failed" : full ? "Refunded in full" : "Refunded in part",
        reason: p.status === "failed" ? p.error_description || null : null,
        at: new Date(p.created_at * 1000),
        name: v?.name || e?.customerName || p.notes?.customer_name || null,
        contact: v?.contact || e?.contact || (p.contact ? String(p.contact).replace(/^\+91/, "") : null),
        // A refunded payment that still has a visit is revenue that was handed back.
        visitCounted: Boolean(v),
      };
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, LIMIT);
}

/**
 * Counter QR visits (D60) saved as "paid, reference pending" whose Razorpay payment id still
 * has not arrived after 10 minutes. The webhook normally fills it within a second, the
 * payments-list backfill within a minute or two; one left over means a human should look
 * at Payments → Unreconciled. Not day-windowed: a stuck payment is stuck whenever it started.
 */
async function missingReference() {
  const { backfillReferences, STALE_REFERENCE_MS } = require("../utils/counter");
  // Heal what can be healed first, so the list only holds what really is stuck.
  await backfillReferences({ limit: 10 }).catch((err) => console.error("[data-fixes] backfill failed:", err.message));
  const rows = await Visit.find({ referencePending: true, createdAt: { $lt: new Date(Date.now() - STALE_REFERENCE_MS) } })
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .select("name contact date createdAt finalTotal onlineAmount")
    .lean();
  return rows.map((v) => ({
    key: `rf:${v._id}`,
    kind: "reference",
    visitId: String(v._id),
    name: v.name,
    contact: v.contact,
    date: v.date,
    at: v.createdAt,
    amount: v.onlineAmount || v.finalTotal,
    what: "Paid by UPI QR, but Razorpay's payment reference never arrived",
  }));
}

router.get("/", async (req, res) => {
  const kind = String(req.query.kind || "");
  if (!KINDS.includes(kind)) return res.status(400).json({ error: "kind must be one of " + KINDS.join(", ") });
  const status = ["open", "resolved", "all"].includes(req.query.status) ? req.query.status : "open";
  const win = window(req.query.days);
  const q = String(req.query.q || "").trim().toLowerCase();

  try {
    let issues = [];
    let warning = null;
    if (kind === "duplicate") issues = duplicates(await contactGroups(win));
    else if (kind === "invalid") issues = invalid(await contactGroups(win));
    else if (kind === "unassigned") issues = await unassigned(win);
    else if (kind === "reference") issues = await missingReference();
    else {
      try {
        issues = await payments(win);
      } catch (err) {
        warning = `Could not read Razorpay: ${err.message}`;
      }
    }

    const decided = new Map((await DataFix.find({ kind }).lean()).map((d) => [d.key, d]));
    issues = issues.map((i) => {
      const d = decided.get(i.key);
      return { ...i, status: d ? d.status : "open", note: d?.note ?? null, identified: d?.identified?.name || d?.identified?.contact ? d.identified : null, resolvedBy: d?.resolvedBy?.name ?? null, resolvedAt: d?.resolvedAt ?? null };
    });
    if (status === "open") issues = issues.filter((i) => i.status === "open");
    else if (status === "resolved") issues = issues.filter((i) => i.status !== "open");
    if (q) issues = issues.filter((i) => JSON.stringify(i).toLowerCase().includes(q));

    if (kind === "duplicate") issues.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) || b.a.lastDate - a.a.lastDate);
    return res.json({ kind, days: win.days, through: addDays(win.today, -1), total: issues.length, issues: issues.slice(0, LIMIT), warning });
  } catch (err) {
    console.error("[data-fixes] list failed:", err);
    return res.status(500).json({ error: "Could not load this list" });
  }
});

router.post("/correct-contact", async (req, res) => {
  try {
    const from = last10(req.body?.from);
    const toRaw = String(req.body?.to ?? "").trim();
    const note = String(req.body?.note || "").trim().slice(0, 300) || null;
    const key = req.body?.key ? String(req.body.key) : null;
    if (key && !KEY_RE.test(key)) return res.status(400).json({ error: "Bad key" });
    if (!isValidPhone(toRaw)) return res.status(400).json({ error: "Enter a valid 10-digit mobile number (starts with 6–9)." });
    const to = last10(toRaw);
    if (!from || from === to) return res.status(400).json({ error: "The new number must be different." });

    // Contacts are free text on old visits ("+91 98…"), so match on the digits, not the string.
    const raws = (await Visit.distinct("contact")).filter((c) => last10(c) === from);
    if (!raws.length) return res.status(404).json({ error: "No visits are filed under that number." });

    const out = await Visit.updateMany(
      { contact: { $in: raws } },
      { $set: { contact: to }, $push: { contactHistory: { from, to, at: new Date(), byName: req.session?.name || "staff" } } }
    );

    await audit.record({ action: "visit.contact_corrected", req, meta: { from, to, visits: out.modifiedCount, key, note } });
    if (key) {
      const kind = key.startsWith("dup:") ? "duplicate" : key.startsWith("inv:") ? "invalid" : null;
      if (kind) {
        await DataFix.findOneAndUpdate(
          { key },
          { $set: { kind, status: "fixed", note, resolvedBy: { id: req.session?.userId ?? null, name: req.session?.name ?? null }, resolvedAt: new Date() } },
          { upsert: true }
        );
      }
    }
    return res.json({ ok: true, visitsMoved: out.modifiedCount, from, to });
  } catch (err) {
    console.error("[data-fixes] correct-contact failed:", err);
    return res.status(500).json({ error: "Could not correct the number" });
  }
});

router.post("/resolve", async (req, res) => {
  try {
    const { key, kind, status } = req.body || {};
    if (!KEY_RE.test(String(key || "")) || !KINDS.includes(kind)) return res.status(400).json({ error: "Bad request" });
    if (!["fixed", "dismissed", "open"].includes(status)) return res.status(400).json({ error: "status must be fixed, dismissed or open" });

    if (status === "open") {
      await DataFix.deleteOne({ key });
    } else {
      const idn = req.body.identified || {};
      const contact = String(idn.contact || "").trim();
      if (contact && !isValidPhone(contact)) return res.status(400).json({ error: "That number is not a valid mobile number." });
      await DataFix.findOneAndUpdate(
        { key },
        {
          $set: {
            kind,
            status,
            note: String(req.body.note || "").trim().slice(0, 300) || null,
            identified: { name: String(idn.name || "").trim().slice(0, 80) || null, contact: contact ? last10(contact) : null },
            resolvedBy: { id: req.session?.userId ?? null, name: req.session?.name ?? null },
            resolvedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }
    await audit.record({ action: "datafix.resolved", req, meta: { key, kind, status } });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[data-fixes] resolve failed:", err);
    return res.status(500).json({ error: "Could not save" });
  }
});

module.exports = router;
module.exports.__test = { duplicates, invalid };
