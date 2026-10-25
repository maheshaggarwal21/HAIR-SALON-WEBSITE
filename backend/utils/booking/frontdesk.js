/**
 * @file utils/booking/frontdesk.js
 * @description Front desk: walk-ins, move, change artist, leave, check-in, finish, no-show, blocked time (T2.14-T2.17).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const { BLOCK_MS, blocksFor, salonDate } = require("../time");
const { loadEngineInput, BookingError } = require("../availabilityLoader");
const mongoose = require("mongoose");
const SlotLock = require("../../models/SlotLock");
const Customer = require("../../models/Customer");
const Appointment = require("../../models/Appointment");
const { notify } = require("../notify");
const { formatInstant, whenText } = require("../bookingAlerts");
const { serviceKeys } = require("../skills");
const { canDo } = require("../availability");
const SiteSettings = require("../../models/SiteSettings");
const { FIRM, duplicateKey, expiredHoldsFilter, lockDocsFor } = require("./locks");
const { ownersOf } = require("./conflicts");
const { applyGroupPlan, groupModeOf } = require("./requests");
const { manageUrl } = require("./messages");
const { closeBooking } = require("./salon");

/** Price/duration snapshot of a service for a desk booking (any active service, on the menu or not). */
function deskItem(s, artist, startMs) {
  const durationMin = s.durationMinutes || 60;
  return {
    serviceId: s._id,
    name: s.publicName || s.name,
    publicPrice: require("../../models/Service").deskPrice(s),
    listPrice: s.price ?? null,
    durationMin,
    bufferMin: s.bufferMinutes || 0,
    artistId: artist._id,
    artistName: artist.name,
    startAt: new Date(startMs),
    endAt: new Date(startMs + durationMin * 60_000),
    resourceIds: [],
  };
}

/** Chain items back to back from `startMs`, each with its own artist. */
function rechain(items, startMs) {
  let cursor = startMs;
  return items.map((i) => {
    const out = { ...i, startAt: new Date(cursor), endAt: new Date(cursor + (i.durationMin || 0) * 60_000) };
    cursor += blocksFor((i.durationMin || 0) + (i.bufferMin || 0));
    return out;
  });
}

/**
 * Walk-in at the desk (T2.15, D5, D36): an Appointment with channel "walkin",
 * created straight into `checked_in`, holding FIRM locks — so the website can
 * never sell that chair (CLAUDE.md). All items go to one artist, back to back
 * from `startAt` (default: now, rounded down to the quarter hour).
 *
 * E2: if the artist already has a booking in that time, nothing is saved and
 * the caller gets SLOT_TAKEN with who is in the way. `force: true` saves the
 * walk-in anyway with `lockConflict: true` (locks only on the free blocks);
 * staff must then move one of the two. The route audits it.
 */
async function createWalkin({ name, phone = null, gender = null, artistId, serviceIds, startAt = null, force = false, by = "staff", byUserId = null, now = new Date() }) {
  const Artist = require("../../models/Artist");
  const Service = require("../../models/Service");
  const artist = await Artist.findOne({ _id: artistId, isActive: true }, { name: 1 }).lean();
  if (!artist) throw new BookingError("VALIDATION", "That artist is not active.");
  const docs = await Service.find({ _id: { $in: serviceIds }, isActive: true }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  if (!serviceIds.length || serviceIds.some((sid) => !byId.has(String(sid)))) throw new BookingError("VALIDATION", "Choose services from the list.");

  const start = Math.floor((startAt ? new Date(startAt) : now).getTime() / BLOCK_MS) * BLOCK_MS;
  const items = rechain(serviceIds.map((sid) => deskItem(byId.get(String(sid)), artist, start)), start);
  const endAt = items.reduce((m, i) => Math.max(m, i.startAt.getTime() + blocksFor(i.durationMin + i.bufferMin)), start);
  const subtotal = items.reduce((sum, i) => sum + i.publicPrice, 0);
  const draft = { guests: [{ items }], startAt: new Date(start), endAt: new Date(endAt) };

  const session = await mongoose.startSession();
  let appt;
  let conflictWith = [];
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await session.withTransaction(async () => {
          conflictWith = [];
          const _id = new mongoose.Types.ObjectId();
          await SlotLock.deleteMany(expiredHoldsFilter(draft, now), { session });
          let locks = lockDocsFor({ ...draft, _id }, FIRM);
          const taken = await SlotLock.find(
            { kind: "artist", artistId: artist._id, blockStart: { $in: locks.map((l) => l.blockStart) } },
            null,
            { session }
          ).lean();
          if (taken.length) {
            conflictWith = await ownersOf(taken);
            if (!force) throw Object.assign(new Error("walk-in conflict"), { walkinConflict: true });
            const takenMs = new Set(taken.map((l) => new Date(l.blockStart).getTime()));
            locks = locks.filter((l) => !takenMs.has(l.blockStart.getTime()));
          }
          if (locks.length) await SlotLock.insertMany(locks, { session, ordered: true });

          let customerId = null;
          if (phone) {
            const c = await Customer.findOneAndUpdate(
              { phone },
              { $set: { name }, $setOnInsert: { createdFrom: "desk", gender } },
              { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true, session }
            );
            customerId = c._id;
          }
          [appt] = await Appointment.create(
            [
              {
                _id,
                ref: Appointment.generateRef(),
                mode: "instant",
                status: "checked_in",
                customerId,
                contact: phone || "walk-in",
                name,
                guests: [{ guestKey: "g1", name, gender, customerId, items }],
                startAt: draft.startAt,
                endAt: draft.endAt,
                pricing: { subtotal, discount: 0, total: subtotal },
                deposit: { required: false, amount: 0, status: "none" },
                source: { channel: "walkin" },
                lockConflict: taken.length > 0,
                checkedInAt: now,
                createdBy: byUserId,
                statusHistory: [{ from: null, to: "checked_in", at: now, by, byUserId, reason: taken.length ? "walk-in over a booking (forced)" : "walk-in" }],
              },
            ],
            { session }
          );
        });
        break;
      } catch (err) {
        if (err.walkinConflict) {
          const e = new BookingError("SLOT_TAKEN", `${artist.name} already has a booking then.`, 409);
          e.conflicts = conflictWith;
          throw e;
        }
        const dup = duplicateKey(err);
        if ((dup === "ref" || dup === "phone" || dup === "slot") && attempt < 3) continue; // a parallel write: look again
        throw err;
      }
    }
  } finally {
    await session.endSession();
  }
  return { appt, conflicts: conflictWith };
}

/**
 * Move a booking to another time (T2.17). It SHIFTS: every item and the booking's
 * start/end move by the same amount (new start − old start), so each item keeps its
 * offset. A parallel group stays parallel; a group served by one artist one after
 * another stays in series (D67). In one transaction the old locks go and the new ones
 * are taken; if anyone holds a new block the whole move is refused (409, naming who)
 * and nothing changes. Staff may move outside the online rules (lead time, share).
 *
 * `artistId` moves a ONE-person booking to that artist. For 2+ people it is refused:
 * change one person's artist with changeGuestArtist.
 */
async function moveBooking(id, { startAt, artistId = null, reason = null, by = "staff", byUserId = null, now = new Date() }) {
  const Artist = require("../../models/Artist");
  const artist = artistId ? await Artist.findOne({ _id: artistId, isActive: true }, { name: 1 }).lean() : null;
  if (artistId && !artist) throw new BookingError("VALIDATION", "That artist is not active.");
  const start = Math.floor(new Date(startAt).getTime() / BLOCK_MS) * BLOCK_MS;
  if (!Number.isFinite(start)) throw new BookingError("VALIDATION", "Pick a time.");

  const done = await applyGroupPlan(id, {
    statuses: ["confirmed", "requested", "checked_in"],
    reason: "moved",
    by,
    byUserId,
    now,
    plan: (cur) => {
      if (artist && cur.guests.length > 1) {
        throw new BookingError("VALIDATION", "Change the artist one person at a time. Moving a group only changes the time.");
      }
      const timed = cur.startAt && cur.guests.every((g) => g.items.every((i) => i.startAt));
      let guests;
      let endMs;
      if (timed) {
        const delta = start - new Date(cur.startAt).getTime();
        const shift = (d) => new Date(new Date(d).getTime() + delta);
        guests = cur.guests.map((g) => ({
          ...g,
          items: g.items.map((i) => ({ ...i, startAt: shift(i.startAt), endAt: i.endAt ? shift(i.endAt) : i.endAt, ...(artist ? { artistId: artist._id, artistName: artist.name } : {}) })),
        }));
        endMs = new Date(cur.endAt).getTime() + delta;
      } else {
        // A request that was never given a time: lay its items out from the new start.
        guests = cur.guests.map((g) => ({ ...g, items: rechain(g.items.map((i) => (artist ? { ...i, artistId: artist._id, artistName: artist.name } : i)), start) }));
        endMs = guests.flatMap((g) => g.items).reduce((m, i) => Math.max(m, i.startAt.getTime() + blocksFor((i.durationMin || 0) + (i.bufferMin || 0))), start);
      }
      return { guests, startAt: new Date(start), endAt: new Date(endMs) };
    },
  });
  if (!done.ok) return done;

  const updated = done.appt;
  const before = { startAt: done.before.startAt, artists: [...new Set(done.before.guests.flatMap((g) => g.items.map((i) => i.artistName)))] };
  const talkable = updated.status === "confirmed" && updated.source?.channel !== "walkin" && updated.contact !== "walk-in";
  const timeChanged = new Date(before.startAt).getTime() !== new Date(updated.startAt).getTime();
  const artistsNow = [...new Set(updated.guests.flatMap((g) => g.items.map((i) => i.artistName)))];
  const artistChanged = artistsNow.slice().sort().join("|") !== before.artists.slice().sort().join("|");
  if (talkable && timeChanged) {
    await notify({
      key: `${updated._id}:moved:${start}`,
      type: "booking_moved",
      to: updated.contact,
      appointmentId: updated._id,
      params: { name: updated.name, ref: updated.ref, when: whenText(updated), link: manageUrl(updated) },
    });
  }
  // They asked for a named artist and now have someone else: tell them (D48).
  if (talkable && artistChanged && updated.preferredArtistId) {
    await Appointment.updateOne({ _id: updated._id }, { $set: { artistChangedBySalon: true } });
    await notify({
      key: `${updated._id}:artist_changed:${artistsNow.join(",")}:${start}`,
      type: "booking_artist_changed",
      to: updated.contact,
      appointmentId: updated._id,
      params: { name: updated.name, ref: updated.ref, when: whenText(updated), oldArtist: before.artists.join(", "), newArtist: artistsNow.join(", "), reason, link: manageUrl(updated) },
    });
  }
  return { ok: true, appt: updated, before };
}

/**
 * Change ONE guest's artist (D67): only that guest's items are re-picked, times stay as
 * they were. `artistId` null = pick like the engine (a free artist who can do every
 * service, working then, not already doing someone else in this booking); a named artist
 * must be active and able to do every service of that guest. Goes through applyGroupPlan:
 * 409 SLOT_TAKEN naming who when the artist is busy. `groupMode` follows the artists.
 *
 * @returns {Promise<{ok: true, appt, changed: boolean, from: string[], to: string[]} | {ok: false, error: "CONFLICT"}>}
 */
async function changeGuestArtist(id, guestKey, artistId, { by = "staff", byUserId = null, now = new Date() } = {}) {
  const Service = require("../../models/Service");
  const appt = await Appointment.findOne({ _id: id, status: { $in: ["confirmed", "requested", "checked_in"] } }).lean();
  if (!appt) return { ok: false, error: "CONFLICT" };
  const guest = appt.guests.find((g) => g.guestKey === guestKey);
  if (!guest) throw new BookingError("NOT_FOUND", "That person isn't on this booking.", 404);
  if (!guest.items.length || guest.items.some((i) => !i.startAt)) throw new BookingError("VALIDATION", "This booking has no times yet. Confirm it first.");

  const services = new Map((await Service.find({ _id: { $in: guest.items.map((i) => i.serviceId) } }).lean()).map((d) => [String(d._id), d]));
  const keysOf = (i) => ({ serviceId: String(i.serviceId), ...(services.get(String(i.serviceId)) ? serviceKeys(services.get(String(i.serviceId))) : {}) });
  // Every active artist as the engine sees them (skills, hours, what is booked), without THIS booking's own locks.
  const dates = [...new Set(guest.items.map((i) => salonDate(new Date(i.startAt))))];
  const inputs = new Map();
  for (const date of dates) inputs.set(date, (await loadEngineInput({ date, guests: [], services: new Map(), now, staff: true, excludeAppointmentId: appt._id })).input);
  const pool = inputs.get(dates[0]).artists;

  let picks; // item index → engine artist
  let expectRev = null;
  if (artistId) {
    const a = pool.find((x) => x.id === String(artistId));
    if (!a) throw new BookingError("VALIDATION", "That artist is not active.");
    const cannot = guest.items.find((i) => !canDo(a, keysOf(i)));
    if (cannot) throw new BookingError("VALIDATION", `${a.name} can't do ${cannot.name}.`);
    picks = guest.items.map(() => a);
  } else {
    // Auto-pick. Depends on what else is booked, so it is only valid for this version of the booking.
    expectRev = appt.planRev || 0;
    const taken = new Set();
    for (const g of appt.guests) {
      if (g.guestKey === guestKey) continue;
      for (const i of g.items) {
        if (!i.artistId || !i.startAt) continue;
        const from = new Date(i.startAt).getTime();
        for (let b = from; b < from + blocksFor((i.durationMin || 0) + (i.bufferMin || 0)); b += BLOCK_MS) taken.add(`${i.artistId}|${b}`);
      }
    }
    picks = [];
    for (const item of guest.items) {
      const input = inputs.get(salonDate(new Date(item.startAt)));
      const from = new Date(item.startAt).getTime();
      const to = from + blocksFor((item.durationMin || 0) + (item.bufferMin || 0));
      const blocks = [];
      for (let b = from; b < to; b += BLOCK_MS) blocks.push(b);
      const already = new Set(picks.map((p) => p.id));
      const candidate = input.artists
        .filter((a) => canDo(a, keysOf(item)))
        .filter((a) => a.id !== String(item.artistId)) // they asked to CHANGE it
        .filter((a) => a.intervals.some((iv) => iv.start <= from && to <= iv.end))
        .filter((a) => blocks.every((b) => !input.locks.has(`${a.id}|${b}`) && !taken.has(`${a.id}|${b}`)))
        .sort((x, y) => Number(already.has(y.id)) - Number(already.has(x.id)) || x.bookedMinutes - y.bookedMinutes || x.name.localeCompare(y.name))[0];
      if (!candidate) throw new BookingError("SLOT_TAKEN", `Nobody else is free at ${formatInstant(item.startAt)} for ${item.name}. Choose an artist yourself or move the booking.`, 409);
      for (const b of blocks) taken.add(`${candidate.id}|${b}`);
      picks.push(candidate);
    }
  }

  const from = [...new Set(guest.items.map((i) => i.artistName))];
  const to = [...new Set(picks.map((p) => p.name))];
  if (guest.items.every((i, n) => String(i.artistId) === picks[n].id)) return { ok: true, appt, changed: false, from, to };

  const done = await applyGroupPlan(id, {
    statuses: ["confirmed", "requested", "checked_in"],
    expectRev,
    reason: `guest ${guestKey} artist: ${from.join(", ")} → ${to.join(", ")}`,
    by,
    byUserId,
    now,
    plan: (cur) => {
      const g = cur.guests.find((x) => x.guestKey === guestKey);
      if (!g || g.items.length !== picks.length) return null;
      const guests = cur.guests.map((x) => (x.guestKey !== guestKey ? x : { ...x, items: x.items.map((i, n) => ({ ...i, artistId: new mongoose.Types.ObjectId(picks[n].id), artistName: picks[n].name })) }));
      return { guests, startAt: cur.startAt, endAt: cur.endAt, groupMode: groupModeOf(guests) };
    },
  });
  if (!done.ok) return done;

  // The booker named an artist for the FIRST person and that person now has someone else: tell them, as a move does (D48).
  const updated = done.appt;
  const talkable = updated.status === "confirmed" && updated.source?.channel !== "walkin" && updated.contact !== "walk-in";
  if (talkable && updated.preferredArtistId && updated.guests[0]?.guestKey === guestKey) {
    await Appointment.updateOne({ _id: updated._id }, { $set: { artistChangedBySalon: true } });
    await notify({
      key: `${updated._id}:artist_changed:${to.join(",")}:${new Date(updated.startAt).getTime()}`,
      type: "booking_artist_changed",
      to: updated.contact,
      appointmentId: updated._id,
      params: { name: updated.name, ref: updated.ref, when: whenText(updated), oldArtist: from.join(", "), newArtist: to.join(", "), reason: null, link: manageUrl(updated) },
    });
  }
  return { ok: true, appt: updated, changed: true, from, to };
}

/**
 * An artist can't work [from, to) (leave, sickness…). Move each affected booking
 * to a free artist for the SAME time, automatically (D48). A customer who named
 * an artist is told on WhatsApp who they have instead and why; one who chose
 * "any available" isn't (nothing they asked for changed). If nobody is free for
 * any of a booking's affected services it is left as it is and reported, for
 * reception to sort out by hand — never cancelled.
 *
 * @returns {Promise<{moved: object[], flagged: object[]}>}
 */
async function reassignForLeave({ artistId, from, to, reason = null, by = "staff", byUserId = null, now = new Date() }) {
  const leaving = String(artistId);
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const rows = await Appointment.find(
    {
      status: { $in: ["confirmed", "requested"] },
      guests: { $elemMatch: { items: { $elemMatch: { artistId: new mongoose.Types.ObjectId(leaving), startAt: { $lt: new Date(toMs) }, endAt: { $gt: new Date(fromMs) } } } } },
    },
    null
  )
    .sort({ startAt: 1 })
    .limit(100)
    .lean();

  const Service = require("../../models/Service");
  const moved = [];
  const flagged = [];
  for (const appt of rows) {
    const brief = { _id: appt._id, ref: appt.ref, name: appt.name, contact: appt.contact, startAt: appt.startAt };
    try {
      const itemsAffected = (i) => String(i.artistId) === leaving && new Date(i.startAt).getTime() < toMs && new Date(i.endAt).getTime() > fromMs;
      const serviceIds = [...new Set(appt.guests.flatMap((g) => g.items.filter(itemsAffected).map((i) => String(i.serviceId))))];
      const keys = new Map((await Service.find({ _id: { $in: serviceIds } }).lean()).map((s) => [String(s._id), serviceKeys(s)]));
      const inputs = new Map(); // date → engine input without this booking's own locks
      const taken = new Set();
      const picks = new Map(); // item object → artist
      let stuck = null;

      for (const [gi, g] of appt.guests.entries()) {
        for (const [ii, item] of g.items.entries()) {
          if (!itemsAffected(item)) continue;
          const date = salonDate(new Date(item.startAt));
          if (!inputs.has(date)) inputs.set(date, (await loadEngineInput({ date, guests: [], services: new Map(), now, staff: true, excludeAppointmentId: appt._id })).input);
          const input = inputs.get(date);
          const start = new Date(item.startAt).getTime();
          const end = start + blocksFor((item.durationMin || 0) + (item.bufferMin || 0));
          const blocks = [];
          for (let b = start; b < end; b += BLOCK_MS) blocks.push(b);
          const candidates = input.artists
            .filter((a) => a.id !== leaving)
            .filter((a) => canDo(a, { serviceId: String(item.serviceId), ...(keys.get(String(item.serviceId)) || {}) }))
            .filter((a) => a.intervals.some((iv) => iv.start <= start && end <= iv.end))
            .filter((a) => blocks.every((b) => !input.locks.has(`${a.id}|${b}`) && !taken.has(`${a.id}|${b}`)))
            .sort((x, y) => x.bookedMinutes - y.bookedMinutes || x.name.localeCompare(y.name));
          if (!candidates.length) {
            stuck = `Nobody is free at ${formatInstant(item.startAt)} for ${item.name}.`;
            break;
          }
          picks.set(`${gi}:${ii}`, candidates[0]); // items have no id of their own: guest:item position
          for (const b of blocks) taken.add(`${candidates[0].id}|${b}`);
        }
        if (stuck) break;
      }
      if (stuck) {
        flagged.push({ ...brief, reason: stuck });
        continue;
      }

      const Artist = require("../../models/Artist");
      const names = new Map((await Artist.find({ _id: { $in: [...picks.values()].map((a) => a.id) } }, { name: 1 }).lean()).map((a) => [String(a._id), a.name]));
      let updated;
      try {
        const done = await applyGroupPlan(appt._id, {
          statuses: [appt.status],
          // The picks above were made from this version of the booking.
          expectRev: appt.planRev || 0,
          reason: `artist_reassigned${reason ? `: ${reason}` : ""}`,
          by,
          byUserId,
          now,
          set: appt.preferredArtistId ? { artistChangedBySalon: true } : {},
          plan: (cur) => ({
            guests: cur.guests.map((g, gi) => ({
              ...g,
              items: g.items.map((i, ii) => {
                const pick = picks.get(`${gi}:${ii}`);
                return pick ? { ...i, artistId: new mongoose.Types.ObjectId(pick.id), artistName: names.get(pick.id) || pick.name } : i;
              }),
            })),
            startAt: cur.startAt,
            endAt: cur.endAt,
          }),
        });
        if (!done.ok) {
          flagged.push({ ...brief, reason: "This booking changed while it was being moved. Check it by hand." });
          continue;
        }
        updated = done.appt;
      } catch (err) {
        if (err?.code === "SLOT_TAKEN") {
          flagged.push({ ...brief, reason: "Someone took the free time just now." });
          continue;
        }
        throw err;
      }

      const oldNames = [...new Set(appt.guests.flatMap((g) => g.items.filter(itemsAffected).map((i) => i.artistName)))];
      const newNames = [...new Set([...picks.values()].map((a) => names.get(a.id) || a.name))];
      const named = Boolean(updated.preferredArtistId);
      if (named && updated.contact && updated.contact !== "walk-in" && updated.source?.channel !== "walkin") {
        await notify({
          key: `${updated._id}:artist_changed:${newNames.join(",")}:${updated.startAt.getTime()}`,
          type: "booking_artist_changed",
          to: updated.contact,
          appointmentId: updated._id,
          params: { name: updated.name, ref: updated.ref, when: whenText(updated), oldArtist: oldNames.join(", "), newArtist: newNames.join(", "), reason, link: manageUrl(updated) },
        });
      }
      moved.push({ ...brief, from: oldNames, to: newNames, customerTold: named });
    } catch (err) {
      console.error("[booking] reassign failed for", appt.ref, err.message);
      flagged.push({ ...brief, reason: "Couldn't move it automatically." });
    }
  }
  return { moved, flagged };
}

/** Customer arrived (T2.16): confirmed → checked_in. Visit Entry opens prefilled next. */
async function checkIn(id, { by = "staff", byUserId = null, now = new Date() } = {}) {
  const updated = await Appointment.findOneAndUpdate(
    { _id: id, status: "confirmed" },
    { $set: { status: "checked_in", checkedInAt: now }, $push: { statusHistory: { from: "confirmed", to: "checked_in", at: now, by, byUserId } } },
    { returnDocument: "after" }
  );
  return updated ? { ok: true, appt: updated } : { ok: false, error: "CONFLICT" };
}

/**
 * "Finished" (one tap): the real end of the service. The start is the check-in
 * time, so the two give the time taken without anyone typing it afterwards.
 * Only once, and only while the customer is in the chair.
 */
async function finish(id, { now = new Date() } = {}) {
  const updated = await Appointment.findOneAndUpdate(
    { _id: id, status: "checked_in", finishedAt: null, visitId: null, checkedInAt: { $ne: null, $lte: now } },
    { $set: { finishedAt: now } },
    { returnDocument: "after" }
  );
  return updated ? { ok: true, appt: updated } : { ok: false, error: "CONFLICT" };
}

/**
 * No-show (§3): only after start + noShowGraceMinutes. Locks go, the
 * cancellation fee is kept and anything above it is queued for refund (D18),
 * and the customer's no-show count goes up.
 */
async function markNoShow(id, { by = "staff", byUserId = null, now = new Date() } = {}) {
  const appt = await Appointment.findOne({ _id: id, status: "confirmed" }, { startAt: 1 }).lean();
  if (!appt) return { ok: false, error: "CONFLICT" };
  const settings = (await SiteSettings.getSingleton()).toObject();
  const grace = (settings.noShowGraceMinutes ?? 15) * 60_000;
  if (now.getTime() < new Date(appt.startAt).getTime() + grace) {
    return { ok: false, error: "TOO_EARLY", message: `Wait until ${settings.noShowGraceMinutes ?? 15} minutes after the start time.` };
  }
  return closeBooking(id, { from: "confirmed", to: "no_show", side: "customer", reason: "no_show", by, byUserId, now });
}

/** Staff block an artist's time (training, lunch): firm locks with no appointment. */
async function blockTime({ artistId, startAt, endAt, note = null }) {
  const start = Math.floor(new Date(startAt).getTime() / BLOCK_MS) * BLOCK_MS;
  const end = Math.ceil(new Date(endAt).getTime() / BLOCK_MS) * BLOCK_MS;
  if (!(end > start)) throw new BookingError("VALIDATION", "Blocked time must end after it starts.");
  const docs = [];
  for (let b = start; b < end; b += BLOCK_MS) docs.push({ kind: "artist", artistId, resourceUnit: 0, blockStart: new Date(b), state: "firm", appointmentId: null, note });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await SlotLock.deleteMany({ state: "hold", expiresAt: { $lte: new Date() }, artistId, blockStart: { $gte: new Date(start), $lt: new Date(end) } }, { session });
      await SlotLock.insertMany(docs, { session, ordered: true });
    });
  } catch (err) {
    if (duplicateKey(err) === "slot") {
      const taken = await SlotLock.find({ kind: "artist", artistId, blockStart: { $gte: new Date(start), $lt: new Date(end) } }).lean();
      const e = new BookingError("SLOT_TAKEN", "Part of that time is already booked.", 409);
      e.conflicts = await ownersOf(taken);
      throw e;
    }
    throw err;
  } finally {
    await session.endSession();
  }
  return { blocks: docs.length, startAt: new Date(start), endAt: new Date(end) };
}

async function unblockTime({ artistId, startAt, endAt }) {
  const res = await SlotLock.deleteMany({
    kind: "artist",
    artistId,
    appointmentId: null,
    blockStart: { $gte: new Date(startAt), $lt: new Date(endAt) },
  });
  return { blocks: res.deletedCount };
}

module.exports = { changeGuestArtist, createWalkin, moveBooking, checkIn, reassignForLeave, finish, markNoShow, blockTime, unblockTime };
