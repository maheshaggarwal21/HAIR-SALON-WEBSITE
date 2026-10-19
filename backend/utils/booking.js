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
const { BLOCK_MS, blocksFor, salonDate, daysBetween, addWorkingMinutes, SALON_TZ } = require("./time");
const { manageToken, hashManageToken } = require("./bookingToken");
const payments = require("./payments");
const { notify } = require("./notify");
const { alertBooking, formatInstant } = require("./bookingAlerts");

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
 * @param {{name?: string, for?: "her"|"him", services?: string[]}[]} rawGuests
 * @param {object|null} pkg   a live package from livePackages()
 * @returns {Promise<{guests: {key, name, gender, serviceIds}[], services: Map, pkg}>}
 */
async function prepareSelection(rawGuests, pkg = null) {
  const pkgIds = pkg ? pkg.items.map((i) => String(i.id)) : [];
  const guests = rawGuests.map((g, idx) => {
    const own = [...new Set((g.services || []).map(String))];
    const serviceIds = idx === 0 ? [...pkgIds, ...own.filter((id) => !pkgIds.includes(id))] : own;
    return {
      key: `g${idx + 1}`,
      name: g.name?.trim() || null,
      gender: g.for === "him" ? "male" : g.for === "her" ? "female" : null,
      serviceIds,
    };
  });
  if (!guests.length || guests.some((g) => !g.serviceIds.length)) {
    throw new BookingError("VALIDATION", "Choose at least one service for each person.");
  }
  const services = await loadServices(
    guests.flatMap((g) => g.serviceIds),
    { allowPackageOnly: new Set(pkgIds) }
  );
  return { guests, services, pkg };
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
 * A group is served in parallel, so each guest needs a different artist. One
 * chosen artist would be demanded for everyone's services and leave no time at
 * all; groups therefore always use "any available" (D46). The booking sheet
 * skips the artist step for groups; this keeps the API honest for anyone else.
 */
const artistForGroup = (selection, artistId) => (selection.guests.length > 1 ? null : artistId || null);

async function findSlots({ date, selection, artistId: wantedArtist = null, now = new Date(), phone = null, excludeAppointmentId = null }) {
  const artistId = artistForGroup(selection, wantedArtist);
  const patchTestOk = await patchTestOkFor(phone, now);
  const { input, mode } = await loadEngineInput({
    date,
    guests: selection.guests,
    services: selection.services,
    artistId,
    now,
    patchTestOk,
    excludeAppointmentId,
  });
  const out = availability(input);
  return {
    mode,
    patchTestDelay: out.patchTestDelay,
    slots: out.slots.map((s) => publicSlot(s, selection.services)),
    raw: out.slots,
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
  o = { ...o, artistId: artistForGroup(selection, o.artistId) };
  const settings = (await SiteSettings.getSingleton()).toObject();
  const wanted = Date.parse(o.startAt);
  if (!Number.isFinite(wanted)) throw new BookingError("VALIDATION", "Pick a time.");
  const date = salonDate(new Date(wanted));
  const ahead = daysBetween(salonDate(now), date);
  if (ahead < 0 || ahead > settings.horizonDays) {
    throw new BookingError("OUTSIDE_HOURS", `Choose a date within the next ${settings.horizonDays} days.`);
  }
  if (selection.guests.length > settings.maxGuests) {
    throw new BookingError("VALIDATION", `Book up to ${settings.maxGuests} people at a time.`);
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
                preferredArtistId: o.artistId || null,
                preferredArtistName: o.artistId ? guests[0].items.find((i) => String(i.artistId) === String(o.artistId))?.artistName ?? null : null,
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
                source: { channel: o.staff?.channel || "web", utm },
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
  const base = (process.env.CUSTOMER_SITE_URL || "https://www.thexpertshair.com").replace(/\/+$/, "");
  return `${base}/booking/${manageToken(appt._id)}`;
}

/** Customer WhatsApp + owner Telegram once a booking is confirmed or waiting for approval. */
async function afterSettled(appt, _settings) {
  const type = appt.status === "requested" ? "request_received" : "booking_confirmed";
  await Promise.all([
    notify({
      key: `${appt._id}:${type}`,
      type,
      to: appt.contact,
      appointmentId: appt._id,
      params: { name: appt.name, ref: appt.ref, when: formatInstant(appt.startAt), link: manageUrl(appt) },
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
    const params = { name: a.name, ref: a.ref, when: formatInstant(a.startAt), link: manageUrl(a), map: settings.contact?.mapUrl || "" };
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
  if (notifyCustomer && engineBooking && updated.source?.channel !== "walkin" && ["cancelled", "declined", "expired"].includes(to)) {
    await notify({
      key: `${updated._id}:${to}`,
      type: to === "cancelled" ? "booking_cancelled" : "booking_declined",
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
    publicPrice: s.publicPrice ?? Math.round((s.price || 0) * 0.5),
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
 * Move a booking to another time and/or artist (T2.17). One transaction:
 * release the old locks, take the new ones; if anyone holds a new block the
 * whole move is refused and nothing changes. Items keep their order and
 * durations; `artistId` moves every item to that artist, otherwise each keeps
 * its own. Staff may move outside the online rules (lead time, share).
 */
async function moveBooking(id, { startAt, artistId = null, reason = null, by = "staff", byUserId = null, now = new Date() }) {
  const Artist = require("../models/Artist");
  const artist = artistId ? await Artist.findOne({ _id: artistId, isActive: true }, { name: 1 }).lean() : null;
  if (artistId && !artist) throw new BookingError("VALIDATION", "That artist is not active.");
  const start = Math.floor(new Date(startAt).getTime() / BLOCK_MS) * BLOCK_MS;
  if (!Number.isFinite(start)) throw new BookingError("VALIDATION", "Pick a time.");

  const session = await mongoose.startSession();
  let updated = null;
  let before = null;
  try {
    await session.withTransaction(async () => {
      updated = null;
      const appt = await Appointment.findOne({ _id: id, status: { $in: ["confirmed", "requested", "checked_in"] } }, null, { session }).lean();
      if (!appt) return;
      before = { startAt: appt.startAt, artists: [...new Set(appt.guests.flatMap((g) => g.items.map((i) => i.artistName)))] };
      // Guests run in parallel from the same start (D9); each guest's items chain.
      const guests = appt.guests.map((g) => ({
        ...g,
        items: rechain(g.items.map((i) => (artist ? { ...i, artistId: artist._id, artistName: artist.name } : i)), start),
      }));
      const endAt = guests.flatMap((g) => g.items).reduce((m, i) => Math.max(m, i.startAt.getTime() + blocksFor((i.durationMin || 0) + (i.bufferMin || 0))), start);
      const lock = appt.status === "requested" && appt.requestExpiresAt ? { state: "hold", expiresAt: appt.requestExpiresAt } : FIRM;
      const draft = { ...appt, guests, startAt: new Date(start), endAt: new Date(endAt) };

      await SlotLock.deleteMany({ appointmentId: appt._id }, { session });
      await SlotLock.deleteMany(expiredHoldsFilter(draft, now), { session });
      await SlotLock.insertMany(lockDocsFor(draft, lock), { session, ordered: true });
      updated = await Appointment.findOneAndUpdate(
        { _id: appt._id, status: appt.status },
        {
          $set: { guests, startAt: draft.startAt, endAt: draft.endAt, lockConflict: false },
          $push: { statusHistory: { from: appt.status, to: appt.status, at: now, by, byUserId, reason: "moved" } },
        },
        { returnDocument: "after", session, runValidators: true }
      );
    });
  } catch (err) {
    if (duplicateKey(err) === "slot") throw new BookingError("SLOT_TAKEN", "That time isn't free for this artist.", 409);
    throw err;
  } finally {
    await session.endSession();
  }
  if (!updated) return { ok: false, error: "CONFLICT" };
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
      params: { name: updated.name, ref: updated.ref, when: formatInstant(updated.startAt), link: manageUrl(updated) },
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
      params: { name: updated.name, ref: updated.ref, when: formatInstant(updated.startAt), oldArtist: before.artists.join(", "), newArtist: artistsNow.join(", "), reason: reason || "a change in our schedule", link: manageUrl(updated) },
    });
  }
  return { ok: true, appt: updated, before };
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
      const session = await mongoose.startSession();
      let updated = null;
      try {
        await session.withTransaction(async () => {
          updated = null;
          const cur = await Appointment.findOne({ _id: appt._id, status: appt.status }, null, { session }).lean();
          if (!cur) return;
          const guests = cur.guests.map((g, gi) => ({
            ...g,
            items: g.items.map((i, ii) => {
              const pick = picks.get(`${gi}:${ii}`);
              return pick ? { ...i, artistId: new mongoose.Types.ObjectId(pick.id), artistName: names.get(pick.id) || pick.name } : i;
            }),
          }));
          const lock = cur.status === "requested" && cur.requestExpiresAt ? { state: "hold", expiresAt: cur.requestExpiresAt } : FIRM;
          const draft = { ...cur, guests };
          await SlotLock.deleteMany({ appointmentId: cur._id }, { session });
          await SlotLock.insertMany(lockDocsFor(draft, lock), { session, ordered: true });
          updated = await Appointment.findOneAndUpdate(
            { _id: cur._id, status: cur.status },
            {
              $set: { guests, ...(cur.preferredArtistId ? { artistChangedBySalon: true } : {}) },
              $push: { statusHistory: { from: cur.status, to: cur.status, at: now, by, byUserId, reason: `artist_reassigned${reason ? `: ${reason}` : ""}` } },
            },
            { returnDocument: "after", session, runValidators: true }
          );
        });
      } catch (err) {
        if (duplicateKey(err) === "slot") {
          flagged.push({ ...brief, reason: "Someone took the free time just now." });
          continue;
        }
        throw err;
      } finally {
        await session.endSession();
      }
      if (!updated) continue;

      const oldNames = [...new Set(appt.guests.flatMap((g) => g.items.filter(itemsAffected).map((i) => i.artistName)))];
      const newNames = [...new Set([...picks.values()].map((a) => names.get(a.id) || a.name))];
      const named = Boolean(updated.preferredArtistId);
      if (named && updated.contact && updated.contact !== "walk-in" && updated.source?.channel !== "walkin") {
        await notify({
          key: `${updated._id}:artist_changed:${newNames.join(",")}:${updated.startAt.getTime()}`,
          type: "booking_artist_changed",
          to: updated.contact,
          appointmentId: updated._id,
          params: { name: updated.name, ref: updated.ref, when: formatInstant(updated.startAt), oldArtist: oldNames.join(", "), newArtist: newNames.join(", "), reason: reason || "a change in our schedule", link: manageUrl(updated) },
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
  const canReschedule =
    open && appt.status !== "pending_payment" && (appt.rescheduleCount || 0) < (settings.maxOnlineReschedules ?? 2) && cutoff && now < cutoff;
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
  const guests = appt.guests.map((g) => ({ key: g.guestKey, serviceIds: g.items.map((i) => String(i.serviceId)) }));
  const firstArtist = appt.guests[0]?.items[0]?.artistId ? String(appt.guests[0].items[0].artistId) : null;
  const { input } = await loadEngineInput({ date, guests, services, artistId: firstArtist, now, excludeAppointmentId: appt._id, patchTestOk: true });
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
  const draft = { ...appt, guests: newGuests, startAt: new Date(slot.startAt), endAt: new Date(slot.endAt) };
  const lock = appt.status === "requested" && appt.requestExpiresAt ? { state: "hold", expiresAt: appt.requestExpiresAt } : FIRM;

  const session = await mongoose.startSession();
  let updated = null;
  try {
    await session.withTransaction(async () => {
      updated = null;
      await SlotLock.deleteMany({ appointmentId: appt._id }, { session });
      await SlotLock.deleteMany(expiredHoldsFilter(draft, now), { session });
      await SlotLock.insertMany(lockDocsFor(draft, lock), { session, ordered: true });
      updated = await Appointment.findOneAndUpdate(
        { _id: appt._id, status: appt.status, rescheduleCount: appt.rescheduleCount || 0 },
        {
          $set: { guests: newGuests, startAt: draft.startAt, endAt: draft.endAt },
          $inc: { rescheduleCount: 1 },
          $push: { statusHistory: { from: appt.status, to: appt.status, at: now, by: "customer", reason: "rescheduled online" } },
        },
        { returnDocument: "after", session }
      );
      if (!updated) throw Object.assign(new Error("changed"), { changed: true });
    });
  } catch (err) {
    if (duplicateKey(err) === "slot") throw slotTaken([]);
    if (err.changed) throw new BookingError("CONFLICT", "This booking just changed. Reload the page.", 409);
    throw err;
  } finally {
    await session.endSession();
  }
  await Promise.all([
    notify({
      key: `${appt._id}:rescheduled:${updated.rescheduleCount}`,
      type: "booking_moved",
      to: updated.contact,
      appointmentId: updated._id,
      params: { name: updated.name, ref: updated.ref, when: formatInstant(updated.startAt), link: manageUrl(updated) },
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
