/**
 * @file test/phase1b.test.js
 * @description Phase 1b backend: reels (T1.20), Google reviews cache (T1.21),
 * website media + consent-gated before/after photos, and the revalidate ping
 * after owner edits (T1.24). Google, Telegram and the customer site are a
 * local stub server.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let stub;
let calls = [];
let placesReply;
let server;
let base;
let Service, ReviewCache;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ url: req.url, headers: req.headers, body: raw });
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/places/")) {
        res.statusCode = placesReply.status;
        return res.end(JSON.stringify(placesReply.body));
      }
      return res.end(JSON.stringify({ revalidated: true }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(process.env, {
    GOOGLE_PLACES_API_BASE: stubBase,
    GOOGLE_PLACES_API_KEY: "test-key",
    SALON_PLACE_ID: "ChIJtest",
    CUSTOMER_SITE_URL: stubBase,
    REVALIDATE_SECRET: "reval-secret",
    CRON_SECRET: "cron-secret",
  });

  await startDb();
  Service = require("../models/Service");
  ReviewCache = require("../models/ReviewCache");

  const app = express();
  app.use(express.json());
  app.use("/api/public", require("../routes/public"));
  app.use("/api/cron", require("../routes/cron"));
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
  await new Promise((r) => stub.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  calls = [];
  placesReply = { status: 200, body: {} };
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const revalidations = () => calls.filter((c) => c.url === "/api/revalidate").map((c) => JSON.parse(c.body).tags);

test("reels: owner adds, hides and tags a reel; the public feed shows visible ones with 'Book this look'", async () => {
  const svc = await Service.create({ name: "Balayage", price: 9000, publicPrice: 4500, showOnWebsite: true, slug: "balayage", bookingMode: "request" });
  const a = await call("POST", "/website/reels", { mediaUrl: "https://blob.example/a.mp4", caption: "Balayage", serviceId: String(svc._id) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await call("POST", "/website/reels", { mediaUrl: "https://blob.example/b.mp4" });
  await call("PATCH", `/website/reels/${b.body._id}`, { visible: false });
  assert.equal((await call("POST", "/website/reels", { mediaUrl: "http://insecure/c.mp4" })).status, 400);

  const pub = await call("GET", "/public/reels");
  assert.equal(pub.body.reels.length, 1);
  assert.deepEqual(pub.body.reels[0].service, { slug: "balayage", name: "Balayage", optionId: String(svc._id) });
  assert.ok(revalidations().every((t) => t.includes("reels")));
  assert.equal(revalidations().length, 3); // two creates + one hide; the refused one does not ping
  assert.equal(calls.find((c) => c.url === "/api/revalidate").headers["x-revalidate-secret"], "reval-secret");

  assert.equal((await call("DELETE", `/website/reels/${b.body._id}`)).status, 200);
});

test("before/after photos are public only with recorded consent", async () => {
  const res = await call("PATCH", "/website/settings", {
    transformations: [
      { before: "https://blob.example/1b.jpg", after: "https://blob.example/1a.jpg", caption: "Keratin", consent: true },
      { before: "https://blob.example/2b.jpg", after: "https://blob.example/2a.jpg", consent: false },
    ],
    media: { heroVideoUrl: "https://blob.example/hero.mp4", forHerImage: "" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const site = await call("GET", "/public/site");
  assert.equal(site.body.transformations.length, 1);
  assert.equal(site.body.transformations[0].caption, "Keratin");
  assert.equal(site.body.media.heroVideoUrl, "https://blob.example/hero.mp4");
  assert.deepEqual(revalidations(), [["site"]]);

  const missing = await call("PATCH", "/website/settings", { transformations: [{ before: "https://x/b.jpg", after: "https://x/a.jpg" }] });
  assert.equal(missing.status, 400);
});

test("reviews: the daily job caches Google's rating and reviews as given; the site shows them", async () => {
  placesReply = {
    status: 200,
    body: {
      rating: 4.6,
      userRatingCount: 128,
      googleMapsUri: "https://maps.google.com/?cid=1",
      reviews: [
        { rating: 5, text: { text: "Lovely keratin." }, relativePublishTimeDescription: "a week ago", authorAttribution: { displayName: "Ritu", uri: "https://g/u1" } },
        { rating: 2, text: { text: "Had to wait." }, relativePublishTimeDescription: "a month ago", authorAttribution: { displayName: "Aman" } },
      ],
    },
  };
  assert.equal((await call("GET", "/cron/reviews-refresh")).status, 401);
  const run = await call("GET", "/cron/reviews-refresh", null, { Authorization: "Bearer cron-secret" });
  assert.equal(run.body.result.ok, true);
  const g = calls.find((c) => c.url.startsWith("/places/"));
  assert.equal(g.headers["x-goog-api-key"], "test-key");
  assert.match(g.url, /ChIJtest/);
  assert.deepEqual(revalidations(), [["reviews", "site"]]);

  const reviews = await call("GET", "/public/reviews");
  assert.equal(reviews.body.rating, 4.6);
  // No filtering by stars (§13): the 2★ review is shown too.
  assert.deepEqual(reviews.body.reviews.map((r) => r.rating), [5, 2]);
  assert.equal(reviews.body.attribution, "Reviews from Google");
  const site = await call("GET", "/public/site");
  assert.deepEqual(site.body.rating, { value: 4.6, count: 128, mapsUri: "https://maps.google.com/?cid=1", source: "Google" });
});

test("a failed Google refresh keeps the last good copy", async () => {
  await ReviewCache.create({ key: "google", rating: 4.5, count: 25, reviews: [], fetchedAt: new Date() });
  placesReply = { status: 403, body: { error: { message: "The caller does not have permission" } } };
  const run = await call("GET", "/cron/reviews-refresh", null, { Authorization: "Bearer cron-secret" });
  assert.equal(run.body.result.ok, false);
  const doc = await ReviewCache.findOne({ key: "google" }).lean();
  assert.equal(doc.rating, 4.5);
  assert.match(doc.lastError, /permission/);
  assert.equal(revalidations().length, 0);
});

test("menu editor lists services with website fields; editing one pings the site", async () => {
  const s = await Service.create({ name: "Hydra Facial", price: 3100 });
  const list = await call("GET", "/website/services");
  assert.equal(list.body[0].name, "Hydra Facial");
  await call("PATCH", `/website/services/${s._id}/public`, { featured: true, shortDescription: "Deep clean and glow." });
  assert.deepEqual(revalidations(), [["services", "packages"]]);
});

test("uploads say clearly when Blob storage isn't set up", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const res = await call("POST", "/website/media/upload", { type: "blob.generate-client-token" });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /Paste a link/);
});

test("owner-entered rating + selected reviews (D27): short names, hidden until the rating is set, live Google wins", async () => {
  // Nothing saved yet: the starting list and the owner's figures (4.5, 1,000+).
  let reviews = await call("GET", "/public/reviews");
  assert.equal(reviews.body.curated, true);
  assert.equal(reviews.body.rating, 4.5);
  assert.equal(reviews.body.count, 1000);
  assert.equal(reviews.body.attribution, "Selected from our Google reviews");
  assert.deepEqual(reviews.body.reviews.map((r) => r.author), ["Naman T.", "Joban M.", "Leven A.", "Dilpreet K."]);
  assert.ok(!JSON.stringify(reviews.body).includes("Toor"), "full surname never leaves the server");
  assert.equal((await call("GET", "/public/site")).body.rating.value, 4.5);

  // The staff editor sees the starting list with full names, so it can save it.
  const settings = await call("GET", "/website/settings");
  assert.equal(settings.body.reviews.featured.length, 4);
  assert.equal(settings.body.reviews.featured[0].author, "Naman Toor");

  // Bad input is refused.
  assert.equal((await call("PATCH", "/website/settings", { reviews: { rating: 6 } })).status, 400);
  assert.equal((await call("PATCH", "/website/settings", { reviews: { featured: [{ author: "A B", rating: 5, text: "" }] } })).status, 400);

  // Owner sets the figures and hides one review.
  const featured = settings.body.reviews.featured.map((r, i) => ({ ...r, visible: i !== 1 }));
  const saved = await call("PATCH", "/website/settings", {
    reviews: { rating: 4.8, count: 126, url: "https://maps.app.goo.gl/abc", featured },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(revalidations().at(-1), ["site", "reviews"]);

  reviews = await call("GET", "/public/reviews");
  assert.equal(reviews.body.rating, 4.8);
  assert.equal(reviews.body.count, 126);
  assert.equal(reviews.body.mapsUri, "https://maps.app.goo.gl/abc");
  assert.deepEqual(reviews.body.reviews.map((r) => r.author), ["Naman T.", "Leven A.", "Dilpreet K."]);
  assert.deepEqual((await call("GET", "/public/site")).body.rating, {
    value: 4.8,
    count: 126,
    mapsUri: "https://maps.app.goo.gl/abc",
    source: "Google",
  });

  // An empty list means "show none", not "go back to the starting list".
  await call("PATCH", "/website/settings", { reviews: { featured: [] } });
  assert.deepEqual((await call("GET", "/public/reviews")).body.reviews, []);

  // Once the Places feed has data, Google's own figures win.
  await ReviewCache.create({ key: "google", rating: 4.6, count: 130, mapsUri: "https://maps.google.com/?cid=1", reviews: [] });
  assert.equal((await call("GET", "/public/site")).body.rating.value, 4.6);
  assert.equal((await call("GET", "/public/reviews")).body.attribution, "Reviews from Google");
});

test("clients served (D28): distinct paid phone numbers, rounded down, hidden below 100", async () => {
  const Visit = require("../models/Visit");
  const raw = (contact, paymentStatus = "success") => ({ contact, paymentStatus, name: "x", gender: "female" });
  // 99 distinct paid clients: below the threshold, so nothing is shown.
  await Visit.collection.insertMany(Array.from({ length: 99 }, (_, i) => raw(`98${String(i).padStart(8, "0")}`)));
  assert.deepEqual((await call("GET", "/public/site")).body.stats, { clientsServed: null });

  await Visit.collection.insertMany([
    raw("9800000000"), // repeat visit, same number
    raw("+91 98000 00001"), // same client, written differently
    raw("9700000000", "failed"), // unpaid: not a client served
    raw("9700000001", "pending"),
    raw("12345"), // not a phone number
    ...Array.from({ length: 30 }, (_, i) => raw(`96${String(i).padStart(8, "0")}`)),
  ]);
  // 99 + 30 = 129 distinct paid clients → shown as 100(+).
  assert.deepEqual((await call("GET", "/public/site")).body.stats, { clientsServed: 100 });
});

test("offers (D29): owner creates, edits and pauses; the site sees only live or soon-starting ones", async () => {
  const { salonDate, addDays } = require("../utils/time");
  const today = salonDate();
  const base = {
    name: "Karva Chauth",
    startDate: addDays(today, -1),
    endDate: addDays(today, 3),
    content: { headline: "Karva Chauth glow", ctaHref: "/offers/karva-chauth", image: "https://x.public.blob.vercel-storage.com/kc.jpg" },
  };
  // Refused: end before start, unsafe link, pop-up sooner than 5s.
  assert.equal((await call("POST", "/website/campaigns", { ...base, endDate: addDays(today, -2) })).status, 400);
  assert.equal((await call("POST", "/website/campaigns", { ...base, content: { ...base.content, ctaHref: "javascript:alert(1)" } })).status, 400);
  assert.equal((await call("POST", "/website/campaigns", { ...base, popup: { delaySeconds: 2 } })).status, 400);

  const live = await call("POST", "/website/campaigns", base);
  assert.equal(live.status, 201, JSON.stringify(live.body));
  assert.equal(live.body.status, "live");
  assert.deepEqual(revalidations().at(-1), ["campaigns"]);
  await call("POST", "/website/campaigns", { ...base, name: "Diwali", startDate: addDays(today, 5), endDate: addDays(today, 9) });
  await call("POST", "/website/campaigns", { ...base, name: "Next month", startDate: addDays(today, 30), endDate: addDays(today, 35) });
  await call("POST", "/website/campaigns", { ...base, name: "Old", startDate: addDays(today, -20), endDate: addDays(today, -10) });

  let pub = (await call("GET", "/public/campaigns")).body;
  assert.equal(pub.today, today);
  // Live + starting within 7 days; not next month, not ended.
  assert.deepEqual(pub.campaigns.map((c) => c.startDate), [addDays(today, -1), addDays(today, 5)]);
  assert.ok(!("name" in pub.campaigns[0]), "internal name stays on the server");
  assert.equal(pub.campaigns[0].popup.delaySeconds, 6);

  // Pausing hides it from the site at once.
  const paused = await call("PATCH", `/website/campaigns/${live.body._id}`, { active: false });
  assert.equal(paused.body.status, "paused");
  pub = (await call("GET", "/public/campaigns")).body;
  assert.deepEqual(pub.campaigns.map((c) => c.startDate), [addDays(today, 5)]);

  const staff = (await call("GET", "/website/campaigns")).body;
  assert.deepEqual(staff.map((c) => c.status).sort(), ["ended", "paused", "scheduled", "scheduled"]);
  assert.equal((await call("DELETE", `/website/campaigns/${live.body._id}`)).status, 200);
});

test("hero slider (D31) and service photos (D30): saved in order, public, validated", async () => {
  // Never saved: the starting slides shipped with the site.
  let start = (await call("GET", "/public/site")).body.media.heroSlides;
  assert.equal(start.length, 6);
  assert.equal(start[0].wideUrl, "/media/hero/hero-1-moustache-style-wide.mp4");
  assert.equal((await call("GET", "/website/settings")).body.media.heroSlides.length, 6);
  // The owner can save them back unchanged (site paths are allowed).
  assert.equal((await call("PATCH", "/website/settings", { media: { heroSlides: start } })).status, 200);
  const slides = [
    { kind: "video", url: "https://x.public.blob.vercel-storage.com/hero-1.mp4", poster: "https://x.public.blob.vercel-storage.com/hero-1.webp", alt: "Moustache styling", wideUrl: "https://x.public.blob.vercel-storage.com/hero-1-wide.mp4" },
    { kind: "image", url: "https://x.public.blob.vercel-storage.com/salon.webp", alt: "The salon floor" },
  ];
  assert.equal((await call("PATCH", "/website/settings", { media: { heroSlides: [{ kind: "gif", url: "https://a/b" }] } })).status, 400);
  assert.equal((await call("PATCH", "/website/settings", { media: { heroSlides: [{ kind: "video", url: "http://insecure/x.mp4" }] } })).status, 400);
  assert.equal((await call("PATCH", "/website/settings", { media: { heroSlides: slides } })).status, 200);
  let site = (await call("GET", "/public/site")).body;
  assert.deepEqual(site.media.heroSlides.map((s) => s.kind), ["video", "image"]);
  assert.equal(site.media.heroSlides[0].wideUrl, "https://x.public.blob.vercel-storage.com/hero-1-wide.mp4");
  assert.equal(site.media.heroSlides[1].wideUrl, null);
  assert.equal(site.media.heroSlides[1].poster, null);

  // A saved empty list hides the slider (it does not bring the starting slides back).
  await call("PATCH", "/website/settings", { media: { heroSlides: [], heroVideoUrl: "https://x/hero.mp4" } });
  site = (await call("GET", "/public/site")).body;
  assert.deepEqual(site.media.heroSlides, []);

  // A service's own photo: saved, public, and [] clears it.
  const svc = await Service.create({ name: "Keratin", category: "Hair", price: 4000, showOnWebsite: true, slug: "keratin", publicPrice: 2000, displayCategory: "Treatments", audience: "her", bookingMode: "request" });
  assert.equal((await call("PATCH", `/website/services/${svc._id}/public`, { images: ["not-a-url"] })).status, 400);
  assert.equal((await call("PATCH", `/website/services/${svc._id}/public`, { images: ["https://x.public.blob.vercel-storage.com/keratin.jpg"] })).status, 200);
  let card = (await call("GET", "/public/services?for=her")).body.services.find((c) => c.slug === "keratin");
  assert.deepEqual(card.images, ["https://x.public.blob.vercel-storage.com/keratin.jpg"]);
  await call("PATCH", `/website/services/${svc._id}/public`, { images: [] });
  card = (await call("GET", "/public/services?for=her")).body.services.find((c) => c.slug === "keratin");
  assert.deepEqual(card.images, []);
});

test("meet the owner (D32): starting draft, owner edits win, can be hidden", async () => {
  let site = (await call("GET", "/public/site")).body;
  assert.equal(site.owner.name, "Ajit Singh");
  assert.equal(site.owner.photo, "/images/owner/ajit-singh.webp");
  assert.equal((await call("GET", "/website/settings")).body.owner.name, "Ajit Singh");
  assert.equal((await call("PATCH", "/website/settings", { owner: { photo: "javascript:alert(1)" } })).status, 400);
  assert.equal((await call("PATCH", "/website/settings", { owner: { bio: "Twenty years of colour work.", photo: "https://x.public.blob.vercel-storage.com/ajit.jpg" } })).status, 200);
  site = (await call("GET", "/public/site")).body;
  assert.equal(site.owner.bio, "Twenty years of colour work.");
  assert.equal(site.owner.name, "Ajit Singh"); // untouched field keeps the draft
  assert.equal(site.owner.photo, "https://x.public.blob.vercel-storage.com/ajit.jpg");
  await call("PATCH", "/website/settings", { owner: { visible: false } });
  assert.equal((await call("GET", "/public/site")).body.owner, null);
});

test("salon gallery (D33): starting photos, owner list wins, [] hides", async () => {
  let site = (await call("GET", "/public/site")).body;
  assert.equal(site.media.gallery.length, 3);
  assert.equal(site.media.gallery[0].url, "/images/gallery/salon-floor.webp");
  assert.equal((await call("GET", "/website/settings")).body.media.gallery.length, 3);
  assert.equal((await call("PATCH", "/website/settings", { media: { gallery: [{ url: "javascript:x", caption: "bad" }] } })).status, 400);
  await call("PATCH", "/website/settings", { media: { gallery: [{ url: "https://x.public.blob.vercel-storage.com/a.jpg", caption: "Bridal room" }] } });
  site = (await call("GET", "/public/site")).body;
  assert.deepEqual(site.media.gallery, [{ url: "https://x.public.blob.vercel-storage.com/a.jpg", caption: "Bridal room" }]);
  await call("PATCH", "/website/settings", { media: { gallery: [] } });
  assert.deepEqual((await call("GET", "/public/site")).body.media.gallery, []);
});

test("map embed: starts on the salon's pin, accepts Google's whole <iframe> code, refuses other sites", async () => {
  assert.match((await call("GET", "/public/site")).body.contact.mapEmbedUrl, /^https:\/\/maps\.google\.com\/maps\?q=30\.3667632,76\.4024824/);
  const code = '<iframe src="https://www.google.com/maps/embed?pb=!1m18!1m12&amp;x=1" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy"></iframe>';
  const ok = await call("PATCH", "/website/settings", { contact: { mapEmbedUrl: code } });
  assert.equal(ok.status, 200);
  assert.equal((await call("GET", "/public/site")).body.contact.mapEmbedUrl, "https://www.google.com/maps/embed?pb=!1m18!1m12&x=1");
  assert.equal((await call("PATCH", "/website/settings", { contact: { mapEmbedUrl: "https://evil.example/maps/embed" } })).status, 400);
  assert.equal((await call("PATCH", "/website/settings", { contact: { mapEmbedUrl: "" } })).status, 200);
  assert.equal((await call("GET", "/public/site")).body.contact.mapEmbedUrl, null);
});
