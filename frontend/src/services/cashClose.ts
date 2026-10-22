/**
 * @file cashClose.ts
 * @description API client for the daily cash close (D60, part C).
 */

const BASE = import.meta.env.VITE_BACKEND_URL || "";

export interface CashCloseRecord {
  day: string;
  openingFloat: number;
  openingFloatSource: "previous_close" | "entered";
  countedCash: number;
  cashSales: number;
  cashSalesVisits: number;
  cashTakenOut: { reason: string; amount: number }[];
  takenOutTotal: number;
  expectedCash: number;
  difference: number;
  leftInDrawer: number;
  banked: number;
  note: string | null;
  closedBy: string | null;
  closedAt: string;
  adjustments: { delta: number; reason: string; by: string | null; at: string }[];
  effectiveCountedCash: number;
  effectiveDifference: number;
}

export type DayState =
  | { day: string; closed: true; record: CashCloseRecord }
  | { day: string; closed: false; suggestedOpeningFloat: number; suggestedFrom: string | null };

export interface CloseInput {
  day: string;
  countedCash: number;
  openingFloat?: number;
  leftInDrawer: number;
  cashTakenOut: { reason: string; amount: number }[];
  note?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/cash-close${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data as T;
}

export const fetchDay = (day: string) => call<DayState>("GET", `/day/${day}`);
export const closeDay = (input: CloseInput) => call<{ record: CashCloseRecord }>("POST", "/", input).then((r) => r.record);
export const fetchHistory = (days = 14) =>
  call<{ days: ({ day: string; closed: false } | { day: string; closed: true; record: CashCloseRecord })[] }>("GET", `/?days=${days}`).then((r) => r.days);
export const addAdjustment = (day: string, delta: number, reason: string) =>
  call<{ record: CashCloseRecord }>("POST", `/${day}/adjustments`, { delta, reason }).then((r) => r.record);
