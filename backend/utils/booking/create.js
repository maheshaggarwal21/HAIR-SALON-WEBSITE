/**
 * @file utils/booking/create.js
 * @description Create a booking: limits, re-check the slot, price, transaction with locks (§5.1).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const SiteSettings = require("../../models/SiteSettings");
const { loadEngineInput, BookingError } = require("../availabilityLoader");
const { salonDate, daysBetween } = require("../time");
const { groupLimitMessage } = require("../groupLimit");
const Appointment = require("../../models/Appointment");
const { availability } = require("../availability");
const { buildQuote } = require("../quote");
const mongoose = require("mongoose");
const SlotLock = require("../../models/SlotLock");
const Customer = require("../../models/Customer");
const { manageToken, hashManageToken } = require("../bookingToken");
const payments = require("../payments");
const { ACTIVE, nearestAlternatives, patchTestOkFor, singleArtist, slotTaken } = require("./selection");
const { duplicateKey, expiredHoldsFilter, lockDocsFor, settledState } = require("./locks");
const { groupModeOf } = require("./requests");
const { afterSettled } = require("./messages");
const { releaseUnpaid } = require("./expiry");

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

module.exports = { createBooking };
