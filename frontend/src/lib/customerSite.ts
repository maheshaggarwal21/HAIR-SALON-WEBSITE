/**
 * @file customerSite.ts
 * @description Where the public website lives (T1.23).
 *
 * The staff app is only the staff app now: its old landing, About and Contact
 * pages are gone, and anything public (home, legal pages, contact) is on the
 * customer site. VITE_CUSTOMER_SITE_URL overrides the default for a staging copy.
 */

export const CUSTOMER_SITE_URL = (
  (import.meta.env.VITE_CUSTOMER_SITE_URL as string | undefined) || "https://thexpertshair.com"
).replace(/\/+$/, "");
