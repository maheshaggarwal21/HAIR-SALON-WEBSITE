/**
 * @file availability.js
 * @description The availability engine (CONTROL_FLOW_AND_DATA_LOGIC.md §4, T2.4).
 *
 * PURE: no database, no clock. Everything it needs is passed in, so every rule
 * below is unit-tested, including 1,000 random scenarios that check it never
 * gives two items the same artist block (test/availability.test.js). The
 * loader that fills the inputs from MongoDB is utils/availabilityLoader.js.
 *
 * ── What a slot is ───────────────────────────────────────────────────────────
 * A start time `t` on the 15-minute grid at which EVERY guest gets a chain:
 * their items back to back, each with an artist who can do it, is working the
 * whole time, isn't locked, and (if the item needs one) a free station unit.
 * Group guests run in parallel from the same `t` (D9); blocks claimed by an
 * earlier guest in the same candidate count as taken for the later ones. In "series"
 * mode they run one after another with the same artist instead (D67).
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *   - t ≥ now + minLeadMinutes (E10), and ≥ now + 48h when an item needs a
 *     patch test the customer hasn't had (E14);
 *   - each item needs ceil15(duration + buffer) of free blocks; the service
 *     runs for `duration`, the buffer is cleanup after it;
 *   - blocks must sit inside the artist's working intervals, which the loader
 *     already clipped to opening hours — so a chain can never run past closing (E9);
 *   - artist order per item: the customer's preferred artist (MUST be used for
 *     the items they can do) > the artist already doing this guest's chain >
 *     fewest booked minutes today > name;
 *   - a GROUP (D67): each guest may name an artist (`guest.artistPref`, used for the items they can
 *     do, like the single-guest preference). Side by side (the default) every guest needs an artist
 *     of their own at the same time. `groupMode: "series"` is strict: ONE artist who can do every
 *     guest's services does them all, guest after guest, back to back; a named artist must be that one.
 *   - onlineShare: an artist sells at most share% of their working minutes online;
 *   - `remaining` counts how many different first artists could take the slot
 *     (capped at 3) — the honest number behind "2 left" (DS §5).
 */

const { BLOCK_MS, ceilBlock, blocksFor } = require("./time");

const PATCH_TEST_LEAD_MS = 48 * 60 * 60 * 1000;
const REMAINING_CAP = 3;

/**
 * @typedef {object} Item
 * @property {string}   serviceId
 * @property {number}   durationMin
 * @property {number}   [bufferMin]
 * @property {string}   [category]       displayCategory, matched against skillCategories
 * @property {string}   [group]          menu sub-group / card slug, matched against skillGroups (D35)
 * @property {string[]} [resourceIds]
 * @property {boolean}  [requiresPatchTest]
 *
 * @typedef {object} Artist
 * @property {string}   id
 * @property {string}   name
 * @property {boolean}  [skillAll]        may do every service (D35)
 * @property {Set<string>} skills          service ids
 * @property {Set<string>} skillCategories
 * @property {Set<string>} [skillGroups]   menu sub-groups (D35)
 * @property {{start:number,end:number}[]} intervals   working ms, already − breaks − time off
 * @property {number}   onlineShare       0–100
 * @property {number}   onlineMinutesSold already sold online that day
 * @property {number}   bookedMinutes     all booked minutes that day (for balancing)
 *
 * @typedef {object} Input
 * @property {number}   now               epoch ms
 * @property {number}   minLeadMinutes
 * @property {{start:number,end:number}[]} opening   the salon's open intervals that day
 * @property {{key:string, items:Item[]}[]} guests
 * @property {Artist[]} artists
 * @property {Set<string>} locks          `${artistId}|${blockMs}` taken artist blocks
 * @property {{id:string, capacity:number}[]} [resources]
 * @property {Set<string>} [resourceLocks] `${resourceId}|${unit}|${blockMs}`
 * @property {string|null} [artistPref]      single-guest preference; a guest's own `artistPref` wins
 * @property {"parallel"|"series"} [groupMode]  default parallel
 * @property {boolean}  [patchTestOk]      customer had a patch test in the last 6 months
 * @property {number}   [onlyAt]          compute just this start (create / reschedule)
 */

function canDo(artist, item) {
  return (
    artist.skillAll === true ||
    artist.skills.has(String(item.serviceId)) ||
    Boolean(item.category && artist.skillCategories.has(item.category)) ||
    Boolean(item.group && artist.skillGroups?.has(item.group))
  );
}

function inside(intervals, start, end) {
  return intervals.some((i) => i.start <= start && end <= i.end);
}

/**
 * Can artist `a` do `item` from `cursor` to `end` (blocks already listed)? Working then, blocks free,
 * within their online share, and a free unit of every station the service needs. Returns the station
 * units to use ([] if none) or null. Reads only.
 */
function fits(input, a, item, cursor, end, blocks, need, taken, localTaken, claimedMinutes, localMinutes) {
  if (!inside(a.intervals, cursor, end)) return null;
  const isTaken = (key) => input.locks.has(key) || taken.has(key) || localTaken.has(key);
  if (blocks.some((b) => isTaken(`${a.id}|${b}`))) return null;
  const sold = a.onlineMinutesSold + (claimedMinutes.get(a.id) || 0) + (localMinutes.get(a.id) || 0);
  const working = a.intervals.reduce((s, i) => s + (i.end - i.start) / 60000, 0);
  if (sold + need / 60000 > (working * a.onlineShare) / 100 + 1e-9) return null;

  // Stations: one free unit of each required resource for the whole span.
  const units = [];
  for (const rid of item.resourceIds || []) {
    const res = (input.resources || []).find((r) => r.id === String(rid));
    if (!res) continue; // station not tracked
    let unit = -1;
    for (let u = 0; u < res.capacity; u++) {
      if (!blocks.some((b) => (input.resourceLocks || new Set()).has(`${res.id}|${u}|${b}`) || taken.has(`r:${res.id}|${u}|${b}`) || localTaken.has(`r:${res.id}|${u}|${b}`))) {
        unit = u;
        break;
      }
    }
    if (unit === -1) return null;
    units.push({ resourceId: res.id, unit });
  }
  return units;
}

/** The artist a guest asked for, if any: their own, else the single-guest preference. */
const prefOf = (input, guest) => guest.artistPref || input.artistPref || null;

/**
 * Try to build one guest's chain from `t`. `taken` holds blocks claimed by
 * earlier guests/items in this candidate (artist and resource keys) and is
 * extended on success. `forceFirst` pins the first item's artist (used for
 * `remaining`). Returns the chain or null.
 */
function buildChain(input, guest, t, taken, claimedMinutes, forceFirst = null) {
  const chain = [];
  const localTaken = new Set();
  const localMinutes = new Map();
  const pref = prefOf(input, guest);
  let cursor = t;

  for (let idx = 0; idx < guest.items.length; idx++) {
    const item = guest.items[idx];
    const need = blocksFor((item.durationMin || 0) + (item.bufferMin || 0));
    const end = cursor + need;
    const blocks = [];
    for (let b = cursor; b < end; b += BLOCK_MS) blocks.push(b);

    let candidates = input.artists.filter((a) => canDo(a, item));
    const prefCan = pref && candidates.some((a) => a.id === pref);
    if (prefCan) candidates = candidates.filter((a) => a.id === pref);
    if (idx === 0 && forceFirst) candidates = candidates.filter((a) => a.id === forceFirst);
    const inChain = new Set(chain.map((c) => c.artistId));
    candidates.sort(
      (a, b) =>
        Number(inChain.has(b.id)) - Number(inChain.has(a.id)) ||
        a.bookedMinutes - b.bookedMinutes ||
        a.name.localeCompare(b.name)
    );

    let picked = null;
    for (const a of candidates) {
      const units = fits(input, a, item, cursor, end, blocks, need, taken, localTaken, claimedMinutes, localMinutes);
      if (units) {
        picked = { a, units };
        break;
      }
    }
    if (!picked) return null;

    for (const b of blocks) localTaken.add(`${picked.a.id}|${b}`);
    for (const { resourceId, unit } of picked.units) for (const b of blocks) localTaken.add(`r:${resourceId}|${unit}|${b}`);
    localMinutes.set(picked.a.id, (localMinutes.get(picked.a.id) || 0) + need / 60000);
    chain.push({
      serviceId: String(item.serviceId),
      artistId: picked.a.id,
      artistName: picked.a.name,
      startAt: cursor,
      endAt: cursor + (item.durationMin || 0) * 60000,
      blocks,
      resources: picked.units,
    });
    cursor = end;
  }

  for (const k of localTaken) taken.add(k);
  for (const [id, m] of localMinutes) claimedMinutes.set(id, (claimedMinutes.get(id) || 0) + m);
  return { chain, endAt: cursor };
}

/**
 * "Series" (D67): ONE artist does every guest's services, guest after guest, back to back from `t`.
 * Strict: the artist must be able to do ALL the items, and must be the named artist if anyone named one
 * (two different named artists cannot both be "the same artist"). `forceArtist` pins who (for `remaining`).
 * Returns { chains, endAt } or null.
 */
function placeSeries(input, t, forceArtist = null) {
  const named = new Set(input.guests.map((g) => prefOf(input, g)).filter(Boolean));
  if (named.size > 1) return null;
  const items = input.guests.flatMap((g) => g.items);
  let candidates = input.artists.filter((a) => items.every((it) => canDo(a, it)));
  if (named.size === 1) candidates = candidates.filter((a) => a.id === [...named][0]);
  if (forceArtist) candidates = candidates.filter((a) => a.id === forceArtist);
  candidates.sort((a, b) => a.bookedMinutes - b.bookedMinutes || a.name.localeCompare(b.name));

  for (const a of candidates) {
    const taken = new Set();
    const claimed = new Map();
    const chains = [];
    let cursor = t;
    let ok = true;
    for (const guest of input.guests) {
      const chain = [];
      for (const item of guest.items) {
        const need = blocksFor((item.durationMin || 0) + (item.bufferMin || 0));
        const end = cursor + need;
        const blocks = [];
        for (let b = cursor; b < end; b += BLOCK_MS) blocks.push(b);
        const units = fits(input, a, item, cursor, end, blocks, need / 1, taken, new Set(), claimed, new Map());
        if (!units) {
          ok = false;
          break;
        }
        for (const b of blocks) taken.add(`${a.id}|${b}`);
        for (const { resourceId, unit } of units) for (const b of blocks) taken.add(`r:${resourceId}|${unit}|${b}`);
        claimed.set(a.id, (claimed.get(a.id) || 0) + need / 60000);
        chain.push({ serviceId: String(item.serviceId), artistId: a.id, artistName: a.name, startAt: cursor, endAt: cursor + (item.durationMin || 0) * 60000, blocks, resources: units });
        cursor = end;
      }
      if (!ok) break;
      chains.push({ guestKey: guest.key, items: chain });
    }
    if (ok) return { chains, endAt: cursor };
  }
  return null;
}

const isSeries = (input) => input.groupMode === "series" && input.guests.length > 1;

/** Every guest at the same start. Returns { chains, endAt } or null. */
function placeAll(input, t, forceFirst = null) {
  const taken = new Set();
  const claimed = new Map();
  const chains = [];
  let endAt = t;
  for (let g = 0; g < input.guests.length; g++) {
    const out = buildChain(input, input.guests[g], t, taken, claimed, g === 0 ? forceFirst : null);
    if (!out) return null;
    chains.push({ guestKey: input.guests[g].key, items: out.chain });
    endAt = Math.max(endAt, out.endAt);
  }
  return { chains, endAt };
}

function earliestStart(input) {
  let earliest = input.now + (input.minLeadMinutes || 0) * 60000;
  const needsPatch = input.guests.some((g) => g.items.some((i) => i.requiresPatchTest));
  if (needsPatch && !input.patchTestOk) earliest = Math.max(earliest, input.now + PATCH_TEST_LEAD_MS);
  return ceilBlock(earliest);
}

/**
 * @param {Input} input
 * @returns {{ slots: {startAt:number, endAt:number, remaining:number, chains:object[]}[], patchTestDelay: boolean }}
 */
function availability(input) {
  const out = { slots: [], patchTestDelay: false };
  if (!input.guests.length || input.guests.some((g) => !g.items.length)) return out;
  const earliest = earliestStart(input);
  out.patchTestDelay =
    !input.patchTestOk && input.guests.some((g) => g.items.some((i) => i.requiresPatchTest));

  const starts = [];
  if (input.onlyAt != null) starts.push(input.onlyAt);
  else for (const o of input.opening) for (let t = ceilBlock(o.start); t < o.end; t += BLOCK_MS) starts.push(t);

  for (const t of starts) {
    if (t < earliest || t % BLOCK_MS !== 0) continue;
    const placed = isSeries(input) ? placeSeries(input, t) : placeAll(input, t);
    if (!placed) continue;

    // Honest "N left": how many different artists could take the first item (series: could take it all).
    let remaining = 1;
    if (input.onlyAt == null) {
      const first = input.guests[0].items[0];
      const chosen = placed.chains[0].items[0].artistId;
      const wanted = prefOf(input, input.guests[0]);
      const others = input.artists.filter((a) => a.id !== chosen && canDo(a, first));
      for (const a of others) {
        if (remaining >= REMAINING_CAP) break;
        if (wanted && wanted !== a.id && input.artists.some((x) => x.id === wanted && canDo(x, first))) break;
        if (isSeries(input) ? placeSeries(input, t, a.id) : placeAll(input, t, a.id)) remaining += 1;
      }
    }
    out.slots.push({ startAt: t, endAt: placed.endAt, remaining, chains: placed.chains });
  }
  return out;
}

module.exports = { availability, canDo, PATCH_TEST_LEAD_MS };
