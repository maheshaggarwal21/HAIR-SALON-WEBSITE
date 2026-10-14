/**
 * @file quote.js
 * @description Server-side price, payment options and cancellation terms for
 * a booking (CF §5.2, D18). The browser never sends a price; it sends service
 * ids and a payment choice, and this computes everything else.
 *
 * D18 (owner, 14 Oct 2026):
 *   - every online booking is paid online: in full, or a ₹500 deposit with the
 *     rest at the salon (deposit option only when it is less than the total);
 *   - on a customer cancellation or no-show the salon keeps a ₹500 fee
 *     (never more than was paid) and refunds the rest;
 *   - salon-side cancellations, declines and expiries refund everything.
 */

const { rupees } = require("./money");

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
        durationMinutes: s.durationConfirmed ? s.durationMinutes : null,
        inPackage: g.key === guests[0].key && pkgIds.has(String(s._id)),
      });
    }
  }
  const subtotal = lines.reduce((sum, l) => sum + l.price, 0);
  const pkgItemsTotal = lines.filter((l) => l.inPackage).reduce((sum, l) => sum + l.price, 0);
  const discount = pkg ? Math.max(0, pkgItemsTotal - pkg.price) : 0;
  const total = subtotal - discount;

  const perService = Math.max(0, ...[...services.values()].map((s) => s.depositAmount || 0));
  const depositAmount = Math.min(total, Math.max(settings.deposit?.amount ?? 500, perService));
  const fee = settings.cancellationFee ?? 500;

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
      note: cancellationNote(fee, settings.freeCancellationHours),
    },
  };
}

/** The one line shown under the Pay button (D18). */
function cancellationNote(fee, freeHours) {
  const base = `If you cancel or don't come, ${rupees(fee)} is kept as a cancellation fee and the rest is refunded.`;
  return freeHours ? `Free to cancel until ${freeHours} hours before. After that: ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
}

/**
 * What goes back when an appointment is cancelled (§5.2).
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
  const freeHours = settings.freeCancellationHours;
  if (freeHours && appt.startAt && new Date(appt.startAt).getTime() - now.getTime() >= freeHours * 3600e3) {
    return { refund: paid, kept: 0 };
  }
  const kept = Math.min(paid, settings.cancellationFee ?? 500);
  return { refund: paid - kept, kept };
}

module.exports = { buildQuote, refundFor, cancellationNote };
