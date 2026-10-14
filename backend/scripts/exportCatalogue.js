/**
 * @file scripts/exportCatalogue.js
 * @description T0.3 — export the service catalogue as a review sheet for the owner.
 *
 *   npm run export:catalogue
 *   → docs/customer-platform/data/services-public.draft.csv
 *
 * Read-only. The sheet has two halves:
 *
 *   proposed_*  — what the rules in migrations/lib/catalogue.js suggest
 *                 (public price at 50%, display category, audience, clean name,
 *                 slug, variant grouping) plus `flags` for anything odd.
 *   owner_*     — blank. The owner fills these in; a blank owner cell means
 *                 "accept the proposal". `owner_showOnWebsite` has no proposal
 *                 on purpose: curating the public menu is the owner's call.
 *
 * Once the owner has signed it off, save it as `services-public.csv` next to
 * the draft (the T0.3 acceptance path). Importing the signed sheet is a
 * separate, reviewed step — this script never writes to the database.
 *
 * Written with a UTF-8 BOM so Excel shows ₹ and & correctly when double-clicked.
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../db");
const Service = require("../models/Service");
const {
  proposePublicPrice,
  proposeDisplayCategory,
  proposeAudience,
  proposePublicName,
  proposeVariant,
  slugify,
  flagServices,
} = require("../migrations/lib/catalogue");

const OUT = path.join(__dirname, "..", "..", "docs", "customer-platform", "data", "services-public.draft.csv");

const COLUMNS = [
  "id",
  "name",
  "category",
  "price",
  "isActive",
  "proposed_publicPrice",
  "proposed_displayCategory",
  "proposed_audience",
  "audience_reason",
  "proposed_publicName",
  "proposed_slug",
  "proposed_variantGroup",
  "proposed_variantLabel",
  "flags",
  "owner_showOnWebsite",
  "owner_publicPrice",
  "owner_displayCategory",
  "owner_audience",
  "owner_publicName",
  "owner_notes",
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCatalogue() {
  await connectDB();
  const services = await Service.find({}).sort({ category: 1, name: 1 }).lean();
  const flags = flagServices(services);

  const usedSlugs = new Set();
  const rows = services.map((s, i) => {
    let slug = slugify(s.name);
    for (let n = 2; usedSlugs.has(slug); n++) slug = `${slugify(s.name)}-${n}`;
    usedSlugs.add(slug);

    const { audience, reason } = proposeAudience(s.name);
    const { variantGroup, variantLabel } = proposeVariant(s.name);
    return {
      id: String(s._id),
      name: s.name,
      category: s.category,
      price: s.price,
      isActive: s.isActive,
      proposed_publicPrice: proposePublicPrice(s.price),
      proposed_displayCategory: proposeDisplayCategory(s.name, s.category),
      proposed_audience: audience,
      audience_reason: reason,
      proposed_publicName: proposePublicName(s.name),
      proposed_slug: slug,
      proposed_variantGroup: variantGroup,
      proposed_variantLabel: variantLabel,
      flags: flags[i].join(" | "),
    };
  });

  const csv =
    "﻿" +
    [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\r\n") +
    "\r\n";

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, csv);

  const flagged = rows.filter((r) => r.flags).length;
  console.log(`[export] ${rows.length} services → ${path.relative(process.cwd(), OUT)}`);
  console.log(`[export] ${flagged} flagged for owner attention`);
}

if (require.main === module) {
  exportCatalogue()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error("[export] FAILED:", err.message);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = exportCatalogue;
