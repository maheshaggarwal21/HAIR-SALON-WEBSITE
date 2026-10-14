/**
 * @file config/packages.js
 * @description Phase 1 static packages (T1.7) until the Package model and its
 * staff editor arrive in Phase 3. Every entry here is a public offer the owner
 * has approved (T0.2 K3).
 *
 * Shape of one entry:
 *   slug          URL-safe, unique
 *   name, description
 *   audience      her | him | unisex
 *   serviceIds    real Service _ids, so the package works before the website
 *                 menu is curated, and keeps working if a service is renamed.
 *                 An item does NOT have to be listed on the menu by itself
 *                 (head wash can be in a package without its own card); it
 *                 must be active and have a website price.
 *   packagePrice  whole rupees, what the customer pays
 *   validFrom / validTo  IST dates, inclusive. Optional: omit both for an
 *                 offer that runs until it is removed here.
 *   draft         true keeps it out of the API (not on the website, can't be
 *                 requested) while details are still being confirmed.
 *
 * A package whose service is missing or inactive is left out of the API (and
 * logged) rather than sold with a missing item.
 *
 * Honesty: the website shows the package price and, when it's lower, the real
 * sum of the items' website prices ("₹3,310 if booked separately"). It never
 * shows an invented "was" price (CLAUDE.md, "Prices shown to customers").
 */

module.exports = [
  {
    // Owner's poster "Karva Chauth Special", T0.2 K3, 14 Oct 2026. Women only,
    // no end date for now. Waxes as the owner chose: half arm rica, half leg
    // honey. DRAFT until the owner confirms which facial is included —
    // Fruit Facial is assumed.
    slug: "karva-chauth-special",
    name: "Karva Chauth Special",
    description: "Ten services to get ready for the evening.",
    audience: "her",
    serviceIds: [
      "699ff11183c21439c00614e9", // Bleach Face
      "699ff7f389fbabf985075402", // Fruit Facial  ← confirm with owner
      "699ff9a389fbabf985075466", // Half Arms wax (rica)
      "699ff9b689fbabf98507546a", // Half legs wax (honey)
      "6a3d23d1ce5c5c2723f3285f", // Pedicure
      "6aabb99f87d1a72a595e6612", // head wash
      "699ff1cc83c21439c006150a", // Blow dry (women)
      "699ff77789fbabf9850753ea", // Eyebrows (threading)
      "699fffc489fbabf9850755a3", // Upper Lips (Thread)
      "699fef55598c6761f9eb3b8f", // Forehead (Thread)
    ],
    packagePrice: 2500,
    draft: true,
  },
];
