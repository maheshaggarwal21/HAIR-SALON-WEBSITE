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
 * Never throws: failures are logged and left for the cron's single retry
 * (E21). The booking that triggered the message is already saved.
 */

const NotificationLog = require("../models/NotificationLog");
const whatsapp = require("./whatsapp");
const SiteSettings = require("../models/SiteSettings");

const MAX_ATTEMPTS = 2;

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
      ? { key, status: { $in: ["failed", "pending"] }, attempts: { $lt: MAX_ATTEMPTS } }
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

/** Cron (E21): retry each failed message once. Returns how many were retried. */
async function retryFailed(limit = 20) {
  const stale = new Date(Date.now() - 5 * 60 * 1000);
  const rows = await NotificationLog.find({
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [{ status: "failed" }, { status: "pending", updatedAt: { $lt: stale } }],
  })
    .limit(limit)
    .lean();
  for (const r of rows) await notify({ key: r.key, type: r.type, to: r.to, params: r.params || {}, appointmentId: r.appointmentId, retry: true });
  return rows.length;
}

module.exports = { notify, retryFailed };
