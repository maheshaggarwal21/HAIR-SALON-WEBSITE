/**
 * @file test/menu-groups.test.js
 * @description Website menu groups (CF D34): look-alike services shown as one
 * card with options, each still its own service and price. Pure function tests
 * over serviceCards plus the config's own sanity checks.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { serviceCards, cardSlugFor } = require("../utils/publicCatalogue");
const { GROUPS, groupFor, norm } = require("../config/menuGroups");

let n = 0;
const svc = (name, publicPrice, extra = {}) => ({
  _id: `id${++n}`,
  name,
  publicPrice,
  slug: norm(name).replace(/ /g, "-"),
  displayCategory: "Hair",
  audience: "unisex",
  bookingMode: "request",
  ...extra,
});

test("look-alike services become one card; options keep their own id, price and config order", () => {
  const list = [
    svc("Luxury Manicure", 1500, { displayCategory: "Hands & feet" }),
    svc("Mini Manicure", 500, { displayCategory: "Hands & feet" }),
    svc("Manicure", 750, { displayCategory: "Hands & feet" }),
    svc("Premium Manicure", 1000, { displayCategory: "Hands & feet" }),
    svc("Foot massage", 250, { displayCategory: "Hands & feet" }),
  ];
  const cards = serviceCards(list);
  assert.equal(cards.length, 2);
  const mani = cards.find((c) => c.slug === "manicure");
  assert.equal(mani.name, "Manicure");
  assert.deepEqual(mani.options.map((o) => [o.label, o.price]), [["Mini", 500], ["Classic", 750], ["Premium", 1000], ["Luxury", 1500]]);
  assert.equal(mani.fromPrice, 500);
  assert.deepEqual(new Set(mani.options.map((o) => o.id)).size, 4, "each option is a real service");
  assert.equal(cards.find((c) => c.slug !== "manicure").name, "Foot massage", "ungrouped services stay their own card");
});

test("odd spacing and case still match; a group can move a card to its own section", () => {
  assert.equal(groupFor({ name: "Forehead ( Thread)" }).group.slug, "threading");
  assert.equal(groupFor({ name: "Full Arms wax ( honey)" }).label, "Full arms, honey");
  const cards = serviceCards([svc("Eyebrows", 50, { displayCategory: "Skin" }), svc("Chin (Thread)", 30, { displayCategory: "Threading" })]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].displayCategory, "Threading");
});

test("the owner's own variant group in the database wins over the config", () => {
  const cards = serviceCards([
    svc("Keratin Short", 3500, { variantGroup: "keratin-women", variantLabel: "Short", publicName: "Keratin" }),
    svc("Keratin Long", 6500, { variantGroup: "keratin-women", variantLabel: "Long", publicName: "Keratin" }),
    svc("Hair spa", 1500, { variantGroup: "my-spa", variantLabel: "Spa" }),
  ]);
  assert.deepEqual(cards.map((c) => c.slug).sort(), ["keratin-women", "my-spa"]);
  assert.equal(cardSlugFor({ name: "Hair spa", variantGroup: "my-spa" }), "my-spa");
  assert.equal(cardSlugFor({ name: "Hair spa" }), "hair-spa-repair");
});

test("a group with one option on a tab keeps that service's own name and URL", () => {
  const [card] = serviceCards([svc("Hair Cut (By Creative Styling)", 500)]);
  assert.equal(card.name, "Hair Cut (By Creative Styling)");
  assert.equal(card.slug, "hair-cut-by-creative-styling");
});

test("config sanity: unique slugs, no service listed twice, every label short", () => {
  const slugs = GROUPS.map((g) => g.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  const names = GROUPS.flatMap((g) => g.members.map(([name]) => norm(name)));
  assert.equal(new Set(names).size, names.length);
  for (const g of GROUPS) {
    assert.ok(g.members.length >= 2 || g.keepTitle, `${g.slug} has at least two options (or renames one service)`);
    for (const [, label] of g.members) assert.ok(label.length <= 40, `${g.slug}: "${label}" is short`);
  }
});

test("a men's and a women's version with the same label are told apart", () => {
  const [card] = serviceCards([
    svc("Hair spa", 1000, { audience: "him", slug: "hair-spa-men" }),
    svc("Hair spa", 1500, { audience: "her", slug: "hair-spa-women" }),
    svc("Split Ends (Wash, Conditioning, Blow Dry)", 500),
  ]);
  assert.deepEqual(card.options.map((o) => o.label).sort(), ["Hair spa (men)", "Hair spa (women)", "Split-end treatment"]);
});

test("pick: areas can be combined, levels are alternatives", () => {
  const cards = serviceCards([
    svc("Eyebrows", 50, { displayCategory: "Threading" }),
    svc("Upper Lips (Thread)", 30, { displayCategory: "Threading" }),
    svc("Mini Manicure", 500, { displayCategory: "Hands & feet" }),
    svc("Manicure", 750, { displayCategory: "Hands & feet" }),
    svc("Keratin Short", 3500, { variantGroup: "keratin-women", variantLabel: "Short" }),
    svc("Keratin Long", 6500, { variantGroup: "keratin-women", variantLabel: "Long" }),
  ]);
  const pick = Object.fromEntries(cards.map((c) => [c.slug, c.pick]));
  assert.deepEqual(pick, { threading: "many", manicure: "one", "keratin-women": "one" });
});

test("keepTitle renames a single service for the website (couple haircut)", () => {
  const [card] = serviceCards([svc("Hair Cut (Creative Styling)", 200, { audience: "him", slug: "hair-cut-creative-styling" })]);
  assert.equal(card.name, "Couple haircut");
  assert.equal(card.slug, "couple-haircut");
  assert.equal(card.options[0].price, 200, "price is the service's own");
});

test("Everyone view: a women's and a men's card with the same name merge, options say who", () => {
  const cards = serviceCards([
    svc("Keratin Short", 3500, { variantGroup: "keratin-women", variantLabel: "Short", publicName: "Keratin", audience: "her", displayCategory: "Treatments" }),
    svc("Keratin Long", 6500, { variantGroup: "keratin-women", variantLabel: "Long", publicName: "Keratin", audience: "her", displayCategory: "Treatments" }),
    svc("Keratin", 1500, { audience: "him", displayCategory: "Treatments" }),
  ]);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].options.map((o) => [o.label, o.price]), [["Short (women)", 3500], ["Long (women)", 6500], ["Men", 1500]]);
  assert.equal(cards[0].fromPrice, 1500);
});
