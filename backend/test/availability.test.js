/**
 * @file test/availability.test.js
 * @description The availability engine (T2.4): CF §4 rules, edge cases E9,
 * E10, E13, E14, and 1,000 random scenarios that must never double-assign.
 * Pure function — no database.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { availability } = require("../utils/availability");
const { salonInstant, BLOCK_MS, openingIntervals } = require("../utils/time");

const DAY = "2026-10-29"; // a Thursday
const at = (hhmm) => salonInstant(DAY, hhmm).getTime();
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const OPENING = [{ start: at("09:00"), end: at("21:00") }];

function artist(id, over = {}) {
  return {
    id,
    name: id,
    skills: new Set(over.skills || []),
    skillCategories: new Set(over.categories || ["Hair", "Skin", "Threading", "Makeup"]),
    intervals: over.intervals || OPENING,
    onlineShare: over.onlineShare ?? 100,
    onlineMinutesSold: over.sold ?? 0,
    bookedMinutes: over.booked ?? 0,
  };
}
const item = (over = {}) => ({ serviceId: over.serviceId || "svc", durationMin: 60, bufferMin: 0, category: "Hair", ...over });
const base = (over = {}) => ({
  now: salonInstant("2026-10-28", "09:00").getTime(),
  minLeadMinutes: 120,
  opening: OPENING,
  guests: [{ key: "g1", items: [item()] }],
  artists: [artist("asha")],
  locks: new Set(),
  ...over,
});
const times = (out) => out.slots.map((s) => clock(s.startAt));

test("one artist, one hour: every quarter hour from opening until an hour before closing", () => {
  const out = availability(base());
  assert.equal(times(out)[0], "09:00");
  assert.equal(times(out).at(-1), "20:00"); // E9: 20:15 would run past 21:00
  assert.equal(out.slots.length, 45);
});

test("locks remove the blocks they cover, and a chain needs every block free", () => {
  // 12:00–12:15 is locked. A one-hour slot needs 4 free blocks.
  const locks = new Set([`asha|${at("12:00")}`]);
  const t = times(availability(base({ locks })));
  assert.ok(t.includes("11:00")); // 11:00–12:00 ends exactly at the lock
  for (const blocked of ["11:15", "11:30", "11:45", "12:00"]) assert.ok(!t.includes(blocked), blocked);
  assert.ok(t.includes("12:15"));
});

test("lead time (E10): nothing earlier than now + minLeadMinutes", () => {
  const out = availability(base({ now: at("10:05"), minLeadMinutes: 120 }));
  assert.equal(times(out)[0], "12:15");
});

test("buffer extends the hold but not the service window", () => {
  const out = availability(base({ guests: [{ key: "g1", items: [item({ durationMin: 50, bufferMin: 10 })] }], onlyAt: at("10:00") }));
  const c = out.slots[0].chains[0].items[0];
  assert.equal(clock(c.endAt), "10:50");
  assert.equal(c.blocks.length, 4); // 10:00–11:00
});

test("items chain back to back; a second artist picks up what the first can't do", () => {
  const out = availability(
    base({
      guests: [{ key: "g1", items: [item({ category: "Hair", durationMin: 45 }), item({ serviceId: "brows", category: "Threading", durationMin: 15 })] }],
      artists: [artist("asha", { categories: ["Hair"] }), artist("bina", { categories: ["Threading"] })],
      onlyAt: at("10:00"),
    })
  );
  const [cut, brows] = out.slots[0].chains[0].items;
  assert.deepEqual([cut.artistId, clock(cut.startAt), brows.artistId, clock(brows.startAt)], ["asha", "10:00", "bina", "10:45"]);
});

test("the artist already in the chain is preferred for the next item", () => {
  const out = availability(
    base({
      guests: [{ key: "g1", items: [item(), item({ serviceId: "b" })] }],
      artists: [artist("asha", { booked: 300 }), artist("bina")],
      onlyAt: at("10:00"),
    })
  );
  const [a, b] = out.slots[0].chains[0].items;
  assert.equal(a.artistId, "bina"); // fewest booked minutes
  assert.equal(b.artistId, "bina"); // stays with the same artist
});

test("artist preference must be honoured for the items they can do", () => {
  const locks = new Set([`asha|${at("10:00")}`]);
  const artists = [artist("asha"), artist("bina")];
  assert.equal(availability(base({ artists, locks, artistPref: "asha", onlyAt: at("10:00") })).slots.length, 0);
  const free = availability(base({ artists, locks, onlyAt: at("10:00") }));
  assert.equal(free.slots[0].chains[0].items[0].artistId, "bina");
});

test("skills: explicit services or whole categories; neither = not offered", () => {
  const artists = [artist("asha", { categories: [], skills: ["keratin"] })];
  assert.equal(availability(base({ artists, guests: [{ key: "g", items: [item({ serviceId: "keratin", category: "Treatments" })] }] })).slots.length > 0, true);
  assert.equal(availability(base({ artists, guests: [{ key: "g", items: [item({ serviceId: "other", category: "Treatments" })] }] })).slots.length, 0);
});

test("group booking (E13): one guest who can't be placed removes the whole slot", () => {
  const guests = [
    { key: "g1", items: [item()] },
    { key: "g2", items: [item({ serviceId: "x" })] },
  ];
  const one = availability(base({ guests, artists: [artist("asha")] }));
  assert.equal(one.slots.length, 0); // only one artist for two guests at once
  const two = availability(base({ guests, artists: [artist("asha"), artist("bina")], onlyAt: at("10:00") }));
  const used = two.slots[0].chains.map((c) => c.items[0].artistId).sort();
  assert.deepEqual(used, ["asha", "bina"]);
});

test("patch test (E14): colour waits 48 hours unless the customer had one recently", () => {
  const guests = [{ key: "g", items: [item({ requiresPatchTest: true })] }];
  const now = salonInstant("2026-10-27", "10:00").getTime();
  const out = availability(base({ guests, now }));
  assert.equal(out.patchTestDelay, true);
  assert.equal(out.slots[0].startAt >= now + 48 * 3600e3, true);
  const ok = availability(base({ guests, now, patchTestOk: true }));
  assert.equal(ok.patchTestDelay, false);
  assert.ok(ok.slots[0].startAt < now + 48 * 3600e3);
});

test("onlineShare caps what an artist sells online", () => {
  // 12h working = 720 min; 10% = 72 min. 60 already sold → a 60 min item doesn't fit.
  const artists = [artist("asha", { onlineShare: 10, sold: 60 })];
  assert.equal(availability(base({ artists })).slots.length, 0);
  assert.ok(availability(base({ artists: [artist("asha", { onlineShare: 10, sold: 0 })] })).slots.length > 0);
});

test("stations: two facials can't share a single bed", () => {
  const guests = [
    { key: "g1", items: [item({ resourceIds: ["bed"] })] },
    { key: "g2", items: [item({ serviceId: "f2", resourceIds: ["bed"] })] },
  ];
  const artists = [artist("asha"), artist("bina")];
  assert.equal(availability(base({ guests, artists, resources: [{ id: "bed", capacity: 1 }], onlyAt: at("10:00") })).slots.length, 0);
  assert.equal(availability(base({ guests, artists, resources: [{ id: "bed", capacity: 2 }], onlyAt: at("10:00") })).slots.length, 1);
});

test("remaining counts different artists who could take the slot, capped at 3", () => {
  const artists = ["a", "b", "c", "d"].map((id) => artist(id));
  assert.equal(availability(base({ artists })).slots[0].remaining, 3);
  assert.equal(availability(base({ artists: artists.slice(0, 2) })).slots[0].remaining, 2);
});

test("closed day: no opening intervals, no slots", () => {
  const opening = openingIntervals({ openingHours: { tue: [] }, holidays: [] }, "2026-10-27");
  assert.deepEqual(opening, []);
  assert.equal(availability(base({ opening })).slots.length, 0);
});

// ── 1,000 random scenarios ───────────────────────────────────────────────────

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("1,000 random scenarios: never two items on one artist block, never a locked block, never outside working time", () => {
  const rand = rng(20261029);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const cats = ["Hair", "Skin", "Threading", "Makeup"];
  let slotsChecked = 0;

  for (let n = 0; n < 1000; n++) {
    const artists = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => {
      const startH = 9 + Math.floor(rand() * 3);
      const endH = 17 + Math.floor(rand() * 4);
      return artist(`a${i}`, {
        categories: cats.filter(() => rand() < 0.6),
        intervals: [{ start: at(`${String(startH).padStart(2, "0")}:00`), end: at(`${endH}:00`) }],
        onlineShare: pick([100, 100, 60]),
        sold: pick([0, 0, 120]),
        booked: Math.floor(rand() * 300),
      });
    });
    const locks = new Set();
    for (const a of artists) for (let k = 0; k < 10; k++) locks.add(`${a.id}|${at("09:00") + Math.floor(rand() * 48) * BLOCK_MS}`);
    const guests = Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, g) => ({
      key: `g${g}`,
      items: Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => ({
        serviceId: `s${g}${i}`,
        durationMin: pick([15, 30, 45, 60, 90]),
        bufferMin: pick([0, 0, 10]),
        category: pick(cats),
      })),
    }));

    const out = availability(base({ artists, locks, guests, now: at("06:00"), minLeadMinutes: 0 }));
    for (const slot of out.slots) {
      slotsChecked++;
      const used = new Set();
      for (const chain of slot.chains) {
        let cursor = slot.startAt;
        for (const it of chain.items) {
          assert.equal(it.startAt, cursor, "items chain back to back");
          const a = artists.find((x) => x.id === it.artistId);
          for (const b of it.blocks) {
            const key = `${it.artistId}|${b}`;
            assert.ok(!used.has(key), `double-assigned ${key} in scenario ${n}`);
            assert.ok(!locks.has(key), `locked block used in scenario ${n}`);
            assert.ok(a.intervals.some((i) => i.start <= b && b + BLOCK_MS <= i.end), `outside working time in scenario ${n}`);
            used.add(key);
          }
          cursor = it.startAt + it.blocks.length * BLOCK_MS;
        }
      }
    }
  }
  assert.ok(slotsChecked > 1000, `only ${slotsChecked} slots exercised`);
});
