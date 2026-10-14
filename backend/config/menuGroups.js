/**
 * @file config/menuGroups.js
 * @description Website menu groups (CF D34): services that are the same kind of
 * thing with small differences ("Blow dry", "Hair style", "Open hair styling
 * (curls)"…) are shown as ONE card with a choice of options, each with its own
 * price. Every option is still the real service (its own id and price), so
 * requests, packages, Visits and analytics are unchanged (D8).
 *
 * This is a display overlay for the public API only. Nothing in the database is
 * changed; a service the owner has put in a variant group in the database
 * (`Service.variantGroup`, e.g. Keratin Short / Medium / Long) keeps that group.
 * A service not listed here stays its own card, so new services never break.
 *
 * Matching is by the service's website name or internal name, ignoring case,
 * spacing and punctuation. `label` is what the option is called on the card.
 * `category` (optional) puts the card in that menu section regardless of where
 * its first option sits (e.g. Eyebrows lives under Skin in the data but belongs
 * with threading).
 *
 * `keepTitle: true` shows the group's title even with a single member, which is
 * how a service is renamed for the website without touching the database.
 *
 * `pick: "many"` lets a customer tick several options of one card in the
 * request sheet (Eyebrows + Upper lip, Underarms + Half arms). Otherwise the
 * options are alternatives and picking one replaces the other (Mini vs
 * Premium manicure, Basic vs HD bridal).
 */

const GROUPS = [
  // ── Hair ──────────────────────────────────────────────────────────────────
  {
    slug: "hair-styling-blow-dry",
    title: "Hair styling & blow-dry",
    members: [
      ["Blowdry & styling", "Blow-dry & styling"],
      ["hair style", "Hair style"],
      ["Hair Styling", "Hair styling (men)"],
      ["Blow dry", "Blow-dry"],
      ["Blow Dry (Wash, Conditioning, Blow Dry)", "Wash, condition & blow-dry"],
      ["Blow dry nd wash", "Wash & blow-dry (men)"],
      ["Flat Iron Straightening (Wash, Conditioning)", "Flat-iron straightening"],
      ["Open Hair Styling (crimping)", "Open hair: crimping"],
      ["Open Hair Styling (curls)", "Open hair: curls"],
      ["Open Hair Styling (waves)", "Open hair: waves"],
    ],
  },
  {
    slug: "hair-wash",
    title: "Hair wash & shampoo",
    members: [
      ["Shampoo (Conditioning, Natural Dry)", "Shampoo, condition & natural dry"],
      ["Shampoo (Wash Styling)", "Shampoo & styling (men)"],
    ],
  },
  {
    slug: "haircut",
    title: "Haircut",
    members: [
      ["Hair Cut (By Creative Styling)", "Creative cut"],
      ["Hair Cut (Wash, Conditioning, Blow Dry)", "Cut with wash & blow-dry"],
      ["Baby Girls Hair Cut (Wash, Conditioning)", "Girls' cut (kids)"],
    ],
  },
  {
    slug: "mens-haircut",
    title: "Men's haircut",
    members: [
      ["Hair Cut (Wash Styling)", "Cut with wash & styling"],
      ["Baby Boy Hair Cut (Styling)", "Boys' cut (kids)"],
    ],
  },
  {
    // The owner's team: "Hair Cut (Creative Styling)" is the couple cut (14 Oct 2026).
    slug: "couple-haircut",
    title: "Couple haircut",
    keepTitle: true,
    members: [["Hair Cut (Creative Styling)", "Couple haircut"]],
  },
  {
    slug: "head-massage",
    title: "Head massage",
    members: [
      ["Basic Head Massage", "Basic"],
      ["Head Massage (Coconut, Olive Oil, Natural Dry)", "Oil massage (coconut / olive)"],
    ],
  },
  {
    slug: "party-hairdo",
    title: "Party hairdo",
    members: [
      ["Hairdo (braid)", "Braid"],
      ["Party Hairdo (bun)", "Bun"],
    ],
  },
  // ── Colour ────────────────────────────────────────────────────────────────
  {
    slug: "hair-colour",
    title: "Hair colour",
    members: [
      ["Root touchup", "Root touch-up"],
      ["Global Color", "Global colour (men)"],
      ["Men hair colour", "Men's hair colour"],
      ["Highlighting", "Highlights (men)"],
      ["Color Remove (Henna, Dye)", "Colour removal (henna, dye)"],
    ],
  },
  // ── Treatments ────────────────────────────────────────────────────────────
  {
    // Olaplex spa stays its own card (it has its own bond-repair photo).
    slug: "hair-spa-repair",
    title: "Hair spa & repair",
    members: [
      ["Hair spa", "Hair spa"],
      ["Split Ends (Wash, Conditioning, Blow Dry)", "Split-end treatment"],
    ],
  },
  // ── Skin ──────────────────────────────────────────────────────────────────
  {
    slug: "facials",
    title: "Facials",
    members: [
      ["Fruit Facial", "Fruit"],
      ["Radiant Facial (Lotus Professional)", "Radiant (Lotus Professional)"],
      ["Power Brightening (Paragon)", "Power brightening (Paragon)"],
      ["Pure Vitamin Facial (Paragon)", "Pure vitamin (Paragon)"],
      ["Pro Hydra (dry skin)", "Pro Hydra, dry skin"],
      ["Pro Hydra (oily skin)", "Pro Hydra, oily skin"],
    ],
  },
  {
    slug: "advanced-facials",
    title: "Advanced facials",
    members: [
      ["Hydra Facial", "Hydra facial"],
      ["Dermasyl Range", "Dermasyl"],
      ["Blanch", "Blanch"],
      ["Sensi-Age", "Sensi-Age"],
      ["Save The Date (Instant Glow For Bride & Groom)", "Save the Date (bride & groom glow)"],
    ],
  },
  {
    slug: "clean-up",
    title: "Clean-up",
    members: [
      ["Clean-up (Basic)", "Basic"],
      ["Brightening Cleanup (Paragon)", "Brightening (Paragon)"],
      ["Deep Cleaning (For Oily/Dry) (Kanpeki)", "Deep cleaning, oily/dry (Kanpeki)"],
    ],
  },
  {
    slug: "de-tan",
    title: "De-tan",
    members: [
      ["De-tan Cleansing", "De-tan cleansing"],
      ["Ruber Mask (De Tan Mask)", "De-tan rubber mask"],
      ["Dull Skin (For Tan Skin) (Brillare)", "Dull, tanned skin (Brillare)"],
      ["D-tan facial (paragon)", "De-tan facial (Paragon)"],
      ["D-tan Facial (Brillare)", "De-tan facial (Brillare)"],
      ["D-tan", "De-tan (men)"],
      ["Dtan paragon", "De-tan, Paragon (men)"],
    ],
  },
  {
    slug: "bleach",
    pick: "many",
    title: "Bleach",
    members: [
      ["Bleach Face", "Face"],
      ["Face Bleach", "Face (men)"],
      ["Bleach Neck", "Neck"],
      ["Bleach Hand/Feet", "Hands / feet"],
      ["Bleach Arms", "Arms"],
      ["Bleach Legs", "Legs"],
      ["Bleach Back", "Back"],
      ["Bleach Stomach", "Stomach"],
      ["Bleach Full Body", "Full body"],
      ["Body Bleach", "Body bleach"],
    ],
  },
  {
    slug: "organic-bleach",
    pick: "many",
    title: "Organic bleach",
    members: [
      ["Organic Bleach Neck", "Neck"],
      ["Organic Bleach Hand/Feet", "Hands / feet"],
      ["Organic Bleach Arms", "Arms"],
      ["Organic Bleach Legs", "Legs"],
      ["Organic Bleach Back", "Back"],
      ["Organic Bleach Stomach", "Stomach"],
      ["Organic Bleach Full Body", "Full body"],
    ],
  },
  {
    slug: "body-scrub-polish-wrap",
    title: "Body scrub, polish & wrap",
    members: [
      ["Body Scrub", "Body scrub"],
      ["Body Polishing", "Body polishing"],
      ["Body Wrap", "Body wrap"],
      ["Body Polishing + Wrap Combo", "Polishing + wrap combo"],
      ["Papaya & Marshmallow", "Papaya & marshmallow"],
      ["Ginger & Walnut", "Ginger & walnut"],
      ["Jamaican Sorrel", "Jamaican sorrel"],
    ],
  },
  // ── Threading ─────────────────────────────────────────────────────────────
  {
    slug: "threading",
    pick: "many",
    title: "Threading",
    category: "Threading",
    members: [
      ["Eyebrows", "Eyebrows"],
      ["Upper Lips (Thread)", "Upper lip"],
      ["Chin (Thread)", "Chin"],
      ["Forehead (Thread)", "Forehead"],
      ["Men thread", "Men's threading"],
      ["Thread combo", "Combo"],
      ["Threading Full Face", "Full face"],
    ],
  },
  // ── Hands & feet ──────────────────────────────────────────────────────────
  {
    slug: "manicure",
    title: "Manicure",
    members: [
      ["Mini Manicure", "Mini"],
      ["Manicure", "Classic"],
      ["Premium Manicure", "Premium"],
      ["Luxury Manicure", "Luxury"],
    ],
  },
  {
    slug: "pedicure",
    title: "Pedicure",
    members: [
      ["Mini Pedicure", "Mini"],
      ["Pedicure", "Classic"],
      ["Premium Pedicure", "Premium"],
      ["Luxury Pedicure", "Luxury"],
    ],
  },
  // ── Makeup ────────────────────────────────────────────────────────────────
  {
    slug: "party-makeup",
    title: "Party make-up",
    members: [
      ["Basic Party Make-up", "Basic"],
      ["HD Party Make-up", "HD"],
      ["Signature Make-up", "Signature"],
    ],
  },
  {
    slug: "engagement-makeup",
    title: "Engagement make-up",
    members: [
      ["Basic Engagement Make-up", "Basic"],
      ["HD Engagement Make-up", "HD"],
      ["Signature Engagement Make-up", "Signature"],
      ["Celebrity Engagement Make-up", "Celebrity"],
    ],
  },
  {
    slug: "reception-makeup",
    title: "Reception make-up",
    members: [
      ["Basic Reception Make-up", "Basic"],
      ["HD Make-up (Reception)", "HD"],
      ["Signature Reception Make-up", "Signature"],
      ["Celebrity Reception Make-up", "Celebrity"],
    ],
  },
  {
    slug: "bridal-makeup",
    title: "Bridal make-up",
    members: [
      ["Basic Bridal Make-up", "Basic"],
      ["HD Bridal Make-up", "HD"],
    ],
  },
  {
    slug: "draping-dress-up",
    pick: "many",
    title: "Draping & dress-up",
    members: [
      ["Saree Draping", "Saree draping"],
      ["Bridal Draping", "Bridal draping"],
      ["Dress up Setting", "Dress-up setting"],
    ],
  },
  // ── Waxing ────────────────────────────────────────────────────────────────
  {
    slug: "face-waxing",
    pick: "many",
    title: "Face waxing",
    members: [
      ["Upper lips (wax)", "Upper lip"],
      ["Chin (wax)", "Chin"],
      ["Nose (wax)", "Nose"],
      ["Nose wax (inner)", "Nose, inner (men)"],
      ["Nose wax (outer)", "Nose, outer (men)"],
      ["Forehead (wax) Women", "Forehead"],
      ["Forehead wax", "Forehead (men)"],
      ["Side locks (wax)", "Side locks"],
      ["Ear wax", "Ears (men)"],
      ["Face Wax", "Full face"],
      ["Full Face wax", "Full face (men)"],
    ],
  },
  {
    slug: "arms-underarms-waxing",
    pick: "many",
    title: "Arms & underarms waxing",
    members: [
      ["Under arms wax (honey)", "Underarms, honey"],
      ["Under arms wax (rica)", "Underarms, Rica"],
      ["Half Arms wax (honey)", "Half arms, honey"],
      ["Half Arms wax (rica)", "Half arms, Rica"],
      ["Full Arms wax (honey)", "Full arms, honey"],
      ["Full Arms wax (rica)", "Full arms, Rica"],
    ],
  },
  {
    slug: "legs-waxing",
    pick: "many",
    title: "Legs waxing",
    members: [
      ["Half legs wax (honey)", "Half legs, honey"],
      ["Half legs wax (rica)", "Half legs, Rica"],
      ["Full legs wax (honey)", "Full legs, honey"],
      ["Full legs wax (rica)", "Full legs, Rica"],
    ],
  },
  {
    slug: "back-stomach-waxing",
    pick: "many",
    title: "Back & stomach waxing",
    members: [
      ["Half back wax (rica)", "Half back, Rica"],
      ["Back wax (honey)", "Full back, honey"],
      ["Back wax (rica)", "Full back, Rica"],
      ["Stomach wax (honey)", "Stomach, honey"],
      ["Stomach wax (rica)", "Stomach, Rica"],
    ],
  },
  {
    slug: "bikini-body-waxing",
    pick: "many",
    title: "Bikini & full-body waxing",
    members: [
      ["Bikini wax (honey)", "Bikini, honey"],
      ["Bikini wax (rica)", "Bikini, Rica"],
      ["Body wax (excluded bikini) (honey)", "Full body except bikini, honey"],
    ],
  },
  // ── Grooming ──────────────────────────────────────────────────────────────
  {
    slug: "beard-moustache",
    pick: "many",
    title: "Beard & moustache",
    members: [
      ["Beard cut", "Beard cut"],
      ["Beard Trim", "Beard trim"],
      ["Beard Color", "Beard colour"],
      ["Moustache Pasting", "Moustache setting"],
      ["Moustache Pasting (Color)", "Moustache colour"],
    ],
  },
];

/** Lowercase, "&" → "and", every run of punctuation/space → one space. */
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const BY_NAME = new Map();
const BY_SLUG = new Map();
for (const g of GROUPS) {
  BY_SLUG.set(g.slug, g);
  g.members.forEach(([name, label], order) => BY_NAME.set(norm(name), { group: g, label, order }));
}

/** The config group (and this service's label in it) for a service, or null. */
function groupFor(service) {
  return BY_NAME.get(norm(service.publicName)) || BY_NAME.get(norm(service.name)) || null;
}

module.exports = { GROUPS, groupFor, groupBySlug: (slug) => BY_SLUG.get(slug) || null, norm };
