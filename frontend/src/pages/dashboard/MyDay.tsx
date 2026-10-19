/**
 * @file MyDay.tsx
 * @description The artist's day sheet (D55): who is coming to MY chair today.
 *
 * Before this, an artist learned who was booked by asking the front desk or
 * looking over the receptionist's shoulder at the Today board. This shows just
 * their own bookings — time, service, client's name, any note — and nothing
 * about phone numbers or money. Walk-ins the desk adds appear within a minute
 * (the page refreshes itself).
 *
 * Days from last week to three weeks ahead; the server enforces the range.
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CalendarOff, ChevronLeft, ChevronRight, Clock, Loader2, RotateCcw, StickyNote } from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";
const IST = "Asia/Kolkata";

interface Item {
  ref: string;
  status: "confirmed" | "checked_in" | "completed" | "no_show";
  name: string;
  service: string;
  startAt: string;
  endAt: string;
  notes: string | null;
}
interface Range {
  start: string;
  end: string;
  reason?: string | null;
  note?: string | null;
}
interface Sheet {
  date: string;
  today: string;
  now?: string;
  closed: boolean;
  working: Range[];
  leave: Range[];
  blocked: Range[];
  items: Item[];
}

const STATUS: Record<Item["status"], { label: string; cls: string }> = {
  confirmed: { label: "Booked", cls: "bg-blue-50 text-blue-700" },
  checked_in: { label: "Here now", cls: "bg-emerald-50 text-emerald-700" },
  completed: { label: "Done", cls: "bg-stone-100 text-stone-500" },
  no_show: { label: "Didn't come", cls: "bg-red-50 text-red-700" },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST });
const longDay = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shift = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);

async function fetchSheet(date: string | null): Promise<Sheet> {
  const res = await fetch(`${API}/api/artist-dashboard/my-day${date ? `?date=${date}` : ""}`, { credentials: "include" });
  if (!(res.headers.get("content-type") || "").includes("json")) throw new Error("The server sent an unexpected reply. Reload the page and try again.");
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Could not load your day");
  return d as Sheet;
}

export default function MyDay() {
  const [date, setDate] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [reply, setReply] = useState<{ sig: string; sheet: Sheet | null; error: string } | null>(null);
  const sig = `${date}|${nonce}`;

  useEffect(() => {
    let live = true;
    const run = () =>
      fetchSheet(date)
        .then((sheet) => live && setReply({ sig, sheet, error: "" }))
        .catch((e) => live && setReply((prev) => (prev?.sig === sig ? prev : { sig, sheet: null, error: e.message })));
    run();
    // Walk-ins and moves by the desk show up without anyone reloading.
    const timer = setInterval(run, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [date, sig]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const loading = reply?.sig !== sig;
  const sheet = reply?.sig === sig ? reply.sheet : null;
  const error = reply?.sig === sig ? reply.error : "";

  const today = sheet?.today;
  const shown = sheet?.date;
  const offset = today && shown ? diffDays(today, shown) : 0;
  const isToday = offset === 0;
  const live = (i: Item) => isToday && sheet?.now && new Date(i.startAt) <= new Date(sheet.now) && new Date(sheet.now) < new Date(i.endAt);
  const open = sheet?.items.filter((i) => i.status === "confirmed" || i.status === "checked_in").length ?? 0;

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="max-w-2xl space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-stone-900">My day</h2>
          <p className="text-sm text-stone-500">{shown ? longDay(shown) : " "}{isToday ? " · today" : ""}</p>
        </div>
        <button onClick={refresh} title="Refresh" className="rounded-lg p-2 text-stone-500 hover:bg-stone-100">
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button disabled={!shown || offset <= -7} onClick={() => shown && setDate(shift(shown, -1))} className="rounded-lg bg-white p-2 ring-1 ring-stone-200 hover:bg-stone-50 disabled:opacity-40">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button disabled={!today || isToday} onClick={() => setDate(null)} className="rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-stone-200 hover:bg-stone-50 disabled:opacity-40">
          Today
        </button>
        <button disabled={!shown || offset >= 21} onClick={() => shown && setDate(shift(shown, 1))} className="rounded-lg bg-white p-2 ring-1 ring-stone-200 hover:bg-stone-50 disabled:opacity-40">
          <ChevronRight className="h-4 w-4" />
        </button>
        {sheet && !loading && (
          <span className="ml-2 text-sm text-stone-500">
            {sheet.items.length === 0 ? "Nobody booked" : `${sheet.items.length} client${sheet.items.length === 1 ? "" : "s"}${open && open !== sheet.items.length ? ` · ${open} still to come` : ""}`}
          </span>
        )}
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {loading && !error ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
        </div>
      ) : sheet ? (
        <>
          {sheet.closed && <Notice>The salon is closed this day.</Notice>}
          {sheet.leave.map((l, k) => (
            <Notice key={k}>
              You're on leave {time(l.start)} – {time(l.end)}
              {l.reason ? ` (${l.reason})` : ""}.
            </Notice>
          ))}
          {sheet.blocked.map((b, k) => (
            <Notice key={k}>
              Time blocked {time(b.start)} – {time(b.end)}
              {b.note ? ` (${b.note})` : ""}.
            </Notice>
          ))}

          {sheet.items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-stone-300 py-14 text-center text-sm text-stone-500">
              <CalendarOff className="mx-auto mb-2 h-6 w-6 text-stone-400" />
              No bookings for you on this day. Walk-ins are added by the front desk and appear here.
            </div>
          ) : (
            <ol className="space-y-3">
              {sheet.items.map((i) => (
                <li key={`${i.ref}-${i.startAt}`} className={`rounded-2xl border bg-white p-4 shadow-sm ${live(i) ? "border-emerald-300 ring-1 ring-emerald-200" : "border-stone-200"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-stone-900">
                      <Clock className="h-4 w-4 text-stone-400" />
                      {time(i.startAt)} – {time(i.endAt)}
                      {live(i) && <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white">Now</span>}
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span>
                  </div>
                  <p className="mt-2 text-lg font-semibold text-stone-900">{i.name}</p>
                  <p className="text-sm text-stone-600">{i.service}</p>
                  {i.notes && (
                    <p className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      <StickyNote className="mt-0.5 h-4 w-4 shrink-0" /> {i.notes}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </motion.div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-stone-100 px-4 py-2.5 text-sm text-stone-600">{children}</p>;
}
