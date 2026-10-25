/**
 * @file NumberFixes.tsx
 * @description Fix Numbers — the receptionist's daily list of wrong numbers (D54).
 *
 * Five kinds of thing found by the server from yesterday and earlier, plus "Payment log errors" (D70), which
 * lists payment-id check results recorded when a sale was saved, today's included:
 *   - Possible duplicates: the same name under two numbers that differ by a
 *     digit or two. One of them is probably a typo, and the client's history
 *     and payments are split between them.
 *   - Invalid numbers: not a real 10-digit mobile.
 *   - Refunded or failed online payments, so money that went back (or never
 *     arrived) is tied to a person.
 *   - Paid visits whose artists were never assigned.
 *
 * Fixing a number re-files the visits under the right one; amounts and dates
 * never change, and the change is recorded and can be reversed by correcting
 * back. "Different people" and "Done" are remembered, so a list only shrinks.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import CopyId from "@/components/CopyId";
import { usePermission } from "@/hooks/usePermission";
import { historyLink, razorpayPaymentUrl } from "@/lib/paymentLinks";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Copy, Hash, Loader2, PhoneOff, RotateCcw, Search, ShieldAlert, Undo2, UserX, Wallet } from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";

type Kind = "duplicate" | "invalid" | "payment" | "unassigned" | "reference" | "payment_id";
type Status = "open" | "resolved" | "all";

interface Side {
  contact: string;
  name: string;
  visits: number;
  revenue: number;
  lastDate: string;
  recent: number;
}
interface Issue {
  key: string;
  kind: Kind;
  status: "open" | "fixed" | "dismissed";
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  identified: { name: string | null; contact: string | null } | null;
  // duplicate
  confidence?: "high" | "medium";
  nameMatch?: "identical" | "similar";
  diff?: string;
  a?: Side;
  b?: Side;
  likelyWrong?: "a" | "b" | null;
  // invalid / unassigned / payment
  contact?: string | null;
  name?: string | null;
  visits?: number;
  revenue?: number;
  lastDate?: string;
  visitId?: string;
  date?: string;
  amount?: number;
  paymentId?: string;
  refunded?: number;
  what?: string;
  reason?: string | null;
  at?: string;
  visitCounted?: boolean;
  // payment_id (Payment log errors, D70)
  expected?: number | null;
  found?: number | null;
  refused?: boolean;
  replay?: boolean;
  by?: string;
  ref?: string | null;
  visitDay?: string | null;
}
interface Reply {
  issues: Issue[];
  total: number;
  through: string;
  warning: string | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/data-fixes${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error("The server sent an unexpected reply. Reload the page and try again.");
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Request failed");
  return d as T;
}

const KINDS: { id: Kind; label: string; icon: React.ElementType; hint: string }[] = [
  { id: "duplicate", label: "Possible duplicates", icon: Copy, hint: "Same name, numbers one or two digits apart" },
  { id: "invalid", label: "Invalid numbers", icon: PhoneOff, hint: "Not a real 10-digit mobile" },
  { id: "payment", label: "Refunded & failed", icon: Wallet, hint: "Online payments that went back or never completed" },
  { id: "unassigned", label: "Artists not assigned", icon: UserX, hint: "Paid, but the artist step was never finished" },
  { id: "reference", label: "Missing payment reference", icon: Hash, hint: "Paid by QR at the counter, but Razorpay's reference never arrived" },
  { id: "payment_id", label: "Payment log errors", icon: ShieldAlert, hint: "Sales saved today or earlier whose Razorpay payment id did not check out. Read-only: nothing here changes an amount." },
];

const time = (d?: string | null) => (d ? new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");
const day = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");
const rupees = (n?: number) => `₹${Math.round(n ?? 0).toLocaleString("en-IN")}`;

export default function NumberFixes() {
  const [kind, setKind] = useState<Kind>("duplicate");
  const [status, setStatus] = useState<Status>("open");
  const [days, setDays] = useState(30);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // One reply per request signature: while the current signature has no reply
  // yet, the list is loading. Setting state only when the fetch settles keeps
  // effects free of synchronous updates.
  const [nonce, setNonce] = useState(0);
  const sig = `${kind}|${status}|${days}|${query}|${nonce}`;
  const [reply, setReply] = useState<{ sig: string; data: Reply | null; error: string } | null>(null);

  useEffect(() => {
    let live = true;
    api<Reply>(`?kind=${kind}&status=${status}&days=${days}&q=${encodeURIComponent(query)}`)
      .then((data) => live && setReply({ sig, data, error: "" }))
      .catch((e) => live && setReply({ sig, data: null, error: e.message }));
    return () => {
      live = false;
    };
  }, [kind, status, days, query, sig]);

  const load = useCallback(() => setNonce((n) => n + 1), []);
  const loading = reply?.sig !== sig;
  const data = reply?.sig === sig ? reply.data : null;
  const error = reply?.sig === sig ? reply.error : "";

  const meta = KINDS.find((k) => k.id === kind)!;

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="max-w-5xl space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-bold text-stone-900">
          <AlertTriangle className="h-6 w-6" /> Fix numbers &amp; payment errors
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          {kind === "payment_id"
            ? "Payment log errors include today's sales, as soon as they are saved. Checking one off never changes an amount."
            : `Checked up to yesterday${data ? ` (${day(data.through)})` : ""} — today's visits show up tomorrow. Fixing a number never changes an amount or a date.`}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKind(k.id)}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition ${
              kind === k.id ? "bg-stone-900 text-white" : "bg-white text-stone-600 ring-1 ring-stone-200 hover:ring-stone-300"
            }`}
          >
            <k.icon className="h-4 w-4" /> {k.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200 bg-white p-3">
        <select value={status} onChange={(e) => setStatus(e.target.value as Status)} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
          <option value="open">To fix</option>
          <option value="resolved">Done</option>
          <option value="all">All</option>
        </select>
        {kind !== "payment_id" && (
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
            {[7, 14, 30, 60, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
          className="flex flex-1 items-center gap-2"
        >
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or number…" className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 text-sm" />
          </div>
          <button className="rounded-lg bg-stone-100 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-200">Search</button>
          <button type="button" onClick={load} title="Refresh" className="rounded-lg p-2 text-stone-500 hover:bg-stone-100">
            <RotateCcw className="h-4 w-4" />
          </button>
        </form>
      </div>
      <p className="-mt-3 text-xs text-stone-400">{meta.hint}</p>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {data?.warning && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{data.warning}</p>}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
        </div>
      ) : data && data.issues.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 py-16 text-center text-sm text-stone-500">
          <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
          {status === "open" ? "Nothing to fix here." : "Nothing in this list."}
        </div>
      ) : (
        <div className="space-y-4">
          {data && data.total > data.issues.length && <p className="text-xs text-stone-400">Showing the first {data.issues.length} of {data.total}. Narrow the dates or search to see the rest.</p>}
          {data?.issues.map((i) => (
            <Card key={i.key} issue={i} onChanged={load} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ── One item ─────────────────────────────────────────────────────────────────

function Card({ issue: i, onChanged }: { issue: Issue; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolve = (status: "fixed" | "dismissed" | "open", extra: Record<string, unknown> = {}) =>
    run(() => api("/resolve", { method: "POST", body: JSON.stringify({ key: i.key, kind: i.kind, status, ...extra }) }));

  return (
    <div className={`rounded-2xl border bg-white p-5 shadow-sm ${i.status === "open" ? "border-stone-200" : "border-emerald-200 bg-emerald-50/30"}`}>
      {i.kind === "duplicate" && <Duplicate i={i} busy={busy} run={run} resolve={resolve} />}
      {i.kind === "invalid" && <Invalid i={i} busy={busy} run={run} resolve={resolve} />}
      {i.kind === "payment" && <Payment i={i} busy={busy} resolve={resolve} />}
      {i.kind === "unassigned" && <Unassigned i={i} busy={busy} resolve={resolve} />}
      {i.kind === "reference" && <Reference i={i} busy={busy} resolve={resolve} />}
      {i.kind === "payment_id" && <PaymentLog i={i} busy={busy} resolve={resolve} />}

      {i.status !== "open" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-100 pt-3 text-xs text-emerald-800">
          <span>
            {i.kind === "payment_id" ? (i.status === "fixed" ? "Checked" : "Dismissed") : i.status === "fixed" ? "Fixed" : "Marked as fine"}
            {i.resolvedBy ? ` by ${i.resolvedBy}` : ""} on {day(i.resolvedAt)}
            {i.identified?.name || i.identified?.contact ? ` — identified as ${[i.identified.name, i.identified.contact].filter(Boolean).join(", ")}` : ""}
            {i.note ? ` — “${i.note}”` : ""}
          </span>
          <button disabled={busy} onClick={() => resolve("open")} className="inline-flex items-center gap-1 font-medium underline disabled:opacity-50">
            <Undo2 className="h-3 w-3" /> Reopen
          </button>
        </div>
      )}
      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<void>;
type Resolve = (status: "fixed" | "dismissed" | "open", extra?: Record<string, unknown>) => Promise<void>;

function Duplicate({ i, busy, run, resolve }: { i: Issue; busy: boolean; run: Run; resolve: Resolve }) {
  const [confirm, setConfirm] = useState<"a" | "b" | null>(null);
  const a = i.a!;
  const b = i.b!;
  const move = (from: Side, to: Side) =>
    run(async () => {
      await api("/correct-contact", { method: "POST", body: JSON.stringify({ from: from.contact, to: to.contact, key: i.key }) });
      setConfirm(null);
    });

  const col = (s: Side, tag: "a" | "b") => (
    <div className={`rounded-xl border p-4 ${i.likelyWrong === tag ? "border-amber-300 bg-amber-50/50" : "border-stone-200"}`}>
      {i.likelyWrong === tag && <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">Likely the typo — fewer visits</p>}
      <p className="font-mono text-lg font-semibold text-stone-900">{s.contact}</p>
      <p className="text-sm text-stone-700">{s.name}</p>
      <p className="mt-2 text-xs text-stone-500">
        {s.visits} visit{s.visits === 1 ? "" : "s"} · {rupees(s.revenue)} · last {day(s.lastDate)}
      </p>
    </div>
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2.5 py-1 font-medium ${i.confidence === "high" ? "bg-red-50 text-red-700" : "bg-stone-100 text-stone-600"}`}>
          {i.confidence === "high" ? "Very likely the same person" : "Possibly the same person"}
        </span>
        <span className="text-stone-500">
          {i.nameMatch === "identical" ? "Same name" : "Similar name"} · {i.diff}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {col(a, "a")}
        {col(b, "b")}
      </div>

      {i.status === "open" && (
        <div className="mt-4 space-y-3">
          {confirm ? (
            (() => {
              const [from, to] = confirm === "a" ? [a, b] : [b, a];
              return (
                <div className="rounded-xl bg-stone-50 p-4 text-sm text-stone-700">
                  Move {from.visits} visit{from.visits === 1 ? "" : "s"} ({rupees(from.revenue)}) from <b className="font-mono">{from.contact}</b> to <b className="font-mono">{to.contact}</b>? Amounts and dates stay the same.
                  <div className="mt-3 flex gap-2">
                    <button disabled={busy} onClick={() => move(from, to)} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                      {busy ? "Moving…" : "Yes, move them"}
                    </button>
                    <button onClick={() => setConfirm(null)} className="rounded-lg px-4 py-2 text-sm text-stone-600 hover:bg-stone-100">
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} onClick={() => setConfirm("a")} className="rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">
                {a.contact} is wrong → use {b.contact}
              </button>
              <button disabled={busy} onClick={() => setConfirm("b")} className="rounded-lg bg-stone-900 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">
                {b.contact} is wrong → use {a.contact}
              </button>
              <button disabled={busy} onClick={() => resolve("dismissed", { note: "Different people" })} className="rounded-lg px-3.5 py-2 text-sm font-medium text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50 disabled:opacity-50">
                Different people
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Invalid({ i, busy, run, resolve }: { i: Issue; busy: boolean; run: Run; resolve: Resolve }) {
  const [to, setTo] = useState("");
  return (
    <>
      <p className="font-mono text-lg font-semibold text-red-700">{i.contact || "(empty)"}</p>
      <p className="text-sm text-stone-700">{i.name}</p>
      <p className="mt-1 text-xs text-stone-500">
        {i.visits} visit{i.visits === 1 ? "" : "s"} · {rupees(i.revenue)} · last {day(i.lastDate)}
      </p>
      {i.status === "open" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input value={to} onChange={(e) => setTo(e.target.value.replace(/[^\d+ ]/g, ""))} inputMode="numeric" placeholder="Correct 10-digit number" className="w-56 rounded-lg border border-stone-200 px-3 py-2 text-sm" />
          <button
            disabled={busy || to.replace(/\D/g, "").length < 10}
            onClick={() => run(() => api("/correct-contact", { method: "POST", body: JSON.stringify({ from: i.contact, to, key: i.key }) }))}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Save number
          </button>
          <button disabled={busy} onClick={() => resolve("dismissed", { note: "Number not available" })} className="rounded-lg px-3.5 py-2 text-sm text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50">
            Can't find it
          </button>
        </div>
      )}
    </>
  );
}

function Payment({ i, busy, resolve }: { i: Issue; busy: boolean; resolve: Resolve }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${i.what === "Failed" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}`}>{i.what}</span>
        <span className="text-lg font-semibold text-stone-900">{rupees(i.amount)}</span>
        {i.what !== "Failed" && <span className="text-sm text-stone-500">({rupees(i.refunded)} returned)</span>}
        <span className="text-sm text-stone-500">· {day(i.at)}</span>
      </div>
      <p className="mt-1 font-mono text-xs text-stone-400">{i.paymentId}</p>
      <p className="mt-2 text-sm text-stone-700">
        {i.name || i.contact ? (
          <>
            {i.name || "(no name)"} · <span className="font-mono">{i.contact || "no number"}</span>
          </>
        ) : (
          <span className="text-amber-700">Nobody is linked to this payment. Look it up in Razorpay or ask the client.</span>
        )}
      </p>
      {i.reason && <p className="mt-1 text-xs text-stone-500">Razorpay says: {i.reason}</p>}
      {i.what !== "Failed" && (
        <p className={`mt-1 text-xs ${i.visitCounted ? "text-red-600" : "text-stone-500"}`}>
          {i.visitCounted ? "A visit is still counted as revenue for this payment." : "No visit is counted, so revenue is not affected."}
        </p>
      )}
      {i.status === "open" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Client name" className="w-40 rounded-lg border border-stone-200 px-3 py-2 text-sm" />
          <input value={contact} onChange={(e) => setContact(e.target.value.replace(/[^\d+ ]/g, ""))} placeholder="Number" className="w-40 rounded-lg border border-stone-200 px-3 py-2 text-sm" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="min-w-[160px] flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm" />
          <button disabled={busy || (!name.trim() && !contact.trim())} onClick={() => resolve("fixed", { identified: { name, contact }, note })} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            Save who it was
          </button>
          <button disabled={busy} onClick={() => resolve("dismissed", { note })} className="rounded-lg px-3.5 py-2 text-sm text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50">
            Nothing to do
          </button>
        </div>
      )}
    </>
  );
}

function Unassigned({ i, busy, resolve }: { i: Issue; busy: boolean; resolve: Resolve }) {
  const navigate = useNavigate();
  return (
    <>
      <p className="text-lg font-semibold text-stone-900">
        {i.name} <span className="font-mono text-base font-normal text-stone-500">{i.contact}</span>
      </p>
      <p className="mt-1 text-sm text-stone-600">
        Paid {rupees(i.amount)} on {day(i.date)}, but the artists were never assigned, so this is not counted in revenue yet.
      </p>
      {i.status === "open" && (
        <div className="mt-4 flex gap-2">
          <button onClick={() => navigate(`/visit-assignment/${i.visitId}`)} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">
            Assign artists
          </button>
          <button disabled={busy} onClick={() => resolve("dismissed", { note: "Left as is" })} className="rounded-lg px-3.5 py-2 text-sm text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50">
            Leave as is
          </button>
        </div>
      )}
    </>
  );
}

/** A counter QR visit still waiting for Razorpay's payment id after 10 minutes (D60). */
function Reference({ i, busy, resolve }: { i: Issue; busy: boolean; resolve: Resolve }) {
  const navigate = useNavigate();
  return (
    <>
      <p className="text-lg font-semibold text-stone-900">
        {i.name} <span className="font-mono text-base font-normal text-stone-500">{i.contact}</span>
      </p>
      <p className="mt-1 text-sm text-stone-600">
        Paid {rupees(i.amount)} by UPI QR on {day(i.date)}. The sale is saved and counted, but Razorpay's payment reference never reached us, so it cannot be matched to the money yet.
      </p>
      {i.status === "open" && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => navigate("/dashboard/receptionist/payments")} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">
            Look in Payments
          </button>
          <button disabled={busy} onClick={() => resolve("fixed", { note: "Checked in Razorpay" })} className="rounded-lg px-3.5 py-2 text-sm text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50">
            I checked it
          </button>
        </div>
      )}
    </>
  );
}

/** One recorded payment-id check result (D70). Read-only for money: the buttons only record that someone looked. */
function PaymentLog({ i, busy, resolve }: { i: Issue; busy: boolean; resolve: Resolve }) {
  const [note, setNote] = useState("");
  const noteOk = note.trim().length > 0;
  // The link follows the role the user is inside; it is hidden without payments.view, and for a row with no
  // visit, a deleted visit or a visit without a valid 10-digit number (the server then sends contact: null).
  const { pathname } = useLocation();
  const canViewPayments = usePermission("payments.view");
  const link = historyLink({ pathname, canView: canViewPayments, contact: i.contact, day: i.visitDay });
  const razorpayUrl = razorpayPaymentUrl(i.paymentId);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">{i.what}</span>
        {i.refused && <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">Sale was refused — nothing saved</span>}
      </div>
      <p className="mt-2 text-lg font-semibold text-stone-900">{i.name || "(no name)"}</p>
      <p className="text-xs text-stone-500">
        {day(i.date || i.at)} · recorded {day(i.at)} {time(i.at)}
        {i.ref ? ` · booking ${i.ref}` : ""}
        {i.visitId ? ` · visit …${i.visitId.slice(-6)}` : ""}
        {i.by ? ` · entered by ${i.by}` : ""}
      </p>
      <p className="mt-2 text-sm text-stone-700">
        This sale needed <b>{rupees(i.expected ?? 0)}</b> online
        {i.found != null ? (
          <>
            ; {i.replay ? "the first visit with this payment took" : "the payment found was"} <b>{rupees(i.found)}</b>
          </>
        ) : (
          "; no amount could be found for this payment"
        )}
        .
      </p>
      <div className="mt-1">{i.paymentId && <CopyId id={i.paymentId} />}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {link && (
          <Link to={link} className="text-sm font-medium text-amber-700 underline underline-offset-2 hover:text-amber-800">
            See this client's payments
          </Link>
        )}
        {razorpayUrl && (
          <a
            href={razorpayUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Opens this payment in the Razorpay dashboard. It only opens for someone signed in to the salon's Razorpay account."
            className="text-sm font-medium text-amber-700 underline underline-offset-2 hover:text-amber-800"
          >
            Open in Razorpay
          </a>
        )}
      </div>
      {i.status === "open" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="What did you check? (required)" className="min-w-[220px] flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm" />
          <button disabled={busy || !noteOk} onClick={() => resolve("fixed", { note })} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            I checked it
          </button>
          <button disabled={busy || !noteOk} onClick={() => resolve("dismissed", { note })} className="rounded-lg px-3.5 py-2 text-sm text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50 disabled:opacity-40">
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
