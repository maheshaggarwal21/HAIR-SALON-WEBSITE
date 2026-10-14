/**
 * Service → photo, in one place (no per-card image paths in JSX).
 *
 * Files live in public/images/services/<slug>-640.webp (cards) and
 * <slug>-1200.webp (hero tiles, detail page), made from the salon's source
 * photos (q78 / q80, metadata stripped, 3:2).
 *
 * getServiceImage(card) resolves in this order, so every card gets a photo and a
 * service added later never breaks the page:
 *   0. the owner's own photo for that service (Service.images[0]) wins;
 *   1. exact name match (case, spacing and punctuation ignored);
 *   2. men's cards: beard / moustache / Grooming → "for-him", other men-only
 *      hair cards → "duo-haircut";
 *   3. keyword rules, MOST SPECIFIC FIRST ("Split Ends (… Blow Dry)" is hair
 *      spa, not blow-dry; "Organic Bleach Neck" is face bleach, not body;
 *      "Bridal Draping" is draping, not bridal make-up);
 *   4. category fallback, with a console warning in development so a new
 *      service without a good match is noticed.
 */

import type { ServiceCard } from "./types";

export type ImageSlug =
  | "bridal-makeup"
  | "soft-glam-makeup"
  | "celebrity-makeup"
  | "saree-draping"
  | "dress-up-setting"
  | "manicure"
  | "pedicure"
  | "foot-massage"
  | "threading-eyebrow"
  | "threading-lip"
  | "facial"
  | "facial-cleanup"
  | "detan-mask"
  | "bleach-face"
  | "bleach-body"
  | "body-scrub"
  | "haircut"
  | "kids-haircut"
  | "blow-dry"
  | "head-massage"
  | "braid-bun"
  | "glossy-waves"
  | "silky-straight"
  | "balayage"
  | "root-colour"
  | "hair-spa"
  | "for-her"
  | "for-him"
  | "duo-haircut";

/** Short, specific alt text: what the photo shows, never the file name. */
const ALT: Record<ImageSlug, string> = {
  "bridal-makeup": "Makeup artist applying lipstick to a bride in a red lehenga",
  "soft-glam-makeup": "Artist applying soft glam eye makeup",
  "celebrity-makeup": "Makeup artist adding a final brushstroke of blush",
  "saree-draping": "Stylist draping a red and gold bridal saree",
  "dress-up-setting": "Stylist settling a client's dupatta in front of a mirror",
  manicure: "Beautician applying a nude-pink manicure",
  pedicure: "Pedicure with a rose-petal foot soak",
  "foot-massage": "Therapist giving a relaxing foot massage",
  "threading-eyebrow": "Beautician shaping eyebrows with thread",
  "threading-lip": "Beautician threading the upper lip",
  facial: "Facial mask being applied, with cucumber slices beside",
  "facial-cleanup": "Gentle facial cleanse with steam",
  "detan-mask": "De-tan mask being brushed onto the face",
  "bleach-face": "Face bleach being applied with eye pads in place",
  "bleach-body": "Bleach being applied to a client's forearm",
  "body-scrub": "Therapist applying a scrub to the lower leg",
  haircut: "Stylist cutting a client's shoulder-length hair",
  "kids-haircut": "Stylist giving a young girl a haircut",
  "blow-dry": "Stylist blow-drying long hair into soft waves",
  "head-massage": "Client relaxing during a head massage",
  "braid-bun": "Stylist pinning flowers into a braided bun",
  "glossy-waves": "Stylist curling long hair into glossy waves",
  "silky-straight": "Stylist smoothing long, silky straight hair",
  balayage: "Colourist applying caramel balayage with foils",
  "root-colour": "Colourist applying colour at the roots",
  "hair-spa": "Hair spa treatment under a steamer",
  "for-her": "Smiling woman with freshly styled long hair",
  "for-him": "Barber trimming a client's beard",
  "duo-haircut": "A man and a woman getting haircuts side by side",
};

/** Lowercase, "&" → "and", every run of punctuation/space → one space. */
export function normaliseName(name: string) {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** 1. Exact card names (as the menu shows them) → photo. */
const EXACT_LIST: [ImageSlug, string[]][] = [
  ["bridal-makeup", ["Basic Bridal Make-up", "HD Bridal Make-up"]],
  [
    "soft-glam-makeup",
    ["Basic Party Make-up", "HD Party Make-up", "Basic Engagement Make-up", "HD Engagement Make-up", "Basic Reception Make-up", "HD Make-up (Reception)"],
  ],
  [
    "celebrity-makeup",
    ["Celebrity Engagement Make-up", "Celebrity Reception Make-up", "Signature Make-up", "Signature Engagement Make-up", "Signature Reception Make-up"],
  ],
  ["saree-draping", ["Saree Draping", "Bridal Draping"]],
  ["dress-up-setting", ["Dress up Setting"]],
  ["manicure", ["Mini Manicure", "Manicure", "Premium Manicure", "Luxury Manicure"]],
  ["pedicure", ["Mini Pedicure", "Pedicure", "Premium Pedicure", "Luxury Pedicure"]],
  ["foot-massage", ["Foot massage"]],
  ["threading-eyebrow", ["Eyebrows", "Forehead (Thread)", "Thread combo", "Threading Full Face"]],
  ["threading-lip", ["Upper Lips (Thread)", "Chin (Thread)"]],
  [
    "facial",
    [
      "Fruit Facial",
      "Radiant Facial (Lotus Professional)",
      "Power Brightening (Paragon)",
      "Pure Vitamin Facial (Paragon)",
      "Pro Hydra (dry skin)",
      "Pro Hydra (oily skin)",
      "Hydra Facial",
      "Dermasyl Range",
      "Blanch",
      "Sensi-Age",
      "Save The Date (Instant Glow For Bride & Groom)",
    ],
  ],
  ["facial-cleanup", ["Clean-up (Basic)", "Brightening Cleanup (Paragon)", "Deep Cleaning (For Oily/Dry) (Kanpeki)"]],
  ["detan-mask", ["D-tan Facial (Brillare)", "D-tan facial (paragon)", "Dull Skin (For Tan Skin) (Brillare)", "Ruber Mask (De Tan Mask)", "De-tan Cleansing"]],
  ["bleach-face", ["Bleach Face", "Bleach Neck", "Organic Bleach Neck"]],
  [
    "body-scrub",
    ["Body Scrub", "Body Polishing", "Body Wrap", "Body Polishing + Wrap Combo", "Papaya & Marshmallow", "Ginger & Walnut", "Jamaican Sorrel"],
  ],
  ["haircut", ["Hair Cut (By Creative Styling)", "Hair Cut (Wash, Conditioning, Blow Dry)"]],
  ["kids-haircut", ["Baby Girls Hair Cut (Wash, Conditioning)"]],
  ["blow-dry", ["Blowdry & styling", "hair style", "Blow dry", "Shampoo (Conditioning, Natural Dry)", "Blow Dry (Wash, Conditioning, Blow Dry)"]],
  ["head-massage", ["Basic Head Massage", "Head Massage (Coconut, Olive Oil, Natural Dry)"]],
  ["braid-bun", ["Hairdo (braid)", "Party Hairdo (bun)"]],
  ["glossy-waves", ["Open Hair Styling (crimping)", "Open Hair Styling (curls)", "Open Hair Styling (waves)"]],
  [
    "silky-straight",
    ["Flat Iron Straightening (Wash, Conditioning)", "Smoothening", "Olaplex spa", "Botox", "Silk Therapy/Straight Therapy", "Nanoplastia", "Hair Perming", "Keratin"],
  ],
  ["balayage", ["Global Highlights Balayage Ombre Baby Light"]],
  ["root-colour", ["Root touchup", "Color Remove (Henna, Dye)"]],
  ["hair-spa", ["Hair spa", "Split Ends (Wash, Conditioning, Blow Dry)"]],
];
const EXACT = new Map<string, ImageSlug>(EXACT_LIST.flatMap(([slug, names]) => names.map((n) => [normaliseName(n), slug] as const)));

/** 3. Keyword rules on the normalised name, most specific first. First match wins. */
const KEYWORDS: [RegExp, ImageSlug][] = [
  [/\bsplit ends?\b/, "hair-spa"],
  [/\bhair spa\b/, "hair-spa"],
  [/\bdraping\b|\bsaree\b/, "saree-draping"],
  [/\bdupatta\b|\bdress up\b/, "dress-up-setting"],
  [/\b(celebrity|signature)\b.*\bmake ?up\b/, "celebrity-makeup"],
  [/\bbridal make ?up\b/, "bridal-makeup"],
  [/\bmake ?up\b/, "soft-glam-makeup"],
  [/\b(beard|moustache|mustache)\b/, "for-him"],
  [/\bbleach\b.*\b(face|neck)\b|\b(face|neck)\b.*\bbleach\b/, "bleach-face"],
  [/\bbleach\b/, "bleach-body"],
  [/\bd ?tan\b|\bdtan\b|\bde ?tan\b|\btan skin\b/, "detan-mask"],
  [/\bclean ?up\b|\bcleaning\b|\bcleansing\b/, "facial-cleanup"],
  [/\bfacial\b|\bhydra\b|\bglow\b|\bbrightening\b|\bvitamin\b/, "facial"],
  [/\bscrub\b|\bpolishing\b|\bwrap\b/, "body-scrub"],
  [/\bmanicure\b/, "manicure"],
  [/\bpedicure\b/, "pedicure"],
  [/\b(foot|feet) massage\b/, "foot-massage"],
  [/\bthread(ing)?\b.*\b(lips?|chin)\b|\b(lips?|chin)\b.*\bthread(ing)?\b/, "threading-lip"],
  [/\bthread(ing)?\b|\beyebrows?\b/, "threading-eyebrow"],
  [/\bhead massage\b/, "head-massage"],
  [/\bbraid\b|\bbun\b|\bhairdo\b/, "braid-bun"],
  [/\bcrimp(ing)?\b|\bcurls?\b|\bwaves?\b/, "glossy-waves"],
  [/\bstraight(ening)?\b|\bsmooth(ening)?\b|\bkeratin\b|\bbotox\b|\bnanoplast|\bperm(ing)?\b|\bsilk\b|\bolaplex\b/, "silky-straight"],
  [/\bhighlight|\bbalayage\b|\bombre\b|\bglobal colou?r\b/, "balayage"],
  [/\broot\b|\bhenna\b|\bcolou?r\b/, "root-colour"],
  [/\bbaby girls?\b/, "kids-haircut"],
  [/\bhair ?cut\b/, "haircut"],
  [/\bblow ?dry\b|\bshampoo\b|\bstyl(e|ing)\b/, "blow-dry"],
];

/** 4. Category fallbacks (Waxing has no photo yet: body scrub stands in). */
const CATEGORY: Record<string, ImageSlug> = {
  makeup: "soft-glam-makeup",
  "hands and feet": "manicure",
  threading: "threading-eyebrow",
  skin: "facial",
  hair: "blow-dry",
  colour: "balayage",
  color: "balayage",
  treatments: "silky-straight",
  waxing: "body-scrub",
  grooming: "for-him",
};
const DEFAULT_SLUG: ImageSlug = "blow-dry";

export interface ServiceImage {
  src: string;
  srcSet?: string;
  alt: string;
  /** Which photo, and how it was chosen (for the dev table and warnings). */
  slug: ImageSlug | "owner";
  via: "owner" | "exact" | "men" | "keyword" | "category" | "default";
}

const base = (slug: ImageSlug) => `/images/services/${slug}`;

/** A photo by slug, for hero tiles and the detail page. */
export function imageBySlug(slug: ImageSlug): Omit<ServiceImage, "via"> {
  return { src: `${base(slug)}-640.webp`, srcSet: `${base(slug)}-640.webp 640w, ${base(slug)}-1200.webp 1200w`, alt: ALT[slug], slug };
}

const warned = new Set<string>();

type ImageInput = Pick<ServiceCard, "name"> & Partial<Pick<ServiceCard, "displayCategory" | "audience" | "images">>;

export function getServiceImage(service: ImageInput): ServiceImage {
  const own = service.images?.find(Boolean);
  if (own) return { src: own, alt: service.name, slug: "owner", via: "owner" };

  const name = normaliseName(service.name);
  const category = normaliseName(service.displayCategory ?? "");
  const pick = (slug: ImageSlug, via: ServiceImage["via"]): ServiceImage => ({ ...imageBySlug(slug), slug, via });

  const exact = EXACT.get(name);
  if (exact) return pick(exact, "exact");

  if (service.audience === "him") {
    if (category === "grooming" || /\b(beard|moustache|mustache)\b/.test(name)) return pick("for-him", "men");
    if (category === "hair") return pick("duo-haircut", "men");
  }

  for (const [re, slug] of KEYWORDS) if (re.test(name)) return pick(slug, "keyword");

  const fallback = CATEGORY[category];
  if (process.env.NODE_ENV !== "production" && !warned.has(service.name)) {
    warned.add(service.name);
    console.warn(`[serviceImages] "${service.name}" (${service.displayCategory ?? "no category"}) has no dedicated photo; using the ${fallback ?? DEFAULT_SLUG} fallback.`);
  }
  return fallback ? pick(fallback, "category") : pick(DEFAULT_SLUG, "default");
}
