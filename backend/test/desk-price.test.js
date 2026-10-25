/**
 * @file test/desk-price.test.js
 * @description Audit #13: the desk price (what a customer pays: Service.publicPrice, or half the list price when
 * none is set) was typed in two places (utils/checkout.js and utils/booking.js). Both now call
 * Service.deskPrice(). It must give IDENTICAL results to the two old inline formulas, for every shape of
 * service, because it prices real sales.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Service = require("../models/Service");

// The two formulas exactly as they were before the change.
const oldCheckout = (s) => (s.publicPrice != null ? s.publicPrice : Math.round((s.price || 0) * 0.5));
const oldBooking = (s) => s.publicPrice ?? Math.round((s.price || 0) * 0.5);

test("Service.deskPrice gives the same answer as both old formulas for every combination", () => {
  const publicPrices = [undefined, null, 0, 1, 49, 50, 249, 500, 1234.5];
  const prices = [undefined, null, 0, 1, 2, 3, 25, 99, 101, 255, 399, 1001, 3333, 5000, 12345];
  let n = 0;
  for (const publicPrice of publicPrices) {
    for (const price of prices) {
      const s = { publicPrice, price };
      assert.equal(Service.deskPrice(s), oldCheckout(s), JSON.stringify(s));
      assert.equal(Service.deskPrice(s), oldBooking(s), JSON.stringify(s));
      n++;
    }
  }
  assert.equal(n, 9 * 15);
});

test("every whole-rupee list price from 0 to 20000 with no public price rounds exactly as before (x.5 rounds up)", () => {
  for (let price = 0; price <= 20000; price++) assert.equal(Service.deskPrice({ price }), oldCheckout({ price }), String(price));
  assert.equal(Service.deskPrice({ price: 101 }), 51);
  assert.equal(Service.deskPrice({ price: 99 }), 50);
});

test("a set publicPrice always wins, including 0; works on a plain object and on a document", () => {
  assert.equal(Service.deskPrice({ price: 1000, publicPrice: 0 }), 0);
  assert.equal(Service.deskPrice({ price: 1000, publicPrice: 400 }), 400);
  assert.equal(Service.deskPrice(new Service({ name: "x", price: 1000, publicPrice: 450 })), 450);
  assert.equal(Service.deskPrice(new Service({ name: "x", price: 1000 })), oldCheckout({ price: 1000, publicPrice: null }));
});

test("the ratio is the one constant on the Service model", () => {
  assert.equal(Service.PUBLIC_PRICE_RATIO, 0.5);
});
