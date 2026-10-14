/**
 * @file test/catalogue-rules.test.js
 * @description Rules behind migrations M2/M3/M4 and the T0.3 export. Names are
 * taken verbatim from the live catalogue (13 Oct 2026), odd spacing included.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const c = require("../migrations/lib/catalogue");

test("M3: public price is half the list price, rounded", () => {
  assert.equal(c.proposePublicPrice(9000), 4500);
  assert.equal(c.proposePublicPrice(99), 50);
  assert.equal(c.proposePublicPrice(0), 0);
  assert.equal(c.proposePublicPrice(null), null);
  assert.equal(c.proposePublicPrice(-5), null);
});

test("M4: category is trimmed and title-cased", () => {
  assert.equal(c.normaliseCategory("hair"), "Hair");
  assert.equal(c.normaliseCategory("  hands  &  FEET "), "Hands & Feet");
  assert.equal(c.normaliseCategory(undefined), "");
});

test("M4: display category comes from the name before the coarse category", () => {
  const cases = [
    ["Chin (Thread)", "Skin", "Threading"],
    ["Side Locks (Thread)", "Skin", "Threading"],
    ["Cheeks (wax)", "Skin", "Waxing"],
    ["Full Arms wax ( honey)", "Body", "Waxing"],
    ["Bleach Hand/Feet", "Body", "Skin"],
    ["Manicure", "Skin", "Hands & feet"],
    ["Foot massage", "Body", "Hands & feet"],
    ["Beard Color", "Hair", "Grooming"],
    ["Moustache Pasting (Color)", "Hair", "Grooming"],
    ["Global Highlights Balayage Ombre Baby Light (Long)", "Hair", "Colour"],
    ["Root touchup", "Hair", "Colour"],
    ["Keratin (Women) Medium", "Hair", "Treatments"],
    ["Nano plastia", "hair", "Treatments"],
    ["Hair spa ( men)", "Hair", "Treatments"],
    ["Bridal Draping", "Body", "Makeup"],
    ["HD Bridal Make-up", "Makeup", "Makeup"],
    ["Hydra Facial", "Skin", "Skin"],
    ["Dull Skin (For Tan Skin) (Brillare)", "Skin", "Skin"],
    ["Hair Cut (Wash, Conditioning, Blow Dry) (women)", "Hair", "Hair"],
    ["head wash", "hair", "Hair"],
  ];
  for (const [name, category, expected] of cases) {
    assert.equal(c.proposeDisplayCategory(name, category), expected, name);
  }
});

test("M4: the catch-all never gets a display category", () => {
  assert.equal(c.proposeDisplayCategory("Any item", "Hair"), null);
});

test("audience: explicit tags, 'women' never read as 'men', bride & groom is unisex", () => {
  assert.equal(c.proposeAudience("Keratin (Women) Long").audience, "her");
  assert.equal(c.proposeAudience("Organic Bleach Neck  (women)").audience, "her");
  assert.equal(c.proposeAudience("Hair Cut (Creative Styling)   (men)").audience, "him");
  assert.equal(c.proposeAudience("Baby Boy Hair Cut (Styling)").audience, "him");
  assert.equal(c.proposeAudience("Blow Dry (Wash, Conditioning, Blow Dry) Female").audience, "her");
  assert.equal(c.proposeAudience("Signature Make-up").audience, "her");
  assert.equal(c.proposeAudience("Beard Trim").audience, "him");
  assert.equal(c.proposeAudience("Save The Date (Instant Glow For Bride & Groom)").audience, "unisex");
  assert.equal(c.proposeAudience("Hydra Facial").audience, "unisex");
});

test("variants group length options of one service", () => {
  assert.deepEqual(c.proposeVariant("Keratin (Women) Long"), { variantGroup: "keratin-women", variantLabel: "Long" });
  assert.deepEqual(c.proposeVariant("Global Highlights Balayage Ombre Baby Light (Short)"), {
    variantGroup: "global-highlights-balayage-ombre-baby-light",
    variantLabel: "Short",
  });
  assert.deepEqual(c.proposeVariant("Smoothening (Men)"), { variantGroup: null, variantLabel: null });
});

test("public name drops gender and length tags", () => {
  assert.equal(c.proposePublicName("Smoothening (Women) Medium"), "Smoothening");
  assert.equal(c.proposePublicName("Hair Cut (Creative Styling)   (men)"), "Hair Cut (Creative Styling)");
  assert.equal(c.proposePublicName("Global Highlights Balayage Ombre Baby Light (Long)"), "Global Highlights Balayage Ombre Baby Light");
});

test("flags: outlier price, catch-all, unnormalised category, duplicates but not her/him pairs", () => {
  const services = [
    { name: "Chin (Thread)", category: "Skin", price: 60 },
    { name: "Upper Lips ( Thread)", category: "Skin", price: 60 },
    { name: "Threading Full Face", category: "Skin", price: 400 },
    { name: "Side Locks (Thread)", category: "Skin", price: 4000 },
    { name: "Any item", category: "Hair", price: 100 },
    { name: "head wash", category: "hair", price: 400 },
    { name: "Hair spa ( men)", category: "Hair", price: 2000 },
    { name: "Hair spa (women)", category: "Hair", price: 3000 },
    { name: "Head Massage", category: "Hair", price: 700 },
    { name: "Head Massage (Men)", category: "Hair", price: 600 },
  ];
  const flags = c.flagServices(services);
  const at = (name) => flags[services.findIndex((s) => s.name === name)].join(" | ");

  assert.match(at("Side Locks (Thread)"), /price outlier/);
  assert.doesNotMatch(at("Threading Full Face"), /price outlier/);
  assert.match(at("Any item"), /catch-all/);
  assert.match(at("head wash"), /not normalised/);
  assert.doesNotMatch(at("Hair spa ( men)"), /duplicate/);
  assert.match(at("Head Massage"), /possible duplicate of: Head Massage \(Men\)/);
});

test("M2: median of enough clean samples, rounded up to 5 minutes", () => {
  assert.deepEqual(c.proposeDuration([30, 40, 41, 50, 90]), { durationMinutes: 45, samples: 5 });
  assert.deepEqual(c.proposeDuration([30, 30, 30, 30]), { durationMinutes: null, samples: 4 });
  // 0 and 900 are entry mistakes and do not count towards the sample size.
  assert.deepEqual(c.proposeDuration([0, 900, 20, 20, 20, 20]), { durationMinutes: null, samples: 4 });
  assert.deepEqual(c.proposeDuration([20, 21, 22, 23, 24, 25]), { durationMinutes: 25, samples: 6 });
});

test("M2: every service is assumed to take at least an hour until the owner edits it", () => {
  assert.equal(c.DEFAULT_DURATION_MINUTES, 60);
  // No data at all → the hour.
  assert.deepEqual(c.assumeDuration([]), { durationMinutes: 60, measured: null, samples: 0, source: "default" });
  // Measured but shorter (threading) → still the hour.
  assert.deepEqual(c.assumeDuration([10, 10, 15, 15, 20]), { durationMinutes: 60, measured: 15, samples: 5, source: "floor" });
  // Measured and longer (keratin) → the measurement wins.
  assert.deepEqual(c.assumeDuration([150, 160, 170, 180, 190]), { durationMinutes: 170, measured: 170, samples: 5, source: "visits" });
});
