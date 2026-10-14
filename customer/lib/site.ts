/**
 * Where the site lives and whether search engines may index it (T1.22, T1.23).
 *
 * NEXT_PUBLIC_SITE_URL = the canonical origin (https://www.thexpertshair.com
 * — www is the main address, the bare domain redirects to it, D37 — once
 * the domain switches). NEXT_PUBLIC_INDEXABLE = "1" only on that production
 * deployment — previews and the staging domain stay noindex.
 */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.thexpertshair.com").replace(/\/+$/, "");
export const INDEXABLE = process.env.NEXT_PUBLIC_INDEXABLE === "1";

/**
 * Staff sign-in (T1.23): the staff app lives on its own subdomain once this
 * site takes the apex. STAFF_APP_URL is read on the server, where the header
 * and footer render; the default is the planned home, so the link works before
 * the variable is set.
 */
export const STAFF_SIGNIN_URL = `${(process.env.STAFF_APP_URL || "https://app.thexpertshair.com").replace(/\/+$/, "")}/signin`;
