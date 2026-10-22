/**
 * @file paymentSum.ts
 * @description The sum check for the visit form (D60, A6).
 *
 * A visit's cash + card + UPI parts must add up to what the customer owes, to the
 * rupee (CLAUDE.md "Money"). The server derives the parts itself and rounds them
 * to whole rupees, so a desk that types ₹100.50 cash would see one figure on the
 * screen, charge one amount on Razorpay, and have the Visit record another. This
 * runs before anything is charged and refuses that case.
 *
 * Pure on purpose: no React, so the same rule can be reused by the tablet flow.
 */

import type { PaymentMode } from "@/types/visit";

export interface PaymentParts {
  cash: number;
  card: number;
  /** The UPI / online portion. */
  upi: number;
}

/** How a payable amount is divided between the methods for a payment mode. */
export function splitParts(mode: PaymentMode, payable: number, cash: number): PaymentParts {
  if (mode === "cash") return { cash: payable, card: 0, upi: 0 };
  if (mode === "card") return { cash: 0, card: payable, upi: 0 };
  if (mode === "partial") return { cash, card: 0, upi: payable - cash };
  return { cash: 0, card: 0, upi: payable };
}

/**
 * @returns an error message for the desk, or null when the parts add up.
 *          `field` says which input to point at.
 */
export function checkPaymentSum(
  mode: PaymentMode,
  payable: number,
  cash: number
): { field: "cashAmount" | "amount"; message: string } | null {
  if (mode === "partial" && !Number.isInteger(cash)) {
    return { field: "cashAmount", message: "Enter the cash in whole rupees (no paise)." };
  }
  const p = splitParts(mode, payable, cash);
  if (Math.abs(p.cash + p.card + p.upi - payable) > 0.004) {
    return { field: "amount", message: "Cash, card and UPI must add up to the total. Check the amounts." };
  }
  if (p.cash < 0 || p.card < 0 || p.upi < 0) {
    return { field: "cashAmount", message: "Cash can't be more than the total." };
  }
  return null;
}
