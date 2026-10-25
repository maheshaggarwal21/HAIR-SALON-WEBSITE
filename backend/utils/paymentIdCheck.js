/**
 * @file paymentIdCheck.js
 * @description Does the Razorpay payment id typed or carried into a desk sale really belong to this sale?
 * (audit #1, D70)
 *
 * Until now the desk accepted any id string for the online part of a sale: nothing compared it with what
 * Razorpay actually took. A typo, a made-up id, a failed payment, a payment for another amount or a
 * booking's deposit id would all have become "paid online" revenue. This file asks the questions; the
 * routes in visits.js only call `begin()` and `done()`.
 *
 * ── It is an OBSERVER, and it must never be able to break a sale ───────────────────────────────────────
 *   - It changes no price, no cash/card/online split, no verification and no webhook handling. It reads.
 *   - `begin()` and `done()` never throw. Every question has its own try/catch and a short time limit
 *     (TIMEOUT_MS). If the check cannot run - Razorpay down, a database error, a timeout - the sale goes
 *     through unchanged, in BOTH modes, and the failure is recorded as reason "check_failed".
 *   - "log" (the default, SiteSettings.paymentIdCheck) records what it found and never blocks.
 *   - "enforce" refuses only a payment that is clearly wrong: Razorpay has never heard of it, it failed or
 *     was refunded, it was for an amount at least ₹1 away from what this sale needs, or it belongs to a
 *     booking's deposit. Anything ambiguous (authorized but not yet captured, a difference under ₹1, a cash
 *     or card sale that happens to carry an id) is allowed and recorded.
 *
 * ── What it asks, in order ─────────────────────────────────────────────────────────────────────────────
 *   1. Is the id already on a visit? Then the routes' existing guards answer (the duplicate replay in
 *      /v2, "already on another visit" at booking checkout), exactly as today. Nothing to add.
 *   2. Is it a booking deposit or a gift card payment (PaymentEvent.purpose, or an Appointment's deposit)?
 *      Then it cannot also be the money for this sale: reason already_used.
 *   3. Our own webhook record (PaymentEvent) if it says "captured". If there is no record yet (the webhook
 *      is late), or it says anything else, ask Razorpay directly. Razorpay saying "no such payment" is
 *      not_found; Razorpay not answering is check_failed.
 *   4. Captured? (not_captured otherwise.) Amount in PAISE equal to what the server worked out the online
 *      part of this sale should be? (amount_mismatch otherwise.)
 *
 * A reused id (the same payment id on a second, DIFFERENT sale) is answered by the route's existing duplicate
 * replay: the caller gets the first visit back, unchanged. `recordReplay()` only notes it, as already_used with
 * `replay: true`, against the FIRST visit.
 *
 * Results are written to the audit log as `payment.id_unverified` with a reason from REASONS. Staff see
 * them under Fix numbers & payment errors → Payment log errors (routes/dataFixes.js), where "open" means
 * no DataFix row decided it yet. Counter QR sales and booking deposits are not checked here.
 *
 * Not checked here, deliberately: the Razorpay webhook handler, /verify-order-payment and the order
 * creation. Those are untouched.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const PaymentEvent = require("../models/PaymentEvent");
const Appointment = require("../models/Appointment");
const Visit = require("../models/Visit");
const SiteSettings = require("../models/SiteSettings");
const AuditLog = require("../models/AuditLog");
const DataFix = require("../models/DataFix");
const NotificationLog = require("../models/NotificationLog");
const User = require("../models/User");
const payments = require("./payments");
const telegram = require("./telegram");
const audit = require("./audit");
const { salonDate } = require("./time");

const REASONS = ["not_found", "not_captured", "amount_mismatch", "already_used", "check_failed"];
const MODES = ["log", "enforce"];
const DEFAULT_TIMEOUT_MS = 4000;
const MODE_CACHE_MS = 30 * 1000;
/** A difference smaller than this (₹1, in paise) is recorded but never refused: whole-rupee rounding on old records. */
const CLEAR_DIFFERENCE_PAISE = 100;
const FAILURE_ALERT_COUNT = 3;
const FAILURE_ALERT_WINDOW_MS = 60 * 60 * 1000;
const LIST_SCAN_LIMIT = 1000;

let timeoutMs = DEFAULT_TIMEOUT_MS;
let now = () => Date.now();
let modeCache = null; // { mode, at }

/**
 * The DataFix key for ONE problem: payment id + visit + reason. A decision about one problem therefore never
 * hides a different one for the same payment id. Always fits routes/dataFixes.js KEY_RE, whatever was typed
 * (a very long id is cut and given a short hash so two different long ids cannot share a key).
 */
function keyFor(paymentId, visitId, reason) {
  const id = String(paymentId);
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, "_");
  const short = safe.length > 36 || safe !== id ? `${safe.slice(0, 30)}-${crypto.createHash("sha1").update(id).digest("hex").slice(0, 6)}` : safe;
  return `pid:${short}:${visitId ? String(visitId).slice(0, 24) : "none"}:${reason}`;
}

/** A decision stands only until the same problem is recorded again afterwards. */
const stillDecided = (entry, fix) => Boolean(fix) && !(new Date(entry.at) > new Date(fix.resolvedAt));

const rupees = (paise) => (paise == null ? null : Math.round(paise) / 100);
const inr = (paise) => `₹${rupees(paise).toLocaleString("en-IN")}`;

// ─── mode ───────────────────────────────────────────────────────────────────

/** "log" or "enforce". Cached for up to 30 seconds; any trouble reading it means "log". Never throws. */
async function getMode() {
  try {
    if (modeCache && now() - modeCache.at < MODE_CACHE_MS) return modeCache.mode;
    const doc = await SiteSettings.findOne({ key: "default" }, { paymentIdCheck: 1 }).lean();
    const mode = doc?.paymentIdCheck === "enforce" ? "enforce" : "log";
    modeCache = { mode, at: now() };
    return mode;
  } catch (err) {
    console.error("[paymentIdCheck] could not read the mode, using 'log':", err.message);
    return "log";
  }
}

/** The settings route calls this after a change so this instance sees it at once; others catch up within 30 s. */
function clearModeCache() {
  modeCache = null;
}

// ─── the check ──────────────────────────────────────────────────────────────

const isNotFound = (err) => err?.statusCode === 400 || err?.statusCode === 404 || err?.error?.code === "BAD_REQUEST_ERROR";

async function inspect({ paymentId, expectedPaise }) {
  const id = String(paymentId).trim();
  if (!Number.isFinite(expectedPaise)) throw new Error("the amount this sale needs online could not be worked out");
  const base = { paymentId: id, expectedPaise, foundPaise: null, status: null, source: null };

  // 1. A visit already holds it: the route's own guard answers that, unchanged.
  if (await Visit.exists({ razorpayPaymentId: id })) return { ...base, reason: null };

  // 2. Money that was for something else.
  const event = await PaymentEvent.findOne({ razorpayPaymentId: id }).lean();
  if (event && ["booking", "giftcard"].includes(event.purpose)) {
    return { ...base, reason: "already_used", status: event.status, foundPaise: eventPaise(event).paise, source: "event", detail: event.purpose };
  }
  if (await Appointment.exists({ "deposit.razorpayPaymentId": id })) {
    return { ...base, reason: "already_used", source: "event", detail: "booking" };
  }

  // 3. Our webhook record if it says captured; Razorpay itself otherwise.
  let status = event?.status ?? null;
  let found = event ? eventPaise(event) : { paise: null, exact: false };
  let source = event ? "event" : null;
  if (!event || event.status !== "captured") {
    try {
      const p = await payments.fetchPayment(id);
      status = p?.status ?? status;
      found = { paise: Number.isFinite(Number(p?.amount)) ? Number(p.amount) : found.paise, exact: Number.isFinite(Number(p?.amount)) };
      source = "razorpay";
    } catch (err) {
      if (!event && isNotFound(err)) return { ...base, reason: "not_found" };
      if (!event) throw err; // Razorpay down or not configured, and nothing of our own to go on
      // We do have our own record: use it as it stands.
    }
  }

  // 4. Captured, and for the right amount.
  const out = { ...base, status, foundPaise: found.paise, source };
  if (status !== "captured") return { ...out, reason: "not_captured" };
  if (found.paise != null) {
    const same = found.exact ? found.paise === expectedPaise : Math.round(found.paise / 100) === Math.round(expectedPaise / 100);
    if (!same) return { ...out, reason: "amount_mismatch" };
  }
  return { ...out, reason: null };
}

/** Exact paise from the webhook payload when we kept it; otherwise the whole-rupee figure (not exact). */
function eventPaise(event) {
  const raw = Number(event.raw?.amount);
  if (Number.isFinite(raw) && raw >= 0) return { paise: raw, exact: true };
  return { paise: Math.round(Number(event.amount) * 100), exact: false };
}

/**
 * Run the check with its own time limit and try/catch. Always resolves; `reason` is null when the payment
 * checks out (or the routes' existing guards own the answer), or one of REASONS.
 */
async function evaluate({ paymentId, expectedPaise }) {
  let timer;
  try {
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the check took longer than ${timeoutMs} ms`)), timeoutMs);
    });
    return await Promise.race([inspect({ paymentId, expectedPaise }), limit]);
  } catch (err) {
    console.error("[paymentIdCheck] could not check", String(paymentId).slice(0, 40), "-", err.message);
    return { paymentId: String(paymentId).trim(), expectedPaise, foundPaise: null, status: null, source: null, reason: "check_failed", detail: String(err.message).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Would "enforce" refuse this? Only a payment that is clearly wrong. */
function clearlyWrong(r) {
  switch (r.reason) {
    case "not_found":
    case "already_used":
      return true;
    case "not_captured":
      return ["failed", "refunded"].includes(r.status);
    case "amount_mismatch":
      return r.expectedPaise > 0 && r.foundPaise != null && Math.abs(r.foundPaise - r.expectedPaise) >= CLEAR_DIFFERENCE_PAISE;
    default:
      return false;
  }
}

const HINT = ' If this is wrong, ask the owner to switch "Payment ID check" to Log only (bottom of the left menu).';

/** What the desk is told when a sale is refused. */
function refusalMessage(r) {
  switch (r.reason) {
    case "not_found":
      return `That Razorpay payment id isn't a payment Razorpay has. Check the id.${HINT}`;
    case "not_captured":
      return `Razorpay shows that payment as ${r.status}, so no money was collected.${HINT}`;
    case "amount_mismatch":
      return `That payment was ${inr(r.foundPaise)} but this sale needs ${inr(r.expectedPaise)} online.${HINT}`;
    default:
      return `That payment was for a booking deposit, not for this sale.${HINT}`;
  }
}

/** The reason in plain words, for the Payment log errors list. */
function plainReason(m) {
  switch (m.reason) {
    case "not_found":
      return "Razorpay has no payment with this id";
    case "not_captured":
      return `Razorpay shows this payment as ${m.status || "not captured"}, so no money was collected`;
    case "amount_mismatch":
      return m.expectedPaise === 0
        ? "This sale was not paid online, but a Razorpay payment id was entered"
        : "The payment amount is different from what this sale needed online";
    case "already_used":
      return m.replay
        ? "A second sale used this payment id; it was replayed onto the first visit (its total or services were different)"
        : "This payment was made for a booking deposit, not for a sale";
    default:
      return "The check could not run (Razorpay or the database did not answer). Nothing was blocked";
  }
}

// ─── the two calls the routes make ──────────────────────────────────────────

/**
 * Before the sale is saved. Returns `{ refusal, done }`:
 *   - `refusal` is null unless mode is "enforce" AND the payment is clearly wrong; then it is
 *     `{ status: 400, body }` for the route to send, and the refusal has been recorded;
 *   - `done(visitId)` is called after the sale is saved, to record a result for it. Never throws.
 * Does nothing (and costs nothing) when there is no payment id.
 *
 * @param {object} p
 * @param {object} p.req
 * @param {string|null} p.paymentId       the id that will be stored on the visit
 * @param {number} p.expectedPaise        what the SERVER worked out the online part should be (0 for cash/card)
 * @param {string|null} [p.name]          who the sale is for, for the Payment log errors list
 * @param {Date|string|null} [p.date]
 * @param {string|null} [p.ref]           booking reference, when there is one
 */
async function begin({ req, paymentId, expectedPaise, name = null, date = null, ref = null }) {
  const noop = { refusal: null, done: async () => {} };
  try {
    if (!paymentId || !String(paymentId).trim()) return noop;
    const mode = await getMode();
    const r = await evaluate({ paymentId, expectedPaise });
    if (!r.reason) return noop;

    const meta = {
      reason: r.reason,
      paymentId: r.paymentId.slice(0, 100),
      expectedPaise: r.expectedPaise,
      foundPaise: r.foundPaise,
      status: r.status,
      source: r.source,
      detail: r.detail ?? null,
      mode,
      refused: false,
      visitId: null,
      visitName: name ? String(name).slice(0, 80) : null,
      visitDate: date ? new Date(date) : null,
      ref,
    };

    if (mode === "enforce" && clearlyWrong(r)) {
      await audit.record({ action: "payment.id_unverified", req, meta: { ...meta, refused: true } });
      return { refusal: { status: 400, body: { error: refusalMessage(r), code: "PAYMENT_ID_CHECK", reason: r.reason } }, done: async () => {} };
    }

    return {
      refusal: null,
      done: async (visitId) => {
        try {
          await audit.record({ action: "payment.id_unverified", req, meta: { ...meta, visitId: visitId ? String(visitId) : null } });
          if (r.reason === "check_failed") await alertIfFailing();
        } catch (err) {
          console.error("[paymentIdCheck] could not record the result:", err.message);
        }
      },
    };
  } catch (err) {
    console.error("[paymentIdCheck] check skipped:", err.message);
    return noop;
  }
}

/** Run an observation with the same time limit and try/catch as the check. Never throws, never blocks longer than the limit. */
async function observe(fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`took longer than ${timeoutMs} ms`)), timeoutMs)))]);
  } catch (err) {
    console.error("[paymentIdCheck] observation skipped:", err.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A second sale reused a payment id that is already on `existing`, and the route answered with the first
 * visit (the duplicate replay). Called only when that second sale's total or services differ. Records it;
 * changes nothing the caller receives, in either mode.
 */
async function recordReplay({ req, paymentId, existing, requestedTotal, expectedPaise }) {
  const mode = await getMode();
  await audit.record({
    action: "payment.id_unverified",
    req,
    meta: {
      reason: "already_used",
      paymentId: String(paymentId).slice(0, 100),
      expectedPaise: Number.isFinite(expectedPaise) ? expectedPaise : null,
      foundPaise: Math.round(Number(existing.onlineAmount || 0) * 100),
      status: null,
      source: "visit",
      detail: "replayed onto an earlier visit",
      replay: true,
      requestedTotal,
      existingTotal: existing.finalTotal,
      mode,
      refused: false,
      visitId: String(existing._id),
      visitName: existing.name ? String(existing.name).slice(0, 80) : null,
      visitDate: existing.date ?? null,
      ref: null,
    },
  });
}

// ─── messages to the owner ──────────────────────────────────────────────────

/** Send one Telegram message to each owner, at most once per `keyBase` (same claim pattern as timerHealth). Never throws. */
async function tellOwners(text, keyBase, type) {
  try {
    if (!telegram.isConfigured()) return 0;
    const owners = await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean();
    let done = 0;
    for (const o of owners) {
      const key = `${keyBase}:${o.telegramChatId}`;
      try {
        await NotificationLog.findOneAndUpdate(
          { key, status: { $ne: "sent" } },
          { $setOnInsert: { key, type, to: String(o.telegramChatId), channel: "telegram" }, $set: { status: "pending" }, $inc: { attempts: 1 } },
          { upsert: true }
        );
      } catch (err) {
        if (err?.code === 11000) continue; // already sent
        throw err;
      }
      const res = await telegram.sendMessage(o.telegramChatId, text);
      const ok = Boolean(res?.ok);
      await NotificationLog.updateOne({ key }, { $set: { status: ok ? "sent" : "failed", sentAt: ok ? new Date() : null, error: ok ? null : String(res?.error || res?.description || "Telegram did not accept it") } });
      if (ok) done++;
    }
    return done;
  } catch (err) {
    console.error("[paymentIdCheck] could not message the owner:", err.message);
    return 0;
  }
}

/** Three or more "could not be checked" in an hour: Razorpay or the database is having trouble. Once per clock hour. */
async function alertIfFailing() {
  const since = new Date(now() - FAILURE_ALERT_WINDOW_MS);
  const n = await AuditLog.countDocuments({ action: "payment.id_unverified", "meta.reason": "check_failed", createdAt: { $gte: since } });
  if (n < FAILURE_ALERT_COUNT) return;
  const hour = Math.floor(now() / FAILURE_ALERT_WINDOW_MS);
  await tellOwners(
    [
      `⚠️ ${n} payment ids could not be checked in the last hour.`,
      "• Razorpay or the database is not answering the payment check.",
      "• Nothing was blocked: those sales were saved as usual and are listed under Fix numbers & payment errors → Payment log errors.",
    ].join("\n"),
    `owner:pidfail:${hour}`,
    "owner_payment_check_failing"
  );
}

/** Immediately, when someone changes the mode. */
async function alertModeChanged({ from, to, who }) {
  const label = (m) => (m === "enforce" ? "Enforce" : "Log only");
  await tellOwners(
    `🔐 Payment ID check was switched from ${label(from)} to ${label(to)} by ${who || "someone"}.`,
    `owner:pidmode:${new mongoose.Types.ObjectId()}`,
    "owner_payment_check_mode"
  );
}

// ─── the Payment log errors list ────────────────────────────────────────────

/**
 * Recorded check results, newest first, one row per PROBLEM (payment id + visit + reason; its latest
 * recording), each with whether someone has decided it. Reads the audit log directly: no visit is scanned. Includes today's.
 */
async function listEntries() {
  const rows = await AuditLog.find({ action: "payment.id_unverified" }).sort({ createdAt: -1 }).limit(LIST_SCAN_LIMIT).lean();
  const latest = new Map();
  for (const r of rows) {
    const m = r.meta;
    if (!m?.paymentId) continue;
    const key = keyFor(m.paymentId, m.visitId, m.reason);
    if (!latest.has(key)) latest.set(key, { key, r });
  }
  return [...latest.values()].map(({ key, r }) => {
    const m = r.meta;
    return {
      key,
      kind: "payment_id",
      paymentId: m.paymentId,
      name: m.visitName ?? null,
      visitId: m.visitId ?? null,
      date: m.visitDate ?? null,
      ref: m.ref ?? null,
      at: r.createdAt,
      reason: m.reason,
      what: plainReason(m),
      expected: rupees(m.expectedPaise),
      found: rupees(m.foundPaise),
      refused: Boolean(m.refused),
      replay: Boolean(m.replay),
      mode: m.mode,
      by: r.actorName,
    };
  });
}

/**
 * Adds `contact` (the visit's 10-digit phone, or null) and `visitDay` (YYYY-MM-DD) to list rows, for the
 * link to Payment History. Read from the visit when the list is built, never stored in the audit entry, so a
 * corrected number is followed. null when there is no visit (a sale refused in enforce mode), the visit was
 * deleted, or its contact is not exactly 10 digits (walk-ins without a phone). Read-only.
 */
async function withVisitContacts(entries) {
  const idList = [...new Set(entries.map((e) => e.visitId).filter((v) => v && mongoose.Types.ObjectId.isValid(v)))];
  const visits = idList.length ? await Visit.find({ _id: { $in: idList } }, { contact: 1, date: 1 }).lean() : [];
  const byId = new Map(visits.map((v) => [String(v._id), v]));
  return entries.map((e) => {
    const v = e.visitId ? byId.get(String(e.visitId)) : null;
    const contact = typeof v?.contact === "string" ? v.contact.trim() : "";
    return { ...e, contact: /^\d{10}$/.test(contact) ? contact : null, visitDay: v?.date ? new Date(v.date).toISOString().slice(0, 10) : null };
  });
}

/** How many recorded results nobody has decided yet. Never throws (0 on trouble). */
async function countOpen() {
  try {
    const entries = await listEntries();
    if (!entries.length) return 0;
    const decided = await DataFix.find({ kind: "payment_id", key: { $in: entries.map((e) => e.key) } }, { key: 1, resolvedAt: 1 }).lean();
    const byKey = new Map(decided.map((d) => [d.key, d]));
    return entries.filter((e) => !stillDecided(e, byKey.get(e.key))).length;
  } catch (err) {
    console.error("[paymentIdCheck] could not count open entries:", err.message);
    return 0;
  }
}

/**
 * The morning message: ONE line a day, only when something is open. Same claim pattern as the
 * timer alert, so calling the morning job twice sends it once. Never throws.
 * @returns {Promise<{paymentIdAlerts: number}>}
 */
async function alertOwnerOpenEntries(at = new Date()) {
  try {
    const n = await countOpen();
    if (n === 0) return { paymentIdAlerts: 0 };
    const text = `🔎 ${n} payment id${n === 1 ? "" : "s"} ${n === 1 ? "needs" : "need"} checking. Open Fix numbers & payment errors → Payment log errors.`;
    return { paymentIdAlerts: await tellOwners(text, `owner:${salonDate(at)}:pidcheck`, "owner_payment_ids_open") };
  } catch (err) {
    console.error("[paymentIdCheck] morning alert failed:", err.message);
    return { paymentIdAlerts: 0 };
  }
}

module.exports = {
  REASONS,
  MODES,
  getMode,
  clearModeCache,
  begin,
  evaluate,
  observe,
  recordReplay,
  keyFor,
  stillDecided,
  listEntries,
  withVisitContacts,
  countOpen,
  alertOwnerOpenEntries,
  alertModeChanged,
  __test: {
    reset() {
      timeoutMs = DEFAULT_TIMEOUT_MS;
      now = () => Date.now();
      modeCache = null;
    },
    clearModeCache,
    setTimeoutMs(ms) {
      timeoutMs = ms;
    },
    setNow(fn) {
      now = fn;
    },
  },
};
