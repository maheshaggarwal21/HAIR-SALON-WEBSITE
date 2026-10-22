/**
 * @file CashClose.tsx
 * @description Close the day: count the drawer, then see how it compares (D60, part C).
 *
 * The count is BLIND. This screen never shows what the till should hold until the count has
 * been submitted; the server computes it at that moment. A closed day cannot be changed
 * here — only the owner can add an adjustment (a signed amount and a reason) that sits beside
 * the original figures.
 */

import { useCallback, useEffect, useState } from "react";
import { Banknote, CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import {
  addAdjustment,
  closeDay,
  fetchDay,
  fetchHistory,
  type CashCloseRecord,
  type DayState,
} from "@/services/cashClose";
import { useAuth } from "@/context/AuthContext";

const rupees = (n: number) => `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
const signed = (n: number) => (n === 0 ? "₹0" : `${n > 0 ? "+" : "−"}₹${Math.abs(n).toLocaleString("en-IN")}`);

/** "YYYY-MM-DD" for today in Patiala. */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
const prettyDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

function Difference({ value, label = "Difference" }: { value: number; label?: string }) {
  const tone = value === 0 ? "text-emerald-700 bg-emerald-50 border-emerald-200" : "text-amber-800 bg-amber-50 border-amber-200";
  return (
    <div className={`rounded-xl border px-4 py-3 ${tone}`}>
      <p className="text-xs font-semibold uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value === 0 ? "Matches exactly" : value < 0 ? `Short ${rupees(-value)}` : `Over ${rupees(value)}`}</p>
    </div>
  );
}

function Result({ record, isOwner, onChanged }: { record: CashCloseRecord; isOwner: boolean; onChanged: (r: CashCloseRecord) => void }) {
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adjust = async () => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await addAdjustment(record.day, Number(delta), reason));
      setDelta("");
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add");
    } finally {
      setBusy(false);
    }
  };

  const adjusted = record.adjustments.length > 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-emerald-700">
        <CheckCircle2 className="h-5 w-5" />
        <p className="font-semibold">{prettyDay(record.day)} is closed</p>
        <span className="text-sm text-stone-500">by {record.closedBy} · {new Date(record.closedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}</span>
      </div>

      <Difference value={record.difference} />
      {adjusted && <Difference value={record.effectiveDifference} label="After the owner's adjustment" />}

      <div className="rounded-xl border border-stone-200 bg-white">
        <dl className="divide-y divide-stone-100 text-sm">
          {[
            ["Opening float", rupees(record.openingFloat), record.openingFloatSource === "previous_close" ? "from the last close" : "entered"],
            [`Cash sales (${record.cashSalesVisits} visits)`, `+ ${rupees(record.cashSales)}`, "the cash part only; card and UPI are not in the drawer"],
            ...record.cashTakenOut.map((l) => [`Taken out: ${l.reason}`, `− ${rupees(l.amount)}`, ""]),
            ["Expected in the drawer", rupees(record.expectedCash), ""],
            ["You counted", rupees(record.countedCash), ""],
            ["Left in the drawer", rupees(record.leftInDrawer), "tomorrow's opening float"],
            ["To bank", rupees(record.banked), ""],
          ].map(([k, v, hint]) => (
            <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-4 px-4 py-2.5">
              <dt className="text-stone-600">{k}</dt>
              <dd className="font-medium tabular-nums text-stone-900">
                {v} {hint && <span className="ml-2 text-xs font-normal text-stone-400">{hint}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {record.note && <p className="text-sm text-stone-600">Note: {record.note}</p>}

      {adjusted && (
        <ul className="space-y-1 text-sm text-stone-700">
          {record.adjustments.map((a, i) => (
            <li key={i} className="rounded-lg bg-stone-50 px-3 py-2">
              <span className="font-medium tabular-nums">{signed(a.delta)}</span> · {a.reason} <span className="text-stone-400">({a.by})</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-stone-500">A closed day cannot be changed. {isOwner ? "If the count was wrong, add an adjustment below; the original figures stay as they were." : "If something was wrong, ask the owner to add an adjustment."}</p>

      {isOwner && (
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-sm font-semibold text-stone-900">Add an adjustment</p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Rupees (+ or −)
              <input value={delta} inputMode="numeric" onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ""))} className="mt-1 block w-32 rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal text-stone-900" placeholder="e.g. 50" />
            </label>
            <label className="min-w-60 flex-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Why
              <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal text-stone-900" />
            </label>
            <button type="button" onClick={adjust} disabled={busy || !Number(delta) || !reason.trim()} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              {busy ? "Adding…" : "Add adjustment"}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </div>
      )}
    </div>
  );
}

function CloseForm({ day, suggested, from, onClosed }: { day: string; suggested: number; from: string | null; onClosed: (r: CashCloseRecord) => void }) {
  const [counted, setCounted] = useState("");
  const [opening, setOpening] = useState(String(suggested));
  const [left, setLeft] = useState(String(suggested));
  const [lines, setLines] = useState<{ reason: string; amount: string }[]>([]);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const ready = Number.isInteger(num(counted)) && Number.isInteger(num(left)) && Number.isInteger(num(opening)) && lines.every((l) => l.reason.trim() && Number(l.amount) >= 1);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onClosed(
        await closeDay({
          day,
          countedCash: num(counted),
          openingFloat: num(opening),
          leftInDrawer: num(left),
          cashTakenOut: lines.map((l) => ({ reason: l.reason.trim(), amount: Number(l.amount) })),
          note: note.trim() || undefined,
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not close the day");
      setConfirming(false);
      setBusy(false);
    }
  };

  const field = "mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2 text-stone-900";
  const label = "text-xs font-semibold uppercase tracking-wide text-stone-500";
  const digits = (v: string) => v.replace(/\D/g, "");

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Count the cash in the drawer first and type it in. The app shows what it should be <b>after</b> you close the day.
      </div>

      <label className={`${label} block`}>
        Cash counted in the drawer (₹)
        <input value={counted} inputMode="numeric" onChange={(e) => setCounted(digits(e.target.value))} className={`${field} text-3xl font-semibold tabular-nums`} placeholder="0" autoFocus />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>
          Opening float (₹)
          <input value={opening} inputMode="numeric" onChange={(e) => setOpening(digits(e.target.value))} className={field} />
          <span className="mt-1 block text-[11px] font-normal normal-case text-stone-400">{from ? `Cash left in the drawer at the close on ${prettyDay(from)}` : "Nothing was closed before, so this starts at 0"}</span>
        </label>
        <label className={label}>
          Leave in the drawer for tomorrow (₹)
          <input value={left} inputMode="numeric" onChange={(e) => setLeft(digits(e.target.value))} className={field} />
          <span className="mt-1 block text-[11px] font-normal normal-case text-stone-400">Becomes tomorrow's opening float. The rest is banked.</span>
        </label>
      </div>

      <div>
        <p className={label}>Cash taken out of the drawer today (optional)</p>
        {lines.map((l, i) => (
          <div key={i} className="mt-2 flex gap-2">
            <input value={l.reason} maxLength={120} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} placeholder="Reason, e.g. tea and milk" className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm" />
            <input value={l.amount} inputMode="numeric" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: digits(e.target.value) } : x)))} placeholder="₹" className="w-28 rounded-lg border border-stone-300 px-3 py-2 text-sm" />
            <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove this line" className="px-2 text-stone-400 hover:text-red-700">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        {lines.length < 10 && (
          <button type="button" onClick={() => setLines([...lines, { reason: "", amount: "" }])} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-stone-700 hover:text-stone-900">
            <Plus className="h-4 w-4" /> Add a line
          </button>
        )}
      </div>

      <label className={`${label} block`}>
        Note (optional)
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className={field} />
      </label>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {!confirming ? (
        <button type="button" disabled={!ready} onClick={() => setConfirming(true)} className="w-full rounded-xl bg-stone-900 px-6 py-3 font-semibold text-white disabled:opacity-40 sm:w-auto">
          Close {prettyDay(day)}
        </button>
      ) : (
        <div className="rounded-xl border border-stone-300 bg-white p-4">
          <p className="text-sm text-stone-800">
            Close {prettyDay(day)} with <b>{rupees(num(counted))}</b> counted? <b>It cannot be changed afterwards.</b>
          </p>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={submit} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Yes, close the day
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-stone-600 ring-1 ring-stone-200">
              Go back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CashClose() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [day, setDay] = useState(istToday());
  const [state, setState] = useState<DayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof fetchHistory>>>([]);

  const loadHistory = useCallback(() => fetchHistory(14).then(setHistory).catch(() => undefined), []);

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the previous day while the next one loads
    setState(null);
    setError(null);
    fetchDay(day)
      .then((s) => live && setState(s))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load"));
    return () => {
      live = false;
    };
  }, [day]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const done = (record: CashCloseRecord) => {
    setState({ day: record.day, closed: true, record });
    void loadHistory();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-stone-900">
          <Banknote className="h-5 w-5" /> Close the day
        </h1>
        <p className="mt-1 text-sm text-stone-500">Count the cash drawer at the end of the day and record it.</p>
      </div>

      <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500">
        Day
        <input type="date" value={day} max={istToday()} onChange={(e) => e.target.value && setDay(e.target.value)} className="mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal normal-case text-stone-900" />
      </label>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {!state && !error && <p className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}

      {state?.closed === true && <Result record={state.record} isOwner={isOwner} onChanged={done} />}
      {state?.closed === false && <CloseForm key={day} day={day} suggested={state.suggestedOpeningFloat} from={state.suggestedFrom} onClosed={done} />}

      <div>
        <h2 className="text-sm font-semibold text-stone-900">Last 14 days</h2>
        <ul className="mt-2 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white text-sm">
          {history.map((h) => (
            <li key={h.day}>
              <button type="button" onClick={() => setDay(h.day)} className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-stone-50 ${h.day === day ? "bg-stone-50" : ""}`}>
                <span className="text-stone-800">{prettyDay(h.day)}</span>
                {h.closed ? (
                  <span className={`tabular-nums ${h.record.effectiveDifference === 0 ? "text-emerald-700" : "text-amber-700"}`}>
                    {h.record.effectiveDifference === 0 ? "Matches" : h.record.effectiveDifference < 0 ? `Short ${rupees(-h.record.effectiveDifference)}` : `Over ${rupees(h.record.effectiveDifference)}`}
                  </span>
                ) : (
                  <span className="text-stone-400">{h.day === istToday() ? "Not closed yet" : "Not closed"}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
