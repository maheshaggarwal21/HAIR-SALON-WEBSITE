/**
 * @file UnreconciledPayments.tsx
 * @description Alert panel for money Razorpay took that has no visit against it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * On 7 Aug a customer paid ₹150 by UPI and Razorpay captured it, while the
 * Checkout window claimed "Payment could not be completed — Too many requests"
 * and offered a fresh QR. The visit was never created, and nobody in the salon
 * had any way of knowing: the gap only surfaced weeks later when someone
 * reconciled Razorpay against the database by hand.
 *
 * The order-status poller in the visit form should stop that happening at all.
 * This panel is what covers the cases it cannot — a browser closed mid-payment,
 * a laptop that lost power — by putting the gap in front of the people who can
 * still remember what the customer had done, on the day it happens.
 *
 * It renders nothing when everything reconciles, which is the normal state.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw, FilePlus2 } from "lucide-react";
import { usePermission } from "@/hooks/usePermission";

const API = import.meta.env.VITE_BACKEND_URL || "";

interface UnreconciledPayment {
  razorpayPaymentId: string;
  razorpayOrderId: string | null;
  amount: number;
  method: string | null;
  contact: string | null;
  customerName: string | null;
  capturedAt: string;
}

interface UnreconciledResponse {
  count: number;
  totalAmount: number;
  healed: number;
  payments: UnreconciledPayment[];
}

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

export default function UnreconciledPayments({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<UnreconciledResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // Recording a recovery creates a visit, so it needs the same permission as
  // any other visit entry. Without it the list is still worth showing — knowing
  // money is missing matters even if you cannot be the one to fix it.
  const canRecordVisit = usePermission("visit.create");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/payments/unreconciled?days=${days}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("failed");
      setData(await res.json());
    } catch {
      // A panel that cannot load is not itself news. Staying silent keeps a
      // backend hiccup from looking like a payment problem.
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data || data.count === 0) return null;

  return (
    <div className="mb-4 rounded-2xl border border-red-200 bg-red-50/70 shadow-sm overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-red-200/70">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-red-900">
              {data.count} payment{data.count === 1 ? "" : "s"} collected with no visit recorded
              {" — ₹"}
              {data.totalAmount.toLocaleString("en-IN")}
            </h3>
            <p className="text-xs text-red-700/90 mt-0.5">
              Razorpay has this money. Use <strong>Record visit</strong> to fill in the
              services and artist — the customer is not charged again, and the row
              clears from this list once saved.
            </p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 self-start sm:self-auto shrink-0 text-xs font-medium text-red-800 bg-white border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-100 disabled:opacity-40 transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Re-check
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-red-800/70">
              <th className="px-5 py-2 font-medium">Paid at</th>
              <th className="px-5 py-2 font-medium">Customer</th>
              <th className="px-5 py-2 font-medium">Phone</th>
              <th className="px-5 py-2 font-medium text-right">Amount</th>
              <th className="px-5 py-2 font-medium">Razorpay reference</th>
              <th className="px-5 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {data.payments.map((p) => (
              <tr key={p.razorpayPaymentId} className="border-t border-red-200/60">
                <td className="px-5 py-2.5 text-stone-700 whitespace-nowrap">
                  {fmtDateTime(p.capturedAt)}
                </td>
                <td className="px-5 py-2.5 text-stone-900 font-medium whitespace-nowrap">
                  {p.customerName || "—"}
                </td>
                <td className="px-5 py-2.5 text-stone-700 whitespace-nowrap">
                  {p.contact || "—"}
                </td>
                <td className="px-5 py-2.5 text-stone-900 font-semibold text-right whitespace-nowrap">
                  ₹{p.amount.toLocaleString("en-IN")}
                </td>
                <td className="px-5 py-2.5 text-stone-500 font-mono text-[11px] whitespace-nowrap">
                  {p.razorpayPaymentId}
                </td>
                <td className="px-5 py-2.5">
                  {canRecordVisit && (
                    <Link
                      to={`/visit-entry?recover=${encodeURIComponent(p.razorpayPaymentId)}`}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      <FilePlus2 className="w-3.5 h-3.5" /> Record visit
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
