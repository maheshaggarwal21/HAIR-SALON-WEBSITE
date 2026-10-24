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
 *    name (`content_name`).
 */

type Fbq = (command: "track" | "trackCustom" | "init", event: string, params?: Record<string, unknown>, options?: { eventID?: string }) => void;

declare global {
  interface Window {
    fbq?: Fbq;
  }
}

export type PixelEvent = "PageView" | "ViewContent" | "Contact" | "Lead" | "Schedule";

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
