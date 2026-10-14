/**
 * @file migrations/lib/catalogueImport.js
 * @description Pure rules for M6 (T0.3): turn the owner's signed-off sheet
 * (`docs/customer-platform/data/services-public.csv`) into guarded updates.
 * No I/O; tested in test/catalogue-import.test.js.
 *
 * ── How the sheet is read ────────────────────────────────────────────────────
 *   owner_showOnWebsite   yes / y / true / 1 → on the website; anything else → off
 *   owner_publicPrice     whole rupees; blank → proposed_publicPrice (50%, D12)
 *   owner_displayCategory blank → proposed;  owner_audience blank → proposed
 *   owner_publicName      blank → proposed
 *   slug / variant group / variant label always come from the proposed columns.
 * A service shown on the website gets `bookingMode: "request"` (Phase 1).
 *
 * ── What it will never do ────────────────────────────────────────────────────
 * - Touch internal fields: name, list price, category, duration, isActive.
 * - Overwrite a website field someone has set in the meantime. A field is
 *   written only if it is still empty (null / unset / showOnWebsite false); if
 *   the database already holds a DIFFERENT value it is listed as a conflict and
 *   left alone. Re-running is therefore a no-op.
 * - Import a row whose id or name no longer matches the database (renamed or
 *   deleted since the export) — those are listed for a human.
 */

const { DISPLAY_CATEGORIES, AUDIENCES } = require("../../models/Service");

const YES = new Set(["yes", "y", "true", "1", "✓", "x"]);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF, BOM. */
function parseCsv(text) {
  const src = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const blank = (v) => v === undefined || v === null || String(v).trim() === "";

/** What the sheet says the website fields should be for one row. */
function desiredFromRow(row) {
  const errors = [];
  const show = YES.has(String(row.owner_showOnWebsite || "").trim().toLowerCase());

  const priceText = blank(row.owner_publicPrice) ? row.proposed_publicPrice : row.owner_publicPrice;
  const publicPrice = Number(String(priceText).replace(/[₹,\s]/g, ""));
  if (!Number.isInteger(publicPrice) || publicPrice < 0) errors.push(`website price "${priceText}" is not whole rupees`);

  const displayCategory = blank(row.owner_displayCategory) ? row.proposed_displayCategory || null : row.owner_displayCategory;
  if (displayCategory && !DISPLAY_CATEGORIES.includes(displayCategory)) {
    errors.push(`category "${displayCategory}" must be one of: ${DISPLAY_CATEGORIES.join(", ")}`);
  }
  if (show && !displayCategory) errors.push("a website service needs a category");

  const audienceRaw = blank(row.owner_audience) ? row.proposed_audience || null : row.owner_audience.toLowerCase();
  const audience = audienceRaw || null;
  if (audience && !AUDIENCES.includes(audience)) errors.push(`audience "${audience}" must be her, him or unisex`);

  const publicName = (blank(row.owner_publicName) ? row.proposed_publicName : row.owner_publicName) || null;
  const slug = row.proposed_slug || null;
  if (show && (!slug || !SLUG_RE.test(slug))) errors.push(`slug "${slug}" is not usable`);

  return {
    show,
    errors,
    fields: {
      publicPrice,
      displayCategory,
      audience,
      publicName,
      slug,
      variantGroup: row.proposed_variantGroup || null,
      variantLabel: row.proposed_variantLabel || null,
    },
  };
}

/**
 * @param {object[]} rows      parsed sheet rows
 * @param {object[]} services  lean Service docs from the database
 * @returns {{ changes, conflicts, problems, summary }}
 */
function planCatalogueImport(rows, services) {
  const byId = new Map(services.map((s) => [String(s._id), s]));
  const changes = [];
  const conflicts = [];
  const problems = [];
  const seenSlugs = new Map();
  // Slugs already taken in the database, so a clash is reported here instead of
  // failing halfway through the bulk write on the unique index.
  const dbSlugOwner = new Map(services.filter((s) => s.slug).map((s) => [s.slug, String(s._id)]));
  let shown = 0;

  for (const row of rows) {
    const svc = byId.get(row.id);
    if (!svc) {
      problems.push({ id: row.id, name: row.name, problem: "not in the database any more" });
      continue;
    }
    if (svc.name.trim() !== String(row.name).trim()) {
      problems.push({ id: row.id, name: row.name, problem: `renamed since export (now "${svc.name}")` });
      continue;
    }
    const { show, errors, fields } = desiredFromRow(row);
    if (fields.slug) {
      const owner = dbSlugOwner.get(fields.slug);
      const clash = seenSlugs.has(fields.slug)
        ? `slug "${fields.slug}" also used by "${seenSlugs.get(fields.slug)}"`
        : owner && owner !== String(svc._id)
          ? `slug "${fields.slug}" already belongs to another service`
          : null;
      if (!clash) seenSlugs.set(fields.slug, row.name);
      // A website service needs its URL, so a clash stops the row. A hidden one
      // just doesn't get a slug yet; the owner can give it one when it goes live.
      else if (show) errors.push(clash);
      else fields.slug = null;
    }
    if (errors.length) {
      problems.push({ id: row.id, name: row.name, problem: errors.join("; ") });
      continue;
    }

    const set = {};
    const filter = { _id: svc._id };
    const note = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) continue;
      const current = svc[k];
      if (current === undefined || current === null) {
        set[k] = v;
        // Guard: still empty at write time. `slug` has no default, so it is absent.
        filter[k] = k === "slug" ? { $exists: false } : null;
      } else if (current !== v) {
        conflicts.push({ name: svc.name, field: k, inDatabase: current, inSheet: v });
        note.push(k);
      }
    }
    if (show) {
      shown += 1;
      if (svc.showOnWebsite !== true) {
        set.showOnWebsite = true;
        filter.showOnWebsite = { $ne: true };
      }
      if (!svc.bookingMode || svc.bookingMode === "hidden") {
        set.bookingMode = "request";
        filter.bookingMode = { $in: [null, "hidden"] };
      }
    }
    if (Object.keys(set).length) {
      changes.push({
        filter,
        update: { $set: set },
        summary: { name: svc.name, show, set: Object.keys(set), keptExisting: note },
      });
    }
  }

  return {
    changes,
    conflicts,
    problems,
    summary: { rows: rows.length, shownOnWebsite: shown, changes: changes.length, conflicts: conflicts.length, problems: problems.length },
  };
}

module.exports = { parseCsv, desiredFromRow, planCatalogueImport };
