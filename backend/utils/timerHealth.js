/**
 * @file timerHealth.js
 * @description Is the outside 15-minute timer still running? (audit item 7)
 *
 * The bookings-tick job is called every 15 minutes by cron-job.org — a service
 * outside this repo. It frees unpaid holds and sends reminders. If that timer
 * is paused, deleted or its account lapses, nothing in the server notices and
 * customers' held slots just stay held. runJob() already stamps
 * JobRun.lastRunAt on every call; this file only reads it.
 *
 * Two readers:
 *   - /api/health shows `{ ok, minutesAgo }` so an uptime monitor can watch it;
 *   - the daily morning job tells the owner on Telegram, once a day.
 *
 * Only the age is exposed: no secrets, no lastResult, no lastError text.
 * `minutesAgo: null` means the job has never run (no document, or one that was
 * only ever locked).
 *
 * Limit: the only schedulers we have are daily, so the Telegram alert can come
 * up to a day after the timer stopped. /api/health is the fast signal.
 */

const JobRun = require("../models/JobRun");
const NotificationLog = require("../models/NotificationLog");
const User = require("../models/User");
const telegram = require("./telegram");
const { salonDate } = require("./time");

/** The timer runs every 15 minutes: three missed ticks and a bit of slack. */
const BOOKINGS_TICK_STALE_MS = 45 * 60 * 1000;

/**
 * @param {Date} [now]
 * @returns {Promise<{ok: boolean, minutesAgo: number|null}>}
 */
async function checkBookingsTickHealth(now = new Date()) {
  const run = await JobRun.findOne({ name: "bookings-tick" }, { lastRunAt: 1 }).lean();
  if (!run?.lastRunAt) return { ok: false, minutesAgo: null };
  const age = Math.max(0, now.getTime() - new Date(run.lastRunAt).getTime());
  return { ok: age <= BOOKINGS_TICK_STALE_MS, minutesAgo: Math.floor(age / 60_000) };
}

/** The block /api/health returns. */
async function timersHealth(now = new Date()) {
  return { bookingsTick: await checkBookingsTickHealth(now) };
}

const ago = (minutes) => {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
};

/**
 * Tell each owner on Telegram, at most once per IST day, if the timer is stale
 * or has never run. Same claim pattern as the morning summary: a row that says
 * "sent" means done; a failed send is retried by the next call. Never throws —
 * the morning job has more to do than this.
 * @returns {Promise<{timerAlerts: number}>}
 */
async function alertOwnerIfTimerStale(now = new Date()) {
  try {
    if (!telegram.isConfigured()) return { timerAlerts: 0 };
    const health = await checkBookingsTickHealth(now);
    if (health.ok) return { timerAlerts: 0 };

    const owners = await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean();
    const date = salonDate(now);
    const text = [
      "⚠️ The 15-minute booking timer has stopped.",
      health.minutesAgo == null ? "• It has never run." : `• Last run: ${ago(health.minutesAgo)} ago.`,
      "• Until it runs again, unpaid slot holds are not released and reminders are not sent.",
      "",
      "Check the cron-job.org job “bookings-tick”.",
    ].join("\n");

    let done = 0;
    for (const o of owners) {
      const key = `owner:${date}:timer:${o.telegramChatId}`;
      try {
        await NotificationLog.findOneAndUpdate(
          { key, status: { $ne: "sent" } },
          { $setOnInsert: { key, type: "owner_timer_alert", to: String(o.telegramChatId), channel: "telegram" }, $set: { status: "pending" }, $inc: { attempts: 1 } },
          { upsert: true }
        );
      } catch (err) {
        if (err?.code === 11000) continue; // already sent today
        throw err;
      }
      const res = await telegram.sendMessage(o.telegramChatId, text);
      const ok = Boolean(res?.ok);
      await NotificationLog.updateOne({ key }, { $set: { status: ok ? "sent" : "failed", sentAt: ok ? new Date() : null, error: ok ? null : String(res?.error || res?.description || "Telegram did not accept it") } });
      if (ok) done++;
    }
    return { timerAlerts: done };
  } catch (err) {
    console.error("[timerHealth] could not check or alert:", err.message);
    return { timerAlerts: 0 };
  }
}

module.exports = { BOOKINGS_TICK_STALE_MS, checkBookingsTickHealth, timersHealth, alertOwnerIfTimerStale };
