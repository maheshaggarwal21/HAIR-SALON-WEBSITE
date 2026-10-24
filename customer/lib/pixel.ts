/**
 * Meta Pixel helpers. Browser only; every call is a no-op when the pixel isn't
 * loaded (no NEXT_PUBLIC_META_PIXEL_ID, or an ad blocker), so tracking can never
 * break a booking.
 *
 * Rules from the pixel brief:
 *  - Exact standard event names (Meta is case-sensitive).
 *  - `Schedule` and `Lead` fire ONCE per booking / enquiry. `trackOnce` remembers
 *    the id in localStorage, so a refresh, a back-button return or a second code
 *    path that reaches the same success state (the Razorpay handler and the
 *    payment watcher both can) never counts it twice.
 *  - The booking / enquiry ref is the `eventID`, which is what lets the
 *    Conversions API (later) deduplicate against the browser event.
 *  - No names, phone numbers, emails or notes in parameters. Only the service
 *    name (`content_name`) and, for Lead / Schedule, the server's total.
 *  - `InitiateCheckout` marks a booking STARTED (sheet opened, offer form
 *    touched). People with it and without Lead / Schedule are the "started but
 *    didn't book" retargeting audience.
 *
 * The server sends Lead and Schedule too (Conversions API, backend/utils/
 * metaCapi.js, D65) with the same ref as event_id. `pixelHeaders()` hands it the
 * pixel's own cookie ids so Meta can match the two copies and count them once.
 */

type Fbq = (command: "track" | "trackCustom" | "init", event: string, params?: Record<string, unknown>, options?: { eventID?: string }) => void;

declare global {
  interface Window {
    fbq?: Fbq;
  }
}

export type PixelEvent = "PageView" | "ViewContent" | "Contact" | "InitiateCheckout" | "Lead" | "Schedule";

const SEEN_PREFIX = "exp_px_";
// Fallback when localStorage is unavailable (private mode, in-app browsers).
const seenInMemory = new Set<string>();

/** Fire a standard event. Returns true when it was handed to the pixel. */
export function track(event: PixelEvent, params?: Record<string, unknown>, eventID?: string): boolean {
  if (typeof window === "undefined" || typeof window.fbq !== "function") return false;
  try {
    if (eventID) window.fbq("track", event, params ?? {}, { eventID });
    else if (params) window.fbq("track", event, params);
    else window.fbq("track", event);
    return true;
  } catch {
    return false;
  }
}

function cookie(name: string): string | null {
  try {
    const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : null;
  } catch {
    return null;
  }
}

/**
 * The pixel's `_fbp` / `_fbc` cookie ids as request headers, for the booking and
 * request calls. Headers rather than body fields: the API rejects unknown fields,
 * and the site and the API deploy separately. Empty when the pixel isn't loaded.
 */
export function pixelHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const out: Record<string, string> = {};
  const fbp = cookie("_fbp");
  const fbc = cookie("_fbc");
  if (fbp && fbp.length <= 120) out["X-Meta-Fbp"] = fbp;
  if (fbc && fbc.length <= 600) out["X-Meta-Fbc"] = fbc;
  return out;
}

/** Fire `event` at most once for this `id`, across refreshes. */
export function trackOnce(event: "Lead" | "Schedule", id: string, params?: Record<string, unknown>): void {
  const key = `${SEEN_PREFIX}${event}_${id}`;
  try {
    if (window.localStorage.getItem(key)) return;
  } catch {
    if (seenInMemory.has(key)) return;
  }
  if (seenInMemory.has(key)) return;
  // Only remember it once the pixel actually took it, so a disabled pixel
  // doesn't "use up" the id.
  if (!track(event, params, id)) return;
  seenInMemory.add(key);
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage unavailable: the in-memory set still guards this page view.
  }
}
