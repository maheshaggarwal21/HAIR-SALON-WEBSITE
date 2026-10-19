/**
 * @file migrations/lib/websiteMenu.js
 * @description Pure rules for M7 (CF D53): make the website menu exactly the
 * owner's signed list (docs/customer-platform/data/website-menu.csv, 19 Oct
 * 2026). No I/O; tested in test/website-menu.test.js.
 *
 * ── What one sheet row means ─────────────────────────────────────────────────
 *   billing_id + billing_name  an existing service. Both must still match the
 *                              database (renamed or deleted → listed, skipped).
 *   no billing_id              a service the billing app does not have yet. It
 *                              is created with billing_name, list_price and
 *                              new_category, so the desk can bill it too. If a
 *                              service with that name exists by now (a second
 *                              run), it is used instead: re-running never makes
 *                              a duplicate.
 *   website_price              Service.publicPrice: what the customer pays.
 *   section, audience, website_name, slug, order
 *                              displayCategory, audience, publicName, slug,
 *                              sortOrder. Grouping and option labels are in
 *                              config/menuGroups.js.
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 * - Unlike M6 this sheet is the whole menu, so website fields are SET to the
 *   sheet's values, not only filled when empty. Each update is guarded on the
 *   values read at planning time, so an edit made in between is not
 *   overwritten (the runner reports it as skipped).
 * - Every service the sheet does not list leaves the website
 *   (showOnWebsite → false). Nothing is deleted or deactivated.
 * - The list price of an existing service is NEVER changed: the owner chose
 *   "website only" for the 16 services whose billing price differs from the
 *   sheet (19 Oct 2026). They are listed in the report as `listPriceDiffers`.
 * - Internal name, category, duration and isActive of existing services are
 *   never touched. variantGroup / variantLabel are cleared on listed services,
 *   because a database variant group would override the owner's grouping.
 */

const { DISPLAY_CATEGORIES, AUDIENCES, DEFAULT_DURATION_MINUTES } = require("../../models/Service");

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OID_RE = /^[a-f0-9]{24}$/i;

const wholeRupees = (v) => {
  const n = Number(String(v ?? "").replace(/[₹,\s]/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** The website fields a sheet row asks for, plus any errors in the row itself. */
function desiredFromRow(row) {
  const errors = [];
  const publicPrice = wholeRupees(row.website_price);
  if (publicPrice === null) errors.push(`website price "${row.website_price}" is not whole rupees`);
  const listPrice = wholeRupees(row.list_price);
  if (listPrice === null) errors.push(`list price "${row.list_price}" is not whole rupees`);
  if (!DISPLAY_CATEGORIES.includes(row.section)) errors.push(`section "${row.section}" must be one of: ${DISPLAY_CATEGORIES.join(", ")}`);
  if (!AUDIENCES.includes(row.audience)) errors.push(`audience "${row.audience}" must be her, him or unisex`);
  if (!row.website_name) errors.push("website name is empty");
  if (!SLUG_RE.test(row.slug || "")) errors.push(`slug "${row.slug}" is not usable`);
  if (!row.billing_name) errors.push("billing name is empty");
  if (row.billing_id && !OID_RE.test(row.billing_id)) errors.push(`billing id "${row.billing_id}" is not an id`);
  const sortOrder = Number(row.order);
  if (!Number.isInteger(sortOrder)) errors.push(`order "${row.order}" is not a number`);
  return {
    errors,
    listPrice,
    fields: {
      showOnWebsite: true,
      publicPrice,
      displayCategory: row.section,
      audience: row.audience,
      publicName: row.website_name,
      slug: row.slug,
      sortOrder,
      variantGroup: null,
      variantLabel: null,
    },
  };
}

/** Guard value for "still what we read": absent and null both match `null`, except slug (sparse index). */
const guard = (k, v) => (v === undefined || v === null ? (k === "slug" ? { $exists: false } : null) : v);

/**
 * @param {object[]} rows      parsed sheet rows (website-menu.csv)
 * @param {object[]} services  lean Service docs from the database
 * @param {Date}     [now]     timestamp for created services
 * @returns {{ changes, problems, listPriceDiffers, hidden, created, summary }}
 */
function planWebsiteMenu(rows, services, now = new Date()) {
  const byId = new Map(services.map((s) => [String(s._id), s]));
  const byName = new Map(services.map((s) => [s.name.trim(), s]));
  const slugOwner = new Map(services.filter((s) => s.slug).map((s) => [s.slug, String(s._id)]));
  const changes = [];
  const problems = [];
  const listPriceDiffers = [];
  const created = [];
  const listed = new Set();
  const sheetSlugs = new Map();
  const sheetNames = new Set();

  for (const row of rows) {
    const { errors, listPrice, fields } = desiredFromRow(row);
    const name = String(row.billing_name || "").trim();
    if (sheetNames.has(name)) errors.push(`"${name}" is listed twice`);
    sheetNames.add(name);
    if (sheetSlugs.has(fields.slug)) errors.push(`slug "${fields.slug}" also used by "${sheetSlugs.get(fields.slug)}"`);
    sheetSlugs.set(fields.slug, name);

    let svc = null;
    if (row.billing_id) {
      svc = byId.get(row.billing_id) || null;
      if (!svc) errors.push("not in the database any more");
      else if (svc.name.trim() !== name) errors.push(`renamed since the sheet was made (now "${svc.name}")`);
    } else {
      svc = byName.get(name) || null; // created by an earlier run
    }
    const holder = slugOwner.get(fields.slug);
    if (holder && (!svc || holder !== String(svc._id))) errors.push(`slug "${fields.slug}" already belongs to another service`);

    if (errors.length) {
      problems.push({ name: name || row.website_name, problem: errors.join("; ") });
      continue;
    }

    if (!svc) {
      const doc = {
        name,
        price: listPrice,
        category: row.new_category || "",
        durationMinutes: DEFAULT_DURATION_MINUTES,
        durationConfirmed: false,
        isActive: true,
        bookingMode: "request",
        ...fields,
        createdAt: now,
        updatedAt: now,
      };
      delete doc.variantGroup;
      delete doc.variantLabel;
      created.push({ name, price: listPrice, publicPrice: fields.publicPrice, websiteName: fields.publicName });
      changes.push({
        filter: { name },
        update: { $setOnInsert: doc },
        upsert: true,
        summary: { name, created: true, set: Object.keys(doc) },
      });
      continue;
    }

    listed.add(String(svc._id));
    if (svc.price !== listPrice) {
      listPriceDiffers.push({ name: svc.name, billingPrice: svc.price, sheetListPrice: listPrice, websitePrice: fields.publicPrice });
    }
    const set = {};
    const filter = { _id: svc._id };
    const from = {};
    for (const [k, v] of Object.entries(fields)) {
      const current = svc[k] ?? null;
      if (current === v) continue;
      set[k] = v;
      from[k] = current;
      filter[k] = guard(k, svc[k]);
    }
    if (!svc.bookingMode || svc.bookingMode === "hidden") {
      set.bookingMode = "request";
      from.bookingMode = svc.bookingMode ?? null;
      filter.bookingMode = { $in: [null, "hidden"] };
    }
    if (Object.keys(set).length) {
      changes.push({ filter, update: { $set: set }, summary: { name: svc.name, set: Object.keys(set), from, to: set } });
    }
  }

  const hidden = [];
  for (const s of services) {
    if (s.showOnWebsite !== true || listed.has(String(s._id))) continue;
    hidden.push(s.name);
    changes.push({
      filter: { _id: s._id, showOnWebsite: true },
      update: { $set: { showOnWebsite: false } },
      summary: { name: s.name, set: ["showOnWebsite"], to: { showOnWebsite: false } },
    });
  }

  return {
    changes,
    problems,
    listPriceDiffers,
    hidden,
    created,
    summary: {
      rows: rows.length,
      onWebsite: rows.length - problems.length,
      created: created.length,
      updated: changes.length - created.length - hidden.length,
      hidden: hidden.length,
      listPriceDiffers: listPriceDiffers.length,
      problems: problems.length,
    },
  };
}

module.exports = { desiredFromRow, planWebsiteMenu };
