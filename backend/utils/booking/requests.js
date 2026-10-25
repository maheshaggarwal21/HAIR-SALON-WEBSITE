/**
 * @file utils/booking/requests.js
 * @description Requests that need a time: approve, plan, confirm at a time, suggest artists, group plans (D67, D68).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const mongoose = require("mongoose");
const Appointment = require("../../models/Appointment");
const SlotLock = require("../../models/SlotLock");
const SiteSettings = require("../../models/SiteSettings");
const { BLOCK_MS, blocksFor, salonInstant, SALON_TZ } = require("../time");
const { loadEngineInput, BookingError } = require("../availabilityLoader");
const { serviceKeys } = require("../skills");
const { canDo } = require("../availability");
const { FIRM, duplicateKey, expiredHoldsFilter, lockDocsFor, lockUpdate } = require("./locks");
const { afterSettled } = require("./messages");
const { hhmm, slotTaken } = require("./selection");
const { ownersOf } = require("./conflicts");

// ─── Salon side (§3, §6, T2.10) ──────────────────────────────────────────────

/**
 * Staff approve a request that holds its time: the hold locks turn firm. If
 * TTL already removed them, try to take the same blocks again.
 * @returns {Promise<{ok: true, appt} | {ok: false, error: "CONFLICT"|"SLOT_TAKEN", appt?}>}
 */
async function approveRequest(id, { by = "staff", byUserId = null, now = new Date() } = {}) {
  const session = await mongoose.startSession();
  let updated = null;
  try {
    await session.withTransaction(async () => {
      updated = null;
      const appt = await Appointment.findOne({ _id: id, status: "requested" }, null, { session }).lean();
      if (!appt) return;
      const firm = { state: "firm", expiresAt: null };
      const expected = lockDocsFor(appt, firm);
      const own = await SlotLock.countDocuments({ appointmentId: appt._id }, { session });
      if (own === expected.length) {
        await SlotLock.updateMany({ appointmentId: appt._id }, lockUpdate(firm), { session });
      } else {
        await SlotLock.deleteMany({ appointmentId: appt._id }, { session });
        await SlotLock.deleteMany(expiredHoldsFilter(appt, now), { session });
        await SlotLock.insertMany(expected, { session, ordered: true });
      }
      updated = await Appointment.findOneAndUpdate(
        { _id: appt._id, status: "requested" },
        {
          $set: { status: "confirmed", requestExpiresAt: null },
          $push: { statusHistory: { from: "requested", to: "confirmed", at: now, by, byUserId } },
        },
        { returnDocument: "after", session }
      );
    });
  } catch (err) {
    if (duplicateKey(err) === "slot") return { ok: false, error: "SLOT_TAKEN" };
    throw err;
  } finally {
    await session.endSession();
  }
  if (!updated) return { ok: false, error: "CONFLICT" };
  const settings = (await SiteSettings.getSingleton()).toObject();
  await afterSettled(updated, settings);
  return { ok: true, appt: updated };
}

// ─── Confirming a request that has no time yet (audit item 3) ────────────────

const clockIst = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: SALON_TZ }).replace(/\s/g, "").toLowerCase();

/**
 * Spread a package's time over the services the server matched for ONE person: the package's whole
 * time, rounded up to 15 minutes, shared out in blocks by each service's usual length (largest
 * remainder), so the items together fill it exactly. Mutates `items`.
 */
function fitItemsToPackage(items, pkgMinutes) {
  const { DEFAULT_DURATION_MINUTES } = require("../../models/Service");
  if (!items.length) return;
  const total = Math.ceil(pkgMinutes / 15);
  const weights = items.map((i) => i.durationMin || DEFAULT_DURATION_MINUTES);
  const sum = weights.reduce((n, w) => n + w, 0);
  const exact = weights.map((w) => (w * total) / sum);
  const blocks = exact.map(Math.floor);
  let left = total - blocks.reduce((n, b) => n + b, 0);
  exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .forEach(({ i }) => {
      if (left-- > 0) blocks[i]++;
    });
  items.forEach((it, n) => {
    it.durationMin = blocks[n] * 15;
    it.bufferMin = 0;
  });
}

/**
 * Plan what confirming a request at `startMs` looks like: the items with their windows and
 * artists, the end of the booking, and whether a lock can be taken. Pure (no database), so it
 * is unit-tested.
 *
 *  - A PACKAGE request (offer page, D64) is held for the package's whole time, as the owner set
 *    it, rounded up to 15 minutes, FOR EACH PERSON (D67). The services the server matched on the
 *    menu are only slices of that time (fitItemsToPackage); because every other piece of code that
 *    rebuilds locks reads the items (move, change of artist, leave), the whole time is kept without
 *    those places knowing about packages.
 *  - Any other request keeps each service's own time, back to back, with its buffer.
 *  - A package with no stored time, or with no service matched on the menu, cannot be locked: it
 *    still confirms, takes no lock, and says so (`lock.warning`).
 *
 * Each person has ONE artist (`artistFor(guest)`, or one artist for everybody). People with different
 * artists are side by side from the start; people who share an artist follow one another, in the order
 * of the booking (D67). One person's items run back to back.
 *
 * @param {object} appt
 * @param {object|function} artistFor  an artist {_id, name}, or (guest, index) => artist
 * @returns {{guests: object[], startAt: Date, endAt: Date, lock: {taken: boolean, warning?: string}}}
 */
function planRequestTime(appt, artistFor, startMs) {
  const { DEFAULT_DURATION_MINUTES } = require("../../models/Service");
  const artistOf = typeof artistFor === "function" ? artistFor : () => artistFor;
  const guests = appt.guests.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i })) }));
  const itemCount = guests.reduce((n, g) => n + g.items.length, 0);
  const pkg = appt.source?.offerPackage?.name ? appt.source.offerPackage : null;
  const pkgMinutes = Number(pkg?.durationMinutes);
  const hasPkgTime = Number.isFinite(pkgMinutes) && pkgMinutes > 0;

  let lock = { taken: itemCount > 0 };
  if (pkg && (!hasPkgTime || !itemCount)) {
    lock = { taken: false, warning: !hasPkgTime ? "No lock taken: this package has no time set, so the artist's calendar is not blocked. Check their day by hand." : "No lock taken: none of this package's services are on the service list, so the artist's calendar is not blocked. Check their day by hand." };
  }

  for (const g of guests) {
    if (pkg && lock.taken) fitItemsToPackage(g.items, pkgMinutes);
    else for (const it of g.items) it.durationMin = it.durationMin || DEFAULT_DURATION_MINUTES;
  }

  const freeFrom = new Map(); // artist → when they finish the previous person
  let end = startMs;
  guests.forEach((g, n) => {
    const artist = artistOf(g, n);
    const key = String(artist._id);
    let cursor = Math.max(startMs, freeFrom.get(key) || 0);
    for (const it of g.items) {
      it.startAt = new Date(cursor);
      it.endAt = new Date(cursor + it.durationMin * 60_000);
      it.artistId = artist._id;
      it.artistName = artist.name;
      cursor += blocksFor(it.durationMin + (it.bufferMin || 0));
    }
    freeFrom.set(key, cursor);
    end = Math.max(end, cursor);
  });
  if (!lock.taken && hasPkgTime) end = Math.max(end, startMs + pkgMinutes * 60_000);
  return { guests, startAt: new Date(startMs), endAt: new Date(end), lock };
}

// ─── The one write path for a booking's plan (group bookings, D67) ───────────

const lockKeyOf = (d) => `${d.kind}|${d.artistId}|${d.resourceUnit ?? 0}|${new Date(d.blockStart).getTime()}`;

/** "everyone has the same artist" → "series"; anything else → "parallel". A single guest is "parallel". */
function groupModeOf(guests) {
  if (guests.length < 2) return "parallel";
  const ids = new Set(guests.flatMap((g) => g.items.map((i) => String(i.artistId || ""))));
  return ids.size === 1 && !ids.has("") ? "series" : "parallel";
}

/**
 * 409 SLOT_TAKEN that says WHO is in the way (same shape as the walk-in). Staff only: the
 * customer-facing callers pass `anonymous` and get the plain "just taken" error instead,
 * because another customer's name must never reach a customer (CLAUDE.md, privacy).
 */
async function slotTakenError(attempted, ownId, { anonymous = false } = {}) {
  if (anonymous) return slotTaken([]);
  const artistDocs = (attempted?.docs || []).filter((d) => d.kind === "artist");
  if (!artistDocs.length) return new BookingError("SLOT_TAKEN", "Someone took that time just now. Try again.", 409);
  const taken = await SlotLock.find({
    kind: "artist",
    artistId: { $in: [...new Set(artistDocs.map((d) => d.artistId))] },
    blockStart: { $in: artistDocs.map((d) => d.blockStart) },
    appointmentId: { $ne: ownId },
  }).lean();
  if (!taken.length) return new BookingError("SLOT_TAKEN", "Someone took that time just now. Try again.", 409);
  const who = await ownersOf(taken);
  const nameOf = new Map((attempted.guests || []).flatMap((g) => g.items.map((i) => [String(i.artistId), i.artistName])));
  const artists = [...new Set(taken.filter((l) => l.kind === "artist").map((l) => nameOf.get(String(l.artistId)) || "That artist"))].join(", ");
  const names = who.map((o) => (o.ref ? `${o.name} (${o.ref}${o.startAt ? `, ${clockIst(o.startAt)}` : ""})` : o.name)).join(", ");
  const e = new BookingError("SLOT_TAKEN", `${artists} is already booked then: ${names}. Pick another time or artist.`, 409);
  e.conflicts = who;
  return e;
}

/**
 * THE way a booking's plan is changed after it exists: confirm a request at a time, move it,
 * change one guest's artist, reassign for leave, customer reschedule. In ONE transaction it
 * deletes the booking's old locks and lapsed holds, takes the new locks (lockDocsFor), saves
 * the guests/items and bumps `planRev`. The unique index on SlotLock is what refuses a clash;
 * the caller gets 409 SLOT_TAKEN naming who is in the way. Nothing else may write a booking's
 * locks after creation. (createBooking / confirmPayment / approveRequest / createWalkin write
 * theirs while creating or settling a booking, with the same lockDocsFor.)
 *
 * @param {string} id
 * @param {object} o
 * @param {string[]} o.statuses    the booking must be in one of these (else CONFLICT)
 * @param {string}  [o.toStatus]   also change the status (confirm a request)
 * @param {object|function} o.plan {guests, startAt, endAt, groupMode?, skipLocks?, noLockReason?, set?},
 *                                 or a function of the booking as read INSIDE the transaction, so it
 *                                 can never overwrite a change made a moment ago
 * @param {number}  [o.expectRev]  plan was built from a copy at this planRev; if it moved → CONFLICT
 * @param {object}  [o.where]      extra equality conditions (e.g. rescheduleCount)
 * @param {object}  [o.set]        extra fields to $set     @param {object} [o.inc] extra $inc
 * @param {boolean} [o.anonymous]  customer-facing: do not name who is in the way
 * @returns {Promise<{ok: true, appt, before, blocks} | {ok: false, error: "CONFLICT"}>}
 */
async function applyGroupPlan(id, { statuses, toStatus = null, plan, expectRev = null, lock = null, unitFor, set = {}, inc = {}, where = {}, reason = null, by = "staff", byUserId = null, now = new Date(), anonymous = false }) {
  const session = await mongoose.startSession();
  let out = null;
  let attempted = null;
  try {
    await session.withTransaction(async () => {
      out = null;
      attempted = null;
      const cur = await Appointment.findOne({ _id: id, status: { $in: statuses }, ...where }, null, { session }).lean();
      if (!cur) return;
      if (expectRev != null && (cur.planRev || 0) !== expectRev) return;
      const p = typeof plan === "function" ? await plan(cur) : plan;
      if (!p) return;
      const draft = { ...cur, guests: p.guests, startAt: p.startAt, endAt: p.endAt };
      const state = lock || (cur.status === "requested" && cur.requestExpiresAt ? { state: "hold", expiresAt: cur.requestExpiresAt } : FIRM);

      await SlotLock.deleteMany({ appointmentId: cur._id }, { session });
      let blocks = 0;
      if (!p.skipLocks) {
        const docs = lockDocsFor(draft, state, unitFor);
        attempted = { docs, guests: p.guests };
        // One artist cannot do two people at the same moment: say so, instead of a bare duplicate-key error.
        const seen = new Set();
        for (const d of docs) {
          const k = lockKeyOf(d);
          if (seen.has(k)) {
            const who = p.guests.flatMap((g) => g.items).find((i) => String(i.artistId) === String(d.artistId))?.artistName || "That artist";
            throw new BookingError("SLOT_TAKEN", `${who} would be doing two people at the same time. Put them one after another, or pick another artist.`, 409);
          }
          seen.add(k);
        }
        if (docs.length) {
          await SlotLock.deleteMany(expiredHoldsFilter(draft, now), { session });
          await SlotLock.insertMany(docs, { session, ordered: true });
        }
        blocks = docs.filter((d) => d.kind === "artist").length;
      }
      const updated = await Appointment.findOneAndUpdate(
        { _id: cur._id, status: cur.status, ...where },
        {
          $set: {
            guests: p.guests,
            startAt: p.startAt,
            endAt: p.endAt,
            lockConflict: false,
            ...(toStatus ? { status: toStatus } : {}),
            ...(p.groupMode ? { groupMode: p.groupMode } : {}),
            ...(p.skipLocks && p.noLockReason ? { noLockReason: p.noLockReason } : {}),
            ...(p.set || {}),
            ...set,
          },
          ...(p.skipLocks ? {} : { $unset: { noLockReason: "" } }),
          $inc: { planRev: 1, ...inc },
          $push: { statusHistory: { from: cur.status, to: toStatus || cur.status, at: now, by, byUserId, reason } },
        },
        { returnDocument: "after", session, runValidators: true }
      ).lean();
      // Never leave the booking without its locks: undo the delete above.
      if (!updated) throw Object.assign(new Error("changed"), { changed: true });
      out = { ok: true, appt: updated, before: cur, blocks };
    });
  } catch (err) {
    if (err?.changed) return { ok: false, error: "CONFLICT" };
    if (duplicateKey(err) === "slot") throw await slotTakenError(attempted, id, { anonymous });
    throw err;
  } finally {
    await session.endSession();
  }
  return out || { ok: false, error: "CONFLICT" };
}

/**
 * Confirm a request that has no time yet (request-lite and WhatsApp-ad requests) at a
 * date, time and ARTIST staff chose (audit item 3, D66). Goes through applyGroupPlan: lapsed
 * holds go, the artists' blocks are checked, the firm locks are inserted and the status
 * changes in ONE transaction. Another booking in the way is 409 SLOT_TAKEN naming who;
 * nothing is written. See planRequestTime for what is locked.
 *
 * A group (D67) gives one artist per person in `artistIds` ({guestKey: artistId}); `artistId` alone
 * means the same artist for everybody (so one after another).
 *
 * @param {object} [extraSet]  more fields to set in the same update (e.g. the manage-link key)
 * @returns {Promise<{ok: true, appt, lock: {taken: boolean, blocks?: number, minutes?: number, warning?: string}} | {ok: false, error: "CONFLICT"}>}
 */
async function confirmRequestAtTime(id, { date, time, artistId = null, artistIds = null, extraSet = {}, by = "staff", byUserId = null, now = new Date() }) {
  const Artist = require("../../models/Artist");
  const perGuest = artistIds && typeof artistIds === "object" ? artistIds : {};
  const wanted = [...new Set([artistId, ...Object.values(perGuest)].filter(Boolean).map(String))];
  if (!wanted.length) throw new BookingError("VALIDATION", "Choose the artist who will do this booking.");
  const docs = await Artist.find({ _id: { $in: wanted }, isActive: true }, { name: 1 }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  if (wanted.some((w) => !byId.has(w))) throw new BookingError("VALIDATION", "That artist is not active.");
  const startMs = salonInstant(date, time).getTime();
  if (!Number.isFinite(startMs) || startMs % BLOCK_MS !== 0) {
    throw new BookingError("VALIDATION", "Pick a time on the quarter hour, for example 11:00 or 11:15.");
  }

  let planned = null;
  const done = await applyGroupPlan(id, {
    statuses: ["requested"],
    toStatus: "confirmed",
    plan: (cur) => {
      if (Object.keys(perGuest).some((k) => !cur.guests.some((g) => g.guestKey === k))) {
        throw new BookingError("VALIDATION", "There is no such person on this booking.");
      }
      planned = planRequestTime(
        cur,
        (g, n) => {
          const chosen = perGuest[g.guestKey] ?? artistId;
          if (!chosen) throw new BookingError("VALIDATION", `Choose an artist for ${g.name || `person ${n + 1}`}.`);
          return byId.get(String(chosen));
        },
        startMs
      );
      return { guests: planned.guests, startAt: planned.startAt, endAt: planned.endAt, groupMode: groupModeOf(planned.guests), skipLocks: !planned.lock.taken, noLockReason: planned.lock.warning };
    },
    set: extraSet,
    by,
    byUserId,
    now,
  });
  if (!done.ok) return done;
  const lock = planned.lock.taken ? { taken: true, blocks: done.blocks, minutes: done.blocks * 15 } : { taken: false, warning: planned.lock.warning };
  return { ok: true, appt: done.appt, lock };
}

/**
 * "Suggest artists" for a group request (D67): for the date and time staff are about to confirm, a
 * free artist for each person: able to do all of that person's services, working the whole time, with
 * the whole window free, and not already given to someone else in this booking. Reads only; writes
 * nothing. When it cannot place everyone it says why for each person it could not, and offers the
 * nearest times on the same day where everyone fits.
 *
 * @returns {Promise<{ok: boolean, suggestions: object[], alternatives: object[], reason?: string} | {ok: false, error: "CONFLICT"}>}
 */
async function suggestArtistsForRequest(id, { date, time, now = new Date() }) {
  const Service = require("../../models/Service");
  const Artist = require("../../models/Artist");
  const startMs = salonInstant(date, time).getTime();
  if (!Number.isFinite(startMs) || startMs % BLOCK_MS !== 0) {
    throw new BookingError("VALIDATION", "Pick a time on the quarter hour, for example 11:00 or 11:15.");
  }
  const appt = await Appointment.findOne({ _id: id, status: "requested" }).lean();
  if (!appt || (appt.startAt && appt.requestExpiresAt)) return { ok: false, error: "CONFLICT" };

  // Everybody side by side from the start: that is each person's own window.
  const side = planRequestTime(appt, (g) => ({ _id: `suggest:${g.guestKey}`, name: "" }), startMs);
  if (!side.lock.taken) return { ok: false, suggestions: [], alternatives: [], reason: side.lock.warning };

  const docs = await Service.find({ _id: { $in: appt.guests.flatMap((g) => g.items.map((i) => i.serviceId)) } }).lean();
  const keys = new Map(docs.map((d) => [String(d._id), serviceKeys(d)]));
  const windows = side.guests.map((g, n) => ({
    guestKey: g.guestKey,
    label: g.name || `person ${n + 1}`,
    items: g.items.map((i) => ({ serviceId: String(i.serviceId), ...(keys.get(String(i.serviceId)) || {}) })),
    blocks: Math.round(((g.items.reduce((m, i) => Math.max(m, i.startAt.getTime() + blocksFor(i.durationMin + (i.bufferMin || 0))), startMs)) - startMs) / BLOCK_MS),
  }));
  const names = new Map((await Artist.find({ isActive: true }, { name: 1 }).lean()).map((a) => [String(a._id), a.name]));
  const { input } = await loadEngineInput({ date, guests: [], services: new Map(), now, staff: true });
  const preferred = appt.preferredArtistId ? String(appt.preferredArtistId) : null;

  const place = (start) => {
    const used = new Set();
    const out = windows.map((w, n) => {
      const blocks = Array.from({ length: w.blocks }, (_, k) => start + k * BLOCK_MS);
      const able = input.artists.filter((a) => !used.has(a.id) && w.items.every((it) => canDo(a, it)));
      const free = able
        .filter((a) => a.intervals.some((iv) => iv.start <= blocks[0] && blocks[blocks.length - 1] + BLOCK_MS <= iv.end))
        .filter((a) => blocks.every((b) => !input.locks.has(`${a.id}|${b}`)))
        .sort((x, y) => Number(n === 0 && y.id === preferred) - Number(n === 0 && x.id === preferred) || x.bookedMinutes - y.bookedMinutes || x.name.localeCompare(y.name));
      const pick = free[0];
      if (!pick) {
        return {
          guestKey: w.guestKey,
          artistId: null,
          artistName: null,
          reason: able.length
            ? `No other artist is free for all ${w.blocks * 15} minutes at ${hhmm(start)}.`
            : `No artist is set up to do all of ${w.label}'s services.`,
        };
      }
      used.add(pick.id);
      return { guestKey: w.guestKey, artistId: pick.id, artistName: names.get(pick.id) || pick.name };
    });
    return { ok: out.every((s) => s.artistId), suggestions: out };
  };

  // One artist for everybody, one after another (D67): who could do it all from `start`, if anyone.
  const allItems = windows.flatMap((w) => w.items);
  const totalBlocks = windows.reduce((n, w) => n + w.blocks, 0);
  const placeSeries = (start) => {
    const blocks = Array.from({ length: totalBlocks }, (_, k) => start + k * BLOCK_MS);
    const able = input.artists.filter((a) => allItems.every((it) => canDo(a, it)));
    const free = able
      .filter((a) => a.intervals.some((iv) => iv.start <= blocks[0] && blocks[blocks.length - 1] + BLOCK_MS <= iv.end))
      .filter((a) => blocks.every((b) => !input.locks.has(`${a.id}|${b}`)))
      .sort((x, y) => Number(y.id === preferred) - Number(x.id === preferred) || x.bookedMinutes - y.bookedMinutes || x.name.localeCompare(y.name));
    const pick = free[0];
    if (!pick) return { ok: false, reason: able.length ? `No single artist is free for all ${totalBlocks * 15} minutes at ${hhmm(start)}.` : "No single artist can do everyone's services." };
    return { ok: true, minutes: totalBlocks * 15, suggestions: windows.map((w) => ({ guestKey: w.guestKey, artistId: pick.id, artistName: names.get(pick.id) || pick.name })) };
  };

  const here = place(startMs);
  if (here.ok) return { ok: true, suggestions: here.suggestions, alternatives: [] };

  // Not enough artists free side by side: offer "one artist, one after another" at this time (windows.length > 1),
  // and the nearest times (either way) on the same day.
  const series = windows.length > 1 ? placeSeries(startMs) : null;
  const longest = Math.max(...windows.map((w) => w.blocks)) * BLOCK_MS;
  const alternatives = [];
  for (const o of input.opening) {
    for (let t = Math.ceil(o.start / BLOCK_MS) * BLOCK_MS; t < o.end; t += BLOCK_MS) {
      if (t === startMs || t < now.getTime()) continue;
      const distance = Math.abs(t - startMs);
      if (t + longest <= o.end) {
        const tried = place(t);
        if (tried.ok) alternatives.push({ mode: "parallel", time: hhmm(t), startAt: new Date(t).toISOString(), suggestions: tried.suggestions, distance });
      }
      if (windows.length > 1 && t + totalBlocks * BLOCK_MS <= o.end) {
        const tried = placeSeries(t);
        if (tried.ok) alternatives.push({ mode: "series", time: hhmm(t), startAt: new Date(t).toISOString(), suggestions: tried.suggestions, distance });
      }
    }
  }
  alternatives.sort((a, b) => a.distance - b.distance || a.startAt.localeCompare(b.startAt) || (a.mode === "parallel" ? -1 : 1));
  return {
    ok: false,
    suggestions: here.suggestions,
    ...(series ? { series } : {}),
    alternatives: alternatives.slice(0, 3).map(({ distance, ...rest }) => rest),
  };
}

module.exports = { groupModeOf, applyGroupPlan, approveRequest, confirmRequestAtTime, suggestArtistsForRequest, planRequestTime };
