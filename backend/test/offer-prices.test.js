/**
 * @file test/offer-prices.test.js
 * @description Cheaper prices and bundles inside an offer (D59). Through the
 * real public and website routers plus the booking engine's own helpers, so
 * the page price, the quote and the bundle all come from one place.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let Service, Campaign, SiteSettings, server, base, time, offers, loadServices, buildQuote, publicRoutes;
let ids;

before(async () => {
  Object.assign(process.env, { CUSTOMER_SITE_URL: "", TELEGRAM_BOT_TOKEN: "", PUBLIC_TOKEN_SECRET: "t" });
  await startDb();
  Service = require("../models/Service");
  Campaign = require("../models/Campaign");
  SiteSettings = require("../models/SiteSettings");
  time = require("../utils/time");
  offers = require("../utils/offers");
  ({ loadServices } = require("../utils/availabilityLoader"));
  ({ buildQuote } = require("../utils/quote"));
  publicRoutes = require("../routes/public");

  const app = express();
  app.use(express.json());
  app.use("/api/public", publicRoutes);
  app.use((req, _res, next) => {
    req.session = { userId: new mongoose.Types.ObjectId(), name: "Owner", role: "owner" };
    next();
  });
  app.use("/api/website", require("../routes/website"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

const today = () => time.salonDate();
const plus = (n) => time.addDays(today(), n);

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(async () => {
  await clearDb();
  offers.clearOffersCache();
  const common = { isActive: true, showOnWebsite: true, bookingMode: "instant", durationConfirmed: true, audience: "her", displayCategory: "Hair" };
  const docs = await Service.create([
    { ...common, name: "Haircut Women", price: 1000, publicPrice: 500, slug: "haircut-women", durationMinutes: 45 },
    { ...common, name: "Head Wash", price: 400, publicPrice: 200, slug: "head-wash", durationMinutes: 15 },
    { ...common, name: "Blow Dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
  ]);
  ids = Object.fromEntries(docs.map((d) => [d.slug, String(d._id)]));
  await SiteSettings.getSingleton();
});

const offer = (over = {}) => ({
  name: "Diwali glow",
  startDate: today(),
  endDate: plus(5),
  content: { headline: "Diwali prices", ctaHref: "/services" },
  ...over,
});

test("a live offer price shows on the menu with the normal price to cross out", async () => {
  await Campaign.create(offer({ servicePrices: [{ serviceId: ids["haircut-women"], price: 400 }] }));
  const res = await call("GET", "/public/services");
  const card = res.body.services.find((c) => c.name === "Haircut Women");
  assert.equal(card.fromPrice, 400);
  assert.equal(card.fromRegularPrice, 500);
  assert.equal(card.offerEndsOn, plus(5));
  assert.deepEqual([card.options[0].price, card.options[0].regularPrice], [400, 500]);
  const plain = res.body.services.find((c) => c.name === "Head Wash");
  assert.equal(plain.fromRegularPrice, null);
});

test("an offer that has ended, not started, is paused, or is not below the normal price changes nothing", async () => {
  await Campaign.create([
    offer({ name: "ended", startDate: plus(-9), endDate: plus(-1), servicePrices: [{ serviceId: ids["haircut-women"], price: 100 }] }),
    offer({ name: "future", startDate: plus(1), endDate: plus(3), servicePrices: [{ serviceId: ids["head-wash"], price: 100 }] }),
    offer({ name: "paused", active: false, servicePrices: [{ serviceId: ids["blow-dry"], price: 100 }] }),
  ]);
  await Campaign.create(offer({ name: "stale", servicePrices: [{ serviceId: ids["head-wash"], price: 250 }] })); // normal price is 200
  const res = await call("GET", "/public/services");
  const by = Object.fromEntries(res.body.services.map((c) => [c.name, c]));
  assert.equal(by["Haircut Women"].fromPrice, 500);
  assert.equal(by["Head Wash"].fromPrice, 200);
  assert.equal(by["Blow Dry"].fromPrice, 300);
  assert.equal(by["Head Wash"].fromRegularPrice, null);
});

test("the booking engine charges the offer price, and keeps the normal price for the page to cross out", async () => {
  await Campaign.create(offer({ servicePrices: [{ serviceId: ids["haircut-women"], price: 400 }] }));
  const services = await loadServices([ids["haircut-women"], ids["head-wash"]]);
  const settings = (await SiteSettings.getSingleton()).toObject();
  const q = buildQuote({ guests: [{ key: "g1", serviceIds: [ids["haircut-women"], ids["head-wash"]] }], services, settings });
  assert.equal(q.total, 600);
  const cut = q.lines.find((l) => l.name === "Haircut Women");
  assert.deepEqual([cut.price, cut.regularPrice], [400, 500]);
  assert.equal(q.lines.find((l) => l.name === "Head Wash").regularPrice, null);
  // The deposit is worked out from the price actually charged.
  assert.ok(q.payment.options.every((o) => o.amount <= 600));
});

test("the lowest of two overlapping offers wins", async () => {
  await Campaign.create([
    offer({ name: "a", servicePrices: [{ serviceId: ids["haircut-women"], price: 450 }] }),
    offer({ name: "b", servicePrices: [{ serviceId: ids["haircut-women"], price: 380 }] }),
  ]);
  const services = await loadServices([ids["haircut-women"]]);
  assert.equal(services.get(ids["haircut-women"]).publicPrice, 380);
});

test("a bundle appears as a package at its own price and books through the package path", async () => {
  await Campaign.create(offer({ bundles: [{ slug: "glow-ab12", name: "Glow set", description: "Cut + wash", audience: "her", serviceIds: [ids["haircut-women"], ids["head-wash"]], price: 600 }] }));
  const res = await call("GET", "/public/packages");
  const pkg = res.body.packages.find((p) => p.slug === "glow-ab12");
  assert.equal(pkg.price, 600);
  assert.equal(pkg.validTo, plus(5));
  assert.deepEqual(pkg.items.map((i) => i.price).sort(), [200, 500]); // normal prices, so "700 separately" is honest

  const live = (await publicRoutes.livePackages()).find((p) => p.slug === "glow-ab12");
  const services = await loadServices([ids["haircut-women"], ids["head-wash"]], { allowPackageOnly: new Set(live.items.map((i) => i.id)) });
  const settings = (await SiteSettings.getSingleton()).toObject();
  const q = buildQuote({ guests: [{ key: "g1", serviceIds: live.items.map((i) => i.id) }], services, settings, pkg: live });
  assert.equal(q.subtotal, 700);
  assert.equal(q.discount, 100);
  assert.equal(q.total, 600);
});

test("a package's own items are not discounted twice by a single-service offer", async () => {
  await Campaign.create(
    offer({
      servicePrices: [{ serviceId: ids["haircut-women"], price: 400 }],
      bundles: [{ slug: "glow-ab12", name: "Glow set", serviceIds: [ids["haircut-women"], ids["head-wash"]], price: 600 }],
    })
  );
  const live = (await publicRoutes.livePackages()).find((p) => p.slug === "glow-ab12");
  const services = await loadServices([ids["haircut-women"], ids["head-wash"]], { allowPackageOnly: new Set(live.items.map((i) => i.id)) });
  const settings = (await SiteSettings.getSingleton()).toObject();
  const q = buildQuote({ guests: [{ key: "g1", serviceIds: live.items.map((i) => i.id) }], services, settings, pkg: live });
  assert.equal(q.total, 600);
});

test("a bundle that no longer saves money is left out", async () => {
  await Campaign.create(offer({ bundles: [{ slug: "glow-ab12", name: "Glow set", serviceIds: [ids["haircut-women"], ids["head-wash"]], price: 600 }] }));
  await Service.updateOne({ slug: "haircut-women" }, { $set: { publicPrice: 350 } }); // parts now cost 550
  assert.equal((await publicRoutes.livePackages()).some((p) => p.slug === "glow-ab12"), false);
});

// ── Staff routes ─────────────────────────────────────────────────────────────

test("staff: saving an offer checks prices against the menu and gives each bundle its own URL name", async () => {
  const bad = await call("POST", "/website/campaigns", offer({ servicePrices: [{ serviceId: ids["head-wash"], price: 200 }] }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /below its normal price of ₹200/);

  const dear = await call("POST", "/website/campaigns", offer({ bundles: [{ name: "Too dear", serviceIds: [ids["haircut-women"], ids["head-wash"]], price: 700 }] }));
  assert.equal(dear.status, 400);
  assert.match(dear.body.error, /below the ₹700/);

  const good = await call("POST", "/website/campaigns", offer({
    servicePrices: [{ serviceId: ids["haircut-women"], price: 400 }],
    bundles: [{ name: "Glow set", description: "Cut + wash", serviceIds: [ids["haircut-women"], ids["head-wash"]], price: 600 }],
  }));
  assert.equal(good.status, 201);
  const slug = good.body.bundles[0].slug;
  assert.match(slug, /^glow-set-[0-9a-f]{4}$/);

  // Editing keeps the bundle's URL name; a client cannot pick a new one.
  const patched = await call("PATCH", `/website/campaigns/${good.body._id}`, { bundles: [{ slug, name: "Glow set", serviceIds: [ids["haircut-women"], ids["head-wash"]], price: 550 }] });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.bundles[0].slug, slug);
  assert.equal(patched.body.bundles[0].price, 550);
  const forged = await call("PATCH", `/website/campaigns/${good.body._id}`, { bundles: [{ slug: "chosen-by-browser", name: "Glow set", serviceIds: [ids["haircut-women"], ids["head-wash"]], price: 550 }] });
  assert.notEqual(forged.body.bundles[0].slug, "chosen-by-browser");

  // The offer is live today, so the menu shows it straight away (the 20 s memo is dropped on save).
  const menu = await call("GET", "/public/services");
  assert.equal(menu.body.services.find((c) => c.name === "Haircut Women").fromPrice, 400);
});

test("staff: a service that is not on the menu cannot be put on offer", async () => {
  await Service.updateOne({ slug: "blow-dry" }, { $set: { isActive: false } });
  const res = await call("POST", "/website/campaigns", offer({ servicePrices: [{ serviceId: ids["blow-dry"], price: 100 }] }));
  assert.equal(res.status, 400);
});
