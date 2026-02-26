/**
 * @file api.ts
 * @description HTTP client functions for the visit entry form.
 *
 * All calls hit the Express backend defined by VITE_BACKEND_URL.
 * Each function includes response-status checks and throws on failure
 * so the caller can render user-friendly error messages.
 */

import type { ApiFormData } from "@/types/visit";

/** Backend base URL (injected at build time). */
const BASE = import.meta.env.VITE_BACKEND_URL as string;

/** Fetch dropdown options for the visit entry form. */
export async function fetchFormData(): Promise<ApiFormData> {
  const res = await fetch(`${BASE}/api/form-data`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load form data");
  return res.json();
}

export interface CreateOrderPayload {
  name: string;
  phone: string;
  serviceIds: string[];
  discountPercent: number;
  paymentMode?: "online" | "partial";
  cashAmount?: number;
}

export interface CreateOrderResult {
  order_id: string;
  amount: number;
  currency: string;
  key_id: string;
}

/** Create a Razorpay order on the backend. */
export async function createOrder(
  payload: CreateOrderPayload
): Promise<CreateOrderResult> {
  const res = await fetch(`${BASE}/api/create-order`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to create order");
  return data;
}

export interface VerifyOrderPayload {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  name: string;
  phone: string;
  amount: number;
}

export interface VerifyOrderResult {
  success: boolean;
  payment_id: string;
  amount: number;
  name: string;
  phone: string;
}

/** Verify the Razorpay payment signature on the backend. */
export async function verifyOrderPayment(
  payload: VerifyOrderPayload
): Promise<VerifyOrderResult> {
  const res = await fetch(`${BASE}/api/verify-order-payment`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Verification failed");
  return data;
}

// ─── Visit creation ───────────────────────────────────────────────────────────

export interface CreateVisitPayload {
  name: string;
  contact: string;
  age: string;
  gender: string;
  date: string;
  startTime: string;
  endTime: string;
  artist: string;
  serviceType?: string;
  serviceIds: string[];
  discountPercent: number;
  paymentMethod: "online" | "cash" | "partial";
  cashAmount?: number;
  onlineAmount?: number;
  razorpayPaymentId?: string;
}

export interface CreateVisitResult {
  success: boolean;
  visitId: string;
  finalTotal: number;
}

/** Create a Visit document after successful payment. */
export async function createVisit(
  payload: CreateVisitPayload
): Promise<CreateVisitResult> {
  const res = await fetch(`${BASE}/api/visits`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to create visit record");
  return data;
}
