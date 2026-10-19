/**
 * @file morning.js
 * @description The 08:15 morning push (CONTROL_FLOW_AND_DATA_LOGIC.md §16, D56).
 *
 * Two messages, both about TODAY (IST), both sent at most once a day:
 *
 *   1. Each artist who has bookings gets a WhatsApp day sheet: their clients
 *      and times in one message. Artists with nothing booked get nothing — a
 *      "you have no clients" message every morning would only teach them to
 *      ignore the number. Same data as the My Day page, so they cannot differ.
 *   2. The owner gets a Telegram summary: how many bookings, how many came
 *      from the website, deposits already received, what is waiting for a
 *      decision (requests, refunds owed) and who is away.
 *
 * Idempotent (the timer can fire twice): artist messages go through notify()
 * with a per-artist-per-day key; the owner's summary claims a per-owner-per-day
 * key and only counts as done once Telegram accepted it, so a failed send is
 * retried by the next call. Never throws for one bad recipient.
 */

const Appointment = require("../models/Appointment");
const NotificationLog = require("../models/NotificationLog");
const User = require("../models/User");
const Artist = require("../models/Artist");
const telegram = require("./telegram");
const { notify } = require("./notify");
const { dayBoard } = require("./board");
const { salonDate } = require("./time");

const FIRM = ["confirmed", "checked_in"];
const SHOWN_IN_SHEET = 8;

const clock = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).replace(" ", "").toLowerCase();
const longDay = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
const rupees = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** "10:00am Sita (Haircut) | 3:00pm Kamla (Facial) | +2 more" — one line: WhatsApp variables cannot hold line breaks. */
function sheetLine(items) {
  const shown = items.slice(0, SHOWN_IN_SHEET).map((i) => `${clock(i.startAt)} ${firstName(i.name)} (${i.service})`);
  if (items.length > SHOWN_IN_SHEET) shown.push(`+${items.length - SHOWN_IN_SHEET} more`);
  return shown.join(" | ");
}

async function artistSheets(board, date) {
  const rows = board.artists.filter((a) => !a.inactive);
  const phones = new Map((await Artist.find({ _id: { $in: rows.map((r) => r._id) } }, { phone: 1 }).lean()).map((a) => [String(a._id), a.phone]));
  let sent = 0;
  let notSent = 0; // WhatsApp not set up, or Meta refused: the log row says which
  let skipped = 0;
  for (const row of rows) {
    const items = row.items.filter((i) => FIRM.includes(i.status)).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    if (!items.length) continue;
    const to = String(phones.get(String(row._id)) || "").replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(to)) {
      skipped++;
      continue;
    }
    const out = await notify({
      key: `${row._id}:${date}:artist_day_sheet`,
      type: "artist_day_sheet",
      to,
      params: { name: firstName(row.name), date: longDay(date), count: items.length, list: sheetLine(items) },
    });
    if (out.status === "sent") sent++;
    else if (out.status !== "duplicate") notSent++;
  }
  return { artistsMessaged: sent, artistsNotSent: notSent, artistsWithoutNumber: skipped };
}

async function ownerSummary(board, date) {
  const owners = telegram.isConfigured() ? await User.find({ role: "owner", isActive: true, telegramChatId: { $ne: null } }, { telegramChatId: 1 }).lean() : [];
  if (!owners.length) return { ownerSummaries: 0 };

  const items = board.artists.flatMap((a) => a.items.filter((i) => FIRM.includes(i.status)));
  // One appointment can hold several items (groups, multi-service); count people-visits by appointment.
  const appts = new Map(items.map((i) => [String(i.appointmentId), i]));
  const online = [...appts.values()].filter((i) => i.channel === "web").length;
  const deposits = [...appts.values()].reduce((s, i) => s + (i.deposit && i.deposit.status === "paid" ? i.deposit.amount : 0), 0);
  const starts = items.map((i) => new Date(i.startAt).getTime());
  const waiting = board.attention.filter((a) => a.kind === "approve" || a.kind === "request").length;
  const owed = await Appointment.find({ "refund.status": { $in: ["pending", "processing", "failed"] } }, { "refund.amount": 1 }).lean();
  const away = board.artists.filter((a) => !a.inactive && a.leave.length).map((a) => a.name);

  const lines = [
    `☀️ Good morning — ${longDay(date)}`,
    appts.size
      ? `• ${appts.size} booking${appts.size === 1 ? "" : "s"} today (${online} from the website), ${clock(Math.min(...starts))} to ${clock(Math.max(...starts))}`
      : "• No bookings yet today — walk-ins only so far",
    ...(deposits ? [`• ${rupees(deposits)} already paid online`] : []),
    ...(waiting ? [`• ${waiting} website request${waiting === 1 ? "" : "s"} waiting for an answer`] : []),
    ...(owed.length ? [`• ${owed.length} refund${owed.length === 1 ? "" : "s"} owed (${rupees(owed.reduce((s, a) => s + (a.refund?.amount || 0), 0))})`] : []),
    ...(away.length ? [`• Away today: ${away.join(", ")}`] : []),
    "",
    "Staff app → Bookings → Today.",
  ];

  let done = 0;
  for (const o of owners) {
    const key = `owner:${date}:morning:${o.telegramChatId}`;
    try {
      // Claim the day for this owner; a row that already says "sent" means done.
      await NotificationLog.findOneAndUpdate(
        { key, status: { $ne: "sent" } },
        { $setOnInsert: { key, type: "owner_morning", to: String(o.telegramChatId), channel: "telegram" }, $set: { status: "pending" }, $inc: { attempts: 1 } },
        { upsert: true }
      );
    } catch (err) {
      if (err?.code === 11000) continue; // already sent today
      throw err;
    }
    const res = await telegram.sendMessage(o.telegramChatId, lines.join("\n"));
    const ok = Boolean(res?.ok);
    await NotificationLog.updateOne({ key }, { $set: { status: ok ? "sent" : "failed", sentAt: ok ? new Date() : null, error: ok ? null : String(res?.error || res?.description || "Telegram did not accept it") } });
    if (ok) done++;
  }
  return { ownerSummaries: done };
}

async function morningRun(now = new Date()) {
  const date = salonDate(now);
  const board = await dayBoard(date, now);
  if (board.closed) return { date, closed: true, artistsMessaged: 0, ownerSummaries: 0 };
  const artists = await artistSheets(board, date);
  const owner = await ownerSummary(board, date);
  return { date, closed: false, ...artists, ...owner };
}

module.exports = { morningRun, sheetLine };
