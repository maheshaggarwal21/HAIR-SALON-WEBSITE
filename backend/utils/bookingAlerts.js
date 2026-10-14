/**
 * @file bookingAlerts.js
 * @description Owner alerts for website requests (T1.8, CF §11).
 *
 * Reuses the Telegram bot the login gate already uses: every active owner who
 * has linked Telegram (Management → Telegram) gets the message. Sent with
 * `await` before the API responds — on Vercel, work after res.send() may never
 * run — and bounded by telegram.js's own 8s timeout so the customer is never
 * kept waiting longer than that. Never throws: a Telegram outage must not lose
 * a customer's request, which is already saved by the time this runs.
 *
 * The message carries the customer's phone because it goes only to the owner's
 * private chat, and calling them back is the whole point of the alert.
 */

const telegram = require("./telegram");
const User = require("../models/User");

const WINDOW_LABEL = { morning: "morning", afternoon: "afternoon", evening: "evening" };

function formatDate(date) {
  // "2026-10-29" → "Thu 29 Oct". Built from the calendar date itself (UTC
  // midnight), so the server's timezone can't shift it by a day.
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

function requestAlertText(appt) {
  const items = appt.guests.flatMap((g) => g.items);
  const lines = [
    `🆕 Website request ${appt.ref}`,
    `${appt.name} · ${appt.contact}`,
    `${formatDate(appt.requestedWindow.date)}, ${WINDOW_LABEL[appt.requestedWindow.window] || appt.requestedWindow.window}`,
    ...items.map((i) => `• ${i.name} — ${rupees(i.publicPrice)}`),
    `Total ${rupees(appt.pricing.total)}`,
  ];
  if (appt.preferredArtistName) lines.push(`Prefers: ${appt.preferredArtistName}`);
  if (appt.notes) lines.push(`Note: ${appt.notes}`);
  const utm = appt.source?.utm;
  if (utm?.campaign || utm?.source) lines.push(`From: ${[utm.source, utm.campaign].filter(Boolean).join(" / ")}`);
  lines.push("", "Confirm a time in the staff app → Requests.");
  return lines.join("\n");
}

/** @returns {Promise<{sent: number, failed: number}>} */
async function alertNewRequest(appt) {
  if (!telegram.isConfigured()) return { sent: 0, failed: 0 };
  try {
    const owners = await User.find(
      { role: "owner", isActive: true, telegramChatId: { $ne: null } },
      { telegramChatId: 1 }
    ).lean();
    const text = requestAlertText(appt);
    const results = await Promise.allSettled(owners.map((o) => telegram.sendMessage(o.telegramChatId, text)));
    const sent = results.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
    return { sent, failed: results.length - sent };
  } catch (err) {
    console.error("[bookingAlerts] failed:", err.message);
    return { sent: 0, failed: 1 };
  }
}

module.exports = { alertNewRequest, requestAlertText };
