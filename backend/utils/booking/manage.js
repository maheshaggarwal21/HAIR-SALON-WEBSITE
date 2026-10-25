/**
 * @file utils/booking/manage.js
 * @description Customer self-service from the manage link: view rules, cancel, reschedule, calendar file (§9).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const Appointment = require("../../models/Appointment");
const { hashManageToken } = require("../bookingToken");
const { refundFor, noticeHoursFor } = require("../quote");
const SiteSettings = require("../../models/SiteSettings");
const { loadEngineInput, BookingError } = require("../availabilityLoader");
const { salonDate, daysBetween } = require("../time");
const { availability } = require("../availability");
const { notify } = require("../notify");
const { alertBooking, whenText } = require("../bookingAlerts");
const { releaseUnpaid } = require("./expiry");
const { closeBooking } = require("./salon");
const { slotTaken } = require("./selection");
const { applyGroupPlan } = require("./requests");
const { manageUrl } = require("./messages");

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
  const docs = await require("../../models/Service").find({ _id: { $in: ids } }).lean();
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

module.exports = { findByManageToken, manageRules, cancelByCustomer, rescheduleBooking, icsFor };
