/**
 * @file migrations/m6-import-catalogue.js
 * @description M6 (T0.3) — import the owner's signed-off public catalogue.
 *
 *   npm run migrate:m6                       # dry run (default)
 *   npm run migrate:m6 -- --apply
 *   npm run migrate:m6 -- --file=path.csv    # another sheet (default below)
 *
 * Reads docs/customer-platform/data/services-public.csv — the draft from
 * `npm run export:catalogue` after the owner has filled the owner_* columns and
 * saved it under that name. Rules and guarantees: migrations/lib/catalogueImport.js.
 *
 * Supersedes M3 + M4 for website fields: it sets publicPrice, displayCategory,
 * audience, publicName, slug and variants in one reviewed pass, and switches
 * the chosen services on (`showOnWebsite`, `bookingMode: "request"`). Durations
 * stay with M2. Only empty fields are filled; the report lists every conflict
 * and every row it refused, so nothing is silently skipped.
 */

const fs = require("fs");
const path = require("path");
const Service = require("../models/Service");
const { parseCsv, planCatalogueImport } = require("./lib/catalogueImport");
const { main } = require("./lib/runner");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "docs", "customer-platform", "data", "services-public.csv");

function sheetPath(argv = process.argv.slice(2)) {
  const arg = argv.find((a) => a.startsWith("--file="));
  return arg ? path.resolve(arg.slice("--file=".length)) : DEFAULT_FILE;
}

const M6 = {
  id: "M6",
  title: "Import the signed-off public catalogue (fills empty website fields only)",
  plan: async () => {
    const file = sheetPath();
    if (!fs.existsSync(file)) {
      throw new Error(
        `Sheet not found: ${file}\nThe owner's signed-off copy of services-public.draft.csv must be saved as services-public.csv`
      );
    }
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    const services = await Service.find({}).lean();
    const { changes, conflicts, problems, summary } = planCatalogueImport(rows, services);
    console.log(
      `[M6] sheet ${path.basename(file)}: ${summary.rows} rows, ${summary.shownOnWebsite} on the website, ` +
        `${summary.conflicts} conflict(s), ${summary.problems} problem row(s)`
    );
    return { model: Service, changes, report: { sheet: file, summary, conflicts, problems } };
  },
};

if (require.main === module) main(M6);
module.exports = M6;
