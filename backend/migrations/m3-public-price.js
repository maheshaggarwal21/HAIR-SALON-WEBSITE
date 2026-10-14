/**
 * @file migrations/m3-public-price.js
 * @description M3 (T0.4) — seed `Service.publicPrice = round(price × 0.5)`.
 *
 *   npm run migrate:m3              # dry run (default) — writes a report only
 *   npm run migrate:m3 -- --apply   # writes
 *
 * Desk billing today is list price minus a blanket 50%. The website must show
 * the price a customer actually pays (CLAUDE.md, "Prices shown to customers"),
 * so the starting point is half the list price. The owner then corrects the
 * exceptions in the signed-off sheet (T0.3) — that is why this only fills
 * EMPTY publicPrice values and never overwrites one: running it again after
 * the owner has edited prices must not undo their edits.
 */

const Service = require("../models/Service");
const { proposePublicPrice } = require("./lib/catalogue");
const { main } = require("./lib/runner");

const RATIO = 0.5; // SiteSettings.publicPriceRatio once that model exists (T1.5)

main({
  id: "M3",
  title: `Seed Service.publicPrice = round(price × ${RATIO})`,
  plan: async () => {
    const services = await Service.find({}).sort({ category: 1, name: 1 }).lean();
    const alreadySet = services.filter((s) => s.publicPrice != null);

    const changes = services
      .filter((s) => s.publicPrice == null)
      .map((s) => {
        const publicPrice = proposePublicPrice(s.price, RATIO);
        return {
          filter: { _id: s._id, publicPrice: null },
          update: { $set: { publicPrice } },
          summary: { name: s.name, category: s.category, price: s.price, publicPrice, isActive: s.isActive },
        };
      });

    return {
      model: Service,
      changes,
      report: {
        ratio: RATIO,
        totalServices: services.length,
        skippedAlreadySet: alreadySet.map((s) => ({ name: s.name, publicPrice: s.publicPrice })),
      },
    };
  },
});
