/**
 * Server-side reads from the salon API (CONTROL_FLOW_AND_DATA_LOGIC.md §12, §14).
 * Server Components only — the browser never calls these; it posts requests
 * through the same-origin /api/public rewrite (next.config.ts).
 *
 * ── Caching (Next 16 Cache Components) ───────────────────────────────────────
 * Each reader is a `'use cache'` function tagged by content type (`site`,
 * `services`, `artists`, `packages`), so the owner's edits can be pushed out with
 * revalidateTag() from /api/revalidate (T1.24), and lives for `hours` otherwise.
 * This replaces the older `fetch(..., { next: { revalidate, tags } })` pattern
 * CLAUDE.md described, which Cache Components supersedes (decision D15).
 *
 * ── When the API is down ─────────────────────────────────────────────────────
 * A failed read returns null with a ONE-MINUTE cache life (FAILED below), so a
 * failure is never cached for long and the next minute tries again. The
 * profile is still long enough to be prerendered (expire ≥ 5 min), so the
 * shared layout can await site data without a Suspense boundary and a build
 * with the API unreachable still succeeds. Sections whose data is missing are
 * hidden, never filled with invented placeholders.
 */

import { cacheLife, cacheTag } from "next/cache";
import type { PublicArtist, PublicCampaign, PublicPackage, PublicReel, PublicReviews, ServiceCard, SiteInfo } from "./types";

/** Retry soon after a failed read, but stay prerenderable (see above). */
const FAILED = { stale: 30, revalidate: 60, expire: 300 } as const;

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000").replace(/\/+$/, "");

async function read<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}/api/public${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[api] ${path} → ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[api] ${path} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getSite(): Promise<SiteInfo | null> {
  "use cache";
  cacheTag("site");
  const data = await read<SiteInfo>("/site");
  if (data) cacheLife("hours");
  else cacheLife(FAILED);
  return data;
}

export async function getServices(audience?: "her" | "him"): Promise<ServiceCard[] | null> {
  "use cache";
  cacheTag("services");
  const data = await read<{ services: ServiceCard[] }>(audience ? `/services?for=${audience}` : "/services");
  if (data) cacheLife("hours");
  else cacheLife(FAILED);
  return data?.services ?? null;
}

export async function getArtists(): Promise<PublicArtist[] | null> {
  "use cache";
  cacheTag("artists");
  const data = await read<{ artists: PublicArtist[] }>("/artists");
  if (data) cacheLife("hours");
  else cacheLife(FAILED);
  return data?.artists ?? null;
}

export async function getPackages(): Promise<PublicPackage[] | null> {
  "use cache";
  cacheTag("packages");
  const data = await read<{ packages: PublicPackage[] }>("/packages");
  // Packages switch on and off by date, so they refresh more often.
  if (data) cacheLife("minutes");
  else cacheLife(FAILED);
  return data?.packages ?? null;
}

/**
 * Offers live now or starting within 7 days (CF D29). The bar and pop-up check
 * the dates again in the browser, so a cached page switches an offer on and off
 * on the right IST day; an owner edit drops this cache at once (tag "campaigns").
 */
export async function getCampaigns(): Promise<{ today: string; campaigns: PublicCampaign[] } | null> {
  "use cache";
  cacheTag("campaigns");
  // `today` is the server's IST date at fetch time: the prerendered page picks
  // the offer with it (no clock read during render), the browser re-checks.
  const data = await read<{ today: string; campaigns: PublicCampaign[] }>("/campaigns");
  if (data) cacheLife("minutes");
  else cacheLife(FAILED);
  return data ?? null;
}

export async function getReels(): Promise<PublicReel[] | null> {
  "use cache";
  cacheTag("reels");
  const data = await read<{ reels: PublicReel[] }>("/reels");
  if (data) cacheLife("hours");
  else cacheLife(FAILED);
  return data?.reels ?? null;
}

export async function getReviews(): Promise<PublicReviews | null> {
  "use cache";
  cacheTag("reviews");
  const data = await read<PublicReviews>("/reviews");
  if (data) cacheLife("hours");
  else cacheLife(FAILED);
  return data;
}

/** One service card by slug (any variant's slug works), with description + SEO. */
export async function getService(slug: string): Promise<ServiceCard | null> {
  "use cache";
  cacheTag("services");
  const data = await read<{ service: ServiceCard }>(`/services/${encodeURIComponent(slug)}`);
  if (data) cacheLife("hours");
  else cacheLife(FAILED);
  return data?.service ?? null;
}
