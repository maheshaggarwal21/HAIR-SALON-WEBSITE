/**
 * @file paymentLinks.ts
 * @description Pure helpers for the "Payment log errors" → Payment History link (D70 follow-up).
 *
 * No imports and no browser APIs on purpose, so `npm run test:unit` can run them with plain Node.
 * Nothing here is trusted for access: the URL only PRESELECTS filters on Payment History; the server still
 * enforces payments.view and the front-desk date clamp (payments.today_only).
 */

const TEN_DIGITS = /^\d{10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD (rejects 2026-02-30 and 2026-13-01). */
export function isRealDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export interface HistoryParams {
  contact: string | null;
  range: { from: string; to: string } | null;
}

/**
 * Reads ?contact=, ?from= and ?to=. Anything invalid is ignored silently:
 * contact must be exactly 10 digits (after trimming); from and to must both be real days with from <= to.
 */
export function parseHistoryParams(search: string | URLSearchParams): HistoryParams {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const contact = (p.get("contact") ?? "").trim();
  const from = (p.get("from") ?? "").trim();
  const to = (p.get("to") ?? "").trim();
  return {
    contact: TEN_DIGITS.test(contact) ? contact : null,
    range: isRealDay(from) && isRealDay(to) && from <= to ? { from, to } : null,
  };
}

/** The Payment History route of the role the user is currently inside, or null outside a role dashboard. */
export function paymentsBase(pathname: string): string | null {
  const m = /^\/dashboard\/(owner|manager|receptionist|artist)(\/|$)/.exec(pathname);
  return m ? `/dashboard/${m[1]}/payments` : null;
}

/**
 * The link from a Payment log errors row to that client's Payment History, or null when it must not be shown:
 * the user lacks payments.view, the row has no visit (refused in enforce mode, or the visit was deleted), or the
 * visit's contact is not a valid 10-digit number (walk-ins without a phone).
 */
export function historyLink(o: { pathname: string; canView: boolean; contact: string | null | undefined; day?: string | null }): string | null {
  const base = paymentsBase(o.pathname);
  const contact = (o.contact ?? "").trim();
  if (!o.canView || !base || !TEN_DIGITS.test(contact)) return null;
  const q = new URLSearchParams({ contact });
  if (o.day && isRealDay(o.day)) {
    q.set("from", o.day);
    q.set("to", o.day);
  }
  return `${base}?${q.toString()}`;
}
