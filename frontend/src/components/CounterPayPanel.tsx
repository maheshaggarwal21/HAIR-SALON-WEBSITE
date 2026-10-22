/**
 * @file CounterPayPanel.tsx
 * @description The staff screen's pieces of a counter UPI payment (D60, part A):
 * the tablet chip with its "Use tablet" switch, and the waiting panel.
 *
 * Nothing here decides anything: it shows what the server reported. While a QR is
 * waiting the form above is locked (the server already priced the sale; editing the
 * form now could not change it and would only confuse the desk).
 */

import { useEffect, useState } from "react";
import { Loader2, MonitorSmartphone, QrCode, X } from "lucide-react";
import UpiQr from "@/components/UpiQr";
import type { useCounterPayment } from "@/hooks/useCounterPayment";

type Counter = ReturnType<typeof useCounterPayment>;

export function TabletChip({ counter }: { counter: Counter }) {
  if (!counter.enabled) return null;
  const online = counter.tabletOnline;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
      <span className="flex items-center gap-2 text-stone-700">
        <MonitorSmartphone className="h-4 w-4" />
        Customer tablet
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
            !counter.tabletKnown ? "bg-stone-200 text-stone-500" : online ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${!counter.tabletKnown ? "bg-stone-400" : online ? "bg-emerald-500" : "bg-red-500"}`} />
          {!counter.tabletKnown ? "checking…" : online ? "online" : "offline"}
        </span>
      </span>
      <label className={`flex items-center gap-2 ${online ? "text-stone-700" : "text-stone-400"}`}>
        <input
          type="checkbox"
          checked={online && counter.wantTablet}
          disabled={!online}
          onChange={(e) => counter.setWantTablet(e.target.checked)}
          className="h-4 w-4 accent-stone-900"
        />
        Use tablet
      </label>
      {!online && counter.tabletKnown && <p className="basis-full text-xs text-stone-500">The tablet is off, so the QR will be shown on this screen.</p>}
    </div>
  );
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return <span className="tabular-nums">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>;
}

export function CounterPayPanel({ counter }: { counter: Counter }) {
  const s = counter.session;
  if (!s && !counter.error) return null;

  return (
    <div className="mb-6 rounded-2xl border border-stone-300 bg-white p-5 shadow-sm">
      {s?.status === "pending" && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Waiting for payment</p>
              <p className="text-3xl font-semibold tabular-nums text-stone-900">₹{s.amount.toLocaleString("en-IN")}</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-stone-600">
                <Loader2 className="h-4 w-4 animate-spin" />
                {s.target === "tablet" ? "The customer can scan the QR on the tablet" : "Show this QR to the customer"} · expires in <Countdown until={s.expiresAt} />
              </p>
            </div>
            <div className="flex gap-2">
              {s.target === "tablet" && (
                <button type="button" onClick={counter.showHere} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100">
                  <QrCode className="h-4 w-4" /> Show QR on this screen
                </button>
              )}
              <button type="button" onClick={counter.cancel} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
                <X className="h-4 w-4" /> Cancel
              </button>
            </div>
          </div>
          {s.target === "pc" && s.qr && (
            <div className="mx-auto mt-5 w-full max-w-sm">
              <UpiQr qr={s.qr} className="border border-stone-200" />
              <p className="mt-2 text-center text-sm text-stone-500">Scan with any UPI app</p>
            </div>
          )}
        </>
      )}

      {s?.status === "paid" && (
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-xl text-white">✓</div>
          <div>
            <p className="font-semibold text-stone-900">₹{s.amount.toLocaleString("en-IN")} received</p>
            <p className="flex items-center gap-2 text-sm text-stone-600">
              {counter.saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {counter.error ? "Not saved yet" : "Saving the visit…"}
            </p>
          </div>
        </div>
      )}

      {s && (s.status === "expired" || s.status === "cancelled") && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-stone-700">
            {s.status === "expired" ? "The QR ran out of time and nothing was paid." : "This payment was cancelled."} Press the pay button to start again.
          </p>
          <button type="button" onClick={counter.dismiss} className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100">
            OK
          </button>
        </div>
      )}

      {counter.error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <p>{counter.error}</p>
          <div className="mt-2 flex gap-3">
            {s?.status === "paid" && (
              <button type="button" onClick={counter.retrySave} className="font-medium underline">
                Try saving again
              </button>
            )}
            {!s && (
              <button type="button" onClick={counter.useCheckoutInstead} className="font-medium underline">
                Use Razorpay checkout instead
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
