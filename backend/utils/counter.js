/**
 * @file counter.js
 * @description Counter UPI payments: price a sale, make the QR, follow it to "paid",
 * and tie the payment back to its Visit (D60, part A).
 *
 * ── Who is trusted with what ─────────────────────────────────────────────────
 * Nobody but this file. The staff screen says WHAT is being sold; `computeAmounts`
 * prices it the way /visits/v2 prices a Visit. The tablet only displays. Whether
 * money arrived is decided by Razorpay's webhook (`applyCapturedPayment`) or, as a
 * quicker second witness, Razorpay's own answer to "is this QR paid?"
 * (`syncSession`). Never by the browser.
 *
 * ── Vercel ───────────────────────────────────────────────────────────────────
 * No timers and no memory between calls. Every "after N seconds" below is a
 * timestamp in MongoDB that the NEXT call acts on (the staff screen's poll, the
 * 15-minute cron, the Fix Numbers screen) — see `backfillReferences`.
 *
 * ── Razorpay calls per payment ───────────────────────────────────────────────
 * 1 to create the QR, then at most one status call per session per 2 s while the
 * staff screen waits (usually 0: the webhook lands first and ends the polling),
 * 1 more to close the QR on cancel, and in the rare lost-webhook case 1 payments
 * list after 60 s.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const Service = require("../models/Service");
const Visit = require("../models/Visit");
const User = require("../models/User");
const PaymentEvent = require("../models/PaymentEvent");
const SiteSettings = require("../models/SiteSettings");
const CounterSession = require("../models/CounterSession");
const telegram = require("./telegram");
const { gateway } = require("./razorpayQr");
const { salonDate, salonInstant, weekdayKey } = require("./time");

const QR_DESCRIPTION = "The Experts - counter payment";
/** Razorpay needs close_by at least 2 minutes ahead; the spike used 10. */
const QR_LIFETIME_S = 600;
const SYNC_MIN_GAP_MS = 2000;
const BACKFILL_AFTER_MS = 60_000;
const BACKFILL_RETRY_MS = 30_000;
/** A reference still missing this long after payment is listed in Fix Numbers. */
const STALE_REFERENCE_MS = 10 * 60_000;

const ACTIVE_POLL_MS = 2500;
const IDLE_FAST_MS = 20_000;
const IDLE_SLOW_MS = 5 * 60_000;
const PRE_OPEN_MS = 30 * 60_000;
const POST_CLOSE_MS = 15 * 60_000;
const PAID_SHOW_MS = 8000;

/**
 * Where the QR sits inside Razorpay's 674×1644 poster, measured from a real one.
 * Used only when decoding the QR from the poster fails and the poster itself is shown, cropped.
 */
const POSTER_CROP = { imgW: 674, imgH: 1644, x: 130, y: 642, w: 413, h: 413 };

const isEnabled = () => process.env.COUNTER_DISPLAY_ENABLED === "true";
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;

// ─── Pricing ────────────────────────────────────────────────────────────────

/**
 * Price a sale exactly as POST /visits/v2 will: list price × (1 − discount %), cash part off.
 *
 * @returns {Promise<{ok: true, serviceIds, subtotal, discountPercent, discountAmount,
 *   finalTotal, paymentMode, cashAmount, upiAmount, upiAmountPaise} | {ok: false, error: string}>}
 */
async function computeAmounts({ serviceIds, discountPercent, paymentMode = "online", cashAmount = 0 }) {
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) return { ok: false, error: "At least one service is required" };
  if (serviceIds.length > 40) return { ok: false, error: "Too many services" };
  if (!serviceIds.every(isId)) return { ok: false, error: "Invalid service ID" };

  const wanted = serviceIds.map(String);
  const docs = await Service.find({ _id: { $in: [...new Set(wanted)] }, isActive: true }, { price: 1, name: 1 }).lean();
  const priceById = new Map(docs.map((d) => [String(d._id), d.price]));
  const nameById = new Map(docs.map((d) => [String(d._id), d.name]));
  if (wanted.some((id) => !priceById.has(id))) return { ok: false, error: "One or more selected services are invalid or inactive" };

  const subtotal = wanted.reduce((sum, id) => sum + priceById.get(id), 0);
  // The bill the customer sees: one line per service, in the order entered, with a count for repeats.
  const lines = [];
  for (const id of wanted) {
    const line = lines.find((l) => l.id === id);
    if (line) line.quantity += 1;
    else lines.push({ id, name: nameById.get(id), quantity: 1, price: priceById.get(id) });
  }
  // Same clamp as POST /visits/v2, so the session and the visit always agree.
  const pct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const discountAmount = Math.round(subtotal * (pct / 100));
  const finalTotal = Math.max(0, Math.round(subtotal - discountAmount));

  if (!["online", "partial"].includes(paymentMode)) return { ok: false, error: "Payment mode must be online or partial" };
  let cash = 0;
  if (paymentMode === "partial") {
    cash = Number(cashAmount);
    if (!Number.isInteger(cash)) return { ok: false, error: "Enter the cash in whole rupees" };
    if (cash < 1 || cash > finalTotal - 1) return { ok: false, error: `Cash must be between ₹1 and ₹${Math.max(1, finalTotal - 1)}` };
  }
  const upiAmount = finalTotal - cash;
  if (upiAmount < 1) return { ok: false, error: "The UPI amount must be at least ₹1" };

  return {
    ok: true,
    serviceIds: wanted,
    lines: lines.map(({ name, quantity, price }) => ({ name, quantity, price })),
    subtotal,
    discountPercent: pct,
    discountAmount,
    finalTotal,
    paymentMode,
    cashAmount: cash,
    upiAmount,
    upiAmountPaise: upiAmount * 100,
  };
}

// ─── QR image → UPI string ──────────────────────────────────────────────────

/**
 * Read the UPI payment string out of Razorpay's poster so the tablet can redraw a
 * large, clean QR. Trusted ONLY if the string is a upi://pay link whose amount is
 * the amount we asked for; anything else returns null and the poster is shown instead.
 *
 * @returns {string|null}
 */
function decodeUpiFromPoster(png, expectedRupees) {
  try {
    const { PNG } = require("pngjs");
    const jsQR = require("jsqr");
    const img = PNG.sync.read(png);
    if (img.width * img.height > 6_000_000) return null;
    const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    const text = found?.data;
    if (typeof text !== "string" || !/^upi:\/\/pay\?/i.test(text) || text.length > 600) return null;
    const am = Number(new URL(text).searchParams.get("am"));
    if (!Number.isFinite(am) || Math.abs(am - expectedRupees) > 0.001) return null;
    return text;
  } catch {
    return null;
  }
}

// ─── Views ──────────────────────────────────────────────────────────────────

/** A name for the tablet: plain text, one line, 60 characters at most, or null. Display only. */
function cleanCustomerName(raw) {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return s || null;
}

/** What a browser may see of a session. The QR itself goes only to the screen meant to show it. */
function view(s, { withQr = false } = {}) {
  const out = {
    id: String(s._id),
    status: s.status,
    cancelReason: s.cancelReason,
    target: s.target,
    amount: s.upiAmount,
    finalTotal: s.finalTotal,
    cashAmount: s.cashAmount,
    expiresAt: s.expiresAt,
    paidAt: s.paidAt,
    referencePending: s.status === "paid" && !s.razorpayPaymentId,
    visitId: s.visitId ? String(s.visitId) : null,
  };
  if (withQr) out.qr = qrPayload(s);
  return out;
}

function qrPayload(s) {
  if (s.qrMode === "decoded" && s.qrUpi) return { mode: "decoded", upi: s.qrUpi };
  if (s.qrImageUrl) return { mode: "image", imageUrl: s.qrImageUrl, crop: POSTER_CROP };
  return null;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

async function alertOwners(text) {
  if (!telegram.isConfigured()) return;
  try {
    const owners = await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean();
    await Promise.allSettled(owners.map((o) => telegram.sendMessage(o.telegramChatId, text)));
  } catch (err) {
    console.error("[counter] owner alert failed:", err.message);
  }
}

/**
 * Cancel a session: close the QR at Razorpay FIRST, then mark it. If Razorpay refuses
 * because the QR was already paid, the payment wins and the session becomes paid.
 */
async function cancelSession(s, reason = "staff") {
  if (s.status !== "pending") return s;
  const g = gateway();
  const closed = s.qrId ? await g.closeQr(s.qrId) : { ok: true };
  if (!closed.ok) {
    const q = await g.getQr(s.qrId);
    if (q.ok && q.status === "closed" && q.closeReason === "paid") {
      return (await markPaid(s._id, "poll")) || (await CounterSession.findById(s._id));
    }
    // Razorpay unreachable or the QR was closed some other way: cancel locally; the QR dies by itself within 10 min.
  }
  const updated = await CounterSession.findOneAndUpdate(
    { _id: s._id, status: "pending" },
    { $set: { status: "cancelled", cancelReason: reason } },
    { returnDocument: "after" }
  );
  return updated || (await CounterSession.findById(s._id));
}

/**
 * @param {object} p
 * @param {{id: string, name: string}} p.user
 * @param {object} p.body   { serviceIds, discountPercent, paymentMode, cashAmount, target }
 * @returns {Promise<{status: number, body: object}>}
 */
async function createSession({ user, body }) {
  const calc = await computeAmounts(body || {});
  if (!calc.ok) return { status: 400, body: { error: calc.error } };

  const target = body?.target === "pc" ? "pc" : "tablet";
  const now = new Date();

  if (target === "tablet") {
    const busy = await CounterSession.findOne({
      status: "pending",
      target: "tablet",
      expiresAt: { $gt: now },
      createdBy: { $ne: user.id },
    }).lean();
    if (busy) {
      return {
        status: 409,
        body: { error: `The tablet is showing ${busy.createdByName}'s payment. Show this QR on your own screen instead.`, busy: true },
      };
    }
  }

  // One live QR per person: starting a new one replaces their old one.
  const mine = await CounterSession.find({ createdBy: user.id, status: "pending" });
  for (const old of mine) await cancelSession(old, "superseded");

  const _id = new mongoose.Types.ObjectId();
  const closeBy = Math.floor(now.getTime() / 1000) + QR_LIFETIME_S;
  const g = gateway();
  const qr = await g.createQr({ amountPaise: calc.upiAmountPaise, sessionId: _id, closeBy, description: QR_DESCRIPTION });
  if (!qr.ok) {
    console.error("[counter] QR creation failed:", qr.error);
    return { status: 502, body: { error: "Could not create the payment QR. Try again, or pay with Razorpay checkout.", qrFailed: true } };
  }

  const poster = qr.imageUrl ? await g.fetchPoster(qr.imageUrl) : null;
  const upi = poster ? decodeUpiFromPoster(poster, calc.upiAmount) : null;

  const doc = await CounterSession.create({
    _id,
    createdBy: user.id,
    createdByName: user.name || "Unknown",
    target,
    serviceIds: calc.serviceIds,
    customerName: cleanCustomerName(body?.customerName),
    lines: calc.lines,
    discountPercent: calc.discountPercent,
    paymentMode: calc.paymentMode,
    cashAmount: calc.cashAmount,
    subtotal: calc.subtotal,
    discountAmount: calc.discountAmount,
    finalTotal: calc.finalTotal,
    upiAmount: calc.upiAmount,
    upiAmountPaise: calc.upiAmountPaise,
    qrId: qr.id,
    qrImageUrl: qr.imageUrl,
    qrUpi: upi,
    qrMode: upi ? "decoded" : "image",
    expiresAt: new Date(qr.closeBy * 1000),
  });
  return { status: 201, body: { session: view(doc, { withQr: doc.target === "pc" }) } };
}

/** Pending/expired → paid, once. Returns the updated doc, or null if it was not in that state. */
function markPaid(id, via, extra = {}) {
  return CounterSession.findOneAndUpdate(
    { _id: id, status: { $in: ["pending", "expired"] } },
    { $set: { status: "paid", paidAt: new Date(), paidVia: via, ...extra } },
    { returnDocument: "after" }
  );
}

/**
 * Ask Razorpay about a pending session (at most once per 2 s per session), and
 * close out sessions that ran out of time. Also nudges the reference backfill.
 */
async function syncSession(s, now = new Date()) {
  if (s.status === "pending") {
    const claimed = await CounterSession.findOneAndUpdate(
      { _id: s._id, status: "pending", $or: [{ lastSyncAt: null }, { lastSyncAt: { $lt: new Date(now.getTime() - SYNC_MIN_GAP_MS) } }] },
      { $set: { lastSyncAt: now } },
      { returnDocument: "after" }
    );
    if (!claimed) return (await CounterSession.findById(s._id)) || s; // throttled, or the webhook got there first

    const q = await gateway().getQr(s.qrId);
    if (q.ok && q.status === "closed") {
      if (q.closeReason === "paid") {
        if (q.amountReceivedPaise && q.amountReceivedPaise !== s.upiAmountPaise) {
          console.error(`[counter] session ${s._id}: QR paid ${q.amountReceivedPaise} paise, expected ${s.upiAmountPaise} — not marking paid`);
          return claimed;
        }
        return (await markPaid(s._id, "poll")) || (await CounterSession.findById(s._id));
      }
      const reason = q.closeReason === "on_demand" ? "razorpay_closed" : null;
      const status = q.closeReason === "on_demand" ? "cancelled" : "expired";
      return (
        (await CounterSession.findOneAndUpdate(
          { _id: s._id, status: "pending" },
          { $set: { status, ...(reason ? { cancelReason: reason } : {}) } },
          { returnDocument: "after" }
        )) || (await CounterSession.findById(s._id))
      );
    }
    if (now > s.expiresAt) {
      return (
        (await CounterSession.findOneAndUpdate({ _id: s._id, status: "pending" }, { $set: { status: "expired" } }, { returnDocument: "after" })) ||
        (await CounterSession.findById(s._id))
      );
    }
    return claimed;
  }

  if (s.status === "paid" && !s.razorpayPaymentId && s.paidAt && now.getTime() - s.paidAt.getTime() >= BACKFILL_AFTER_MS) {
    await backfillSession(s, now);
    return (await CounterSession.findById(s._id)) || s;
  }
  return s;
}

// ─── Payment id: webhook, backfill ──────────────────────────────────────────

/**
 * Once a session has its payment id, make the Visit and the payment record agree.
 * The visit is found by counterSessionId (set when it is created) and not by
 * session.visitId, which is written a moment later: a webhook landing in
 * between must not miss it.
 */
async function afterIdKnown(session, paymentId) {
  const visit = await Visit.findOneAndUpdate(
    { counterSessionId: session._id, razorpayPaymentId: null },
    { $set: { razorpayPaymentId: paymentId, "paymentSnapshot.razorpayPaymentId": paymentId, referencePending: false } },
    { projection: { _id: 1 } }
  );
  if (!visit) return; // no visit yet: /visits/v2 will carry the id and mark the payment matched itself
  await PaymentEvent.updateOne(
    { razorpayPaymentId: paymentId },
    { $set: { reconcileStatus: "matched", reconciledVisitId: visit._id, reconciledAt: new Date() } }
  );
}

/**
 * The webhook branch for a captured payment with no order and notes.kind "counter_qr".
 * Idempotent: Razorpay delivers at least once.
 *
 * @param {object} payment  Razorpay payment entity (used here, never logged)
 * @returns {Promise<{outcome: string}>}
 */
async function applyCapturedPayment(payment) {
  const sid = payment?.notes?.sessionId;
  if (!isId(sid)) return { outcome: "no_session" };
  if (payment.status !== "captured") return { outcome: "not_captured" };

  const s = await CounterSession.findById(sid);
  if (!s) return { outcome: "unknown_session" };

  const rupees = Math.round((payment.amount || 0) / 100);
  if (payment.amount !== s.upiAmountPaise) {
    await alertOwners(`⚠️ A counter QR payment (${payment.id}) was for ₹${rupees} but the sale was ₹${s.upiAmount}. It is NOT matched — check Payments → Unreconciled.`);
    return { outcome: "amount_mismatch" };
  }

  if (s.status === "cancelled") {
    await CounterSession.updateOne({ _id: s._id, latePaymentId: null }, { $set: { latePaymentId: payment.id } });
    await alertOwners(`⚠️ ₹${rupees} arrived by UPI (${payment.id}) after a counter payment was cancelled or replaced. The customer paid — find the visit in Payments → Unreconciled and record it.`);
    return { outcome: "late_cancelled" };
  }

  const paid = await markPaid(s._id, "webhook", { razorpayPaymentId: payment.id });
  if (paid) {
    await afterIdKnown(paid, payment.id);
    return { outcome: "paid" };
  }

  const current = await CounterSession.findById(s._id);
  if (current.razorpayPaymentId === payment.id) return { outcome: "duplicate" };
  if (!current.razorpayPaymentId && current.status === "paid") {
    const filled = await CounterSession.findOneAndUpdate(
      { _id: s._id, status: "paid", razorpayPaymentId: null },
      { $set: { razorpayPaymentId: payment.id } },
      { returnDocument: "after" }
    );
    if (filled) {
      await afterIdKnown(filled, payment.id);
      return { outcome: "reference_filled" };
    }
    return { outcome: "duplicate" };
  }
  await alertOwners(`⚠️ A second UPI payment (${payment.id}, ₹${rupees}) arrived for a counter sale already paid. Check Payments → Unreconciled — it may need a refund.`);
  return { outcome: "second_payment" };
}

/** Find the payment id for one paid session from Razorpay's (laggy) payments list. */
async function backfillSession(s, now = new Date()) {
  const claimed = await CounterSession.findOneAndUpdate(
    { _id: s._id, status: "paid", razorpayPaymentId: null, $or: [{ lastSyncAt: null }, { lastSyncAt: { $lt: new Date(now.getTime() - BACKFILL_RETRY_MS) } }] },
    { $set: { lastSyncAt: now } },
    { returnDocument: "after" }
  );
  if (!claimed) return false;
  const list = await gateway().listQrPayments(s.qrId);
  if (!list.ok) return false;
  const match = list.payments.find((p) => p.status === "captured" && p.amountPaise === s.upiAmountPaise);
  if (!match) return false;
  try {
    const filled = await CounterSession.findOneAndUpdate(
      { _id: s._id, status: "paid", razorpayPaymentId: null },
      { $set: { razorpayPaymentId: match.id, paidVia: "backfill" } },
      { returnDocument: "after" }
    );
    if (!filled) return false;
    // Make sure the payment itself is on record even if the webhook never came.
    await PaymentEvent.updateOne(
      { razorpayPaymentId: match.id },
      {
        $setOnInsert: {
          amount: s.upiAmount,
          currency: "INR",
          method: "upi",
          status: "captured",
          capturedAt: s.paidAt || now,
          source: "backfill",
          reconcileStatus: "unmatched",
        },
      },
      { upsert: true }
    );
    await afterIdKnown(filled, match.id);
    return true;
  } catch (err) {
    if (err?.code !== 11000) console.error("[counter] backfill failed:", err.message);
    return false;
  }
}

/**
 * Called by the 15-minute cron and the Fix Numbers screen: fill payment ids that never
 * arrived by webhook, and repair any visit whose session already has its id.
 */
async function backfillReferences({ limit = 10, now = new Date() } = {}) {
  const out = { checked: 0, filled: 0, repaired: 0 };
  const waiting = await CounterSession.find({
    status: "paid",
    razorpayPaymentId: null,
    paidAt: { $lt: new Date(now.getTime() - BACKFILL_AFTER_MS) },
  })
    .sort({ paidAt: 1 })
    .limit(limit);
  for (const s of waiting) {
    out.checked++;
    if (await backfillSession(s, now)) out.filled++;
  }

  const pendingVisits = await Visit.find({ referencePending: true, counterSessionId: { $ne: null } }, { counterSessionId: 1 }).limit(limit).lean();
  for (const v of pendingVisits) {
    const s = await CounterSession.findById(v.counterSessionId, { razorpayPaymentId: 1 }).lean();
    if (s?.razorpayPaymentId) {
      await afterIdKnown(s, s.razorpayPaymentId);
      out.repaired++;
    }
  }
  return out;
}

// ─── Visit creation from a paid session ─────────────────────────────────────

/**
 * Read a paid session for /visits/v2. Server-side truth: the returned `sale` replaces
 * whatever the browser sent for services, discount and payment. One visit per session is
 * enforced by the unique index on Visit.counterSessionId, not by this function.
 *
 * @returns {Promise<{ok: true, session, existingVisit?: object, sale?: object} | {ok: false, status: number, error: string}>}
 */
async function loadSaleForVisit({ sessionId, user }) {
  if (!isEnabled()) return { ok: false, status: 404, error: "Counter payments are switched off" };
  if (!isId(sessionId)) return { ok: false, status: 400, error: "Invalid counter session" };
  const s = await CounterSession.findById(sessionId);
  if (!s) return { ok: false, status: 404, error: "Counter session not found" };
  if (user.role !== "owner" && String(s.createdBy) !== String(user.id)) {
    return { ok: false, status: 403, error: "That payment was started by someone else" };
  }
  const existingVisit = await Visit.findOne({ counterSessionId: s._id }).lean();
  if (existingVisit) return { ok: true, session: s, existingVisit };
  if (s.status !== "paid") return { ok: false, status: 409, error: "That QR payment has not been received yet" };
  return {
    ok: true,
    session: s,
    sale: {
      serviceIds: s.serviceIds.map(String),
      discountPercent: s.discountPercent,
      paymentMethod: s.paymentMode === "partial" ? "partial" : "online",
      cashAmount: s.cashAmount,
      razorpayPaymentId: s.razorpayPaymentId || null,
      finalTotal: s.finalTotal,
    },
  };
}

/** Record which visit a session became. Best effort: Visit.counterSessionId is the real link. */
async function attachVisit(sessionId, visitId) {
  try {
    await CounterSession.updateOne({ _id: sessionId, visitId: null }, { $set: { visitId, consumedAt: new Date() } });
  } catch (err) {
    console.error("[counter] attachVisit failed:", err.message);
  }
}

// ─── Tablet: what to show and how often to ask ──────────────────────────────

let settingsCache = { at: 0, doc: null };
async function siteSettings(now) {
  if (settingsCache.doc && now.getTime() - settingsCache.at < 60_000) return settingsCache.doc;
  // findOne, not getSingleton(): this runs on every idle poll and must not write.
  const doc = (await SiteSettings.findOne({ key: "default" }, { openingHours: 1, holidays: 1 }).lean()) || { openingHours: {}, holidays: [] };
  settingsCache = { at: now.getTime(), doc };
  return doc;
}
const clearSettingsCache = () => {
  settingsCache = { at: 0, doc: null };
};

/**
 * How long the tablet should wait before asking again while nothing is happening:
 * 20 s from 30 minutes before opening until 15 minutes after closing, 5 minutes
 * otherwise. The slow rate is shortened so it never overshoots the moment the fast
 * rate should start — so the staff screen never shows the tablet "offline" at opening.
 * A week with no opening hours at all is treated as always open.
 */
function idlePollMs(settings, now = new Date()) {
  const hours = settings?.openingHours || {};
  const any = Object.values(hours).some((w) => Array.isArray(w) && w.length);
  if (!any) return IDLE_FAST_MS;

  const t = now.getTime();
  const today = salonDate(now);
  let nextStart = Infinity;
  for (const offset of [0, 1]) {
    const day = offset ? salonDate(new Date(t + 86_400_000)) : today;
    if (settings.holidays?.includes(day)) continue;
    for (const w of hours[weekdayKey(day)] || []) {
      const open = salonInstant(day, w.open)?.getTime();
      const close = salonInstant(day, w.close)?.getTime();
      if (open == null || close == null) continue;
      const from = open - PRE_OPEN_MS;
      const to = close + POST_CLOSE_MS;
      if (t >= from && t <= to) return IDLE_FAST_MS;
      if (from > t) nextStart = Math.min(nextStart, from);
    }
  }
  return Math.max(IDLE_FAST_MS, Math.min(IDLE_SLOW_MS, nextStart - t));
}

/**
 * The customer's bill as the tablet shows it, all from the server's own figures. No phone number,
 * no staff name, no payment id, no discount reason.
 */
function billFor(s) {
  return {
    customerName: s.customerName || null,
    lines: (s.lines || []).map((l) => ({ name: l.name, quantity: l.quantity, price: l.price })),
    subtotal: s.subtotal,
    discountPercent: s.discountPercent,
    discountAmount: s.discountAmount,
    cashAmount: s.cashAmount,
    total: s.finalTotal,
    toPay: s.upiAmount,
  };
}

/** The tablet's screen: a live QR, a brief "paid", or idle. */
async function displayState(now = new Date()) {
  const s = await CounterSession.findOne({
    target: "tablet",
    $or: [{ status: "pending", expiresAt: { $gt: now } }, { status: "paid", paidAt: { $gt: new Date(now.getTime() - PAID_SHOW_MS) } }],
  })
    .sort({ createdAt: -1 })
    .lean();

  if (s?.status === "pending") {
    return { mode: "payment", amount: s.upiAmount, bill: billFor(s), expiresAt: s.expiresAt, sessionId: String(s._id), qr: qrPayload(s), nextPollMs: ACTIVE_POLL_MS };
  }
  if (s?.status === "paid") {
    return { mode: "paid", amount: s.upiAmount, customerName: s.customerName || null, sessionId: String(s._id), nextPollMs: ACTIVE_POLL_MS };
  }
  return { mode: "idle", nextPollMs: idlePollMs(await siteSettings(now), now) };
}

/** Tablets that kept to their own schedule recently. */
function isOnline(device, now = new Date()) {
  if (!device.lastPollAt) return false;
  const gap = now.getTime() - new Date(device.lastPollAt).getTime();
  return gap <= 2 * (device.lastPollIntervalMs || IDLE_FAST_MS) + 5000;
}

module.exports = {
  isEnabled,
  sha256,
  computeAmounts,
  decodeUpiFromPoster,
  view,
  createSession,
  cancelSession,
  syncSession,
  applyCapturedPayment,
  backfillReferences,
  backfillSession,
  loadSaleForVisit,
  attachVisit,
  displayState,
  idlePollMs,
  isOnline,
  clearSettingsCache,
  QR_DESCRIPTION,
  STALE_REFERENCE_MS,
  POSTER_CROP,
  ACTIVE_POLL_MS,
  IDLE_FAST_MS,
  IDLE_SLOW_MS,
};
