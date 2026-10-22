/**
 * @file quote.js
 * @description Server-side price, payment options and cancellation terms for
 * a booking (CF §5.2, D18). The browser never sends a price; it sends service
 * ids and a payment choice, and this computes everything else.
 *
 * D18 (owner, 14 Oct 2026) — every online booking is paid online, in full or as
 * a deposit with the rest at the salon; salon-side cancellations, declines and
 * expiries refund everything — as changed by D47 (owner, 15 Oct 2026):
 *   - the fee is a PERCENTAGE of the bill (30%, rounded to ₹10, at least ₹100,
 *     never more than the bill), and the deposit IS that fee, paid up front;
 *   - cancelling or moving is free until `cancellationCutoffHours` (24h) before
 *     the start — the same for every service and every group size;
 *   - later than that, or not coming, keeps the fee and refunds the rest.
 */

const { rupees } = require("./money");

/** The notice a booking needs for a free cancel or move: one window for every service (D47, D49). */
function noticeHoursFor(_booking, settings) {
  return settings.cancellationCutoffHours ?? 24;
}

/** The cancellation fee — and so the deposit — for a bill of `total` rupees (D47). */
function feeFor(total, settings) {
  const pct = settings.cancellationFeePercent ?? 30;
  const step = settings.cancellationFeeRoundTo ?? 10;
  const floor = settings.cancellationFeeMin ?? 100;
  const rounded = step > 0 ? Math.round((total * pct) / 100 / step) * step : Math.round((total * pct) / 100);
  return Math.min(total, Math.max(floor, rounded));
}

/**
 * @param {object}  opts
 * @param {{key, serviceIds}[]} opts.guests
 * @param {Map}     opts.services      id → lean Service
 * @param {object}  opts.settings      SiteSettings (plain)
 * @param {object}  [opts.pkg]         live package {slug, name, price, items:[{id, price}]}
 */
function buildQuote({ guests, services, settings, pkg = null }) {
  const pkgIds = new Set(pkg ? pkg.items.map((i) => String(i.id)) : []);
  const lines = [];
  for (const g of guests) {
    for (const id of g.serviceIds) {
      const s = services.get(String(id));
      lines.push({
        guestKey: g.key,
        serviceId: String(s._id),
        name: s.publicName || s.name,
        price: s.publicPrice,
        // Only while an offer runs (D59): the normal price, which the page shows crossed out.
        regularPrice: s.regularPrice ?? null,
        durationMinutes: s.durationConfirmed ? s.durationMinutes : null,
        inPackage: g.key === guests[0].key && pkgIds.has(String(s._id)),
      });
    }
  }
  const subtotal = lines.reduce((sum, l) => sum + l.price, 0);
  const pkgItemsTotal = lines.filter((l) => l.inPackage).reduce((sum, l) => sum + l.price, 0);
  const discount = pkg ? Math.max(0, pkgItemsTotal - pkg.price) : 0;
  const total = subtotal - discount;

  const fee = feeFor(total, settings);
  const perService = Math.max(0, ...[...services.values()].map((s) => s.depositAmount || 0));
  const depositAmount = Math.min(total, Math.max(fee, perService));
  const noticeHours = noticeHoursFor(null, settings);

  // Full payment first: it is the default, the deposit is the smaller commitment.
  const options = [{ kind: "full", amount: total, label: `Pay ${rupees(total)} now` }];
  if (depositAmount > 0 && depositAmount < total) {
    options.push({
      kind: "deposit",
      amount: depositAmount,
      label: `Pay ${rupees(depositAmount)} now, ${rupees(total - depositAmount)} at the salon`,
    });
  }

  return {
    lines,
    subtotal,
    discount,
    total,
    packageSlug: pkg?.slug ?? null,
    payment: {
      options,
      cancellationFee: fee,
      noticeHours,
      note: cancellationNote({ fee, percent: settings.cancellationFeePercent ?? 30, noticeHours }),
    },
  };
}

/** The one line shown under the Pay button (D47). */
function cancellationNote({ fee, percent, noticeHours }) {
  return `Free to cancel or move until ${noticeHours} hours before. After that, or if you don't come, ${percent}% (${rupees(fee)}) is kept as a cancellation fee and the rest is refunded.`;
}

/**
 * What goes back when an appointment is cancelled (§5.2, D47).
 * @param {object} appt            Appointment (lean or doc)
 * @param {"customer"|"salon"|"system"} by
 * @param {object} settings
 * @param {Date}   [now]
 * @returns {{ refund: number, kept: number }}
 */
function refundFor(appt, by, settings, now = new Date()) {
  const paid = appt.deposit?.status === "paid" ? appt.deposit.amount || 0 : 0;
  if (!paid) return { refund: 0, kept: 0 };
  if (by !== "customer") return { refund: paid, kept: 0 };
  // We changed the artist they chose: leaving is on us, not them (D51).
  if (appt.artistChangedBySalon) return { refund: paid, kept: 0 };
  const notice = noticeHoursFor(appt, settings);
  if (appt.startAt && new Date(appt.startAt).getTime() - now.getTime() >= notice * 3600e3) {
    return { refund: paid, kept: 0 };
  }
  const kept = Math.min(paid, feeFor(appt.pricing?.total ?? paid, settings));
  return { refund: paid - kept, kept };
}

module.exports = { buildQuote, refundFor, cancellationNote, feeFor, noticeHoursFor };
