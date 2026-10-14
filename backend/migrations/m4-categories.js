/**
 * @file migrations/m4-categories.js
 * @description M4 (T0.4) — normalise `category` and seed `displayCategory`.
 *
 *   npm run migrate:m4              # dry run (default)
 *   npm run migrate:m4 -- --apply
 *
 * Two separate changes per service, each with its own guard:
 *
 *   1. `category` trimmed + title-cased. Today this only merges the two rows
 *      filed under "hair" into "Hair", which also tidies the staff app's
 *      category list. Guarded on the old value, so a rename made in the staff
 *      app between planning and applying is left alone.
 *   2. `displayCategory` from the name-based rules in lib/catalogue.js. Only
 *      filled when empty; services no rule can place stay null and are listed
 *      for the owner instead of being guessed.
 *
 * Outliers the doc calls out ("Side Locks (Thread)" at ₹4,000, "Any item") are
 * reported as flags. This migration does not change prices or visibility.
 */

const Service = require("../models/Service");
const {
  normaliseCategory,
  proposeDisplayCategory,
  flagServices,
} = require("./lib/catalogue");
const { main } = require("./lib/runner");

main({
  id: "M4",
  title: "Normalise category; seed displayCategory",
  plan: async () => {
    const services = await Service.find({}).sort({ category: 1, name: 1 }).lean();
    const flags = flagServices(services);
    const changes = [];
    const unmapped = [];

    services.forEach((s) => {
      const category = normaliseCategory(s.category);
      if (category !== s.category) {
        changes.push({
          filter: { _id: s._id, category: s.category },
          update: { $set: { category } },
          summary: { name: s.name, field: "category", from: s.category, to: category },
        });
      }

      if (s.displayCategory == null) {
        const displayCategory = proposeDisplayCategory(s.name, s.category);
        if (displayCategory) {
          changes.push({
            filter: { _id: s._id, displayCategory: null },
            update: { $set: { displayCategory } },
            summary: { name: s.name, field: "displayCategory", from: null, to: displayCategory },
          });
        } else {
          unmapped.push({ name: s.name, category: s.category, price: s.price });
        }
      }
    });

    const byDisplay = {};
    for (const c of changes.filter((c) => c.summary.field === "displayCategory")) {
      byDisplay[c.summary.to] = (byDisplay[c.summary.to] || 0) + 1;
    }

    return {
      model: Service,
      changes,
      report: {
        totalServices: services.length,
        displayCategoryCounts: byDisplay,
        unmapped,
        flagged: services
          .map((s, i) => ({ name: s.name, price: s.price, flags: flags[i] }))
          .filter((r) => r.flags.length),
      },
    };
  },
});
