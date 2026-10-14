/**
 * @file migrations/m1-customers.js
 * @description M1 (T1.3) — backfill one `Customer` per distinct Visit contact.
 *
 *   npm run migrate:m1              # dry run (default)
 *   npm run migrate:m1 -- --apply
 *
 * Rule (CF §20): group by contact (normalised to 10 digits); latest name and
 * gender; first and last visit; visit count; `createdFrom: "backfill"`.
 *
 * Insert-only. Each change is an upsert that uses $setOnInsert alone, so a
 * customer who already exists — created by a website request, or by an earlier
 * run of this script — is never modified. Re-running is a no-op.
 *
 * Privacy: the JSON report lists masked numbers and visit counts only; no
 * names, no full phone numbers (the reports folder is for catalogue-style data).
 * Marketing consent is NOT backfilled: nobody opted in through a visit, so every
 * backfilled customer starts with whatsappOptIn false.
 */

const Customer = require("../models/Customer");
const Visit = require("../models/Visit");
const { groupVisitsByPhone, maskPhone } = require("./lib/customers");
const { main } = require("./lib/runner");

const M1 = {
  id: "M1",
  title: "Backfill Customer from Visit contacts (insert-only)",
  plan: async () => {
    const [visits, existing] = await Promise.all([
      Visit.find({}, { contact: 1, name: 1, gender: 1, date: 1 }).lean(),
      Customer.find({}, { phone: 1 }).lean(),
    ]);
    const have = new Set(existing.map((c) => c.phone));
    const { customers, invalid } = groupVisitsByPhone(visits);

    const changes = customers
      .filter((c) => !have.has(c.phone))
      .map((c) => ({
        filter: { phone: c.phone },
        update: {
          $setOnInsert: {
            phone: c.phone,
            name: c.name,
            gender: c.gender,
            stats: {
              visits: c.visits,
              firstVisitAt: c.firstVisitAt,
              lastVisitAt: c.lastVisitAt,
              noShows: 0,
              lateCancels: 0,
            },
            marketing: { whatsappOptIn: false, at: null, source: null },
            createdFrom: "backfill",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        upsert: true,
        summary: { phone: maskPhone(c.phone), visits: c.visits },
      }));

    return {
      model: Customer,
      changes,
      report: {
        visitsRead: visits.length,
        distinctPhones: customers.length,
        alreadyCustomers: customers.length - changes.length,
        skippedInvalidContacts: invalid,
      },
    };
  },
};

// Runnable as a script; importable by the tests, which run M1.plan in memory.
if (require.main === module) main(M1);
module.exports = M1;
