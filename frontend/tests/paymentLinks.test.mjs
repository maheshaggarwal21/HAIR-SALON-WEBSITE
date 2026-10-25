// Run with: npm run test:unit   (Node's built-in test runner; reads the .ts helper directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHistoryParams, paymentsBase, historyLink, razorpayPaymentUrl } from "../src/lib/paymentLinks.ts";

test("valid contact and dates are read", () => {
  assert.deepEqual(parseHistoryParams("?contact=9876543210&from=2026-10-01&to=2026-10-26"), { contact: "9876543210", range: { from: "2026-10-01", to: "2026-10-26" } });
  assert.deepEqual(parseHistoryParams(new URLSearchParams({ contact: " 9876543210 " })), { contact: "9876543210", range: null }, "trimmed");
  assert.deepEqual(parseHistoryParams("?from=2026-10-26&to=2026-10-26").range, { from: "2026-10-26", to: "2026-10-26" }, "one day is fine");
});

test("an invalid contact is ignored silently (not 10 digits, letters, +91, spaces inside, too long)", () => {
  for (const c of ["98765", "98765432101", "abcdefghij", "+919876543210", "98765 43210", "", "9876543210; drop"]) {
    assert.equal(parseHistoryParams(new URLSearchParams({ contact: c })).contact, null, JSON.stringify(c));
  }
});

test("invalid dates are ignored; from after to is ignored; a lone date is ignored", () => {
  for (const q of ["from=2026-13-01&to=2026-13-02", "from=2026-02-30&to=2026-03-01", "from=26-10-01&to=26-10-02", "from=2026-10-26&to=2026-10-01", "from=2026-10-01", "to=2026-10-01", "from=&to=", "from=abc&to=def"]) {
    assert.equal(parseHistoryParams(q).range, null, q);
  }
});

test("a bad contact does not cancel good dates, and the other way round", () => {
  assert.deepEqual(parseHistoryParams("?contact=12&from=2026-10-01&to=2026-10-02"), { contact: null, range: { from: "2026-10-01", to: "2026-10-02" } });
  assert.deepEqual(parseHistoryParams("?contact=9876543210&from=bad&to=worse"), { contact: "9876543210", range: null });
});

test("no params: nothing is preselected (Payment History behaves as before)", () => {
  assert.deepEqual(parseHistoryParams(""), { contact: null, range: null });
  assert.deepEqual(parseHistoryParams("?foo=bar"), { contact: null, range: null });
});

test("the link base follows the CURRENT role route, never a hardcoded one", () => {
  assert.equal(paymentsBase("/dashboard/owner/fix-numbers"), "/dashboard/owner/payments");
  assert.equal(paymentsBase("/dashboard/receptionist/fix-numbers"), "/dashboard/receptionist/payments");
  assert.equal(paymentsBase("/dashboard/manager/fix-numbers"), "/dashboard/manager/payments");
  assert.equal(paymentsBase("/dashboard/artist/x"), "/dashboard/artist/payments");
  assert.equal(paymentsBase("/dashboard/owner"), "/dashboard/owner/payments");
  assert.equal(paymentsBase("/somewhere/else"), null);
  assert.equal(paymentsBase("/dashboard/hacker/fix-numbers"), null);
});

test("the link is built only when allowed and the visit has a valid 10-digit contact", () => {
  const ok = { pathname: "/dashboard/receptionist/fix-numbers", canView: true, contact: "9876543210", day: "2026-10-26" };
  assert.equal(historyLink(ok), "/dashboard/receptionist/payments?contact=9876543210&from=2026-10-26&to=2026-10-26");
  assert.equal(historyLink({ ...ok, pathname: "/dashboard/owner/fix-numbers" }), "/dashboard/owner/payments?contact=9876543210&from=2026-10-26&to=2026-10-26");
  assert.equal(historyLink({ ...ok, canView: false }), null, "no payments.view");
  assert.equal(historyLink({ ...ok, contact: null }), null, "no visit / deleted visit");
  assert.equal(historyLink({ ...ok, contact: "walk-in" }), null, "no valid phone");
  assert.equal(historyLink({ ...ok, contact: "98765" }), null);
  assert.equal(historyLink({ ...ok, pathname: "/elsewhere" }), null);
  assert.equal(historyLink({ ...ok, day: "nonsense" }), "/dashboard/receptionist/payments?contact=9876543210", "a bad day drops only the dates");
});

test("the Razorpay dashboard link is built only for a real-looking payment id, and the id is URL-encoded", () => {
  assert.equal(razorpayPaymentUrl("pay_Ts1xOOssZkYpa8"), "https://dashboard.razorpay.com/app/payments/pay_Ts1xOOssZkYpa8");
  for (const bad of ["", "order_Ts1xBk8XrtNdHw", "pay_", "pay_abc def", "pay_abc/../x", "pay_abc?x=1", "pay_abc#h", "xpay_abc", "PAY_abc", "pay_abc-d", "pay_é", null, undefined, "<script>"]) {
    assert.equal(razorpayPaymentUrl(bad), null, JSON.stringify(bad));
  }
});
