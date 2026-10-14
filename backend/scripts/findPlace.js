/**
 * @file scripts/findPlace.js
 * @description T0.12 — print candidate Google place IDs for the salon. Read-only.
 *
 *   npm run find:place                      # default query
 *   npm run find:place -- "The Experts salon Patiala"
 *
 * Copy the right `id` into Website Settings (placeId) or SALON_PLACE_ID.
 */
require("dotenv").config({ quiet: true });
const { searchPlaces } = require("../utils/googleReviews");

const query = process.argv.slice(2).join(" ") || "The Experts salon Sirhind Patiala Road Patiala";
searchPlaces(query)
  .then((places) => {
    if (!places.length) console.log("No places found for:", query);
    for (const p of places) {
      console.log(`${p.id}  ${p.displayName?.text ?? "?"} — ${p.formattedAddress ?? ""}  (${p.rating ?? "–"}★, ${p.userRatingCount ?? 0} reviews)`);
    }
  })
  .catch((err) => {
    console.error("Lookup failed:", err.message);
    process.exitCode = 1;
  });
