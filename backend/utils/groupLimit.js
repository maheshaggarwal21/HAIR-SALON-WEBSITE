/**
 * @file groupLimit.js
 * @description What the customer is told when a booking has more people than the salon allows.
 * The limit is SiteSettings.maxGuests, which the owner sets in the staff app (Website → Settings).
 * At 1 groups are switched off, and "up to 1 people" would read oddly, so it says so plainly.
 */

function groupLimitMessage(max) {
  return max <= 1
    ? "Group bookings aren't available right now. Please book one person at a time, or message us on WhatsApp."
    : `Book up to ${max} people at a time.`;
}

module.exports = { groupLimitMessage };
