/**
 * @file googleReviews.js
 * @description Google rating + reviews via the Places API (New) (CF §13, T1.21).
 *
 * One Place Details call a day (cron `reviews-refresh`), cached in
 * ReviewCache. Field mask asks only for what the website shows, which keeps
 * the call in the cheapest SKU that includes reviews. Never throws.
 *
 * Needs GOOGLE_PLACES_API_KEY (restricted to Places API (New)) and the salon's
 * place ID — SiteSettings.contact.placeId, else SALON_PLACE_ID. Find it once
 * with `npm run find:place`.
 */

const ReviewCache = require("../models/ReviewCache");
const SiteSettings = require("../models/SiteSettings");

const apiBase = () => process.env.GOOGLE_PLACES_API_BASE || "https://places.googleapis.com/v1";
const FIELDS = "rating,userRatingCount,googleMapsUri,reviews";

async function placeId() {
  const s = await SiteSettings.getSingleton();
  return s.contact?.placeId || process.env.SALON_PLACE_ID || null;
}

/** @returns {Promise<{ok: boolean, rating?: number, count?: number, error?: string}>} */
async function refreshReviews() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const id = await placeId();
  if (!key || !id) return { ok: false, error: !key ? "GOOGLE_PLACES_API_KEY not set" : "place ID not set" };

  try {
    const res = await fetch(`${apiBase()}/places/${encodeURIComponent(id)}?languageCode=en`, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

    const reviews = (data.reviews || []).map((r) => ({
      author: r.authorAttribution?.displayName ?? null,
      authorUri: r.authorAttribution?.uri ?? null,
      profilePhoto: r.authorAttribution?.photoUri ?? null,
      rating: r.rating ?? null,
      text: r.text?.text ?? r.originalText?.text ?? "",
      relativeTime: r.relativePublishTimeDescription ?? null,
      publishTime: r.publishTime ? new Date(r.publishTime) : null,
    }));
    await ReviewCache.findOneAndUpdate(
      { key: "google" },
      {
        $set: {
          rating: data.rating ?? null,
          count: data.userRatingCount ?? null,
          mapsUri: data.googleMapsUri ?? null,
          reviews,
          fetchedAt: new Date(),
          lastError: null,
        },
      },
      { upsert: true }
    );
    return { ok: true, rating: data.rating, count: data.userRatingCount };
  } catch (err) {
    // Keep the last good copy; record why this refresh failed.
    await ReviewCache.updateOne({ key: "google" }, { $set: { lastError: err.message } }, { upsert: true }).catch(() => {});
    console.error("[reviews] refresh failed:", err.message);
    return { ok: false, error: err.message };
  }
}

/** Text Search once, to find the salon's place ID (scripts/findPlace.js). */
async function searchPlaces(query) {
  const res = await fetch(`${apiBase()}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY || "",
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({ textQuery: query, languageCode: "en" }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data.places || [];
}

module.exports = { refreshReviews, searchPlaces };
