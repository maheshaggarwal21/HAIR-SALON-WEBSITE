/**
 * @file time.js
 * @description Salon wall-clock helpers. Store UTC, compute in Asia/Kolkata.
 *
 * Vercel runs in UTC, so `new Date().getDate()` on the server is the UTC date,
 * which is YESTERDAY in Patiala between 00:00 and 05:30 IST. Anything that asks
 * "what day is it for the salon" — today's date, whether a requested day is in
 * the past, turning "14:30 on the 29th" into an instant — goes through here
 * instead of the server's local time (CLAUDE.md, "Time").
 *
 * Phase 2's slot grid (T2.3) builds on these and adds the 15-minute grid.
 */

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const customParseFormat = require("dayjs/plugin/customParseFormat");

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const SALON_TZ = "Asia/Kolkata";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "YYYY-MM-DD" in IST for an instant (default: now). */
function salonDate(at = new Date()) {
  return dayjs(at).tz(SALON_TZ).format("YYYY-MM-DD");
}

/** True for a real calendar date written as YYYY-MM-DD ("2026-02-30" is false). */
function isValidDate(str) {
  return typeof str === "string" && DATE_RE.test(str) && dayjs(str, "YYYY-MM-DD", true).isValid();
}

/** Whole days from `from` to `to`, both "YYYY-MM-DD". Negative when `to` is earlier. */
function daysBetween(from, to) {
  return dayjs.utc(to).diff(dayjs.utc(from), "day");
}

/** "YYYY-MM-DD" + "HH:mm" in IST → UTC Date. */
function salonInstant(date, time) {
  if (!isValidDate(date) || !TIME_RE.test(String(time))) return null;
  return dayjs.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", SALON_TZ).toDate();
}

/** Weekday key used by SiteSettings.openingHours ("mon" … "sun") for an IST date. */
function weekdayKey(date) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dayjs.utc(date).day()];
}

/** "YYYY-MM-DD" + n days. */
function addDays(date, n) {
  return dayjs.utc(date).add(n, "day").format("YYYY-MM-DD");
}

/**
 * Minutes between two instants that fall inside opening hours (CF §6: the
 * request SLA "counts in opening hours"). A request sent at 22:00 on Monday
 * starts its clock at Wednesday's opening if Tuesday is the weekly off.
 *
 * @param {{openingHours: object, holidays?: string[]}} settings  SiteSettings
 * @param {Date} from
 * @param {Date} to
 */
function workingMinutesBetween(settings, from, to) {
  if (!(to > from)) return 0;
  const last = salonDate(to);
  let total = 0;
  // Bounded walk: a request older than 60 days is overdue whatever we count.
  for (let day = salonDate(from), i = 0; day <= last && i < 60; day = addDays(day, 1), i++) {
    if (settings.holidays?.includes(day)) continue;
    for (const { open, close } of settings.openingHours?.[weekdayKey(day)] || []) {
      const start = Math.max(salonInstant(day, open).getTime(), from.getTime());
      const end = Math.min(salonInstant(day, close).getTime(), to.getTime());
      if (end > start) total += (end - start) / 60_000;
    }
  }
  return Math.floor(total);
}

/**
 * The instant `minutes` of OPENING hours after `from` — the end of a request's
 * SLA (CF §6). A request paid at 22:00 on Monday with a 120-minute SLA, Tuesday
 * off, expires at 11:00 on Wednesday. Returns null if the salon has no opening
 * hours in the next 60 days (nothing to count against).
 */
function addWorkingMinutes(settings, from, minutes) {
  let left = minutes * 60_000;
  for (let day = salonDate(from), i = 0; i < 60; day = addDays(day, 1), i++) {
    if (settings.holidays?.includes(day)) continue;
    for (const { open, close } of settings.openingHours?.[weekdayKey(day)] || []) {
      const start = Math.max(salonInstant(day, open).getTime(), from.getTime());
      const end = salonInstant(day, close).getTime();
      if (end <= start) continue;
      if (end - start >= left) return new Date(start + left);
      left -= end - start;
    }
  }
  return null;
}

// ── 15-minute grid (T2.3) ────────────────────────────────────────────────────
// IST is UTC+05:30 — a whole number of 15-minute steps — so a block that starts
// on a quarter hour in Patiala also starts on a quarter hour of epoch time.
// Grid maths can therefore work on plain epoch milliseconds.

const BLOCK_MS = 15 * 60 * 1000;
const floorBlock = (ms) => Math.floor(ms / BLOCK_MS) * BLOCK_MS;
const ceilBlock = (ms) => Math.ceil(ms / BLOCK_MS) * BLOCK_MS;
/** Minutes rounded up to whole blocks, in ms: 50 min → 60 min. */
const blocksFor = (minutes) => Math.ceil(minutes / 15) * BLOCK_MS;

/** The salon's open intervals on an IST date as epoch-ms pairs. Holidays and special hours win. */
function openingIntervals(settings, date) {
  if (settings.holidays?.includes(date)) return [];
  const special = (settings.specialHours || []).find((h) => h.date === date);
  const list = special
    ? special.open && special.close
      ? [{ open: special.open, close: special.close }]
      : []
    : settings.openingHours?.[weekdayKey(date)] || [];
  return list
    .map(({ open, close }) => ({ start: salonInstant(date, open).getTime(), end: salonInstant(date, close).getTime() }))
    .filter((i) => i.end > i.start);
}

/** Intersection of two sorted interval lists. */
function intersect(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

/** Interval list minus another interval list. */
function subtract(list, cuts) {
  let out = list.map((i) => ({ ...i }));
  for (const c of cuts) {
    const next = [];
    for (const i of out) {
      if (c.end <= i.start || c.start >= i.end) next.push(i);
      else {
        if (c.start > i.start) next.push({ start: i.start, end: c.start });
        if (c.end < i.end) next.push({ start: c.end, end: i.end });
      }
    }
    out = next;
  }
  return out;
}

module.exports = {
  BLOCK_MS,
  floorBlock,
  ceilBlock,
  blocksFor,
  openingIntervals,
  intersect,
  subtract,
  SALON_TZ,
  salonDate,
  isValidDate,
  daysBetween,
  salonInstant,
  weekdayKey,
  addDays,
  workingMinutesBetween,
  addWorkingMinutes,
  TIME_RE,
};
