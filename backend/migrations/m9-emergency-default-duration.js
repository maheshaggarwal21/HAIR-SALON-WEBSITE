/**
 * @file migrations/m9-emergency-default-duration.js
 * @description M9 (emergency) — one-hour estimate for every website service, ordinary ones instant. See migrations/lib/emergencyDuration.js.
 *
 *   npm run migrate:m9                # dry run (default): read-only, writes a report
 *   npm run migrate:m9 -- --apply
 */
const { planEmergencyDuration } = require("./lib/emergencyDuration");
const { main } = require("./lib/runner");

main({
  id: "M9",
  title: "Emergency: standard one-hour estimate for every website service; ordinary services bookable instantly (bridal, colour and chemical stay request-only)",
  plan: planEmergencyDuration,
});
