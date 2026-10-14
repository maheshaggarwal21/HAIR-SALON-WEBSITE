/**
 * Where the site lives and whether search engines may index it (T1.22, T1.23).
 *
 * NEXT_PUBLIC_SITE_URL = the canonical origin (https://thexpertshair.com once
 * the domain switches). NEXT_PUBLIC_INDEXABLE = "1" only on that production
 * deployment — previews and the staging domain stay noindex.
 */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://thexpertshair.com").replace(/\/+$/, "");
export const INDEXABLE = process.env.NEXT_PUBLIC_INDEXABLE === "1";
