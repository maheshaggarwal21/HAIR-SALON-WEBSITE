/**
 * @file cron.js
 * @description Scheduled jobs — `/api/cron/*` (CONTROL_FLOW_AND_DATA_LOGIC.md §16).
 *
 * ── Who calls these (D19) ────────────────────────────────────────────────────
 * The salon is on Vercel's free (Hobby) plan, where Vercel Cron runs at most
 * once a day. So an outside timer — cron-job.org, free — calls these URLs on
 * schedule instead:
 *
 *   GET https://api.thexpertshair.com/api/cron/requests-tick    every 15 min
 *   GET https://api.thexpertshair.com/api/cron/bookings-tick    every 15 min (Phase 2)
 *   GET https://api.thexpertshair.com/api/cron/reviews-refresh  daily (Vercel Cron
 *       can run this one even on Hobby — it is in vercel.json)
 *   Header  Authorization: Bearer <CRON_SECRET>
 *
 * Vercel Cron sends the same header when CRON_SECRET is set, so moving to Pro
 * later only means listing the paths in vercel.json — the routes don't change.
 *
 * ── Rules every job follows (§16) ────────────────────────────────────────────
 *   - refuses without the secret (constant-time compare); 503 if none is set;
 *   - takes a JobRun lock, so overlapping calls do the work once;
 *   - idempotent: running it twice in a row changes nothing the second time;
 *   - finishes every write before responding (Vercel freezes after the reply).
 *
 * Mounted before the session and the global limiter (index.js): the timer has
 * no cookie, and its calls must never be throttled.
 */

const crypto = require("crypto");
const express = require("express");
const connectDB = require("../db");
const Appointment = require("../models/Appointment");
const SiteSettings = require("../models/SiteSettings");
const User = require("../models/User");
const telegram = require("../utils/telegram");
const { runJob } = require("../utils/jobLock");
const { workingMinutesBetween } = require("../utils/time");
const { refreshReviews } = require("../utils/googleReviews");
const { revalidateSite } = require("../utils/revalidate");

const router = express.Router();
const MAX_LISTED = 10;

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // not configured
  const given = Buffer.from(String(req.get("authorization") || ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

router.use(async (req, res, next) => {
  const ok = authorised(req);
  if (ok === null) return res.status(503).json({ error: "CRON_SECRET is not configured" });
  if (!ok) return res.status(401).json({ error: "Unauthorised" });
  try {
    await connectDB();
    return next();
  } catch (err) {
    console.error("[cron] DB error:", err.message);
    return res.status(503).json({ error: "Database unavailable" });
  }
});

/**
 * Website requests still unanswered after `requestSlaMinutes` of OPENING
 * hours → one Telegram nudge to the owner per request (`slaAlertedAt` marks it,
 * so the next tick doesn't repeat it). Customers were told "within 2 working
 * hours"; this is the backstop that keeps the promise.
 */
async function requestsTick(now = new Date()) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  const open = await Appointment.find(
    { mode: "request", status: "requested", slaAlertedAt: null },
    { ref: 1, name: 1, contact: 1, createdAt: 1, requestedWindow: 1 }
  )
    .sort({ createdAt: 1 })
    .lean();
  const overdue = open.filter((a) => workingMinutesBetween(settings, a.createdAt, now) >= settings.requestSlaMinutes);
  if (!overdue.length) return { open: open.length, overdue: 0, alerted: 0 };

  const owners = telegram.isConfigured()
    ? await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean()
    : [];
  const hours = Math.round((settings.requestSlaMinutes / 60) * 10) / 10;
  const lines = [
    `⏰ ${overdue.length} website request${overdue.length === 1 ? "" : "s"} waiting more than ${hours} working hour${hours === 1 ? "" : "s"}:`,
    ...overdue.slice(0, MAX_LISTED).map((a) => `• ${a.ref} — ${a.name} · ${a.contact} (wants ${a.requestedWindow?.date ?? "?"} ${a.requestedWindow?.window ?? ""})`),
    ...(overdue.length > MAX_LISTED ? [`…and ${overdue.length - MAX_LISTED} more`] : []),
    "",
    "Staff app → Website Requests.",
  ];
  const results = await Promise.all(owners.map((o) => telegram.sendMessage(o.telegramChatId, lines.join("\n"))));
  const sent = results.filter((r) => r?.ok).length;

  // Mark only once someone was told; otherwise the next tick tries again.
  if (sent > 0) {
    await Appointment.updateMany(
      { _id: { $in: overdue.map((a) => a._id) }, slaAlertedAt: null },
      { $set: { slaAlertedAt: now } }
    );
  }
  return { open: open.length, overdue: overdue.length, alerted: sent > 0 ? overdue.length : 0, ownersMessaged: sent };
}

// GET for Vercel Cron and most timers; POST for timers that only post.
for (const method of ["get", "post"]) {
  router[method]("/requests-tick", async (_req, res) => {
    try {
      const out = await runJob("requests-tick", () => requestsTick());
      return res.json(out);
    } catch (err) {
      console.error("[cron] requests-tick failed:", err);
      return res.status(500).json({ error: "Job failed" });
    }
  });
}

/** Google rating + reviews, once a day (CF §13, T1.21). */
async function reviewsRefresh() {
  const out = await refreshReviews();
  if (out.ok) await revalidateSite(["reviews", "site"]);
  return out;
}

for (const method of ["get", "post"]) {
  router[method]("/reviews-refresh", async (_req, res) => {
    try {
      return res.json(await runJob("reviews-refresh", reviewsRefresh));
    } catch (err) {
      console.error("[cron] reviews-refresh failed:", err);
      return res.status(500).json({ error: "Job failed" });
    }
  });
}

/**
 * Phase 2 booking housekeeping, every 15 min from the outside timer (§16, T2.12):
 *   - unpaid holds past holdMinutes → expired (after asking Razorpay whether
 *     the order was paid after all — a slow webhook must not cost a booking);
 *   - requests past their approval window → expired, full refund queued;
 *   - 24h / 2h reminders (utils/booking.sendReminders);
 *   - WhatsApp messages that failed → retried once (E21).
 */
async function bookingsTick(now = new Date()) {
  const { expireBookings, sendReminders } = require("../utils/booking");
  const { retryFailed } = require("../utils/notify");
  const expired = await expireBookings(now);
  const reminders = await sendReminders(now);
  const retried = await retryFailed();
  const refundsSent = await require("../utils/booking").retryAutoRefunds(now);
  return { ...expired, ...reminders, messagesRetried: retried, autoRefundsRetried: refundsSent };
}

for (const method of ["get", "post"]) {
  router[method]("/bookings-tick", async (_req, res) => {
    try {
      return res.json(await runJob("bookings-tick", () => bookingsTick()));
    } catch (err) {
      console.error("[cron] bookings-tick failed:", err);
      return res.status(500).json({ error: "Job failed" });
    }
  });
}

module.exports = router;
module.exports.requestsTick = requestsTick;
module.exports.bookingsTick = bookingsTick;
module.exports.reviewsRefresh = reviewsRefresh;
