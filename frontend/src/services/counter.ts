/**
 * @file counter.ts
 * @description Browser side of counter UPI payments (D60, part A).
 *
 * Two different callers, kept apart on purpose:
 *   - staff screens use the session cookie (`credentials: "include"`) on /api/counter;
 *   - the tablet has NO cookie and no staff identity: it uses its own bearer token on
 *     /api/display, stored in this device's localStorage and nowhere else.
 *
 * The browser never sends an amount. It says what is being sold; the server prices it.
 */

const BASE = import.meta.env.VITE_BACKEND_URL || "";

// ─── Types ──────────────────────────────────────────────────────────────────

export type QrPayload =
  | { mode: "decoded"; upi: string }
  | { mode: "image"; imageUrl: string; crop: { imgW: number; imgH: number; x: number; y: number; w: number; h: number } };

export interface CounterSessionView {
  id: string;
  status: "pending" | "paid" | "cancelled" | "expired";
  cancelReason: string | null;
  target: "tablet" | "pc";
  /** Rupees the customer pays by UPI. */
  amount: number;
  finalTotal: number;
  cashAmount: number;
  expiresAt: string;
  paidAt: string | null;
  referencePending: boolean;
  visitId: string | null;
  /** Present only when the QR is meant for this (staff) screen. */
  qr?: QrPayload | null;
}

export interface CounterStatus {
  enabled: boolean;
  tablets?: { id: string; name: string; online: boolean }[];
  anyOnline?: boolean;
  nextPollMs?: number;
}

export interface CounterSaleInput {
  /** Shown to the customer on the tablet. Display only: the server prices the sale from serviceIds. */
  customerName?: string;
  serviceIds: string[];
  discountPercent: number;
  paymentMode: "online" | "partial";
  cashAmount?: number;
  target: "tablet" | "pc";
}

export class CounterApiError extends Error {
  status: number;
  busy: boolean;
  qrFailed: boolean;
  constructor(message: string, status: number, extra: { busy?: boolean; qrFailed?: boolean } = {}) {
    super(message);
    this.status = status;
    this.busy = !!extra.busy;
    this.qrFailed = !!extra.qrFailed;
  }
}

async function staffCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/counter${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CounterApiError(data.error || "Request failed", res.status, data);
  return data as T;
}

// ─── Staff ──────────────────────────────────────────────────────────────────

export const fetchCounterStatus = () => staffCall<CounterStatus>("GET", "/status");
export const createCounterSession = (sale: CounterSaleInput) =>
  staffCall<{ session: CounterSessionView }>("POST", "/sessions", sale).then((r) => r.session);
export const fetchCounterSession = (id: string) =>
  staffCall<{ session: CounterSessionView }>("GET", `/sessions/${id}`).then((r) => r.session);
export const cancelCounterSession = (id: string) =>
  staffCall<{ session: CounterSessionView }>("POST", `/sessions/${id}/cancel`).then((r) => r.session);
export const showCounterQrHere = (id: string) =>
  staffCall<{ session: CounterSessionView }>("POST", `/sessions/${id}/target`, { target: "pc" }).then((r) => r.session);

// Owner
export interface CounterDeviceRow {
  id: string;
  name: string;
  pairedBy: string | null;
  pairedAt: string;
  lastSeenAt: string | null;
  online: boolean;
}
export const fetchCounterDevices = () => staffCall<{ devices: CounterDeviceRow[] }>("GET", "/devices").then((r) => r.devices);
export const createPairingCode = (name: string) =>
  staffCall<{ code: string; name: string; expiresAt: string }>("POST", "/pairings", { name });
export const renameCounterDevice = (id: string, name: string) => staffCall<{ id: string; name: string }>("PATCH", `/devices/${id}`, { name });
export const revokeCounterDevice = (id: string) => staffCall<{ revoked: boolean }>("DELETE", `/devices/${id}`);

// ─── Tablet ─────────────────────────────────────────────────────────────────

const TOKEN_KEY = "counterDeviceToken";

export function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function clearDeviceToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked */
  }
}

export async function pairThisTablet(code: string): Promise<{ name: string }> {
  const res = await fetch(`${BASE}/api/display/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("Too many tries. Wait a minute and try again.");
  if (!res.ok) throw new Error(data.error || "Could not pair");
  try {
    localStorage.setItem(TOKEN_KEY, data.token);
  } catch {
    throw new Error("This browser blocks storage, so it cannot stay paired.");
  }
  return { name: data.name };
}

/** The customer's bill, as the server built it: FINAL prices only (the discount is already in them). */
export interface DisplayBill {
  customerName: string | null;
  lines: { name: string; quantity: number; amount: number }[];
  total: number;
  /** Cash already taken for a split payment. */
  cashAmount: number;
  /** What this QR collects. */
  toPay: number;
}

export type DisplayState =
  | { mode: "idle"; nextPollMs: number; device: string }
  | { mode: "payment"; amount: number; bill: DisplayBill; expiresAt: string; sessionId: string; qr: QrPayload | null; nextPollMs: number; device: string }
  | { mode: "paid"; amount: number; customerName: string | null; sessionId: string; nextPollMs: number; device: string };

export type DisplayResult =
  | { kind: "state"; state: DisplayState }
  | { kind: "unpaired" }
  | { kind: "throttled"; retryMs: number }
  | { kind: "error" };

export async function fetchDisplayState(): Promise<DisplayResult> {
  const token = getDeviceToken();
  if (!token) return { kind: "unpaired" };
  try {
    const res = await fetch(`${BASE}/api/display/state`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (res.status === 401) return { kind: "unpaired" };
    if (res.status === 429) return { kind: "throttled", retryMs: (Number(res.headers.get("Retry-After")) || 2) * 1000 };
    if (!res.ok) return { kind: "error" };
    return { kind: "state", state: (await res.json()) as DisplayState };
  } catch {
    return { kind: "error" };
  }
}
