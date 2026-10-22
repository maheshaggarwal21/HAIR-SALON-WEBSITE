/**
 * @file discounts.js
 * @description Discount logging and the sanity check for a desk discount (D60, part B).
 *
 * No cap: a discount of any percentage from 0 to 100 is allowed. The only thing
 * rejected is nonsense (negative, over 100, not a number) — before this, such a
 * value was silently clamped, so "150" quietly became a free visit.
 *
 * Logging NEVER fails the request it describes: the visit is the record that
 * matters, and a dropped log row is a monitoring problem, not an outage. The
 * same rule as utils/audit.js.
 */

const DiscountLog = require("../models/DiscountLog");
const { salonDate } = require("./time");

const REASON_MAX = 200;

/**
 * @param {unknown} raw  whatever the client sent as discountPercent
 * @returns {{ ok: true, percent: number } | { ok: false, error: string }}
 */
function parseDiscountPercent(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, percent: 0 };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: "Discount must be a number between 0 and 100" };
  if (n < 0 || n > 100) return { ok: false, error: "Discount must be between 0 and 100" };
  return { ok: true, percent: n };
}

/** Trimmed, length-capped reason, or null. */
function cleanReason(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
  return s || null;
}

/**
 * Append a log row for a visit. `created` rows are only written for percent > 0;
 * `edited` rows are written for any change, including a discount removed (→ 0).
 *
 * @param {object} opts
 * @param {object} opts.visit   the saved Visit (or lean object)
 * @param {object} opts.req     express request — supplies the staff identity
 * @param {"created"|"edited"} [opts.kind]
 * @param {string|null} [opts.reason]
 * @returns {Promise<object|null>} the row, or null when nothing was logged
 */
async function recordDiscount({ visit, req, kind = "created", reason = null }) {
  try {
    const percent = Number(visit.discountPercent) || 0;
    if (kind === "created" && percent <= 0) return null;
    return await DiscountLog.create({
      visitId: visit._id,
      kind,
      percent,
      amount: Number(visit.discountAmount) || 0,
      subtotal: Number(visit.subtotal) || 0,
      finalTotal: Number(visit.finalTotal) || 0,
      paymentMethod: visit.paymentMethod ?? null,
      reason: cleanReason(reason),
      staffId: req?.session?.userId ?? null,
      staffName: req?.session?.name || "Unknown",
      day: salonDate(),
    });
  } catch (err) {
    // E11000 on the unique "created" index = a retried request; that is fine.
    if (err?.code !== 11000) console.error("[discounts] log write failed:", err.message);
    return null;
  }
}

/** Call from any future route that changes a visit's discount after the fact. */
const recordDiscountEdit = (opts) => recordDiscount({ ...opts, kind: "edited" });

module.exports = { parseDiscountPercent, cleanReason, recordDiscount, recordDiscountEdit, REASON_MAX };
