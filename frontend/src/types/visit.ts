/**
 * @file visit.ts
 * @description TypeScript type definitions for the visit entry flow.
 *
 * Includes Razorpay SDK window augmentation, API response shapes,
 * and form-state interfaces used by useVisitForm.
 */
// ─── Razorpay SDK types ───────────────────────────────────────────────────────

export interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  image?: string;
  order_id: string;
  handler: (response: RazorpayResponse) => void;
  prefill: { name: string; contact: string };
  readonly?: { contact?: boolean; name?: boolean };
  theme: { color: string };
  modal: { ondismiss: () => void };
}

export interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => { open: () => void };
  }
}

// ─── API / dropdown types ─────────────────────────────────────────────────────

export interface DropdownItem {
  id: string;
  name: string;
}

/** Service item returned by the backend — includes a price. */
export interface ServiceItem {
  id: string;
  name: string;
  price: number;
}

export interface ApiFormData {
  artists: DropdownItem[];
  serviceTypes: DropdownItem[];
  services: ServiceItem[];
}

// ─── Payment mode ──────────────────────────────────────────────────────────
export type PaymentMode = "online" | "cash" | "partial";

// ─── Form state types ─────────────────────────────────────────────────────────

export interface VisitFormData {
  name: string;
  phone: string;
  amount: string;
  age: string;
  gender: string;
  startTime: string;
  endTime: string;
  artist: string;
  serviceType: string[];
  searchService: string[];
  discount: string;
  date: string;
  paymentMode: PaymentMode;
  cashAmount: string;
}

export interface VisitFormErrors {
  name?: string;
  phone?: string;
  amount?: string;
  age?: string;
  gender?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  artist?: string;
  serviceType?: string;
  cashAmount?: string;
}
