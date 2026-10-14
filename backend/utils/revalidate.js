/**
 * @file revalidate.js
 * @description Tell the customer site that content changed, so the owner's
 * edit shows within seconds instead of after the cache lifetime (CF §12, T1.24).
 *
 * POST $CUSTOMER_SITE_URL/api/revalidate with the shared REVALIDATE_SECRET and
 * the cache tags the site uses (`site`, `services`, `artists`, `packages`,
 * `reels`, `reviews`, `campaigns`). Awaited by the caller — on Vercel, work after the
 * response may never run — but bounded to 3s and never throws: a failed ping
 * only means the edit appears when the cache next refreshes (≤ 1 hour).
 */

async function revalidateSite(tags) {
  const base = (process.env.CUSTOMER_SITE_URL || "").replace(/\/+$/, "");
  const secret = process.env.REVALIDATE_SECRET;
  if (!base || !secret || !tags?.length) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${base}/api/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err) {
    console.error(`[revalidate] ${tags.join(",")} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { revalidateSite };
