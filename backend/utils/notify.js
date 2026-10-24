/**
 * @file notify.js
 * @description The one way customer and artist WhatsApp messages go out
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §11, T2.13).
 *
 *   await notify({ key: `${appt._id}:booking_confirmed`, type, to, params })
 *
 * 1. Claims `key` in NotificationLog with an upsert. If the key already exists
 *    and isn't a retryable failure, it returns without sending — so a webhook
 *    and a browser confirming the same payment produce ONE message (E5).
 * 2. Sends through utils/whatsapp.js and records sent / failed / skipped.
 *    Every message also carries `salon_link`, a tap-to-chat link to the main
 *    salon WhatsApp, for the "To talk to us…" line in each template (D52).
 *
 * Never throws: failures are logged and left for the cron's retry (E21). The
 * booking that triggered the message is already saved.
 *
 * ── Held-back messages are resent, but never stale ones ──────────────────────
 * A message recorded as "skipped" (WhatsApp not set up yet, a template missing) or
 * "failed" is tried again by `retryFailed`, up to MAX_ATTEMPTS, for at most 24 hours.
 * A "dry_run" row is never resent: it was a test. Within the 24 hours each type has
 * its own limit (`staleReason`): "we got your request" is useless after half an hour,
 * a reminder only makes sense while the appointment is still ahead, and nothing is
 * sent about a booking that has since been cancelled. Nothing is resent while the
 * provider is still not ready, so waiting for a fix does not use up the attempts.
 */

const NotificationLog = require("../models/NotificationLog");
const Appointment = require("../models/Appointment");
const whatsapp = require("./whatsapp");
const SiteSettings = require("../models/SiteSettings");

const MAX_ATTEMPTS = 3;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Nothing older than this is ever resent. */
const RETRY_WINDOW_MS = 24 * HOUR;
/** Shorter limits for messages that go stale fast. */
const MAX_AGE_MS = { request_received: 30 * MINUTE, artist_day_sheet: 4 * HOUR, reminder_2h: 3 * HOUR };
/** The statuses an appointment must still have for the message to make sense. */
const STILL_REQUESTED = ["requested"];
const STILL_BOOKED = ["confirmed", "checked_in"];

/** Tap-to-chat link to the main salon WhatsApp (Website Settings → contact). */
async function salonLink() {
  try {
    const n = (await SiteSettings.getSingleton()).contact?.whatsapp;
    return n ? `https://wa.me/91${n}` : "https://wa.me/919814830307";
  } catch {
    return "https://wa.me/919814830307";
  }
}

/**
 * @param {object} opts
 * @param {string} opts.key
 * @param {string} opts.type          template type ("booking_confirmed", …)
 * @param {string} opts.to            10-digit phone
 * @param {object} [opts.params]
 * @param {*}      [opts.appointmentId]
 * @param {boolean}[opts.retry]       cron retry of a failed row
 */
async function notify({ key, type, to, params = {}, appointmentId = null, retry = false }) {
  try {
    const claimFilter = retry
      ? {
          key,
          attempts: { $lt: MAX_ATTEMPTS },
          $or: [{ status: { $in: ["failed", "pending"] } }, { status: "skipped", error: { $ne: "dry_run" } }],
        }
      : { key };
    let row;
    if (retry) {
      row = await NotificationLog.findOneAndUpdate(claimFilter, { $set: { status: "pending" }, $inc: { attempts: 1 } }, { returnDocument: "after" });
      if (!row) return { status: "duplicate" };
    } else {
      const before = await NotificationLog.findOneAndUpdate(
        claimFilter,
        {
          $setOnInsert: { key, type, to, params, appointmentId, channel: "whatsapp", status: "pending", attempts: 1 },
        },
        { upsert: true, returnDocument: "before" }
      );
      if (before) return { status: "duplicate" }; // someone already claimed it
      row = { key };
    }

    const out = await whatsapp.sendTemplate({ phone: to, type, params: { ...params, salon_link: await salonLink() } });
    await NotificationLog.updateOne(
      { key },
      {
        $set: {
          status: out.status,
          channel: out.channel,
          providerId: out.providerId ?? null,
          error: out.error ?? null,
          sentAt: out.status === "sent" ? new Date() : null,
        },
      }
    );
    return { status: out.status };
  } catch (err) {
    if (err?.code === 11000) return { status: "duplicate" };
    console.error(`[notify] ${key} failed:`, err.message);
    return { status: "failed" };
  }
}

/**
 * Why this held-back message must NOT be sent now, or null when it still makes sense.
 * @param {object} row   NotificationLog row (lean)
 * @param {object|null} appt  its appointment (status, startAt) when it has one
 */
function staleReason(row, appt, now) {
  const age = now.getTime() - new Date(row.createdAt).getTime();
  const limit = Math.min(MAX_AGE_MS[row.type] ?? RETRY_WINDOW_MS, RETRY_WINDOW_MS);
  if (age > limit) return `too old (${Math.round(age / MINUTE)} min)`;

  const ahead = appt?.startAt ? new Date(appt.startAt).getTime() - now.getTime() : null;
  switch (row.type) {
    case "request_received":
      return appt && STILL_REQUESTED.includes(appt.status) ? null : "request already answered";
    case "booking_confirmed":
    case "booking_moved":
    case "booking_artist_changed":
      return appt && STILL_BOOKED.includes(appt.status) ? null : "booking no longer confirmed";
    case "reminder_24h":
      return appt && STILL_BOOKED.includes(appt.status) && ahead > 3 * HOUR ? null : "appointment too close or gone";
    case "reminder_2h":
      return appt && STILL_BOOKED.includes(appt.status) && ahead > 15 * MINUTE ? null : "appointment too close or gone";
    default:
      return null;
  }
}

/**
 * Cron (E21): resend messages that failed, or were held back because WhatsApp was not set up.
 * Returns how many were sent again. Stale ones are closed with a note instead (see staleReason).
 */
async function retryFailed(limit = 20, now = new Date()) {
  const rows = await NotificationLog.find({
    channel: { $ne: "telegram" }, // the owner's Telegram summary shares this log; it is not a WhatsApp message
    attempts: { $lt: MAX_ATTEMPTS },
    createdAt: { $gte: new Date(now.getTime() - RETRY_WINDOW_MS) },
    $or: [
      { status: "failed" },
      { status: "pending", updatedAt: { $lt: new Date(now.getTime() - 5 * MINUTE) } },
      { status: "skipped", error: { $ne: "dry_run" } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const appts = new Map(
    (await Appointment.find({ _id: { $in: rows.map((r) => r.appointmentId).filter(Boolean) } }, { status: 1, startAt: 1 }).lean()).map((a) => [String(a._id), a])
  );

  let resent = 0;
  for (const r of rows) {
    const why = staleReason(r, r.appointmentId ? appts.get(String(r.appointmentId)) : null, now);
    if (why) {
      // Out of attempts, so it drops out of the next query; the note says why it was never sent.
      await NotificationLog.updateOne({ _id: r._id }, { $set: { attempts: MAX_ATTEMPTS, error: `${r.error || r.status}; not resent: ${why}` } });
      continue;
    }
    if (!whatsapp.canSend(r.type)) continue; // still not ready (or a dry run): wait, do not use up an attempt
    await notify({ key: r.key, type: r.type, to: r.to, params: r.params || {}, appointmentId: r.appointmentId, retry: true });
    resent += 1;
  }
  return resent;
}

module.exports = { notify, retryFailed, staleReason, MAX_ATTEMPTS };
