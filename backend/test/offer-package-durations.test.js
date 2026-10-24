const { test } = require("node:test");
const assert = require("node:assert/strict");
const { describePackages } = require("../scripts/listOfferPackageDurations");

test("lists stored and not-stored package durations, and what requests carry", () => {
  const out = describePackages(
    [{ name: "Karva Chauth 2026", startDate: "2026-10-15", endDate: "2026-10-29", active: true, page: { packages: [
      { name: "Package 1", price: 999, durationMinutes: 180 },
      { name: "Package 2", price: 1999 }, // never stored: the system assumes 120
    ] } }],
    [{ ref: "EXP-AAAAA", status: "requested", source: { offerPackage: { name: "Package 2" } }, guests: [{ items: [] }] }]
  );
  assert.deepEqual(out.packages.map((p) => [p.package, p.durationMinutes]), [["Package 1", 180], ["Package 2", null]]);
  assert.match(out.packages[1].status, /NOT STORED/);
  assert.equal(out.requests[0].durationMinutes, null);
  assert.equal(out.requests[0].hasArtist, false);
});
