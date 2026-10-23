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
    `🆕 ${appt.source?.channel === "wa_ad" ? "WhatsApp ad" : "Website"} request ${appt.ref}`,
    `${appt.name} · ${appt.contact}`,
    appt.requestedWindow.time
      ? `${formatDate(appt.requestedWindow.date)}, ${appt.requestedWindow.time}`
      : `${formatDate(appt.requestedWindow.date)}, ${WINDOW_LABEL[appt.requestedWindow.window] || appt.requestedWindow.window}`,
    ...items.map((i) => `• ${i.name} — ${rupees(i.publicPrice)}`),
    `Total ${rupees(appt.pricing.total)}`,
  ];
  if (appt.preferredArtistName) lines.push(`Prefers: ${appt.preferredArtistName}`);
  if (appt.notes) lines.push(`Note: ${appt.notes}`);
  const utm = appt.source?.utm;
  if (utm?.campaign || utm?.source) lines.push(`From: ${[utm.source, utm.campaign].filter(Boolean).join(" / ")}`);
  if (appt.source?.offerSlug) lines.push(`Offer: ${appt.source.offerHeadline || appt.source.offerSlug} (apply it at billing; nothing is discounted yet)`);
  if (appt.source?.channel === "wa_ad") lines.push("Unpaid request from a WhatsApp ad.");
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

const { SALON_TZ } = require("./time");

/** "Thu 29 Oct, 4:30 pm" in salon time. */
function formatInstant(at) {
  return new Date(at).toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: SALON_TZ,
  });
}

const BOOKING_HEADINGS = {
  confirmed: "✅ Online booking",
  requested: "🕒 Online booking — needs approval",
  paid_after_hold_expired: "🚨 PAID AFTER HOLD EXPIRED — slot was taken, refund needed",
  payment_mismatch: "🚨 Payment amount does not match the booking — check Razorpay",
  refund_failed: "🚨 Refund FAILED — still owed, try again from the Refunds screen",
  rescheduled: "🔁 Customer moved their booking",
  cancelled_by_customer: "❌ Customer cancelled online",
};

/**
 * Engine bookings (Phase 2): confirmed, waiting for approval, or a payment
 * problem the owner must act on (§5.3). Same delivery rules as requests.
 */
function bookingAlertText(appt, kind) {
  const lines = [`${BOOKING_HEADINGS[kind] || kind} ${appt.ref}`, `${appt.name} · ${appt.contact}`];
  if (appt.startAt) lines.push(formatInstant(appt.startAt));
  for (const g of appt.guests) {
    if (appt.guests.length > 1) lines.push(`${g.name || g.guestKey}:`);
    for (const i of g.items) lines.push(`• ${i.name}${i.artistName ? ` — ${i.artistName}` : ""} — ${rupees(i.publicPrice)}`);
  }
  lines.push(`Total ${rupees(appt.pricing.total)}`);
  if (appt.deposit?.amount) {
    const paid = appt.deposit.status === "paid" ? "paid" : appt.deposit.status;
    lines.push(`${appt.deposit.kind === "full" ? "Paid in full" : "Deposit"} ${rupees(appt.deposit.amount)} (${paid})`);
  }
  if (appt.refund?.amount) lines.push(`Refund owed ${rupees(appt.refund.amount)}`);
  if (kind === "refund_failed" && appt.refund?.error) {
    lines.push(`Razorpay said: ${appt.refund.error}`);
    if (/balance|insufficient|fund/i.test(appt.refund.error)) lines.push("Your Razorpay balance looks too low — add funds, then press Try again.");
  }
  if (appt.notes) lines.push(`Note: ${appt.notes}`);
  if (kind === "requested") lines.push("", "Approve or decline below, or in the staff app → Today.");
  return lines.join("\n");
}

/** @returns {Promise<{sent: number, failed: number}>} */
async function alertBooking(appt, kind) {
  if (!telegram.isConfigured()) return { sent: 0, failed: 0 };
  try {
    const owners = await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean();
    const text = bookingAlertText(appt, kind);
    // A request that holds a time can be approved or declined straight from
    // Telegram (CF §6, T2.10); routes/telegram.js handles the tap.
    const extra =
      kind === "requested"
        ? { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `bk:a:${appt._id}` }, { text: "❌ Decline", callback_data: `bk:d:${appt._id}` }]] } }
        : {};
    const results = await Promise.allSettled(owners.map((o) => telegram.sendMessage(o.telegramChatId, text, extra)));
    const sent = results.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
    return { sent, failed: results.length - sent };
  } catch (err) {
    console.error("[bookingAlerts] booking alert failed:", err.message);
    return { sent: 0, failed: 1 };
  }
}

/**
 * Owner's Telegram summary after bookings were moved off an artist who is away
 * or gone (D48). Never throws.
 */
async function alertReassigned({ artistName, why, moved, flagged }) {
  if (!telegram.isConfigured() || (!moved.length && !flagged.length)) return;
  try {
    const owners = await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean();
    const lines = [`📅 ${artistName}${why ? ` (${why})` : ""} is away.`];
    if (moved.length) lines.push(`Moved to other artists: ${moved.map((m) => `${m.ref} ${m.name} → ${m.to.join(", ")}${m.customerTold ? " (told)" : ""}`).join("; ")}`);
    if (flagged.length) {
      lines.push("", "⚠️ Needs you — nobody was free:");
      lines.push(...flagged.slice(0, 10).map((f) => `• ${f.ref} ${f.name} · ${f.contact} — ${formatInstant(f.startAt)}`));
      lines.push("Move or cancel them on the Today board.");
    }
    await Promise.allSettled(owners.map((o) => telegram.sendMessage(o.telegramChatId, lines.join("\n"))));
  } catch (err) {
    console.error("[bookingAlerts] reassign alert failed:", err.message);
  }
}

module.exports = { alertReassigned, alertNewRequest, requestAlertText, alertBooking, bookingAlertText, formatInstant };
