/**
 * @file config/heroSlides.js
 * @description Starting hero background slider (CF D31): the salon's own reels
 * and photos, shipped as static files with the customer site
 * (customer/public/media/hero/, served by Vercel's CDN). Used until the owner
 * saves their own list in Website Settings → Home page slider; after that
 * SiteSettings.media.heroSlides wins ([] hides the slider).
 *
 * `url` is the upright reel (phones); `wideUrl` a face-following 16:9 cut for
 * wide screens (desktop), made from the same reel.
 */

const H = "/media/hero/";

module.exports = [
  {
    kind: "video",
    url: H + "hero-1-moustache-style.mp4",
    poster: H + "hero-1-moustache-style-poster.webp",
    wideUrl: H + "hero-1-moustache-style-wide.mp4",
    widePoster: H + "hero-1-moustache-style-wide-poster.webp",
    alt: "Barbers at work inside The Experts salon",
  },
  {
    kind: "video",
    url: H + "hero-2-hair-colour.mp4",
    poster: H + "hero-2-hair-colour-poster.webp",
    wideUrl: H + "hero-2-hair-colour-wide.mp4",
    widePoster: H + "hero-2-hair-colour-wide-poster.webp",
    alt: "Hair colour transformation",
  },
  {
    kind: "video",
    url: H + "hero-3-haircut-beard.mp4",
    poster: H + "hero-3-haircut-beard-poster.webp",
    wideUrl: H + "hero-3-haircut-beard-wide.mp4",
    widePoster: H + "hero-3-haircut-beard-wide-poster.webp",
    alt: "Haircut and beard styling",
  },
  { kind: "image", url: H + "hero-4-salon-floor.webp", poster: null, wideUrl: null, widePoster: null, alt: "Inside The Experts salon" },
  { kind: "image", url: H + "hero-5-the-experts-sign.webp", poster: null, wideUrl: null, widePoster: null, alt: "The Experts: Skin, Hairs, Makeup" },
  { kind: "image", url: H + "hero-6-styling-station.webp", poster: null, wideUrl: null, widePoster: null, alt: "Makeup and styling station" },
];
