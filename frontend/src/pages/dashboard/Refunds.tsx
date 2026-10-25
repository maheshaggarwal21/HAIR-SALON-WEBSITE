/**
 * @file Refunds.tsx
 * @description Money owed back to online customers (CF §5.2, T2.17, E24).
 *
 * Refunds are QUEUED by the booking engine — salon cancellations and declines
 * (everything back), customer cancellations and no-shows (fee kept), and
 * payments that arrived after their slot was taken (E4).
 *
 * Salon-side ones are sent AUTOMATICALLY (D45): they only show here if Razorpay
 * refused (a few retries first). Customer cancellations and no-shows always wait
 * for the owner, who presses Send, which calls Razorpay once (a double tap is
 * refused by the server) — or changes the amount first. A failed send stays
 * here with Razorpay's reason, so no refund is ever silently lost.
 *
 * "Change" lets the owner waive the fee (refund everything) or record that
 * nothing goes back, with a reason. Needs bookings.refund (owner by default).
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, RotateCcw, Send } from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";
const IST = "Asia/Kolkata";

interface RefundRow {
  _id: string;
  ref: string;
  name: string;
  contact: string;
  startAt: string | null;
  paid: number;
  paymentId: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  status: string;
  refund: { amount: number; status: string; reason: string | null; error: string | null; requestedAt: string | null; processedAt: string | null; razorpayRefundId: string | null; attempts: number };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/bookings${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || "Request failed");
  return d as T;
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST }) : "—";
const REASONS: Record<string, string> = {
  paid_after_hold_expired: "Paid after the slot was taken",
  system_payment_mismatch: "Paid a different amount than the booking needed",
  salon_cancelled: "Salon cancelled",
  salon_declined: "Request declined",
  system_expired: "Request not answered in time",
  salon_expired: "Request not answered in time",
  customer_cancelled: "Customer cancelled (fee kept)",
  customer_no_show: "No-show (fee kept)",
};

export default function Refunds() {
  const [data, setData] = useState<{ open: RefundRow[]; recent: RefundRow[]; autoRefundSalonSide: boolean } | null>(null);
  const [error, setError] = useState("");
  const [savingSwitch, setSavingSwitch] = useState(false);

  async function setAuto(on: boolean) {
    setSavingSwitch(true);
    setError("");
    try {
      await api("/refund-settings", { method: "PUT", body: JSON.stringify({ autoRefundSalonSide: on }) });
      setData((d) => (d ? { ...d, autoRefundSalonSide: on } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSavingSwitch(false);
    }
  }

  const load = () =>
    api<{ open: RefundRow[]; recent: RefundRow[]; autoRefundSalonSide: boolean }>("/refunds")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  if (!data) return <div className="flex justify-center py-16">{error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="w-6 h-6 animate-spin text-stone-400" />}</div>;

  const owed = data.open.reduce((s, r) => s + r.refund.amount, 0);

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <RotateCcw className="w-6 h-6" /> Refunds
        </h2>
        <p className="text-sm text-stone-500 mt-1">{data.open.length ? `${data.open.length} to send · ${rupees(owed)} owed to customers` : "Nothing waiting. Refunds we cause are sent automatically; customer cancellations appear here for your review."}</p>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white p-4 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 accent-stone-900"
          checked={data.autoRefundSalonSide}
          disabled={savingSwitch}
          onChange={(e) => setAuto(e.target.checked)}
        />
        <span>
          <span className="font-medium text-stone-900">Send refunds automatically when the salon cancels</span>
          <span className="block text-stone-500 mt-0.5">
            When we cancel or decline a booking, or a request isn't answered in time, the full refund goes out at once. If it fails, it comes back here to try again.
            Customer cancellations and no-shows always wait here for you. Turn this off to review every refund first.
          </span>
        </span>
      </label>

      <div className="space-y-3">
        {data.open.map((r) => (
          <OpenRefund key={r._id} row={r} onChanged={load} />
        ))}
      </div>

      <FeesKept />

      {data.recent.length > 0 && (
        <section>
          <h3 className="font-semibold text-stone-900 mb-2">Sent recently</h3>
          <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white">
            {data.recent.map((r) => (
              <li key={r._id} className="flex flex-wrap gap-x-4 px-4 py-2 text-sm">
                <span className="font-medium w-28">{r.ref}</span>
                <span className="flex-1">{r.name}</span>
                <span>{rupees(r.refund.amount)}</span>
                <span className="text-stone-500">{when(r.refund.processedAt)}</span>
                <span className="text-stone-400 text-xs">{r.refund.razorpayRefundId}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </motion.div>
  );
}

function OpenRefund({ row, onChanged }: { row: RefundRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(row.refund.amount));
  const [reason, setReason] = useState("");

  async function send() {
    setBusy(true);
    setMsg("");
    try {
      await api(`/${row._id}/refund/send`, { method: "POST" });
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function adjust() {
    setBusy(true);
    setMsg("");
    try {
      await api(`/${row._id}/refund/adjust`, { method: "POST", body: JSON.stringify({ amount: Number(amount), reason }) });
      setEditing(false);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-white p-4 space-y-2 ${row.refund.status === "failed" ? "border-red-300" : "border-stone-200"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-stone-900">
            {row.name} · {row.ref}
          </p>
          <p className="text-xs text-stone-500">
            {REASONS[row.refund.reason || ""] || row.refund.reason || "Refund"} · paid {rupees(row.paid)} · booking {when(row.startAt)} · {row.contact}
          </p>
        </div>
        <span className="text-lg font-semibold text-stone-900">{rupees(row.refund.amount)}</span>
        <button
          type="button"
          disabled={busy || row.refund.status === "processing"}
          onClick={send}
          className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-stone-900 text-white text-sm font-medium hover:bg-stone-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {row.refund.status === "failed" ? "Try again" : row.refund.status === "processing" ? "Sending…" : "Send refund"}
        </button>
        <button type="button" onClick={() => setEditing(!editing)} className="text-sm text-stone-600 underline underline-offset-2">
          Change
        </button>
      </div>
      {row.refund.status === "failed" && (
        <p className="text-sm text-red-700">
          Razorpay refused ({row.refund.attempts} {row.refund.attempts === 1 ? "try" : "tries"}): {row.refund.error}
          {/balance|insufficient|fund/i.test(row.refund.error || "") && <span className="block font-medium">Your Razorpay balance looks too low. Add funds in the Razorpay dashboard, then press Try again.</span>}
        </p>
      )}
      {!row.paymentId && <p className="text-xs text-amber-700">No Razorpay payment on this booking — refund by hand, then set the amount to ₹0 with a note.</p>}
      {editing && (
        <div className="flex flex-wrap items-end gap-2 text-sm border-t border-stone-100 pt-2">
          <label className="flex flex-col gap-1">
            <span className="text-stone-600">Refund (₹0–{row.paid})</span>
            <input type="number" min={0} max={row.paid} value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9 w-28 rounded-lg border border-stone-300 px-2" />
          </label>
          <label className="flex flex-col gap-1 flex-1 min-w-[10rem]">
            <span className="text-stone-600">Why</span>
            <input value={reason} maxLength={200} placeholder="Fee waived for a regular…" onChange={(e) => setReason(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2" />
          </label>
          <button type="button" disabled={busy || reason.trim().length < 2} onClick={adjust} className="h-9 px-3 rounded-lg border border-stone-300 hover:bg-stone-50 disabled:opacity-50">
            Save
          </button>
        </div>
      )}
      {msg && <p className="text-sm text-red-600">{msg}</p>}
    </div>
  );
}

// ─── Cancellation fees kept (D51) ────────────────────────────────────────────
interface FeeRow {
  _id: string;
  ref: string;
  name: string;
  kind: "cancelled" | "no_show";
  startAt: string | null;
  keptAt: string;
  paid: number;
  kept: number;
}

/**
 * Money we KEPT from customers who cancelled late or didn't come. No Visit
 * records it, so Analytics can't see it: this list is where it is counted, per
 * month, to hand to the accountant alongside Razorpay's settlements.
 */
function FeesKept() {
  const [month, setMonth] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date()).slice(0, 7));
  const [fees, setFees] = useState<{ total: number; count: number; rows: FeeRow[] } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    api<{ total: number; count: number; rows: FeeRow[] }>(`/fees?month=${month}`)
      .then((d) => live && (setFees(d), setErr("")))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [month]);

  const shift = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="font-semibold text-stone-900 mr-auto">Cancellation fees kept</h3>
        <button type="button" onClick={() => shift(-1)} className="h-8 px-2 rounded-lg border border-stone-300 text-sm" aria-label="Previous month">‹</button>
        <span className="text-sm w-32 text-center">{label}</span>
        <button type="button" onClick={() => shift(1)} className="h-8 px-2 rounded-lg border border-stone-300 text-sm" aria-label="Next month">›</button>
      </div>
      <p className="text-xs text-stone-500 mb-2">Late cancellations and no-shows. This money has no visit, so it isn't in Analytics — count it from here.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {fees && (
        <>
          <p className="text-sm mb-2">
            <span className="font-semibold">{rupees(fees.total)}</span> kept from {fees.count} booking{fees.count === 1 ? "" : "s"}
          </p>
          {fees.rows.length > 0 && (
            <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white">
              {fees.rows.map((r) => (
                <li key={r._id} className="flex flex-wrap gap-x-4 px-4 py-2 text-sm">
                  <span className="font-medium w-28">{r.ref}</span>
                  <span className="flex-1">{r.name}</span>
                  <span className="text-stone-500">{r.kind === "no_show" ? "No-show" : "Late cancel"}</span>
                  <span>{rupees(r.kept)}</span>
                  <span className="text-stone-500">{when(r.keptAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
