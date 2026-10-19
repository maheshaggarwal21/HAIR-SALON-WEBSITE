/**
 * @file test/cancellation-policy.test.js
 * @description D47: the cancellation fee is 30% of the bill (rounded to ₹10, at
 * least ₹100, never more than the bill), the deposit IS that fee, and the free
 * notice is 24h for every service and group size.
 * Pure functions, no database.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { feeFor, noticeHoursFor, refundFor, buildQuote } = require("../utils/quote");

const S = { cancellationFeePercent: 30, cancellationFeeMin: 100, cancellationFeeRoundTo: 10, cancellationCutoffHours: 24, longNoticeHours: 48 };

test("fee: 30% rounded to ₹10, at least ₹100, never above the bill", () => {
  assert.equal(feeFor(2000, S), 600);
  assert.equal(feeFor(1550, S), 470, "465 → nearest ₹10");
  assert.equal(feeFor(150, S), 100, "45 would cost more to refund than it is worth");
  assert.equal(feeFor(80, S), 80, "never more than the bill");
  assert.equal(feeFor(0, S), 0);
  assert.equal(feeFor(2000, { ...S, cancellationFeePercent: 50 }), 1000, "the owner can change the percentage");
});

test("notice: one window for every service and every group size (D49)", () => {
  assert.equal(noticeHoursFor({ mode: "instant", guests: [{}] }, S), 24);
  assert.equal(noticeHoursFor({ mode: "request", guests: [{}, {}, {}, {}] }, S), 24);
  assert.equal(noticeHoursFor(null, { ...S, cancellationCutoffHours: 12 }), 12, "the owner can change it for everyone");
});

const HOUR = 3600e3;
const appt = (hoursAhead, extra = {}) => ({
  mode: "instant",
  guests: [{}],
  startAt: new Date(Date.now() + hoursAhead * HOUR),
  pricing: { total: 2000 },
  deposit: { status: "paid", amount: 2000 },
  ...extra,
});

test("refund: free before the notice period, 30% kept after it; salon side always everything", () => {
  assert.deepEqual(refundFor(appt(25), "customer", S), { refund: 2000, kept: 0 });
  assert.deepEqual(refundFor(appt(23), "customer", S), { refund: 1400, kept: 600 });
  assert.deepEqual(refundFor(appt(-1), "customer", S), { refund: 1400, kept: 600 }, "a no-show");
  assert.deepEqual(refundFor(appt(23), "salon", S), { refund: 2000, kept: 0 });
  // 30 hours ahead is free for everything — colour, groups of any size.
  assert.equal(refundFor(appt(30), "customer", S).kept, 0);
  assert.equal(refundFor(appt(30, { mode: "request" }), "customer", S).kept, 0);
  assert.equal(refundFor(appt(30, { guests: [{}, {}, {}, {}] }), "customer", S).kept, 0);
});

test("deposit: the deposit is the fee, only the paid part can be kept", () => {
  // Deposit booking of a ₹2,000 bill: ₹600 paid, the fee is ₹600 → all of it kept when late.
  const deposit = appt(10, { deposit: { status: "paid", amount: 600, kind: "deposit" } });
  assert.deepEqual(refundFor(deposit, "customer", S), { refund: 0, kept: 600 });
  assert.deepEqual(refundFor(appt(30, { deposit: { status: "paid", amount: 600 } }), "customer", S), { refund: 600, kept: 0 }, "early: deposit comes back");
});

test("quote: full payment is listed first (the default), the deposit equals the fee, the note says what applies", () => {
  const svc = (id, price) => ({ _id: id, publicPrice: price, name: id, durationConfirmed: true, durationMinutes: 30 });
  const services = new Map([["a", svc("a", 1000)], ["b", svc("b", 1000)]]);
  const q = buildQuote({ guests: [{ key: "g1", serviceIds: ["a", "b"] }], services, settings: S });
  assert.deepEqual(q.payment.options.map((o) => [o.kind, o.amount]), [["full", 2000], ["deposit", 600]]);
  assert.equal(q.payment.cancellationFee, 600);
  assert.match(q.payment.note, /until 24 hours before/);
  assert.match(q.payment.note, /30% \(₹600\)/);
  const group = buildQuote({ guests: [{ key: "g1", serviceIds: ["a"] }, { key: "g2", serviceIds: ["a"] }, { key: "g3", serviceIds: ["a"] }], services, settings: S });
  assert.equal(group.payment.noticeHours, 24, "groups get the same window");
});
