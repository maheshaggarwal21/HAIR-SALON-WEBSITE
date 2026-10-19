/**
 * @file test/menu-groups.test.js
 * @description Website menu groups (CF D34, D53): the owner's groups shown as one
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
    svc("Facial (Luxury)", 2500, { displayCategory: "Skin" }),
    svc("Facial (Basic)", 1200, { displayCategory: "Skin" }),
    svc("Facial (Premium)", 1500, { displayCategory: "Skin" }),
    svc("Foot massage", 250, { displayCategory: "Hands & feet" }),
  ];
  const cards = serviceCards(list);
  assert.equal(cards.length, 2);
  const facials = cards.find((c) => c.slug === "facials");
  assert.equal(facials.name, "Facials");
  assert.deepEqual(facials.options.map((o) => [o.label, o.price]), [["Basic", 1200], ["Premium", 1500], ["Luxury", 2500]]);
  assert.equal(facials.fromPrice, 1200);
  assert.deepEqual(new Set(facials.options.map((o) => o.id)).size, 3, "each option is a real service");
  assert.equal(cards.find((c) => c.slug !== "facials").name, "Foot massage", "ungrouped services stay their own card");
});

test("odd spacing and case still match; a group can move a card to its own section", () => {
  assert.equal(groupFor({ name: "Forehead ( Thread)" }).group.slug, "threading");
  assert.equal(groupFor({ name: "Full Arms wax ( honey)" }).label, "Full arms");
  const cards = serviceCards([svc("Eyebrows", 50, { displayCategory: "Skin" }), svc("Chin (Thread)", 30, { displayCategory: "Threading" })]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].displayCategory, "Threading");
});

test("the owner's own variant group in the database wins over the config", () => {
  const cards = serviceCards([
    svc("Keratin Short", 3500, { variantGroup: "keratin-women", variantLabel: "Short", publicName: "Keratin" }),
    svc("Keratin Long", 6500, { variantGroup: "keratin-women", variantLabel: "Long", publicName: "Keratin" }),
    svc("Split Ends (Wash, Conditioning, Blow Dry)", 500, { variantGroup: "my-spa", variantLabel: "Split ends" }),
  ]);
  assert.deepEqual(cards.map((c) => c.slug).sort(), ["keratin-women", "my-spa"]);
  assert.equal(cardSlugFor({ name: "Split Ends (Wash, Conditioning, Blow Dry)", variantGroup: "my-spa" }), "my-spa");
  assert.equal(cardSlugFor({ name: "Split Ends (Wash, Conditioning, Blow Dry)" }), "hair-services-women");
});

test("a group with one option on a tab keeps that service's own name and URL", () => {
  const [card] = serviceCards([svc("Beard Trim", 150, { audience: "him", publicName: "Beard trim" })]);
  assert.equal(card.name, "Beard trim");
  assert.equal(card.slug, "beard-trim");
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
    svc("Hair spa (men)", 1000, { audience: "him", variantGroup: "spa", variantLabel: "Hair spa" }),
    svc("Hair spa (women)", 1500, { audience: "her", variantGroup: "spa", variantLabel: "Hair spa" }),
    svc("Olaplex spa", 3500, { variantGroup: "spa", variantLabel: "Olaplex" }),
  ]);
  assert.deepEqual(card.options.map((o) => o.label).sort(), ["Hair spa (men)", "Hair spa (women)", "Olaplex"]);
});

test("pick: areas can be combined, levels are alternatives", () => {
  const cards = serviceCards([
    svc("Eyebrows", 50, { displayCategory: "Threading" }),
    svc("Upper Lips ( Thread)", 30, { displayCategory: "Threading" }),
    svc("Facial (Basic)", 1200, { displayCategory: "Skin" }),
    svc("Facial (Premium)", 1500, { displayCategory: "Skin" }),
    svc("Keratin Short", 3500, { variantGroup: "keratin-women", variantLabel: "Short" }),
    svc("Keratin Long", 6500, { variantGroup: "keratin-women", variantLabel: "Long" }),
  ]);
  const pick = Object.fromEntries(cards.map((c) => [c.slug, c.pick]));
  assert.deepEqual(pick, { threading: "many", facials: "one", "keratin-women": "one" });
});

test("keepTitle shows the group's title for a single service (men's hair colour)", () => {
  const [card] = serviceCards([svc("Global Color (Men)", 400, { audience: "him", displayCategory: "Colour", slug: "global-colour-men" })]);
  assert.equal(card.name, "Hair colour");
  assert.equal(card.slug, "hair-colour-men");
  assert.equal(card.options[0].label, "Global colour");
  assert.equal(card.options[0].price, 400, "price is the service's own");
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
