/**
 * @file utils/booking/messages.js
 * @description Messages sent after a booking settles (confirmation, request received) and the manage link.
 *
 * Part of the booking engine's write side, split out of the former single utils/booking.js (2,182 lines)
 * with no change to behaviour. utils/booking.js still exports every name it always did, so callers are
 * unchanged. The overview of the whole engine is in that file's header.
 */

const { manageToken } = require("../bookingToken");
const metaCapi = require("../metaCapi");
const { notify } = require("../notify");
const { alertBooking, whenText } = require("../bookingAlerts");


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

module.exports = { afterSettled, manageUrl };
