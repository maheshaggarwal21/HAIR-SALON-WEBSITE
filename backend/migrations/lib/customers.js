/**
 * @file migrations/lib/customers.js
 * @description Pure rules for M1 (T1.3): turn Visit rows into one Customer per
 * phone. No I/O, unit-tested in test/customers-backfill.test.js.
 *
 * Visits store `contact` as typed at the desk, so the same person can appear as
 * "9876543210", "+91 98765 43210" or "09876543210". Grouping is on the
 * NORMALISED number; anything that isn't a valid Indian mobile after cleanup is
 * counted and skipped rather than guessed at.
 */

const { normalisePhone } = require("../../models/Customer");

/** "9876543210" → "98•••••210" — reports never carry full numbers. */
function maskPhone(phone) {
  return `${phone.slice(0, 2)}•••••${phone.slice(-3)}`;
}

/**
 * @param {Array<{contact, name, gender, date}>} visits  any order
 * @returns {{ customers: Array<{phone, name, gender, firstVisitAt, lastVisitAt, visits}>, invalid: number }}
 */
function groupVisitsByPhone(visits) {
  const byPhone = new Map();
  let invalid = 0;

  for (const v of visits) {
    const phone = normalisePhone(v.contact);
    if (!phone) {
      invalid += 1;
      continue;
    }
    const at = v.date ? new Date(v.date) : null;
    const c = byPhone.get(phone) || {
      phone,
      name: null,
      gender: null,
      firstVisitAt: null,
      lastVisitAt: null,
      visits: 0,
      _latest: -Infinity,
    };
    c.visits += 1;
    if (at && (!c.firstVisitAt || at < c.firstVisitAt)) c.firstVisitAt = at;
    if (at && (!c.lastVisitAt || at > c.lastVisitAt)) c.lastVisitAt = at;
    // Latest visit wins for name and gender ("latest known", CF §20).
    const t = at ? at.getTime() : -Infinity;
    if (t >= c._latest) {
      c._latest = t;
      if (v.name && String(v.name).trim()) c.name = String(v.name).trim().slice(0, 80);
      if (v.gender) c.gender = v.gender;
    }
    byPhone.set(phone, c);
  }

  const customers = [...byPhone.values()].map(({ _latest, ...c }) => c);
  return { customers, invalid };
}

module.exports = { groupVisitsByPhone, maskPhone };
