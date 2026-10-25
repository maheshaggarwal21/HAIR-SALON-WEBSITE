/**
 * @file migrations/m8-payment-id-index.js
 * @description M8 (audit #2, D70) — see migrations/lib/paymentIdIndex.js for what it does and why.
 *
 *   npm run migrate:m8                # dry run (default): read-only, writes a report
 *   npm run migrate:m8 -- --apply     # creates the unique index; refuses while a payment id is on 2+ visits
 */
require("./lib/paymentIdIndex").main();
