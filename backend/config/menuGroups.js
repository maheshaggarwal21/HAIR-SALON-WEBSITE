/**
 * @file config/menuGroups.js
 * @description Website menu groups (CF D34, D53): the cards of the customer
 * menu. Each card is one of the owner's groups ("Hair services", "Waxing
 * (honey)", "Bleach"…) with a choice of options, each with its own price.
 * Every option is still the real service (its own id and price), so requests,
 * packages, Visits and analytics are unchanged (D8).
 *
 * The groups, their order and the option names come from the owner's signed
 * menu (19 Oct 2026, docs/customer-platform/data/website-menu.csv). Which
 * services are on the website, their price, who they are for and their full
 * website name live in the database and are set by migration M7 from that
 * same sheet; this file only decides how they are grouped and labelled.
 * test/website-menu.test.js keeps the two in step.
 *
 * This is a display overlay for the public API only. Nothing in the database is
 * changed; a service the owner has put in a variant group in the database
 * (`Service.variantGroup`, e.g. Keratin Short / Medium / Long) keeps that group.
 * A service not listed here stays its own card, so new services never break.
 *
 * Matching is by the service's internal (billing) name, which is unique, then
 * its website name, ignoring case, spacing and punctuation. Internal name
 * first, because website names repeat across groups ("Keratin" for her and for
 * him). `label` is what the option is called on the card. `category` puts the
 * card in that menu section.
 *
 * `keepTitle: true` shows the group's title even with a single member (the
 * men's "Hair colour" card has only Global colour).
 *
 * `description` is the line under the card title (e.g. "Starting prices…").
 *
 * `pick: "many"` lets a customer tick several options of one card in the
 * request sheet (Eyebrows + Upper lip, Underarms + Half arms). Otherwise the
 * options are alternatives and picking one replaces the other (Basic vs
 * Luxury facial, Party vs Bridal make-up).
 */

const GROUPS = [
  {
    slug: "hair-services-men",
    title: "Hair services",
    category: "Hair",
    pick: "many",
    members: [
      ["Hair Cut (Wash Styling) (men)", "Haircut"],
      ["Hair Styling (Men)", "Hair styling"],
      ["Head Massage", "Head massage"],
      ["Baby Boy Hair Cut (Styling)", "Baby boy haircut"],
    ],
  },
  {
    slug: "beard-moustache",
    title: "Beard & moustache",
    category: "Grooming",
    pick: "many",
    members: [
      ["Beard Trim", "Beard trim"],
      ["Beard Shave", "Beard shave"],
      ["Moustache Pasting", "Moustache pasting"],
      ["Moustache Pasting (Color)", "Moustache colour"],
      ["Beard Color", "Beard colour"],
    ],
  },
  {
    slug: "hair-colour-men",
    title: "Hair colour",
    category: "Colour",
    keepTitle: true,
    members: [
      ["Global Color (Men)", "Global colour"],
    ],
  },
  {
    slug: "hair-treatments-men",
    title: "Hair treatments",
    category: "Treatments",
    members: [
      ["Highlighting (Men)", "Highlighting"],
      ["Keratin (Men)", "Keratin"],
      ["Smoothening (Men)", "Smoothening"],
      ["Botox (Men)", "Botox"],
      ["Hair Perming (Men)", "Hair perming"],
    ],
  },
  {
    slug: "waxing-threading-men",
    title: "Waxing & threading",
    category: "Waxing",
    pick: "many",
    members: [
      ["Cheeks wax (men)", "Cheeks wax"],
      ["Nose wax (men) (outer)", "Nose wax"],
      ["Ear wax (men)", "Ear wax"],
      ["Forehead wax (men)", "Forehead wax"],
      ["Full Face wax (men)", "Full face wax"],
      ["Men thread", "Threading"],
    ],
  },
  {
    slug: "manicure-pedicure",
    title: "Manicure & pedicure",
    category: "Hands & feet",
    members: [
      ["Manicure & Pedicure (Basic)", "Basic"],
      ["Manicure & Pedicure (Premium)", "Premium"],
      ["Manicure & Pedicure (Luxury)", "Luxury"],
    ],
  },
  {
    slug: "clean-up",
    title: "Clean-up",
    category: "Skin",
    members: [
      ["Clean-up (Basic)", "Basic"],
      ["Brightening Cleanup (Paragon)", "Brightening"],
      ["De-tan Cleansing", "De-tan cleansing"],
      ["Deep Cleaning (For Oily/Dry) (Kanpeki)", "Deep cleansing (Kanpeki)"],
    ],
  },
  {
    slug: "facials",
    title: "Facials",
    category: "Skin",
    members: [
      ["Facial (Basic)", "Basic"],
      ["Facial (Premium)", "Premium"],
      ["Facial (Luxury)", "Luxury"],
    ],
  },
  {
    slug: "hair-services-women",
    title: "Hair services",
    category: "Hair",
    pick: "many",
    members: [
      ["head wash", "Head wash (natural dry)"],
      ["Blow dry (women)", "Blow-dry"],
      ["Head Massage (Coconut, Olive Oil, Natural Dry)", "Head massage with wash"],
      ["Hair Cut (Wash, Conditioning, Blow Dry) (women)", "Haircut with wash & blow-dry"],
      ["Split Ends (Wash, Conditioning, Blow Dry)", "Split ends with wash & blow-dry"],
      ["Baby Girls Hair Cut (Wash, Conditioning)", "Baby girl haircut & blow-dry"],
      ["Flat Iron Straightening (Wash, Conditioning)", "Flat-iron straightening"],
      ["Open Hair Styling (curls)", "Spiral curls with wash"],
      ["Root touchup", "Root touch-up"],
    ],
  },
  {
    slug: "hair-colour-women",
    title: "Hair colour",
    category: "Colour",
    description: "Starting prices. The final price depends on your hair length; we confirm it before we start.",
    members: [
      ["Global Highlights Balayage Ombre Baby Light (Short)", "Global colour"],
      ["Highlights (Women)", "Highlights"],
      ["Balayage", "Balayage"],
      ["Ombre", "Ombré"],
      ["Baby Light", "Baby lights"],
      ["Color Remove (Henna, Dye)", "Colour removal (henna, dye)"],
    ],
  },
  {
    slug: "hair-treatments-women",
    title: "Hair treatments",
    category: "Treatments",
    description: "Starting prices, for short hair. Medium and long hair cost more; we confirm the price before we start.",
    members: [
      ["Keratin (Women) Short", "Keratin"],
      ["Smoothening (Women) Short", "Smoothening"],
      ["Rebonding", "Rebonding"],
      ["Botox (Women) Short", "Botox"],
      ["Silk Therapy/Straight Therapy Short", "Silk / straight therapy"],
      ["Nanoplastia Short", "Nanoplastia"],
    ],
  },
  {
    slug: "honey-waxing",
    title: "Waxing (honey)",
    category: "Waxing",
    pick: "many",
    members: [
      ["Full Arms wax ( honey)", "Full arms"],
      ["Full legs wax (honey)", "Full legs"],
      ["Half Arms wax (honey)", "Half arms"],
      ["Half legs wax (honey)", "Half legs"],
      ["Under arms wax (honey)", "Underarms"],
      ["Bikini wax (honey)", "Bikini"],
      ["Body wax (excluded bikini) (honey)", "Full body except bikini"],
      ["Body wax (included bikini) (honey)", "Full body express"],
    ],
  },
  {
    slug: "rica-waxing",
    title: "Waxing (Rica)",
    category: "Waxing",
    pick: "many",
    members: [
      ["Full Arms wax (rica)", "Full arms"],
      ["Full legs wax (rica)", "Full legs"],
      ["Half Arms wax (rica)", "Half arms"],
      ["Half legs wax (rica)", "Half legs"],
      ["Under arms wax (rica)", "Underarms"],
      ["Bikini wax (rica)", "Bikini"],
      ["Body wax (excluded bikini) (rica)", "Full body except bikini"],
      ["Body wax (included bikini) (rica)", "Full body express"],
    ],
  },
  {
    slug: "face-wax",
    title: "Face wax",
    category: "Waxing",
    pick: "many",
    members: [
      ["Eyebrow wax", "Eyebrows"],
      ["Side locks (wax)", "Side locks"],
      ["Upper lips (wax)", "Upper lip"],
      ["Chin (wax)", "Chin"],
      ["Face Wax", "Full face"],
    ],
  },
  {
    slug: "threading",
    title: "Threading",
    category: "Threading",
    pick: "many",
    members: [
      ["Threading Full Face", "Full face"],
      ["Eyebrows", "Eyebrows"],
      ["Forehead ( Thread)", "Forehead"],
      ["Upper Lips ( Thread)", "Upper lip"],
      ["Chin (Thread)", "Chin"],
      ["Side Locks (Thread)", "Side locks"],
    ],
  },
  {
    slug: "bleach",
    title: "Bleach",
    category: "Skin",
    pick: "many",
    members: [
      ["Bleach Face", "Face"],
      ["Bleach Neck", "Neck"],
      ["Bleach Stomach", "Stomach"],
      ["Bleach Back", "Back"],
      ["Bleach Arms", "Arms"],
      ["Bleach Legs", "Legs"],
      ["Bleach Hand/Feet", "Hands / feet"],
      ["Bleach Full Body", "Full body"],
    ],
  },
  {
    slug: "makeup",
    title: "Make-up",
    category: "Makeup",
    members: [
      ["Basic Party Make-up", "Party make-up"],
      ["Basic Engagement Make-up", "Engagement make-up"],
      ["Basic Reception Make-up", "Reception make-up"],
      ["Basic Bridal Make-up", "Bridal make-up"],
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
  return BY_NAME.get(norm(service.name)) || BY_NAME.get(norm(service.publicName)) || null;
}

module.exports = { GROUPS, groupFor, groupBySlug: (slug) => BY_SLUG.get(slug) || null, norm };
