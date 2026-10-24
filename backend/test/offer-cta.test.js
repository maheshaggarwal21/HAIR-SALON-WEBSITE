/**
 * @file test/offer-cta.test.js
 * @description Where "See the offer" goes. Pure model logic, no database: an offer with its own
 * page goes to that page, unless the owner picked something specific.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Campaign = require("../models/Campaign");

const make = (ctaHref, slug) =>
  new Campaign({
    name: "Karva Chauth",
    startDate: "2026-10-20",
    endDate: "2026-10-30",
    content: { headline: "Karva Chauth Glow Package", ctaHref },
    page: { slug },
  });

test("an offer with a page goes to its own page when the button was left on the menu default", () => {
  assert.equal(make("/services", "karva-chauth").toPublic().content.ctaHref, "/offers/karva-chauth");
  assert.equal(make("/offers/now", "karva-chauth").toPublic().content.ctaHref, "/offers/karva-chauth");
  assert.equal(make("/services/", "karva-chauth").toPublic().content.ctaHref, "/offers/karva-chauth");
});

test("a specific choice is kept", () => {
  assert.equal(make("/services?for=her", "karva-chauth").toPublic().content.ctaHref, "/services?for=her");
  assert.equal(make("https://example.com/x", "karva-chauth").toPublic().content.ctaHref, "https://example.com/x");
});

test("an offer without a page keeps whatever was saved", () => {
  assert.equal(make("/services", null).toPublic().content.ctaHref, "/services");
});
