/**
 * @file migrations/m7-website-menu.js
 * @description M7 (CF D53) — make the website menu the owner's signed list.
 *
 *   npm run migrate:m7                       # dry run (default)
 *   npm run migrate:m7 -- --apply
 *   npm run migrate:m7 -- --file=path.csv    # another sheet (default below)
 *
 * Reads docs/customer-platform/data/website-menu.csv: the owner's signed menu
 * of 19 Oct 2026 (91 services in 17 groups), matched to billing services. It
 * puts those 91 on the website with the owner's names, prices, audience and
 * section, creates the 13 the billing app did not have, and takes every other
 * service off the website. Billing prices are not changed. Rules and
 * guarantees: migrations/lib/websiteMenu.js.
 *
 * Supersedes M6 for the website menu (M6's sheet predates the owner's list).
 */

const fs = require("fs");
const path = require("path");
const Service = require("../models/Service");
const { parseCsv } = require("./lib/catalogueImport");
const { planWebsiteMenu } = require("./lib/websiteMenu");
const { main } = require("./lib/runner");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "docs", "customer-platform", "data", "website-menu.csv");

function sheetPath(argv = process.argv.slice(2)) {
  const arg = argv.find((a) => a.startsWith("--file="));
  return arg ? path.resolve(arg.slice("--file=".length)) : DEFAULT_FILE;
}

const M7 = {
  id: "M7",
  title: "Website menu = the owner's signed list (website fields only; billing prices unchanged)",
  plan: async () => {
    const file = sheetPath();
    if (!fs.existsSync(file)) throw new Error(`Sheet not found: ${file}`);
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    const services = await Service.find({}).lean();
    const plan = planWebsiteMenu(rows, services);
    const s = plan.summary;
    console.log(
      `[M7] sheet ${path.basename(file)}: ${s.rows} rows → ${s.onWebsite} on the website ` +
        `(${s.created} new, ${s.updated} updated), ${s.hidden} taken off, ` +
        `${s.listPriceDiffers} billing price(s) differ (left as they are), ${s.problems} problem row(s)`
    );
    for (const p of plan.problems) console.log(`[M7]   problem: ${p.name}: ${p.problem}`);
    return {
      model: Service,
      changes: plan.changes,
      report: { sheet: file, summary: s, created: plan.created, hidden: plan.hidden, listPriceDiffers: plan.listPriceDiffers, problems: plan.problems },
    };
  },
};

if (require.main === module) main(M7);
module.exports = M7;
