/**
 * @file DiscountSummary.tsx
 * @description Who gave how much discount — the owner's control in place of a cap (D60).
 *
 * The desk can give any discount, so this page is where the owner sees it
 * afterwards: for each person, how many of their visits were discounted out of
 * all their visits, the rupees given away and the biggest percentage. Anything
 * above the review percent is highlighted in the list below — highlighted, never
 * blocked, so a regular is never kept waiting at the till.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Percent, Save } from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";

interface StaffRow {
  staffName: string;
  totalVisits: number;
  discountedVisits: number;
  edits: number;
  totalAmount: number;
  highestPercent: number;
  aboveThreshold: number;
}
interface Flagged {
  id: string;
  visitId: string;
  kind: "created" | "edited";
  day: string;
  at: string;
  staffName: string;
  percent: number;
  amount: number;
  finalTotal: number;
  paymentMethod: string | null;
  reason: string | null;
}
interface Summary {
  from: string;
  to: string;
  reviewPercent: number;
  staff: StaffRow[];
  totals: { totalVisits: number; discountedVisits: number; totalAmount: number; highestPercent: number };
  flagged: Flagged[];
  flaggedTruncated: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/discounts${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error("The server sent an unexpected reply. Reload the page and try again.");
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Request failed");
  return d as T;
}

/** "YYYY-MM-DD" in the salon's day, n days before today. */
function istDay(minusDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 3600_000 - minusDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const METHOD: Record<string, string> = { cash: "Cash", card: "Card", online: "UPI", partial: "Cash + UPI" };

export default function DiscountSummary() {
  const [from, setFrom] = useState(istDay(6));
  const [to, setTo] = useState(istDay(0));
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [threshold, setThreshold] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<Summary>(`/summary?from=${from}&to=${to}`);
      setData(d);
      setThreshold(String(d.reviewPercent));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the summary");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveThreshold = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ reviewPercent: Number(threshold) }) });
      setSaved(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-stone-900 flex items-center gap-2">
          <Percent className="w-5 h-5" /> Discounts
        </h1>
        <p className="text-sm text-stone-500 mt-1">
          Who gave how much. There is no limit at the desk; anything above the review percent is highlighted here.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal normal-case text-stone-900" />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          To
          <input type="date" value={to} min={from} max={istDay(0)} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal normal-case text-stone-900" />
        </label>
        <div className="ml-auto flex items-end gap-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Highlight above (%)
            <input type="number" min={0} max={100} value={threshold} onChange={(e) => { setThreshold(e.target.value); setSaved(false); }} className="mt-1 block w-28 rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal text-stone-900" />
          </label>
          <button type="button" onClick={saveThreshold} disabled={saving || threshold === "" || Number(threshold) === data?.reviewPercent} className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</p>}
      {loading && !data && <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ["Visits", String(data.totals.totalVisits)],
              ["With a discount", `${data.totals.discountedVisits}`],
              ["Given away", rupees(data.totals.totalAmount)],
              ["Highest", `${data.totals.highestPercent}%`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-stone-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-stone-500">{label}</p>
                <p className="mt-1 text-2xl font-semibold text-stone-900">{value}</p>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-4 py-3">Staff</th>
                  <th className="px-4 py-3 text-right">Discounted / all visits</th>
                  <th className="px-4 py-3 text-right">Given away</th>
                  <th className="px-4 py-3 text-right">Highest</th>
                  <th className="px-4 py-3 text-right">Above {data.reviewPercent}%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.staff.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-400">No visits in this period.</td></tr>
                )}
                {data.staff.map((s) => (
                  <tr key={s.staffName}>
                    <td className="px-4 py-3 font-medium text-stone-900">{s.staffName}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {s.discountedVisits} / {s.totalVisits}
                      {s.totalVisits > 0 && <span className="ml-1 text-stone-400">({Math.round((s.discountedVisits / s.totalVisits) * 100)}%)</span>}
                      {s.edits > 0 && <span className="ml-1 text-xs text-amber-600">+{s.edits} edited</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{rupees(s.totalAmount)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{s.highestPercent}%</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${s.aboveThreshold ? "font-semibold text-amber-700" : "text-stone-400"}`}>{s.aboveThreshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
              <AlertTriangle className="w-4 h-4 text-amber-600" /> Above {data.reviewPercent}% ({data.flagged.length}{data.flaggedTruncated ? "+" : ""})
            </h2>
            {data.flagged.length === 0 ? (
              <p className="mt-2 text-sm text-stone-400">Nothing above the review percent in this period.</p>
            ) : (
              <ul className="mt-2 divide-y divide-stone-100 rounded-xl border border-amber-200 bg-amber-50/40">
                {data.flagged.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 text-sm">
                    <span className="font-semibold text-amber-700 tabular-nums">{f.percent}%</span>
                    <span className="text-stone-900">{f.staffName}</span>
                    <span className="text-stone-500">{rupees(f.amount)} off → {rupees(f.finalTotal)}</span>
                    <span className="text-stone-400">{f.paymentMethod ? METHOD[f.paymentMethod] ?? f.paymentMethod : ""}</span>
                    {f.kind === "edited" && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">edited later</span>}
                    <span className="ml-auto text-xs text-stone-400">{new Date(f.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
                    {f.reason && <span className="basis-full text-stone-600">“{f.reason}”</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
