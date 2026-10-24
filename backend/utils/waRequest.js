/**
 * @file waRequest.js
 * @description "WhatsApp request booking" (D62): helpers for a booking REQUEST made from a
 * WhatsApp ad link, with no payment and no OTP.
 *
 * Flow: /book?src=wa&c=karwa on the customer site → POST /api/public/requests/wa →
 * Appointment {mode: "request", status: "requested", source.channel: "wa_ad", deposit none}.
 * Nothing is held (no slot locks) and nothing is charged. Reception then taps Confirm
 * (optionally changing the time) or Decline in the staff app, and the customer is told on
 * WhatsApp with the existing templates. A confirmed one is an ordinary `confirmed`
 * booking, so the 24 h and 2 h reminders in `bookings-tick` already cover it.
 *
 * Nothing here touches Checkout, deposits or the paid booking engine.
 */

const Appointment = require("../models/Appointment");
const { notify } = require("./notify");
const { manageUrl } = require("./booking");
const { formatInstant, peopleSuffix } = require("./bookingAlerts");
const { DEFAULT_DURATION_MINUTES } = require("../models/Service");
const { salonDate, salonInstant, weekdayKey, daysBetween, isValidDate } = require("./time");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const GRID_MINUTES = 15;
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Ad tag from the link: lower case letters, digits, "-" and "_" only; anything else is dropped. */
function cleanCampaign(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return CAMPAIGN_RE.test(s) ? s : null;
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Why this date and time cannot be requested, or null when it can.
 * Rejects: a bad date or time, the past (and anything sooner than the salon's own minimum
 * lead), beyond the booking horizon, holidays and closed days, times off the 15-minute grid,
 * a start outside opening hours, and a start where the services would run past closing.
 *
 * @param {object} settings  SiteSettings (plain)
 * @param {string} date      "YYYY-MM-DD" (IST)
 * @param {string} time      "HH:mm" (IST)
 * @param {number} minutesNeeded  total service time; unknown durations count as the default hour
 */
function slotProblem(settings, date, time, minutesNeeded, now = new Date()) {
  if (!isValidDate(date)) return "Choose a date.";
  if (typeof time !== "string" || !TIME_RE.test(time)) return "Choose a time.";
  if (toMinutes(time) % GRID_MINUTES !== 0) return "Choose a time on the quarter hour.";

  const startAt = salonInstant(date, time);
  if (!startAt || startAt <= now) return "That time has passed.";
  const lead = settings.minLeadMinutes ?? 120;
  if (startAt.getTime() - now.getTime() < lead * 60_000) {
    return lead >= 60 ? `Choose a time at least ${Math.round(lead / 60)} hour${lead >= 120 ? "s" : ""} from now.` : "Choose a later time.";
  }
  const ahead = daysBetween(salonDate(now), date);
  if (ahead > (settings.horizonDays ?? 30)) return `Choose a date within the next ${settings.horizonDays ?? 30} days.`;
  if ((settings.holidays || []).includes(date)) return "The salon is closed that day.";

  const intervals = settings.openingHours?.[weekdayKey(date)] || [];
  if (!intervals.length) return "The salon is closed that day.";
  const start = toMinutes(time);
  const within = intervals.find((w) => toMinutes(w.open) <= start && start < toMinutes(w.close));
  if (!within) return "The salon is closed at that time.";
  if (start + minutesNeeded > toMinutes(within.close)) return "That is too late for these services. Choose an earlier time.";
  return null;
}

/** Which of the request windows (morning/afternoon/evening) a start time falls in, for the staff list. */
function windowFor(settings, time) {
  const t = toMinutes(time);
  for (const key of ["morning", "afternoon", "evening"]) {
    const w = settings.requestWindows?.[key];
    if (w && toMinutes(w.start) <= t && t < toMinutes(w.end)) return key;
  }
  return t < 12 * 60 ? "morning" : t < 16 * 60 ? "afternoon" : "evening";
}

const minutesFor = (items) => items.reduce((n, i) => n + (i.durationMin || DEFAULT_DURATION_MINUTES), 0);

/** "Sat, 25 Oct, 11:00 am" for the time the customer asked for. */
const requestedWhen = (appt) =>
  (appt.requestedWindow?.time && appt.requestedWindow?.date
    ? formatInstant(salonInstant(appt.requestedWindow.date, appt.requestedWindow.time))
    : appt.requestedWindow?.date || "") + peopleSuffix(appt);

/** WhatsApp "we got your request". Never throws; one per booking (notify de-duplicates by key). */
function sendReceived(appt) {
  return notify({
    key: `${appt._id}:request_received`,
    type: "request_received",
    to: appt.contact,
    appointmentId: appt._id,
    params: { name: appt.name, ref: appt.ref, when: requestedWhen(appt), link: manageUrl(appt) },
  });
}

/** WhatsApp "your booking is confirmed", with the confirmed time. */
function sendConfirmed(appt) {
  return notify({
    key: `${appt._id}:booking_confirmed`,
    type: "booking_confirmed",
    to: appt.contact,
    appointmentId: appt._id,
    params: { name: appt.name, ref: appt.ref, when: formatInstant(appt.startAt) + peopleSuffix(appt), link: manageUrl(appt) },
  });
}

/** An active booking for this phone at this exact requested slot: a double tap or a re-send. */
function findDuplicate(phone, date, time) {
  return Appointment.findOne({
    contact: phone,
    status: { $in: ["requested", "confirmed"] },
    "source.channel": "wa_ad",
    "requestedWindow.date": date,
    "requestedWindow.time": time,
  });
}

module.exports = { cleanCampaign, slotProblem, windowFor, minutesFor, requestedWhen, peopleSuffix, sendReceived, sendConfirmed, findDuplicate, TIME_RE };
