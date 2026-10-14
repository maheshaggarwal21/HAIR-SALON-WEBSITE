/**
 * POST /api/revalidate (CF §12, T1.24) — the backend calls this right after
 * the owner edits something, with the shared secret and the cache tags to
 * drop (backend/utils/revalidate.js). Pages tagged with them are rebuilt on the
 * next visit, so an edit is live within seconds (CP2: ≤ 60s).
 */

import { revalidateTag } from "next/cache";
import { timingSafeEqual } from "node:crypto";

const TAGS = new Set(["site", "services", "artists", "packages", "reels", "reviews", "campaigns"]);

function authorised(given: string | null) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorised(request.headers.get("x-revalidate-secret"))) {
    return Response.json({ error: "Unauthorised" }, { status: 401 });
  }
  let tags: unknown;
  try {
    ({ tags } = await request.json());
  } catch {
    return Response.json({ error: "Send JSON: { tags: [...] }" }, { status: 400 });
  }
  const valid = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string" && TAGS.has(t)) : [];
  if (!valid.length) return Response.json({ error: "No known tags" }, { status: 400 });
  // Expire now (not stale-while-revalidate): the owner checking the site right
  // after an edit should see the edit.
  for (const t of valid) revalidateTag(t, { expire: 0 });
  return Response.json({ revalidated: valid });
}
