/**
 * @file utils/booking/reminders.js
 * @description Cron: 24h and 2h reminders (§11).
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const SiteSettings = require("../../models/SiteSettings");
const Appointment = require("../../models/Appointment");
const { whenText } = require("../bookingAlerts");
const { notify } = require("../notify");
const { manageUrl } = require("./messages");

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

module.exports = { sendReminders };
