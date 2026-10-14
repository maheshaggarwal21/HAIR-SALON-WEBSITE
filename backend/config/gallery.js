/**
 * @file config/gallery.js
 * @description Starting "See us in action" gallery for the home page (CF D33):
 * the salon's own photos (the same ones the staff app's landing page uses, from
 * frontend/public), shipped as static files with the customer site
 * (customer/public/images/gallery/). Used until the owner saves their own list
 * in Website Settings → Salon gallery; after that SiteSettings.media.gallery wins.
 */

module.exports = [
  { url: "/images/gallery/salon-floor.webp", caption: "Inside The Experts, Sirhind–Patiala Road" },
  { url: "/images/gallery/barber-stations.webp", caption: "Expert styling & cuts" },
  { url: "/images/gallery/styling-station.webp", caption: "Colour, makeup & treatments" },
];
