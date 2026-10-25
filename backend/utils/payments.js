/**
 * @file payments.js
 * @description Razorpay calls for online bookings (CONTROL_FLOW_AND_DATA_LOGIC.md
 * §5.2, §5.3, T2.8). The desk flow in index.js keeps its own client; this one
 * serves the booking engine, so the two can't step on each other.
 *
 * Amounts in and out of this module are whole RUPEES; the paise conversion
 * happens here and nowhere else. The amount always comes from the server's
 * quote — never from the browser (CLAUDE.md, "Money").
 *
 * `setClientForTests()` swaps in a fake so tests never reach Razorpay.
 */

const crypto = require("crypto");
const Razorpay = require("razorpay");

let client; // undefined = not built yet; null = no credentials

function getClient() {
  if (client !== undefined) return client;
  client = process.env.RAZORPAY_KEY_ID
    ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
    : null;
  return client;
}

function setClientForTests(fake) {
  client = fake;
}

function isConfigured() {
  return Boolean(getClient());
}

/** @returns {Promise<{id: string, amount: number, currency: string}>} amount in paise, as Razorpay returns it */
async function createOrder({ amount, receipt, notes }) {
  const rz = getClient();
  if (!rz) throw new Error("Razorpay is not configured");
  return rz.orders.create({ amount: Math.round(amount * 100), currency: "INR", receipt, notes, payment_capture: 1 });
}

/** Captured payments on an order (hold expiry checks before giving a slot away). */
async function capturedPayments(orderId) {
  const rz = getClient();
  if (!rz) return [];
  const { items = [] } = await rz.orders.fetchPayments(orderId);
  return items.filter((p) => p.status === "captured");
}

/**
 * One payment as Razorpay has it (status, amount in paise). Used only by the payment-id check
 * (utils/paymentIdCheck.js) when our own webhook record has not arrived yet. Throws on any failure.
 */
async function fetchPayment(paymentId) {
  const rz = getClient();
  if (!rz) throw new Error("Razorpay is not configured");
  return rz.payments.fetch(paymentId);
}

/**
 * Refund part or all of a captured payment (T2.17). Throws on failure so the
 * caller can keep the refund in the queue and tell the owner (E24).
 * @returns {Promise<{id: string, status: string}>}
 */
async function refund(paymentId, amount, notes = {}) {
  const rz = getClient();
  if (!rz) throw new Error("Razorpay is not configured");
  return rz.payments.refund(paymentId, { amount: Math.round(amount * 100), notes });
}

/**
 * Browser checkout handler signature: HMAC-SHA256(order_id|payment_id, key_secret).
 * Constant-time; false on any missing piece.
 */
function checkoutSignatureOk(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || typeof signature !== "string") return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { createOrder, capturedPayments, fetchPayment, refund, checkoutSignatureOk, isConfigured, setClientForTests, getClient };
