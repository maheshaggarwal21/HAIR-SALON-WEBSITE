/**
 * @file utils/booking/selection.js
 * @description Choosing what is bookable: selection, slots, alternatives (the read side helpers the write side shares).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const { loadEngineInput, loadServices, BookingError } = require("../availabilityLoader");
const { SALON_TZ } = require("../time");
const Customer = require("../../models/Customer");
const { availability, canDo } = require("../availability");


const ACTIVE = ["pending_payment", "requested", "confirmed"];

const PATCH_TEST_VALID_MS = 183 * 24 * 60 * 60 * 1000; // ~6 months (§4.2)

const ALTERNATIVES = 3;

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Normalise the guests the browser sent and load their services. A package's
 * items go to the first guest, ahead of anything they added (D20).
 *
 * @param {{name?: string, for?: "her"|"him", services?: string[], artistId?: string|null}[]} rawGuests
 *        `artistId` is the artist this person asked for (D67), already resolved by the caller
 * @param {object|null} pkg   a live package from livePackages()
 * @param {{groupMode?: "parallel"|"series"}} [opts]  "series": one artist for everyone, one after another
 * @returns {Promise<{guests: {key, name, gender, serviceIds, artistId}[], services: Map, pkg, groupMode}>}
 */
async function prepareSelection(rawGuests, pkg = null, { groupMode = "parallel" } = {}) {
  const pkgIds = pkg ? pkg.items.map((i) => String(i.id)) : [];
  const guests = rawGuests.map((g, idx) => {
    const own = [...new Set((g.services || []).map(String))];
    const serviceIds = idx === 0 ? [...pkgIds, ...own.filter((id) => !pkgIds.includes(id))] : own;
    return {
      key: `g${idx + 1}`,
      name: g.name?.trim() || null,
      gender: g.for === "him" ? "male" : g.for === "her" ? "female" : null,
      serviceIds,
      artistId: g.artistId ? String(g.artistId) : null,
    };
  });
  const series = groupMode === "series" && guests.length > 1;
  if (series && new Set(guests.map((g) => g.artistId).filter(Boolean)).size > 1) {
    throw new BookingError("VALIDATION", "For one artist after another, choose the same artist for everyone, or Any artist.");
  }
  if (!guests.length || guests.some((g) => !g.serviceIds.length)) {
    throw new BookingError("VALIDATION", "Choose at least one service for each person.");
  }
  const services = await loadServices(
    guests.flatMap((g) => g.serviceIds),
    { allowPackageOnly: new Set(pkgIds) }
  );
  return { guests, services, pkg, groupMode: series ? "series" : "parallel" };
}

function hhmm(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: SALON_TZ });
}

/** DS §7 groups: morning < 12:00 ≤ afternoon < 16:00 ≤ evening (§4.2). */
function periodOf(ms) {
  const h = Number(hhmm(ms).slice(0, 2));
  return h < 12 ? "morning" : h < 16 ? "afternoon" : "evening";
}

/** What the website may see of a slot: times, artist names, honest "N left". */
function publicSlot(slot, services) {
  return {
    startAt: new Date(slot.startAt).toISOString(),
    endAt: new Date(slot.endAt).toISOString(),
    time: hhmm(slot.startAt),
    period: periodOf(slot.startAt),
    remaining: slot.remaining,
    guests: slot.chains.map((c) => ({
      key: c.guestKey,
      items: c.items.map((i) => {
        const s = services.get(i.serviceId);
        return {
          serviceId: i.serviceId,
          name: s.publicName || s.name,
          artistName: i.artistName,
          startAt: new Date(i.startAt).toISOString(),
          endAt: new Date(i.endAt).toISOString(),
        };
      }),
    })),
  };
}

async function patchTestOkFor(phone, now) {
  if (!phone) return false;
  const c = await Customer.findOne({ phone }, { patchTestDoneAt: 1 }).lean();
  return Boolean(c?.patchTestDoneAt && now - new Date(c.patchTestDoneAt) < PATCH_TEST_VALID_MS);
}

/**
 * Free start times on one IST date for a selection.
 * @returns {Promise<{mode, slots: object[], patchTestDelay: boolean, raw: object[]}>}
 */
/**
 * The artist for ONE person: the one passed in, else the one named on the selection. A group has no
 * single artist: each guest names their own (`guest.artistId`), and the engine uses it for the items that
 * artist can do (D67 supersedes D46, which ignored any named artist for 2+ people).
 */
const singleArtist = (selection, artistId) => (selection.guests.length === 1 ? artistId || selection.guests[0].artistId || null : null);

/** Can ONE artist (online) do every service of every guest? That is what "one after another" needs. */
function seriesPossible(input) {
  const items = input.guests.flatMap((g) => g.items);
  return input.artists.some((a) => items.every((it) => canDo(a, it)));
}

async function findSlots({ date, selection, artistId: wantedArtist = null, now = new Date(), phone = null, excludeAppointmentId = null }) {
  const artistId = singleArtist(selection, wantedArtist);
  const patchTestOk = await patchTestOkFor(phone, now);
  const groupMode = selection.groupMode || "parallel";
  const { input, mode } = await loadEngineInput({
    date,
    guests: selection.guests,
    services: selection.services,
    artistId,
    groupMode,
    now,
    patchTestOk,
    excludeAppointmentId,
  });
  const out = availability(input);
  const group = selection.guests.length > 1;
  // Side by side found nothing but one artist could do everyone one after another: say so (D67).
  let hint = null;
  if (group && groupMode === "parallel" && !out.slots.length && availability({ ...input, groupMode: "series" }).slots.length) hint = "series_available";
  return {
    mode,
    patchTestDelay: out.patchTestDelay,
    slots: out.slots.map((s) => publicSlot(s, selection.services)),
    raw: out.slots,
    groupMode,
    ...(group ? { seriesPossible: seriesPossible(input), hint } : {}),
  };
}

function slotTaken(alternatives) {
  const err = new BookingError("SLOT_TAKEN", "Sorry, that time was just taken. Pick another time.", 409);
  err.alternatives = alternatives;
  return err;
}

/** The three free times nearest the one the customer wanted (§5.1 step 3). */
async function nearestAlternatives({ date, selection, artistId, now, phone, wanted }) {
  try {
    const { slots } = await findSlots({ date, selection, artistId, now, phone });
    return slots
      .sort((a, b) => Math.abs(Date.parse(a.startAt) - wanted) - Math.abs(Date.parse(b.startAt) - wanted))
      .slice(0, ALTERNATIVES)
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
      .map((s) => ({ startAt: s.startAt, time: s.time }));
  } catch {
    return [];
  }
}

module.exports = { singleArtist, ACTIVE, patchTestOkFor, nearestAlternatives, slotTaken, hhmm, prepareSelection, findSlots, publicSlot, PATCH_TEST_VALID_MS };
