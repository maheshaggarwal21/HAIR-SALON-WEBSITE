/**
 * @file paymentLines.js
 * @description Read-side helpers that expose a visit's payment as line items.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Split payments are ALREADY captured by the visit entry flow. A visit's
 * payment is described two ways at once:
 *
 *   1. `paymentMethod` — a single enum (online | cash | card | partial)
 *   2. `cashAmount` / `cardAmount` / `onlineAmount` — three parallel buckets
 *
 * The buckets are the honest record: verified to sum exactly to `finalTotal`
 * on all 3,624 historical visits. The enum is lossy — it collapses every mixed
 * payment into the single label "partial". That is why the Payments query's
 * `filter.paymentMethod = "cash"` equality check silently misses split visits
 * that did in fact take cash (18 such visits, ₹4,650 of cash collection).
 *
 * This module reads line items back out of the buckets so the Data Pipeline can
 * filter "any visit with a cash component" and treat "split" as its own value.
 * It is READ-ONLY — nothing here writes, and the entry flow is untouched.
 */

/** Payment methods that can appear as a line item. */
const LINE_METHODS = ["cash", "card", "online"];

/** Bucket field on the Visit document backing each line method. */
const BUCKET_FIELD = {
  cash: "cashAmount",
  card: "cardAmount",
  online: "onlineAmount",
};

const METHOD_LABEL = { cash: "Cash", card: "Card", online: "Online" };

/** Coerce anything to a non-negative whole-rupee number. */
function toAmount(value) {
  const n = Math.round(Number(value) || 0);
  return n > 0 ? n : 0;
}

/**
 * Resolve a visit's payment into explicit line items.
 *
 * Zero-amount buckets are dropped, so a plain cash visit yields exactly one
 * line rather than one line plus two empty ones.
 *
 * @param {object} visit - A Visit document or lean object.
 * @returns {{method: string, amount: number}[]} Ordered cash → card → online.
 */
function derivePaymentLines(visit) {
  if (!visit) return [];

  const lines = [];
  for (const method of LINE_METHODS) {
    const amount = toAmount(visit[BUCKET_FIELD[method]]);
    if (amount > 0) lines.push({ method, amount });
  }
  if (lines.length > 0) return lines;

  // All buckets zero/missing. Verified not to occur in current data, but a
  // fully-discounted ₹0 visit would land here — fall back to the enum so the
  // row still reports some method instead of rendering blank.
  const legacyMethod = String(visit.paymentMethod || "").toLowerCase();
  if (LINE_METHODS.includes(legacyMethod)) {
    return [{ method: legacyMethod, amount: toAmount(visit.finalTotal) }];
  }
  return [];
}

/** True when a visit was paid with more than one method. */
function isSplitPayment(visit) {
  return derivePaymentLines(visit).length > 1;
}

/**
 * Display label for a set of lines.
 * One line → "Cash"
 * Many     → "Split — ₹200 Cash + ₹200 Online"
 */
function describePaymentLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length === 0) return "—";
  if (list.length === 1) return METHOD_LABEL[list[0].method] || list[0].method;

  const parts = list.map(
    (l) => `₹${Number(l.amount).toLocaleString("en-IN")} ${METHOD_LABEL[l.method] || l.method}`
  );
  return `Split — ${parts.join(" + ")}`;
}

/**
 * A MongoDB match fragment for a payment-method filter.
 *
 * "cash" matches ANY visit with a cash component, including splits that were
 * only partly cash. "split" is its own value matching any visit whose payment
 * used more than one method.
 *
 * @param {string} method - cash | card | online | split
 * @returns {object|null} Match fragment, or null when the filter is inactive.
 */
function buildMethodMatch(method) {
  const key = String(method || "").toLowerCase();

  if (LINE_METHODS.includes(key)) {
    return { [BUCKET_FIELD[key]]: { $gt: 0 } };
  }

  if (key === "split") {
    return {
      $expr: {
        $gt: [
          {
            $size: {
              $filter: {
                input: [
                  { $ifNull: ["$cashAmount", 0] },
                  { $ifNull: ["$cardAmount", 0] },
                  { $ifNull: ["$onlineAmount", 0] },
                ],
                as: "amount",
                cond: { $gt: ["$$amount", 0] },
              },
            },
          },
          1,
        ],
      },
    };
  }

  return null;
}

module.exports = {
  LINE_METHODS,
  BUCKET_FIELD,
  METHOD_LABEL,
  derivePaymentLines,
  isSplitPayment,
  describePaymentLines,
  buildMethodMatch,
};
