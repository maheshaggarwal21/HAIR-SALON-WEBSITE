/**
 * @file Leads.tsx
 * @description Bookings → Leads: people who left their name, number and (maybe) a question WITHOUT choosing a package on an
 * offer page, or from the "Interested?" section on the landing page. The salon calls them back and marks them contacted or
 * closed, with a note. A request with a package chosen is not here: it is under Website requests.
 *
 * Reading needs bookings.view; changing status or the note needs bookings.manage (the server enforces both).
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Loader2, MessageCircle, Phone, RotateCcw, Search, UserPlus } from "lucide-react";
import { usePermission } from "@/hooks/usePermission";

const API = import.meta.env.VITE_BACKEND_URL || "";
const LIMIT = 25;

type Status = "new" | "contacted" | "closed";
interface Lead {
  id: string;
  name: string;
  phone: string;
  query: string | null;
  status: Status;
  note: string | null;
  handledBy: string | null;
  handledAt: string | null;
  source: "offer_page" | "landing" | null;
  offerSlug: string | null;
  campaign: string | null;
  createdAt: string;
}
interface Reply {
  leads: Lead[];
  total: number;
  page: number;
  counts: Record<Status, number>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/leads${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error("The server sent an unexpected reply. Reload the page and try again.");
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Request failed");
  return d as T;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const STATUS_LABEL: Record<Status, string> = { new: "New", contacted: "Contacted", closed: "Closed" };
const STATUS_STYLE: Record<Status, string> = { new: "bg-amber-50 text-amber-800", contacted: "bg-blue-50 text-blue-700", closed: "bg-stone-100 text-stone-600" };

export default function Leads() {
  const canManage = usePermission("bookings.manage");
  const [status, setStatus] = useState<Status | "all">("new");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);
  const sig = `${status}|${query}|${page}|${nonce}`;
  const [reply, setReply] = useState<{ sig: string; data: Reply | null; error: string } | null>(null);

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (status !== "all") qs.set("status", status);
    if (query) qs.set("q", query);
    api<Reply>(`?${qs}`)
      .then((data) => live && setReply({ sig, data, error: "" }))
      .catch((e) => live && setReply({ sig, data: null, error: e.message }));
    return () => {
      live = false;
    };
  }, [status, query, page, sig]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const loading = reply?.sig !== sig;
  const data = reply?.sig === sig ? reply.data : null;
  const error = reply?.sig === sig ? reply.error : "";
  const counts = data?.counts;
  const pages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1;

  const tabs: { id: Status | "all"; label: string; n?: number }[] = [
    { id: "new", label: "New", n: counts?.new },
    { id: "contacted", label: "Contacted", n: counts?.contacted },
    { id: "closed", label: "Closed", n: counts?.closed },
    { id: "all", label: "All", n: counts ? counts.new + counts.contacted + counts.closed : undefined },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="max-w-6xl space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-bold text-stone-900">
          <UserPlus className="h-6 w-6" /> Leads
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          People who left their details without choosing a package, or from the "Interested?" form on the home page. Call or WhatsApp them, then mark them contacted. A request with a package is under Website requests.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200 bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setStatus(t.id);
                setPage(1);
              }}
              className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition ${status === t.id ? "bg-stone-900 text-white" : "bg-stone-50 text-stone-600 hover:bg-stone-100"}`}
            >
              {t.label}
              {t.n != null && <span className={`rounded-full px-1.5 text-xs ${status === t.id ? "bg-white/20" : "bg-stone-200"}`}>{t.n}</span>}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
            setPage(1);
          }}
          className="flex flex-1 items-center gap-2"
        >
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, number or question…" className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 text-sm" />
          </div>
          <button className="rounded-lg bg-stone-100 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-200">Search</button>
          <button type="button" onClick={reload} title="Refresh" className="rounded-lg p-2 text-stone-500 hover:bg-stone-100">
            <RotateCcw className="h-4 w-4" />
          </button>
        </form>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
        </div>
      ) : data && data.leads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 py-16 text-center text-sm text-stone-500">
          {status === "new" && !query ? "No new leads. They appear here the moment someone fills the form." : "Nothing matches."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">Phone</th>
                <th className="px-4 py-3 font-semibold">Question</th>
                <th className="px-4 py-3 font-semibold">From</th>
                <th className="px-4 py-3 font-semibold">Received</th>
                <th className="px-4 py-3 font-semibold">Status &amp; note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data?.leads.map((l) => (
                <Row key={l.id} lead={l} canManage={canManage} onChanged={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > LIMIT && (
        <div className="flex items-center justify-between text-sm text-stone-500">
          <span>
            {data.total} lead{data.total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg p-2 hover:bg-stone-100 disabled:opacity-40" aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg p-2 hover:bg-stone-100 disabled:opacity-40" aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function Row({ lead: l, canManage, onChanged }: { lead: Lead; canManage: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState(l.note ?? "");
  const save = async (patch: { status?: Status; note?: string }) => {
    setBusy(true);
    setErr("");
    try {
      await api(`/${l.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const noteChanged = note.trim() !== (l.note ?? "");
  return (
    <tr className="align-top">
      <td className="px-4 py-3 font-medium text-stone-900">{l.name}</td>
      <td className="px-4 py-3">
        <div className="font-mono text-stone-800">{l.phone}</div>
        <div className="mt-1 flex gap-3 text-xs">
          <a href={`tel:+91${l.phone}`} className="inline-flex items-center gap-1 font-medium text-stone-600 hover:text-stone-900">
            <Phone className="h-3 w-3" /> Call
          </a>
          <a href={`https://wa.me/91${l.phone}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:text-emerald-900">
            <MessageCircle className="h-3 w-3" /> WhatsApp
          </a>
        </div>
      </td>
      <td className="max-w-[260px] px-4 py-3 text-stone-700">{l.query || <span className="text-stone-400">—</span>}</td>
      <td className="px-4 py-3 text-stone-600">
        {l.source === "offer_page" ? "Offer page" : l.source === "landing" ? "Home page" : "—"}
        {l.offerSlug && <div className="text-xs text-stone-400">{l.offerSlug}</div>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-stone-600">{when(l.createdAt)}</td>
      <td className="min-w-[220px] px-4 py-3">
        {canManage ? (
          <select
            value={l.status}
            disabled={busy}
            onChange={(e) => void save({ status: e.target.value as Status })}
            aria-label={`Status for ${l.name}`}
            className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm"
          >
            {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        ) : (
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[l.status]}`}>{STATUS_LABEL[l.status]}</span>
        )}
        {canManage ? (
          <div className="mt-2 flex gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Note (e.g. called, coming Friday)" aria-label={`Note for ${l.name}`} className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-sm" />
            {noteChanged && (
              <button disabled={busy} onClick={() => void save({ note: note.trim() })} className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                Save
              </button>
            )}
          </div>
        ) : (
          l.note && <p className="mt-2 text-stone-600">{l.note}</p>
        )}
        {l.handledBy && <p className="mt-1 text-xs text-stone-400">{l.handledBy}, {l.handledAt ? when(l.handledAt) : ""}</p>}
        {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
      </td>
    </tr>
  );
}
