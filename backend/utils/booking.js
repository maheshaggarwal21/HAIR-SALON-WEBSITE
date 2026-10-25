/**
 * @file booking.js
 * @description The booking engine's write side: create, pay, expire, approve,
 * decline and cancel (CONTROL_FLOW_AND_DATA_LOGIC.md §3, §5, §6, T2.7, T2.8).
 *
 * The read side — which start times are free — is the pure engine in
 * utils/availability.js, fed by utils/availabilityLoader.js. Everything here
 * that changes who owns an artist's time runs inside a MongoDB transaction
 * that inserts, converts or deletes SlotLock rows. The UNIQUE index on
 * SlotLock is the only thing that decides a race (D4, CLAUDE.md): this file
 * never asks "is it free?" and then writes; it writes and lets the index say no.
 *
 * ── Create (§5.1) ────────────────────────────────────────────────────────────
 *   1. per-phone limits: open bookings (E11) and overlapping times (E12);
 *   2. re-run the engine for the requested start only → 409 SLOT_TAKEN with
 *      the three nearest free times when it no longer fits (E1);
 *   3. price from the server's quote; the browser only says "full"/"deposit";
 *   4. TRANSACTION: delete expired holds in the window (TTL lag, E19) →
 *      insert every SlotLock (duplicate key = someone else won → SLOT_TAKEN) →
 *      upsert the Customer → create the Appointment;
 *   5. after commit: Razorpay order (or, for a ₹0 booking, confirm at once).
 *
 * Every online booking is paid online (D18), so a new booking is
 * `pending_payment` with HOLD locks that expire after `holdMinutes`. The
 * Customer upsert sits inside the transaction (the spec lists it after the
 * commit) so a failed booking never leaves a half-made customer behind and the
 * Appointment can carry `customerId` from its first write.
 *
 * ── Payment (§5.3, webhook first) ────────────────────────────────────────────
 * confirmPayment() is called by the Razorpay webhook AND by the browser's
 * verify-payment call; whichever comes second changes nothing (E5). If the
 * hold lapsed before the money arrived it tries to take the same blocks back
 * (E3); if someone else has them, the booking is cancelled by the system with
 * the full amount in the refund queue and the owner is alerted (E4). Money is
 * never kept silently.
 *
 * ── Salon side (§3, §6) ──────────────────────────────────────────────────────
 * approveRequest() turns a request's hold locks firm; releaseBySalon() declines
 * or cancels, deletes the locks so the time is sellable again, and queues a
 * FULL refund of anything paid (D18: salon-side = everything back). Refunds
 * are queued (`refund.status = "pending"`), never fired from here; the owner's
 * refund screen (T2.17) sends them, so a failed Razorpay call can't strand
 * money (E24).
 *
 * Messages and alerts are sent after the commit but BEFORE the route replies
 * (Vercel freezes the instance after the response). They never throw.
 */

const mongoose = require("mongoose");
const Appointment = require("../models/Appointment");
const SlotLock = require("../models/SlotLock");
const Customer = require("../models/Customer");
const SiteSettings = require("../models/SiteSettings");
const { availability, canDo } = require("./availability");
const { serviceKeys } = require("./skills");
const { loadEngineInput, loadServices, BookingError } = require("./availabilityLoader");
const { buildQuote, refundFor, noticeHoursFor } = require("./quote");
const { BLOCK_MS, blocksFor, salonDate, salonInstant, daysBetween, addWorkingMinutes, SALON_TZ } = require("./time");
const { manageToken, hashManageToken } = require("./bookingToken");
const payments = require("./payments");
const { notify } = require("./notify");
const { alertBooking, formatInstant, whenText } = require("./bookingAlerts");
const { groupLimitMessage } = require("./groupLimit");
const metaCapi = require("./metaCapi");

const ACTIVE = ["pending_payment", "requested", "confirmed"];
const PATCH_TEST_VALID_MS = 183 * 24 * 60 * 60 * 1000; // ~6 months (§4.2)
/** A hold is only given away this long after it lapses: checkout may still be finishing. */
const EXPIRY_GRACE_MS = 2 * 60 * 1000;
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

// ─── Locks ───────────────────────────────────────────────────────────────────

/** Every SlotLock a booking owns, rebuilt from its item snapshots. */
function lockDocsFor(appt, { state, expiresAt }, unitFor = () => 0) {
  const docs = [];
  for (const g of appt.guests) {
    for (const i of g.items) {
      if (!i.startAt || !i.artistId) continue;
      const start = new Date(i.startAt).getTime();
      const end = start + blocksFor((i.durationMin || 0) + (i.bufferMin || 0));
      for (let b = start; b < end; b += BLOCK_MS) {
        const base = { appointmentId: appt._id, blockStart: new Date(b), state, ...(expiresAt ? { expiresAt } : {}) };
        docs.push({ ...base, kind: "artist", artistId: i.artistId, resourceUnit: 0 });
        for (const rid of i.resourceIds || []) docs.push({ ...base, kind: "resource", artistId: rid, resourceUnit: unitFor(i, rid) });
      }
    }
  }
  return docs;
}

/** Blocks of expired holds inside a booking's window: dead, but TTL may not have run yet (E19). */
function expiredHoldsFilter(appt, now) {
  return {
    state: "hold",
    expiresAt: { $lte: now },
    blockStart: { $gte: new Date(appt.startAt), $lt: new Date(appt.endAt) },
  };
}

/** Which unique key a duplicate-key error hit, across insertMany / create shapes. */
function duplicateKey(err) {
  const e = err?.writeErrors?.[0]?.err || err?.writeErrors?.[0] || err;
  if (err?.code !== 11000 && e?.code !== 11000) return null;
  const pattern = err.keyPattern || e.keyPattern || {};
  if ("blockStart" in pattern) return "slot";
  if ("ref" in pattern) return "ref";
  if ("phone" in pattern) return "phone";
  const msg = String(err.message || e.errmsg || "");
  if (msg.includes("blockStart")) return "slot";
  if (msg.includes("ref_")) return "ref";
  if (msg.includes("phone")) return "phone";
  return "other";
}

/** Lock state + appointment fields once a booking stops waiting for money. */
function settledState(appt, settings, now) {
  if (appt.mode === "request") {
    const sla = addWorkingMinutes(settings, now, settings.requestSlaMinutes) || new Date(now.getTime() + settings.requestSlaMinutes * 60_000);
    // Never hold past the appointment itself.
    const requestExpiresAt = new Date(Math.min(sla.getTime(), new Date(appt.startAt).getTime()));
    return { status: "requested", lock: { state: "hold", expiresAt: requestExpiresAt }, requestExpiresAt };
  }
  return { status: "confirmed", lock: { state: "firm", expiresAt: null }, requestExpiresAt: null };
}

function lockUpdate(lock) {
  return lock.expiresAt
    ? { $set: { state: lock.state, expiresAt: lock.expiresAt } }
    : { $set: { state: lock.state }, $unset: { expiresAt: "" } };
}

// ─── Create (§5.1) ───────────────────────────────────────────────────────────

/**
 * @param {object}   o
 * @param {string}   o.phone          verified by the booking token
 * @param {string}   o.name
 * @param {object}   o.selection      from prepareSelection()
 * @param {string}   o.startAt        ISO instant chosen from /availability
 * @param {string}   [o.artistId]
 * @param {"full"|"deposit"} o.paymentKind
 * @param {object}   [o.utm]
 * @param {string}   [o.notes]
 * @param {boolean}  [o.whatsappOptIn]
 * @param {Date}     [o.now]
 * @param {object}   [o.staff]        front desk booking for a phone/desk customer (E22):
 *                                    {channel: "phone"|"desk", by, byUserId}. Any active
 *                                    artist, no lead time, no online payment, confirmed
 *                                    at once (staff are the approval), no per-phone cap.
 * @returns {Promise<{appt, order: object|null, manageToken: string}>}
 */
async function createBooking(o) {
  const now = o.now || new Date();
  const { selection } = o;
  o = { ...o, artistId: singleArtist(selection, o.artistId) };
  const settings = (await SiteSettings.getSingleton()).toObject();
  const wanted = Date.parse(o.startAt);
  if (!Number.isFinite(wanted)) throw new BookingError("VALIDATION", "Pick a time.");
  const date = salonDate(new Date(wanted));
  const ahead = daysBetween(salonDate(now), date);
  if (ahead < 0 || ahead > settings.horizonDays) {
    throw new BookingError("OUTSIDE_HOURS", `Choose a date within the next ${settings.horizonDays} days.`);
  }
  if (selection.guests.length > settings.maxGuests) {
    throw new BookingError("VALIDATION", groupLimitMessage(settings.maxGuests));
  }

  // E11 / E12 — the phone's other open bookings. Lapsed unpaid holds don't count.
  const open = (
    await Appointment.find(
      {
        contact: o.phone,
        status: { $in: ACTIVE },
        $or: [{ startAt: { $gte: now } }, { startAt: null, "requestedWindow.date": { $gte: salonDate(now) } }],
      },
      { startAt: 1, endAt: 1, status: 1, holdExpiresAt: 1 }
    ).lean()
  ).filter((a) => !(a.status === "pending_payment" && a.holdExpiresAt && a.holdExpiresAt <= now));
  if (!o.staff && open.length >= settings.maxActiveBookingsPerPhone) {
    throw new BookingError("LIMIT_REACHED", "You already have several bookings with us. Message us on WhatsApp to add another.", 409);
  }

  // Engine, for this start only.
  const patchTestOk = await patchTestOkFor(o.phone, now);
  const { input, mode } = await loadEngineInput({
    date,
    guests: selection.guests,
    services: selection.services,
    artistId: o.artistId || null,
    groupMode: selection.groupMode || "parallel",
    now,
    patchTestOk,
    staff: Boolean(o.staff),
  });
  const slot = availability({ ...input, onlyAt: wanted }).slots[0];
  const alternatives = () => nearestAlternatives({ date, selection, artistId: o.artistId, now, phone: o.phone, wanted });
  if (!slot) throw slotTaken(await alternatives());

  if (open.some((a) => a.startAt && a.endAt && new Date(a.startAt).getTime() < slot.endAt && new Date(a.endAt).getTime() > slot.startAt)) {
    throw new BookingError("OVERLAP", "You already have a booking at that time.", 409);
  }

  // Price: the server's quote, never the browser's.
  const quote = buildQuote({ guests: selection.guests, services: selection.services, settings, pkg: selection.pkg });
  let amount = 0;
  let kind = "full";
  if (quote.total > 0 && !o.staff) {
    const option = quote.payment.options.find((p) => p.kind === o.paymentKind);
    if (!option) throw new BookingError("VALIDATION", "Choose how you'd like to pay.");
    amount = option.amount;
    kind = option.kind;
  }

  // Snapshots, in chain order (cut before colour…), like Visit does (E6).
  const guests = slot.chains.map((c) => {
    const g = selection.guests.find((x) => x.key === c.guestKey);
    return {
      guestKey: g.key,
      name: g.name || (g.key === "g1" ? o.name : null),
      gender: g.gender,
      preferredArtistId: g.artistId || null,
      items: c.items.map((ci) => {
        const s = selection.services.get(ci.serviceId);
        return {
          serviceId: s._id,
          name: s.publicName || s.name,
          publicPrice: s.publicPrice,
          listPrice: s.price ?? null,
          durationMin: s.durationMinutes || 60,
          bufferMin: s.bufferMinutes || 0,
          artistId: ci.artistId,
          artistName: ci.artistName,
          startAt: new Date(ci.startAt),
          endAt: new Date(ci.endAt),
          resourceIds: ci.resources.map((r) => r.resourceId),
        };
      }),
    };
  });
  const units = new Map(
    slot.chains.flatMap((c) => c.items.flatMap((ci) => ci.resources.map((r) => [`${ci.serviceId}|${ci.startAt}|${r.resourceId}`, r.unit])))
  );
  const unitFor = (item, rid) => units.get(`${item.serviceId}|${new Date(item.startAt).getTime()}|${rid}`) ?? 0;

  const holdExpiresAt = new Date(now.getTime() + settings.holdMinutes * 60_000);
  const draft = { guests, startAt: new Date(slot.startAt), endAt: new Date(slot.endAt), mode: o.staff ? "instant" : mode };
  const free = amount === 0;
  const settled = free ? settledState(draft, settings, now) : null;
  const status = free ? settled.status : "pending_payment";
  const lock = free ? settled.lock : { state: "hold", expiresAt: holdExpiresAt };
  const utm = o.utm || null;

  const session = await mongoose.startSession();
  let appt;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await session.withTransaction(async () => {
          const _id = new mongoose.Types.ObjectId();
          await SlotLock.deleteMany(expiredHoldsFilter(draft, now), { session });
          await SlotLock.insertMany(lockDocsFor({ ...draft, _id }, lock, unitFor), { session, ordered: true });

          const set = { name: o.name };
          if (o.whatsappOptIn === true) {
            Object.assign(set, { "marketing.whatsappOptIn": true, "marketing.at": now, "marketing.source": "web_booking" });
          }
          const customer = await Customer.findOneAndUpdate(
            { phone: o.phone },
            {
              // Only the customer can accept the policy; a desk booking doesn't.
              $set: o.staff ? set : { ...set, policyAcceptedAt: now, policyVersion: settings.policyVersion },
              $setOnInsert: { createdFrom: o.staff ? "desk" : "web", gender: guests[0].gender, firstTouch: { utm, at: utm ? now : null } },
            },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true, session }
          );
          guests[0].customerId = customer._id;

          [appt] = await Appointment.create(
            [
              {
                _id,
                ref: Appointment.generateRef(),
                mode: draft.mode,
                status,
                customerId: customer._id,
                contact: o.phone,
                name: o.name,
                guests,
                startAt: draft.startAt,
                endAt: draft.endAt,
                preferredArtistId: guests[0].preferredArtistId || o.artistId || null,
                preferredArtistName: (guests[0].preferredArtistId || o.artistId) ? guests[0].items.find((i) => String(i.artistId) === String(guests[0].preferredArtistId || o.artistId))?.artistName ?? null : null,
                groupMode: groupModeOf(guests),
                pricing: { subtotal: quote.subtotal, discount: quote.discount, total: quote.total },
                deposit: {
                  required: !free,
                  kind,
                  amount,
                  forfeitable: Math.min(amount, quote.payment.cancellationFee),
                  status: free ? "none" : "pending",
                },
                holdExpiresAt: free ? null : holdExpiresAt,
                requestExpiresAt: settled?.requestExpiresAt ?? null,
                source: { channel: o.staff?.channel || "web", utm, pixel: o.staff ? null : o.pixel || null },
                createdBy: o.staff?.byUserId || null,
                policyVersion: settings.policyVersion,
                policyAcceptedAt: o.staff ? null : now,
                notes: o.notes?.trim() || null,
                manageTokenHash: hashManageToken(manageToken(_id)),
                statusHistory: [{ from: null, to: status, at: now, by: o.staff ? o.staff.by || "staff" : "customer", byUserId: o.staff?.byUserId || null }],
              },
            ],
            { session }
          );
        });
        break;
      } catch (err) {
        const dup = duplicateKey(err);
        if (dup === "slot") throw slotTaken(await alternatives());
        // Booking ref collision, or a first-time customer created by a parallel
        // booking a moment ago: start the transaction again.
        if ((dup === "ref" || dup === "phone") && attempt < 3) continue;
        throw err;
      }
    }
  } finally {
    await session.endSession();
  }

  const token = manageToken(appt._id);
  if (free) {
    await afterSettled(appt, settings);
    return { appt, order: null, manageToken: token };
  }

  try {
    const order = await payments.createOrder({
      amount,
      receipt: appt.ref,
      notes: { kind: "booking", appointmentId: String(appt._id), ref: appt.ref, customer_name: o.name },
    });
    await Appointment.updateOne({ _id: appt._id }, { $set: { "deposit.razorpayOrderId": order.id } });
    appt.deposit.razorpayOrderId = order.id;
    return { appt, order, manageToken: token };
  } catch (err) {
    // Nobody can pay, so give the time back now rather than in 10 minutes.
    console.error(`[booking] Razorpay order for ${appt.ref} failed:`, err.message);
    await releaseUnpaid(appt._id, now, "cancelled", "payment_unavailable");
    throw new BookingError("PAYMENT_UNAVAILABLE", "Online payment isn't available right now. Message us on WhatsApp to book.", 503);
  }
}

// ─── Messages after a booking settles ────────────────────────────────────────

function manageUrl(appt) {
  // A setting typed without "https://" would give customers a link that does not open.
  let base = (process.env.CUSTOMER_SITE_URL || "https://www.thexpertshair.com").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return `${base}/booking/${manageToken(appt._id)}`;
}

/**
 * Customer WhatsApp + owner Telegram once a booking is confirmed or waiting for approval,
 * and the same moment to Meta's Conversions API (D65: Lead while waiting, Schedule once
 * confirmed; desk and phone bookings are skipped inside metaCapi).
 */
async function afterSettled(appt, _settings) {
  const type = appt.status === "requested" ? "request_received" : "booking_confirmed";
  await Promise.all([
    metaCapi.send(appt.status === "requested" ? "Lead" : "Schedule", appt),
    notify({
      key: `${appt._id}:${type}`,
      type,
      to: appt.contact,
      appointmentId: appt._id,
      params: { name: appt.name, ref: appt.ref, when: whenText(appt), link: manageUrl(appt) },
    }),
    // The owner hears about website bookings; desk and phone bookings were made in front of staff.
    appt.source?.channel === "web" ? alertBooking(appt, appt.status) : null,
  ]);
}

// ─── Payment (§5.3) ──────────────────────────────────────────────────────────

/**
 * Money for a booking arrived (webhook or browser). Idempotent.
 * @param {object} p
 * @param {string} p.orderId
 * @param {string} p.paymentId
 * @param {number} [p.amount]    rupees, as captured
 * @returns {Promise<{outcome: "confirmed"|"requested"|"already"|"refund_queued"|"unknown_order"|"amount_mismatch", appt?: object}>}
 */
async function confirmPayment({ orderId, paymentId, amount = null, now = new Date() }) {
  const first = await Appointment.findOne({ "deposit.razorpayOrderId": orderId }).lean();
  if (!first) return { outcome: "unknown_order" };
  if (first.deposit.status !== "pending") return { outcome: "already", appt: first };
  if (amount != null && Math.round(amount) !== first.deposit.amount) {
    console.error(`[booking] ${first.ref}: paid ₹${amount}, expected ₹${first.deposit.amount}`);
    await alertBooking(first, "payment_mismatch");
    return { outcome: "amount_mismatch", appt: first };
  }

  const settings = (await SiteSettings.getSingleton()).toObject();
  const settled = settledState(first, settings, now);
  const paid = { "deposit.status": "paid", "deposit.paidAt": now, "deposit.razorpayPaymentId": paymentId, holdExpiresAt: null };
  let outcome = null;
  let updated = null;

  const session = await mongoose.startSession();
  try {
    try {
      await session.withTransaction(async () => {
        outcome = null;
        const appt = await Appointment.findOne({ _id: first._id, "deposit.status": "pending" }, null, { session }).lean();
        if (!appt) {
          outcome = "already";
          return;
        }
        // Cancelled for another reason before the money landed: refund it all.
        if (!["pending_payment", "expired"].includes(appt.status)) {
          throw Object.assign(new Error("not payable"), { notPayable: true });
        }
        const expected = lockDocsFor(appt, settled.lock);
        const own = await SlotLock.countDocuments({ appointmentId: appt._id }, { session });
        if (own === expected.length) {
          await SlotLock.updateMany({ appointmentId: appt._id }, lockUpdate(settled.lock), { session });
        } else {
          // The hold lapsed (E3): take the same blocks back if they're still free.
          await SlotLock.deleteMany({ appointmentId: appt._id }, { session });
          await SlotLock.deleteMany(expiredHoldsFilter(appt, now), { session });
          await SlotLock.insertMany(expected, { session, ordered: true });
        }
        updated = await Appointment.findOneAndUpdate(
          { _id: appt._id, "deposit.status": "pending" },
          {
            $set: { ...paid, status: settled.status, requestExpiresAt: settled.requestExpiresAt },
            $push: { statusHistory: { from: appt.status, to: settled.status, at: now, by: "system", reason: "payment_received" } },
          },
          { returnDocument: "after", session }
        );
        outcome = settled.status;
      });
    } catch (err) {
      if (duplicateKey(err) !== "slot" && !err.notPayable) throw err;
      // E4: paid, but the time has gone (or the booking was already closed).
      // Cancel by system with everything in the refund queue; tell the owner.
      updated = await Appointment.findOneAndUpdate(
        { _id: first._id, "deposit.status": "pending" },
        [
          {
            $set: {
              ...paid,
              status: "cancelled",
              cancelledAt: { $ifNull: ["$cancelledAt", now] },
              cancelledBy: { $ifNull: ["$cancelledBy", "system"] },
              cancelReason: { $ifNull: ["$cancelReason", "paid_after_hold_expired"] },
              refund: {
                amount: first.deposit.amount,
                status: "pending",
                reason: "paid_after_hold_expired",
                requestedAt: now,
                razorpayRefundId: null,
                processedAt: null,
                attempts: 0,
                error: null,
              },
              statusHistory: {
                $concatArrays: [
                  "$statusHistory",
                  [{ from: "$status", to: "cancelled", at: now, by: "system", byUserId: null, reason: "paid_after_hold_expired" }],
                ],
              },
            },
          },
        ],
        { returnDocument: "after", updatePipeline: true }
      ).lean();
      outcome = updated ? "refund_queued" : "already";
    }
  } finally {
    await session.endSession();
  }

  if (outcome === "refund_queued") {
    await SlotLock.deleteMany({ appointmentId: first._id });
    await alertBooking(updated, "paid_after_hold_expired");
    // Sent at once when automatic; the customer then hears "refund sent" from sendRefund,
    // otherwise they are told it is on its way.
    const sent = await autoRefund(updated);
    if (sent?.ok) updated = sent.appt;
    else {
      await notify({
        key: `${first._id}:paid_after_expiry`,
        type: "booking_refund",
        to: first.contact,
        appointmentId: first._id,
        params: { name: first.name, ref: first.ref, amount: first.deposit.amount },
      });
    }
  } else if (outcome === "confirmed" || outcome === "requested") {
    await afterSettled(updated, settings);
  }
  return { outcome, appt: updated || first };
}

// ─── Expiry (cron, §16) ──────────────────────────────────────────────────────

/** Close an unpaid booking and give its time back. Conditional on still being unpaid. */
async function releaseUnpaid(id, now, to, reason) {
  const session = await mongoose.startSession();
  try {
    let done = false;
    await session.withTransaction(async () => {
      const res = await Appointment.updateOne(
        { _id: id, status: "pending_payment", "deposit.status": { $in: ["pending", "none"] } },
        {
          $set: { status: to, holdExpiresAt: null, ...(to === "cancelled" ? { cancelledAt: now, cancelledBy: "system", cancelReason: reason } : {}) },
          $push: { statusHistory: { from: "pending_payment", to, at: now, by: "system", reason } },
        },
        { session }
      );
      done = res.modifiedCount === 1;
      if (done) await SlotLock.deleteMany({ appointmentId: id }, { session });
    });
    return done;
  } finally {
    await session.endSession();
  }
}

/**
 * Unpaid holds past `holdExpiresAt` (+ grace) → expired. Before giving a slot
 * away, ask Razorpay whether the order was in fact paid (a slow webhook): if
 * so, confirm it instead. Requests whose approval window passed → expired with
 * a full refund queued (§3: salon side). Idempotent.
 */
async function expireBookings(now = new Date()) {
  const out = { holdsExpired: 0, paidLate: 0, requestsExpired: 0 };
  const due = await Appointment.find(
    { status: "pending_payment", holdExpiresAt: { $lte: new Date(now.getTime() - EXPIRY_GRACE_MS) } },
    { _id: 1, "deposit.razorpayOrderId": 1 }
  )
    .limit(50)
    .lean();
  for (const a of due) {
    const orderId = a.deposit?.razorpayOrderId;
    if (orderId && payments.isConfigured()) {
      try {
        const [p] = await payments.capturedPayments(orderId);
        if (p) {
          await confirmPayment({ orderId, paymentId: p.id, amount: p.amount / 100, now });
          out.paidLate += 1;
          continue;
        }
      } catch (err) {
        // Can't tell whether it was paid: keep the hold and look again next tick.
        console.error(`[booking] Razorpay check for ${orderId} failed:`, err.message);
        continue;
      }
    }
    if (await releaseUnpaid(a._id, now, "expired", "hold_expired")) out.holdsExpired += 1;
  }

  const lapsed = await Appointment.find({ status: "requested", requestExpiresAt: { $ne: null, $lte: now } }, { _id: 1 }).limit(50).lean();
  for (const a of lapsed) {
    const r = await releaseBySalon(a._id, { from: "requested", to: "expired", reason: "request_not_answered", by: "system", now });
    if (r.ok) out.requestsExpired += 1;
  }
  return out;
}

// ─── Reminders (cron, §11, T2.12) ────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const hasPhone = (a) => /^[6-9]\d{9}$/.test(String(a.contact || ""));

/**
 * Runs every 15 minutes from bookings-tick. Each message has a NotificationLog
 * key, so running twice (or overlapping) sends it once.
 *   - 24h reminder: confirmed bookings starting in 3–24h that were made more
 *     than a day ahead (a booking made this morning doesn't need "see you
 *     tomorrow" an hour later);
 *   - 2h reminder: confirmed bookings starting within 2h, made 3h+ ahead.
 * Walk-ins never get reminders. There is no review-request message: a
 * WhatsApp marketing message costs about 7x a utility one (D50).
 */
async function sendReminders(now = new Date()) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  const t = now.getTime();
  const out = { reminder24h: 0, reminder2h: 0 };

  const soon = await Appointment.find(
    { status: "confirmed", startAt: { $gt: now, $lte: new Date(t + 24 * HOUR_MS) }, "source.channel": { $ne: "walkin" } },
    { ref: 1, name: 1, contact: 1, startAt: 1, createdAt: 1, guests: 1 }
  )
    .limit(200)
    .lean();
  for (const a of soon) {
    if (!hasPhone(a)) continue;
    const ahead = new Date(a.startAt).getTime() - t;
    const bookedAhead = new Date(a.startAt).getTime() - new Date(a.createdAt).getTime();
    const params = { name: a.name, ref: a.ref, when: whenText(a), link: manageUrl(a), map: settings.contact?.mapUrl || "" };
    if (ahead > 3 * HOUR_MS && bookedAhead > 25 * HOUR_MS) {
      const r = await notify({ key: `${a._id}:reminder_24h`, type: "reminder_24h", to: a.contact, appointmentId: a._id, params });
      if (r.status !== "duplicate") out.reminder24h += 1;
    }
    if (ahead <= 2 * HOUR_MS && bookedAhead > 3 * HOUR_MS) {
      const r = await notify({ key: `${a._id}:reminder_2h`, type: "reminder_2h", to: a.contact, appointmentId: a._id, params });
      if (r.status !== "duplicate") out.reminder2h += 1;
    }
  }

  return out;
}

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
  const { DEFAULT_DURATION_MINUTES } = require("../models/Service");
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
  const { DEFAULT_DURATION_MINUTES } = require("../models/Service");
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
  const Artist = require("../models/Artist");
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
  const Service = require("../models/Service");
  const Artist = require("../models/Artist");
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

/**
 * Close a booking: decline, cancel, expire or no-show. In one transaction the
 * status changes (conditional on the status staff saw), the locks go (the time
 * is sellable at once) and any money owed back is queued.
 *
 *   side "salon" / "system" → everything paid comes back (D18);
 *   side "customer"         → the cancellation fee is kept: refund = paid − min(paid, fee),
 *                             unless the owner has set a free-cancellation window.
 * Works for request-lite requests too (no locks, nothing paid).
 *
 * @returns {Promise<{ok: true, appt} | {ok: false, error: "CONFLICT"}>}
 */
async function closeBooking(id, { from, to, side = "salon", reason = null, by = "staff", byUserId = null, now = new Date(), notifyCustomer = true }) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  const fromList = [].concat(from);
  const session = await mongoose.startSession();
  let updated = null;
  let prior = null;
  try {
    await session.withTransaction(async () => {
      updated = null;
      const appt = await Appointment.findOne({ _id: id, status: { $in: fromList } }, null, { session }).lean();
      if (!appt) return;
      prior = appt.status;
      const { refund, kept } = side === "customer" ? refundFor(appt, "customer", settings, now) : refundFor(appt, "salon", settings, now);
      const set = { status: to };
      if (to === "cancelled") Object.assign(set, { cancelledAt: now, cancelledBy: side, cancelReason: reason });
      if (kept > 0) {
        set["deposit.status"] = refund > 0 ? "paid" : "forfeited";
        set.feeKept = kept;
        set.feeKeptAt = now;
      }
      if (refund > 0) {
        set.refund = {
          amount: refund,
          status: "pending",
          reason: `${side}_${to}`,
          requestedAt: now,
          razorpayRefundId: null,
          processedAt: null,
          attempts: 0,
          error: null,
          claimedAt: null,
        };
      }
      updated = await Appointment.findOneAndUpdate(
        { _id: id, status: appt.status },
        { $set: set, $push: { statusHistory: { from: appt.status, to, at: now, by, byUserId, reason } } },
        { returnDocument: "after", session }
      );
      if (updated) await SlotLock.deleteMany({ appointmentId: id }, { session });
    });
  } finally {
    await session.endSession();
  }
  if (!updated) return { ok: false, error: "CONFLICT" };

  if (to === "no_show" && updated.customerId) {
    await Customer.updateOne({ _id: updated.customerId }, { $inc: { "stats.noShows": 1 } });
  }

  // Engine and phone bookings get a WhatsApp; request-lite ones are handled by phone as before.
  const engineBooking = updated.startAt && (updated.deposit?.amount || updated.requestExpiresAt || updated.source?.channel !== "web");
  // A WhatsApp-ad request (D62) has no time held yet, but the customer asked on WhatsApp, so a decline is answered there.
  const waDeclined = updated.source?.channel === "wa_ad" && to === "declined";
  // An unpaid WhatsApp-ad request that is cancelled (by the salon or by the customer) has nothing to refund either.
  const waCancelled = updated.source?.channel === "wa_ad" && to === "cancelled" && !(updated.deposit?.amount > 0);
  if (notifyCustomer && (engineBooking || waDeclined) && updated.source?.channel !== "walkin" && ["cancelled", "declined", "expired"].includes(to)) {
    await notify({
      key: `${updated._id}:${to}`,
      // A declined WhatsApp-ad request (D62) is unpaid, so it gets its own wording with no refund line.
      type: to === "cancelled" ? (waCancelled ? "request_cancelled" : "booking_cancelled") : waDeclined ? "request_declined" : "booking_declined",
      to: updated.contact,
      appointmentId: updated._id,
      params: { name: updated.name, ref: updated.ref, refund: updated.refund?.amount || 0 },
    });
  }
  const auto = await autoRefund(updated);
  return { ok: true, appt: auto?.appt || updated, from: prior };
}

/**
 * Refunds that need no judgement: the salon (or the system) ended the booking,
 * so the whole payment goes back. These are sent at once; customer
 * cancellations and no-shows stay in the queue for the owner (D45).
 */
const AUTO_REFUND_REASON = /^(salon_|system_)|^paid_after_hold_expired$/;
const AUTO_REFUND_MAX_ATTEMPTS = 3;

async function autoRefund(appt) {
  if (!appt || appt.refund?.status !== "pending" || !AUTO_REFUND_REASON.test(appt.refund.reason || "")) return null;
  const settings = (await SiteSettings.getSingleton()).toObject();
  if (settings.autoRefundSalonSide === false) return null;
  try {
    return await sendRefund(appt._id);
  } catch (err) {
    console.error("[booking] auto refund crashed:", err.message); // stays queued; the tick retries
    return null;
  }
}

/** Cron: try again on automatic refunds that failed or were interrupted (a few times, then the owner decides). */
async function retryAutoRefunds(now = new Date()) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  if (settings.autoRefundSalonSide === false) return 0;
  const rows = await Appointment.find(
    {
      "refund.status": { $in: ["pending", "failed", "processing"] },
      "refund.reason": AUTO_REFUND_REASON,
      "refund.attempts": { $lt: AUTO_REFUND_MAX_ATTEMPTS },
      "refund.requestedAt": { $lt: new Date(now.getTime() - 5 * 60_000) },
    },
    { _id: 1 }
  ).limit(25).lean();
  let sent = 0;
  for (const r of rows) {
    const out = await sendRefund(r._id, { now });
    if (out.ok) sent++;
  }
  return sent;
}

/** Salon-side decline / cancel / expire: everything paid comes back. */
function releaseBySalon(id, opts) {
  return closeBooking(id, { ...opts, side: opts.by === "system" ? "system" : "salon" });
}

// ─── Front desk (T2.14–T2.17) ────────────────────────────────────────────────

const FIRM = { state: "firm", expiresAt: null };

/** Price/duration snapshot of a service for a desk booking (any active service, on the menu or not). */
function deskItem(s, artist, startMs) {
  const durationMin = s.durationMinutes || 60;
  return {
    serviceId: s._id,
    name: s.publicName || s.name,
    publicPrice: require("../models/Service").deskPrice(s),
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

/** Which bookings own the given artist blocks (for "who is in the way?"). */
async function ownersOf(locks) {
  const ids = [...new Set(locks.filter((l) => l.appointmentId).map((l) => String(l.appointmentId)))];
  const appts = ids.length ? await Appointment.find({ _id: { $in: ids } }, { ref: 1, name: 1, status: 1, startAt: 1 }).lean() : [];
  const blocked = locks.some((l) => !l.appointmentId);
  return [...appts.map((a) => ({ _id: a._id, ref: a.ref, name: a.name, status: a.status, startAt: a.startAt })), ...(blocked ? [{ ref: null, name: "Blocked time", status: "blocked" }] : [])];
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
  const Artist = require("../models/Artist");
  const Service = require("../models/Service");
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
  const Artist = require("../models/Artist");
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
  const Service = require("../models/Service");
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

  const Service = require("../models/Service");
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

      const Artist = require("../models/Artist");
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

// ─── Refunds (T2.17, E24) ────────────────────────────────────────────────────

const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Send a queued refund through Razorpay. The claim (pending/failed →
 * processing) is a conditional update, so a double tap or two staff can't
 * refund twice. On failure the refund goes back to "failed" with the error,
 * stays in the queue, and the owner is alerted (E24).
 */
async function sendRefund(id, { now = new Date() } = {}) {
  const claimed = await Appointment.findOneAndUpdate(
    {
      _id: id,
      "refund.amount": { $gt: 0 },
      $or: [{ "refund.status": { $in: ["pending", "failed"] } }, { "refund.status": "processing", "refund.claimedAt": { $lt: new Date(now.getTime() - CLAIM_STALE_MS) } }],
    },
    { $set: { "refund.status": "processing", "refund.claimedAt": now }, $inc: { "refund.attempts": 1 } },
    { returnDocument: "after" }
  ).lean();
  if (!claimed) return { ok: false, error: "CONFLICT" };
  const paymentId = claimed.deposit?.razorpayPaymentId;
  try {
    if (!paymentId) throw new Error("No Razorpay payment on this booking — refund by hand and mark it");
    const r = await payments.refund(paymentId, claimed.refund.amount, { ref: claimed.ref, reason: claimed.refund.reason || "" });
    const full = claimed.refund.amount >= (claimed.deposit.amount || 0);
    const updated = await Appointment.findOneAndUpdate(
      { _id: id, "refund.status": "processing" },
      {
        $set: {
          "refund.status": "processed",
          "refund.razorpayRefundId": r.id,
          "refund.processedAt": now,
          "refund.error": null,
          "refund.claimedAt": null,
          "deposit.status": full ? "refunded" : "partially_refunded",
        },
      },
      { returnDocument: "after" }
    ).lean();
    // Tell the customer the money has actually left (the cancel message only said it would).
    await notify({
      key: `${id}:refund_sent:${r.id}`,
      type: "booking_refund",
      to: claimed.contact,
      appointmentId: claimed._id,
      params: { name: claimed.name, ref: claimed.ref, amount: claimed.refund.amount },
    });
    return { ok: true, appt: updated };
  } catch (err) {
    const message = err?.error?.description || err.message || "Refund failed";
    const updated = await Appointment.findOneAndUpdate(
      { _id: id, "refund.status": "processing" },
      { $set: { "refund.status": "failed", "refund.error": message, "refund.claimedAt": null } },
      { returnDocument: "after" }
    ).lean();
    await alertBooking(updated || claimed, "refund_failed");
    return { ok: false, error: "REFUND_FAILED", message, appt: updated };
  }
}

/**
 * Owner changes what goes back before it is sent: waive the cancellation fee
 * (refund all of it) or record that nothing goes back (amount 0, e.g. moved
 * to a new date by agreement). Never more than was paid.
 */
async function adjustRefund(id, { amount, reason = null }) {
  const appt = await Appointment.findOne({ _id: id, "refund.status": { $in: ["pending", "failed", "none"] }, "deposit.status": { $in: ["paid", "forfeited"] } }).lean();
  if (!appt) return { ok: false, error: "CONFLICT" };
  const paid = appt.deposit.amount || 0;
  if (!(amount >= 0 && amount <= paid)) return { ok: false, error: "VALIDATION", message: `Refund between ₹0 and ₹${paid}.` };
  const set =
    amount === 0
      ? { "refund.amount": 0, "refund.status": "none", "refund.reason": reason, "deposit.status": "forfeited" }
      : { "refund.amount": amount, "refund.status": "pending", "refund.reason": reason || appt.refund?.reason || "owner", "refund.requestedAt": appt.refund?.requestedAt || new Date(), "deposit.status": "paid" };
  set.feeKept = paid - amount; // what stays with the salon after this change (0 = fee waived)
  set.feeKeptAt = appt.feeKeptAt || new Date();
  const updated = await Appointment.findOneAndUpdate({ _id: id, "refund.status": appt.refund?.status ?? "none" }, { $set: set }, { returnDocument: "after" }).lean();
  return updated ? { ok: true, appt: updated, before: appt.refund?.amount || 0 } : { ok: false, error: "CONFLICT" };
}

// ─── Customer self-service (manage link, §9, T2.11) ──────────────────────────

/** Statuses a customer can still change from their link. */
const MANAGEABLE = ["pending_payment", "requested", "confirmed"];
/** A link older than this needs a fresh WhatsApp code for cancel / reschedule (§9). */
const LINK_FRESH_MS = 24 * 60 * 60 * 1000;

async function findByManageToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  return Appointment.findOne({ manageTokenHash: hashManageToken(token) }).lean();
}

/**
 * What the customer may do now, and what it would cost (D18). Shown on the
 * manage page BEFORE they confirm, so nobody is surprised by the fee.
 */
function manageRules(appt, settings, now = new Date()) {
  const open = MANAGEABLE.includes(appt.status) && appt.startAt && new Date(appt.startAt) > now;
  const { refund, kept } = refundFor(appt, "customer", settings, now);
  const notice = noticeHoursFor(appt, settings);
  const cutoff = appt.startAt ? new Date(new Date(appt.startAt).getTime() - notice * 3600e3) : null;
  // A package request holds the package's whole time (planRequestTime). The online engine would
  // re-plan it from the services' own times and shrink the lock, so those are moved by reception.
  const canReschedule =
    open && appt.status !== "pending_payment" && !appt.source?.offerPackage?.name && (appt.rescheduleCount || 0) < (settings.maxOnlineReschedules ?? 2) && cutoff && now < cutoff;
  return {
    canCancel: Boolean(open),
    canReschedule: Boolean(canReschedule),
    rescheduleBefore: cutoff,
    reschedulesLeft: Math.max(0, (settings.maxOnlineReschedules ?? 2) - (appt.rescheduleCount || 0)),
    cancel: { refund, kept },
    needsOtp: now - new Date(appt.createdAt) > LINK_FRESH_MS,
  };
}

/** Customer cancels from their link: fee kept, rest refunded (D18). Unpaid holds just end. */
async function cancelByCustomer(appt, { now = new Date(), reason = null } = {}) {
  if (appt.status === "pending_payment") {
    const ok = await releaseUnpaid(appt._id, now, "cancelled", "customer_cancelled_before_paying");
    return ok ? { ok: true, appt: await Appointment.findById(appt._id).lean() } : { ok: false, error: "CONFLICT" };
  }
  return closeBooking(appt._id, { from: ["requested", "confirmed"], to: "cancelled", side: "customer", reason: reason || "customer_cancelled_online", by: "customer", now });
}

/**
 * Customer moves their booking (§9): the same services, a new start, found by
 * the engine (their own current locks don't count against them). One
 * transaction releases the old blocks and takes the new ones; the payment
 * carries over with no fee (D18).
 */
async function rescheduleBooking(appt, { startAt, now = new Date() }) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  const rules = manageRules(appt, settings, now);
  if (!rules.canReschedule) throw new BookingError("LIMIT_REACHED", "This booking can't be moved online any more. Message us on WhatsApp.", 409);
  const wanted = Date.parse(startAt);
  if (!Number.isFinite(wanted)) throw new BookingError("VALIDATION", "Pick a time.");
  const date = salonDate(new Date(wanted));
  const ahead = daysBetween(salonDate(now), date);
  if (ahead < 0 || ahead > settings.horizonDays) throw new BookingError("OUTSIDE_HOURS", `Choose a date within the next ${settings.horizonDays} days.`);

  const ids = [...new Set(appt.guests.flatMap((g) => g.items.map((i) => String(i.serviceId))))];
  const docs = await require("../models/Service").find({ _id: { $in: ids } }).lean();
  const services = new Map(docs.map((d) => [String(d._id), d]));
  // One person keeps their artist. A group keeps what each person ASKED for (null = matched afresh), and a
  // group booked "one after another" stays that way (D67).
  const guests = appt.guests.map((g) => ({ key: g.guestKey, serviceIds: g.items.map((i) => String(i.serviceId)), artistId: appt.guests.length > 1 ? g.preferredArtistId || null : null }));
  const firstArtist = appt.guests.length === 1 && appt.guests[0]?.items[0]?.artistId ? String(appt.guests[0].items[0].artistId) : null;
  const { input } = await loadEngineInput({ date, guests, services, artistId: firstArtist, groupMode: appt.groupMode === "series" ? "series" : "parallel", now, excludeAppointmentId: appt._id, patchTestOk: true });
  const slot = availability({ ...input, onlyAt: wanted }).slots[0];
  if (!slot) throw slotTaken([]);

  const newGuests = appt.guests.map((g) => {
    const chain = slot.chains.find((c) => c.guestKey === g.guestKey);
    const pool = [...g.items];
    return {
      ...g,
      items: chain.items.map((ci) => {
        const at = pool.findIndex((i) => String(i.serviceId) === ci.serviceId);
        const old = pool.splice(at, 1)[0];
        // Price and duration stay the booking's snapshot (E6); only who and when change.
        return { ...old, artistId: ci.artistId, artistName: ci.artistName, startAt: new Date(ci.startAt), endAt: new Date(ci.endAt), resourceIds: ci.resources.map((r) => r.resourceId) };
      }),
    };
  });
  // Same transaction as every other change of a booking's plan. The customer must never learn who
  // holds the time they wanted, so a clash is the plain "just taken" error (anonymous).
  let updated;
  try {
    const done = await applyGroupPlan(appt._id, {
      statuses: [appt.status],
      expectRev: appt.planRev || 0,
      where: { rescheduleCount: appt.rescheduleCount || 0 },
      inc: { rescheduleCount: 1 },
      reason: "rescheduled online",
      by: "customer",
      now,
      anonymous: true,
      plan: { guests: newGuests, startAt: new Date(slot.startAt), endAt: new Date(slot.endAt) },
    });
    if (!done.ok) throw new BookingError("CONFLICT", "This booking just changed. Reload the page.", 409);
    updated = done.appt;
  } catch (err) {
    if (err?.code === "SLOT_TAKEN") throw slotTaken([]);
    throw err;
  }
  await Promise.all([
    notify({
      key: `${appt._id}:rescheduled:${updated.rescheduleCount}`,
      type: "booking_moved",
      to: updated.contact,
      appointmentId: updated._id,
      params: { name: updated.name, ref: updated.ref, when: whenText(updated), link: manageUrl(updated) },
    }),
    alertBooking(updated, "rescheduled"),
  ]);
  return updated;
}

/** RFC 5545 calendar file for the booking (§9 "add to calendar"). */
function icsFor(appt, settings) {
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (t) => String(t || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const items = appt.guests.flatMap((g) => g.items.map((i) => i.name)).join(", ");
  const where = [settings.contact?.address, "Patiala"].filter(Boolean).join(", ");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//The Experts Hair Salon//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${appt.ref}@thexpertshair.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(appt.startAt)}`,
    `DTEND:${stamp(appt.endAt)}`,
    `SUMMARY:${esc(`The Experts — ${items}`)}`,
    `DESCRIPTION:${esc(`Booking ${appt.ref}. Manage: ${manageUrl(appt)}`)}`,
    `LOCATION:${esc(where)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    "DESCRIPTION:Salon appointment in 2 hours",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// ─── Conflicts (E8, E23) ─────────────────────────────────────────────────────

/** Statuses that occupy an artist's time. */
const OCCUPYING = ["pending_payment", "requested", "confirmed", "checked_in"];

/**
 * Bookings and walk-ins with an item overlapping [from, to), optionally for
 * one artist. Used to warn before leave or a holiday is saved over them.
 * @returns {Promise<{_id, ref, name, contact, status, startAt, items: {name, artistName, startAt, endAt}[]}[]>}
 */
async function bookingsOverlapping({ from, to, artistId = null }) {
  const itemMatch = { startAt: { $lt: to }, endAt: { $gt: from }, ...(artistId ? { artistId: new mongoose.Types.ObjectId(String(artistId)) } : {}) };
  const rows = await Appointment.find(
    { status: { $in: OCCUPYING }, guests: { $elemMatch: { items: { $elemMatch: itemMatch } } } },
    { ref: 1, name: 1, contact: 1, status: 1, startAt: 1, guests: 1 }
  )
    .sort({ startAt: 1 })
    .limit(100)
    .lean();
  return rows.map((a) => ({
    _id: a._id,
    ref: a.ref,
    name: a.name,
    contact: a.contact,
    status: a.status,
    startAt: a.startAt,
    items: a.guests
      .flatMap((g) => g.items)
      .filter((i) => i.startAt < to && i.endAt > from && (!artistId || String(i.artistId) === String(artistId)))
      .map((i) => ({ name: i.name, artistName: i.artistName, startAt: i.startAt, endAt: i.endAt })),
  }));
}

module.exports = {
  bookingsOverlapping,
  OCCUPYING,
  prepareSelection,
  findSlots,
  createBooking,
  confirmPayment,
  expireBookings,
  sendReminders,
  approveRequest,
  confirmRequestAtTime,
  suggestArtistsForRequest,
  planRequestTime,
  applyGroupPlan,
  changeGuestArtist,
  groupModeOf,
  releaseBySalon,
  closeBooking,
  createWalkin,
  moveBooking,
  checkIn,
  reassignForLeave,
  retryAutoRefunds,
  finish,
  markNoShow,
  blockTime,
  unblockTime,
  sendRefund,
  adjustRefund,
  findByManageToken,
  manageRules,
  cancelByCustomer,
  rescheduleBooking,
  icsFor,
  releaseUnpaid,
  lockDocsFor,
  manageUrl,
  publicSlot,
  BookingError,
  PATCH_TEST_VALID_MS,
};
