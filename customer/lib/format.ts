/**
 * Display helpers. Prices are whole rupees; dates are IST calendar days
 * ("YYYY-MM-DD") handled as UTC midnight so no device timezone can shift them.
 */

import type { SiteInfo, WindowKey } from "./types";

export const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** Whole-number "20% off" from a normal price and an offer price; 0 when it is not cheaper. */
export const percentOff = (regular: number, price: number) => (regular > 0 && price < regular ? Math.round((1 - price / regular) * 100) : 0);

/** "27 Oct" for an offer's last day, an IST calendar day handled as UTC midnight. */
export const offerTill = (endsOn: string) => new Date(`${endsOn}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** 45 → "45 min", 90 → "1 hr 30 min", 120 → "2 hr". */
export function minutes(total: number) {
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** "13:30" → "1:30 pm" */
export function clock(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour = ((h + 11) % 12) + 1;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/** Today's date in Patiala, "YYYY-MM-DD". */
export function todayIST(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayParts(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return {
    weekday: d.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }),
    day: d.getUTCDate(),
    month: d.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }),
    long: d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }),
  };
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function isOpenOn(site: Pick<SiteInfo, "openingHours" | "holidays">, date: string) {
  if (site.holidays.includes(date)) return false;
  const key = WEEKDAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return (site.openingHours[key] || []).length > 0;
}

/** Minutes since midnight in IST, for "has this window already passed today?". */
export function nowMinutesIST(now = new Date()) {
  const [h, m] = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(now)
    .split(":")
    .map(Number);
  return h * 60 + m;
}

export function windowPassed(site: SiteInfo, window: WindowKey, date: string, now = new Date()) {
  if (date !== todayIST(now)) return false;
  const end = site.requestWindows[window].end;
  const [h, m] = end.split(":").map(Number);
  return nowMinutesIST(now) >= h * 60 + m;
}

/** 120 → "2 working hours", 90 → "90 minutes" — matches the request SLA copy (DS §7). */
export function slaText(mins: number) {
  if (mins % 60 === 0) {
    const h = mins / 60;
    return `${h} working hour${h === 1 ? "" : "s"}`;
  }
  return `${mins} minutes`;
}

export function whatsappHref(number: string | null | undefined, text?: string) {
  if (!number) return null;
  const q = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/91${number}${q}`;
}

const DAY_NAMES = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;

/** Collapse identical consecutive days: "Mon 9 am – 9 pm · Tue Closed · Wed–Sun 9 am – 9 pm". */
export function hoursSummary(site: SiteInfo) {
  const label = (d: (typeof DAY_NAMES)[number][0]) => {
    const list = site.openingHours[d] || [];
    return list.length ? list.map((i) => `${clock(i.open)} – ${clock(i.close)}`).join(", ") : "Closed";
  };
  const groups: { from: string; to: string; text: string }[] = [];
  for (const [key, name] of DAY_NAMES) {
    const text = label(key);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = name;
    else groups.push({ from: name, to: name, text });
  }
  return groups.map((g) => ({ days: g.from === g.to ? g.from : `${g.from}–${g.to}`, text: g.text }));
}

/** "9814830307" → "98148 30307" */
export const phoneLabel = (p: string) => p.replace(/(\d{5})(\d{5})/, "$1 $2");

/**
 * Round down to a friendly step for a "+" figure (CF D28): 126 → 100, 1,284 → 1,000.
 * Same steps as backend/utils/publicStats.js, so a stat never reads higher than the truth.
 */
export function floorNice(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = n < 100 ? 10 : n < 1000 ? 50 : n < 10000 ? 500 : 1000;
  return Math.floor(n / step) * step;
}

/** "2026-10-29" → "29 Oct" (an IST calendar date; no time-zone shift). */
export function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}
