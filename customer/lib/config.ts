/**
 * Build-time switches. NEXT_PUBLIC_* values are inlined into the browser bundle.
 */

/**
 * CHECKPOINTS.md CP1 rollback: "whatsapp" turns every request CTA into a
 * WhatsApp link and hides the form; the page stays live. Anything else (the
 * default) is the Phase 1 request form.
 */
export const BOOKING_MODE: "request" | "whatsapp" =
  process.env.NEXT_PUBLIC_BOOKING_MODE === "whatsapp" ? "whatsapp" : "request";

/** Cloudflare Turnstile site key (T0.11). Empty in local dev: the widget is skipped. */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
