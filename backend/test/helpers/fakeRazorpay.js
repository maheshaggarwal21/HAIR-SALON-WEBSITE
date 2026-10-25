/**
 * @file test/helpers/fakeRazorpay.js
 * @description A fake Razorpay SDK for tests that load the REAL app (index.js). `install()` puts a fake
 * class in Node's module cache for "razorpay", so `new Razorpay({...})` in index.js and utils/payments.js
 * gets the fake: nothing goes near the network and no production code is changed to allow it.
 * Call install() BEFORE requiring ../index.js.
 *
 * The returned object `rz` is what a test reads and sets:
 *   rz.created      every orders.create() argument, in order
 *   rz.paymentsOf   Map orderId -> payments, returned by orders.fetchPayments()
 *   rz.payment      Map paymentId -> payment entity, returned by payments.fetch() (missing = rejects)
 *   rz.failFetch    make orders.fetchPayments() throw (Razorpay "down")
 *   rz.failPayments make payments.fetch() throw
 *   rz.fetched      every payment id asked of payments.fetch()
 */
const path = require("path");

function install() {
  const rz = { created: [], paymentsOf: new Map(), payment: new Map(), failFetch: false, failPayments: false, fetched: [], reset() {
    this.created = [];
    this.paymentsOf = new Map();
    this.payment = new Map();
    this.failFetch = false;
    this.failPayments = false;
    this.fetched = [];
  } };
  class FakeRazorpay {
    constructor(opts) {
      this.opts = opts;
      this.orders = {
        create: async (p) => {
          rz.created.push(p);
          return { id: `order_char${rz.created.length}`, amount: p.amount, currency: p.currency, receipt: p.receipt, notes: p.notes };
        },
        fetchPayments: async (id) => {
          if (rz.failFetch) throw new Error("razorpay is down");
          return { items: rz.paymentsOf.get(id) || [] };
        },
      };
      this.payments = {
        fetch: async (id) => {
          rz.fetched.push(id);
          if (rz.failPayments) throw new Error("razorpay is down");
          if (!rz.payment.has(id)) throw Object.assign(new Error("The id provided does not exist"), { statusCode: 400 });
          return rz.payment.get(id);
        },
      };
      this.paymentLink = { create: async () => ({}) };
    }
  }
  const p = require.resolve("razorpay", { paths: [path.join(__dirname, "..", "..")] });
  require.cache[p] = { id: p, filename: p, loaded: true, exports: FakeRazorpay };
  return rz;
}

module.exports = { install };
