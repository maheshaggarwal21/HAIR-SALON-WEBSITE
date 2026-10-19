/**
 * @file TodayBoard.tsx
 * @description The Today board (CF §7, T2.14–T2.17): one row per artist, the
 * day's timeline, a red "now" line, every booking and walk-in on it.
 *
 * Built for the front desk at speed:
 *   - tap an empty spot on an artist's row → Walk-in, prefilled with that
 *     artist and time. Pick a service, Save: three taps (T2.15). A walk-in
 *     holds the time, so the website can't sell that chair (CLAUDE.md);
 *   - the same panel books a phone customer (E22) or blocks time (training);
 *   - tap a booking → check in, move, no-show, cancel, approve/decline, call;
 *   - "Needs attention" lists requests to approve and walk-ins forced over a
 *     booking that still need moving (E2);
 *   - refreshes every 30 s.
 *
 * Colours: amber = waiting (payment or approval), stone = confirmed, green =
 * in the chair, violet = walk-in, grey = done, red outline = no-show or a clash.
 * All times IST, whatever the device's timezone.
 *
 * Permissions: bookings.view to see, bookings.manage to act.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageCircle,
  Phone,
  RefreshCw,
  UserPlus,
  X,
} from "lucide-react";
import { usePermission } from "@/hooks/usePermission";

const API = import.meta.env.VITE_BACKEND_URL || "";
const IST = "Asia/Kolkata";
const BLOCK = 15 * 60 * 1000;
const PX = 22; // width of one 15-minute block
const REFRESH_MS = 30_000;

// ── Types ────────────────────────────────────────────────────────────────────
type Status = "pending_payment" | "requested" | "confirmed" | "checked_in" | "completed" | "no_show";
interface Item {
  appointmentId: string;
  ref: string;
  status: Status;
  mode: "instant" | "request";
  channel: string | null;
  name: string;
  contact: string;
  service: string;
  price: number;
  startAt: string;
  endAt: string;
  busyUntil: string;
  lockConflict: boolean;
  deposit: { kind: string; amount: number; status: string } | null;
  notes: string | null;
  internalNote: string | null;
  requestExpiresAt: string | null;
  holdExpiresAt: string | null;
  checkedInAt: string | null;
  finishedAt: string | null;
  visitId: string | null;
}
interface Range {
  start: string;
  end: string;
}
interface Row {
  _id: string;
  name: string;
  onlineBookable: boolean;
  inactive?: boolean;
  working: Range[];
  leave: (Range & { reason: string | null })[];
  blocked: (Range & { note: string | null })[];
  items: Item[];
}
interface Attention {
  kind: "approve" | "conflict" | "request";
  appointmentId: string;
  ref: string;
  name: string;
  contact: string;
  startAt?: string;
  window?: string;
}
interface Board {
  date: string;
  opening: Range[];
  closed: boolean;
  artists: Row[];
  attention: Attention[];
  noShowGraceMinutes: number;
}
interface Svc {
  id: string;
  name: string;
  price: number;
}

class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(d.error || "Request failed", res.status, d);
  return d as T;
}

// ── Time helpers (IST) ───────────────────────────────────────────────────────
const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
const time = (iso: string | number) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST });
const hhmm = (ms: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: IST }).format(new Date(ms));
function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
/** "2026-10-29" + "14:30" → ISO instant. IST is a fixed +05:30. */
const istIso = (date: string, t: string) => new Date(`${date}T${t}:00+05:30`).toISOString();
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

const STATUS_STYLE: Record<Status, string> = {
  pending_payment: "bg-amber-50 border-amber-300 border-dashed text-amber-900",
  requested: "bg-amber-100 border-amber-400 text-amber-900",
  confirmed: "bg-stone-100 border-stone-400 text-stone-900",
  checked_in: "bg-emerald-100 border-emerald-500 text-emerald-900",
  completed: "bg-stone-50 border-stone-200 text-stone-400",
  no_show: "bg-white border-red-400 text-red-700 line-through",
};
const STATUS_LABEL: Record<Status, string> = {
  pending_payment: "Waiting for payment",
  requested: "Needs approval",
  confirmed: "Confirmed",
  checked_in: "In the chair",
  completed: "Done",
  no_show: "No-show",
};

// ── Page ─────────────────────────────────────────────────────────────────────
export default function TodayBoard() {
  const canAct = usePermission("bookings.manage");
  const [date, setDate] = useState(todayIST());
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [services, setServices] = useState<Svc[]>([]);
  const [panel, setPanel] = useState<{ artistId: string; startAt: number } | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [blockSel, setBlockSel] = useState<{ artist: Row; range: Range & { note: string | null } } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await api<Board>(`/api/bookings/day?date=${date}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
      setNow(Date.now());
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    api<{ services: Svc[] }>("/api/form-data")
      .then((d) => setServices(d.services))
      .catch(() => setServices([]));
  }, []);

  // Timeline span: opening hours, widened to show anything booked outside them.
  const span = useMemo(() => {
    if (!board) return null;
    const times = [
      ...board.opening.flatMap((o) => [Date.parse(o.start), Date.parse(o.end)]),
      ...board.artists.flatMap((a) => a.items.flatMap((i) => [Date.parse(i.startAt), Date.parse(i.busyUntil)])),
    ];
    if (!times.length) return null;
    const start = Math.floor(Math.min(...times) / (60 * 60 * 1000)) * 60 * 60 * 1000;
    const end = Math.ceil(Math.max(...times) / (60 * 60 * 1000)) * 60 * 60 * 1000;
    return { start, end, width: ((end - start) / BLOCK) * PX };
  }, [board]);

  const x = (ms: number) => (span ? ((ms - span.start) / BLOCK) * PX : 0);
  const isToday = date === todayIST();

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2 mr-auto">
          <CalendarDays className="w-6 h-6" /> {isToday ? "Today" : dayLabel(date)}
        </h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setDate(shiftDate(date, -1))} className="p-2 rounded-lg border border-stone-300 hover:bg-stone-50" aria-label="Previous day">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2 text-sm" />
          <button type="button" onClick={() => setDate(shiftDate(date, 1))} className="p-2 rounded-lg border border-stone-300 hover:bg-stone-50" aria-label="Next day">
            <ChevronRight className="w-4 h-4" />
          </button>
          {!isToday && (
            <button type="button" onClick={() => setDate(todayIST())} className="h-9 px-3 rounded-lg border border-stone-300 text-sm hover:bg-stone-50">
              Today
            </button>
          )}
        </div>
        <button type="button" onClick={load} className="p-2 rounded-lg border border-stone-300 hover:bg-stone-50" aria-label="Refresh">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
        {canAct && board && board.artists.length > 0 && (
          <button
            type="button"
            onClick={() => setPanel({ artistId: board.artists[0]._id, startAt: Math.max(Math.floor(Date.now() / BLOCK) * BLOCK, span?.start ?? 0) })}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-stone-900 text-white text-sm font-medium hover:bg-stone-800"
          >
            <UserPlus className="w-4 h-4" /> Walk-in / booking
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Needs attention */}
      {board && board.attention.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900 flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4" /> Needs attention
          </p>
          <div className="flex flex-wrap gap-2">
            {board.attention.map((a) => (
              <button
                key={`${a.kind}-${a.appointmentId}`}
                type="button"
                onClick={() => {
                  const item = board.artists.flatMap((r) => r.items).find((i) => i.appointmentId === a.appointmentId);
                  if (item) setSelected(item);
                }}
                className="text-xs rounded-full border border-amber-400 bg-white px-3 py-1 text-amber-900 hover:bg-amber-100"
              >
                {a.kind === "approve" && `Approve ${a.name} · ${a.startAt ? time(a.startAt) : ""}`}
                {a.kind === "conflict" && `Clash: move ${a.name} (${a.ref})`}
                {a.kind === "request" && `Request: ${a.name} · ${a.window} (Website Requests)`}
              </button>
            ))}
          </div>
        </div>
      )}

      {!board ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
        </div>
      ) : board.closed && !board.artists.some((a) => a.items.length) ? (
        <p className="text-stone-500 py-10 text-center">The salon is closed on {dayLabel(date)}.</p>
      ) : !span ? null : (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
          <div className="flex">
            {/* Names */}
            <div className="shrink-0 w-32 border-r border-stone-200">
              <div className="h-8 border-b border-stone-200" />
              {board.artists.map((a) => (
                <div key={a._id} className="h-16 px-3 flex flex-col justify-center border-b border-stone-100">
                  <span className="text-sm font-medium text-stone-900 truncate">{a.name}</span>
                  <span className={`text-[10px] ${a.inactive ? "text-red-600" : a.onlineBookable ? "text-emerald-700" : "text-stone-400"}`}>{a.inactive ? "no longer here — move these" : a.onlineBookable ? "online" : "desk only"}</span>
                </div>
              ))}
            </div>

            {/* Timeline */}
            <div className="overflow-x-auto flex-1">
              <div className="relative" style={{ width: span.width }}>
                {/* Hour ruler */}
                <div className="h-8 border-b border-stone-200 relative">
                  {Array.from({ length: (span.end - span.start) / (60 * 60 * 1000) }, (_, h) => (
                    <span key={h} className="absolute top-2 text-[11px] text-stone-500" style={{ left: h * 4 * PX + 4 }}>
                      {time(span.start + h * 60 * 60 * 1000)}
                    </span>
                  ))}
                </div>

                {board.artists.map((a) => (
                  <ArtistRow
                    key={a._id}
                    row={a}
                    span={span}
                    x={x}
                    canAct={canAct}
                    onEmpty={(ms) => setPanel({ artistId: a._id, startAt: ms })}
                    onItem={setSelected}
                    onBlocked={(range) => setBlockSel({ artist: a, range })}
                  />
                ))}

                {/* Hour lines */}
                {Array.from({ length: (span.end - span.start) / (60 * 60 * 1000) + 1 }, (_, h) => (
                  <div key={h} className="absolute top-8 bottom-0 w-px bg-stone-100 pointer-events-none" style={{ left: h * 4 * PX }} />
                ))}

                {/* Now */}
                {isToday && now >= span.start && now <= span.end && (
                  <div className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none z-20" style={{ left: x(now) }}>
                    <span className="absolute -top-0 -left-1 w-2.5 h-2.5 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <Legend />

      {panel && board && (
        <NewPanel
          board={board}
          date={date}
          services={services}
          initial={panel}
          onClose={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            load();
          }}
        />
      )}
      {selected && board && (
        <ItemPanel
          item={selected}
          board={board}
          date={date}
          now={now}
          canAct={canAct}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            load();
          }}
        />
      )}
      {blockSel && (
        <Modal title={`Blocked: ${blockSel.artist.name}`} onClose={() => setBlockSel(null)}>
          <p className="text-sm text-stone-700">
            {time(blockSel.range.start)} – {time(blockSel.range.end)}
            {blockSel.range.note ? ` · ${blockSel.range.note}` : ""}
          </p>
          {canAct && (
            <ActionButton
              label="Unblock this time"
              onRun={async () => {
                await api("/api/bookings/unblock", { method: "POST", body: JSON.stringify({ artistId: blockSel.artist._id, startAt: blockSel.range.start, endAt: blockSel.range.end }) });
                setBlockSel(null);
                load();
              }}
            />
          )}
        </Modal>
      )}
    </motion.div>
  );
}

// ── One artist's row ─────────────────────────────────────────────────────────
function ArtistRow({
  row,
  span,
  x,
  canAct,
  onEmpty,
  onItem,
  onBlocked,
}: {
  row: Row;
  span: { start: number; end: number };
  x: (ms: number) => number;
  canAct: boolean;
  onEmpty: (ms: number) => void;
  onItem: (i: Item) => void;
  onBlocked: (r: Range & { note: string | null }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Not working = the whole span minus the working intervals.
  const off: Range[] = [];
  let cursor = span.start;
  for (const w of [...row.working].sort((p, q) => Date.parse(p.start) - Date.parse(q.start))) {
    if (Date.parse(w.start) > cursor) off.push({ start: new Date(cursor).toISOString(), end: w.start });
    cursor = Math.max(cursor, Date.parse(w.end));
  }
  if (cursor < span.end) off.push({ start: new Date(cursor).toISOString(), end: new Date(span.end).toISOString() });

  return (
    <div
      ref={ref}
      className={`relative h-16 border-b border-stone-100 ${canAct ? "cursor-pointer" : ""}`}
      onClick={(e) => {
        if (!canAct || e.target !== ref.current) return;
        const rect = ref.current!.getBoundingClientRect();
        const ms = span.start + Math.floor((e.clientX - rect.left) / PX) * BLOCK;
        onEmpty(ms);
      }}
    >
      {off.map((o, i) => (
        <div
          key={`off-${i}`}
          className="absolute top-0 bottom-0 bg-[repeating-linear-gradient(135deg,#f5f5f4_0_6px,#e7e5e4_6px_8px)] pointer-events-none"
          style={{ left: x(Date.parse(o.start)), width: x(Date.parse(o.end)) - x(Date.parse(o.start)) }}
        />
      ))}
      {row.leave.map((l, i) => (
        <div
          key={`leave-${i}`}
          className="absolute top-1 bottom-1 rounded bg-stone-200/70 text-[10px] text-stone-600 px-1 pointer-events-none overflow-hidden"
          style={{ left: Math.max(0, x(Date.parse(l.start))), width: Math.min(x(Date.parse(l.end)), x(span.end)) - Math.max(0, x(Date.parse(l.start))) }}
        >
          Leave{l.reason ? ` · ${l.reason}` : ""}
        </div>
      ))}
      {row.blocked.map((b, i) => (
        <button
          key={`blk-${i}`}
          type="button"
          onClick={() => onBlocked(b)}
          className="absolute top-1 bottom-1 rounded bg-stone-500 text-white text-[10px] px-1 text-left overflow-hidden"
          style={{ left: x(Date.parse(b.start)), width: x(Date.parse(b.end)) - x(Date.parse(b.start)) }}
        >
          {b.note || "Blocked"}
        </button>
      ))}
      {row.items.map((i) => {
        const walkin = i.channel === "walkin";
        const style = walkin && i.status === "checked_in" ? "bg-violet-100 border-violet-500 text-violet-900" : STATUS_STYLE[i.status];
        return (
          <button
            key={`${i.appointmentId}-${i.startAt}`}
            type="button"
            onClick={() => onItem(i)}
            title={`${i.name} · ${i.service} · ${time(i.startAt)}–${time(i.endAt)} · ${STATUS_LABEL[i.status]}`}
            className={`absolute top-1 bottom-1 rounded-md border px-1.5 py-0.5 text-left overflow-hidden z-10 ${style} ${i.lockConflict ? "ring-2 ring-red-500" : ""}`}
            style={{ left: x(Date.parse(i.startAt)) + 1, width: Math.max(PX, x(Date.parse(i.busyUntil)) - x(Date.parse(i.startAt)) - 2) }}
          >
            <span className="block text-[11px] font-semibold truncate">{i.name}</span>
            <span className="block text-[10px] truncate">{i.service}</span>
            <span className="block text-[10px] opacity-70 truncate">
              {time(i.startAt)}
              {walkin ? " · walk-in" : i.channel === "web" ? " · online" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Legend() {
  const chips: [string, string][] = [
    ["bg-amber-100 border-amber-400", "Needs approval / payment"],
    ["bg-stone-100 border-stone-400", "Confirmed"],
    ["bg-emerald-100 border-emerald-500", "In the chair"],
    ["bg-violet-100 border-violet-500", "Walk-in"],
    ["bg-stone-500 border-stone-500", "Blocked"],
    ["bg-white border-red-400", "No-show / clash"],
  ];
  return (
    <div className="flex flex-wrap gap-3 text-xs text-stone-600">
      {chips.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1.5">
          <span className={`w-3 h-3 rounded border ${c}`} /> {l}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 bg-[repeating-linear-gradient(135deg,#f5f5f4_0_3px,#e7e5e4_3px_4px)] border border-stone-200" /> Not working
      </span>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-stone-900">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-stone-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ActionButton({ label, onRun, tone = "dark", confirm }: { label: string; onRun: () => Promise<void>; tone?: "dark" | "light" | "danger"; confirm?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(false);
  const cls =
    tone === "dark"
      ? "bg-stone-900 text-white hover:bg-stone-800"
      : tone === "danger"
        ? "bg-red-600 text-white hover:bg-red-700"
        : "border border-stone-300 text-stone-800 hover:bg-stone-50";
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (confirm && !asking) return setAsking(true);
          setBusy(true);
          setErr("");
          try {
            await onRun();
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Failed");
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
        className={`inline-flex items-center gap-2 h-9 px-3 rounded-lg text-sm font-medium disabled:opacity-50 ${cls}`}
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {asking ? confirm : label}
      </button>
      {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
    </div>
  );
}

// ── New: walk-in / phone booking / block time ────────────────────────────────
function NewPanel({
  board,
  date,
  services,
  initial,
  onClose,
  onDone,
}: {
  board: Board;
  date: string;
  services: Svc[];
  initial: { artistId: string; startAt: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<"walkin" | "phone" | "block">(date === todayIST() ? "walkin" : "phone");
  const [artistId, setArtistId] = useState(initial.artistId);
  const [start, setStart] = useState(hhmm(initial.startAt));
  const [end, setEnd] = useState(hhmm(initial.startAt + 4 * BLOCK));
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<"female" | "male" | "">("");
  const [note, setNote] = useState("");
  const [conflicts, setConflicts] = useState<{ ref: string | null; name: string }[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? services.filter((s) => s.name.toLowerCase().includes(q)) : services;
    return list.filter((s) => !picked.includes(s.id)).slice(0, 8);
  }, [query, services, picked]);
  const byId = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);

  async function save(force = false) {
    setBusy(true);
    setError("");
    try {
      if (tab === "walkin") {
        await api("/api/bookings/walkin", {
          method: "POST",
          body: JSON.stringify({ name: name.trim() || "Walk-in", phone: phone || null, gender: gender || null, artistId, serviceIds: picked, startAt: istIso(date, start), force }),
        });
      } else if (tab === "phone") {
        await api("/api/bookings/staff", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), phone, for: gender === "male" ? "him" : gender === "female" ? "her" : null, serviceIds: picked, startAt: istIso(date, start), artistId, channel: "phone" }),
        });
      } else {
        await api("/api/bookings/block", { method: "POST", body: JSON.stringify({ artistId, startAt: istIso(date, start), endAt: istIso(date, end), note: note || null }) });
      }
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && tab === "walkin" && Array.isArray(e.body.conflicts)) {
        setConflicts(e.body.conflicts as { ref: string | null; name: string }[]);
      }
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  const ready = tab === "block" ? end > start : picked.length > 0 && (tab === "walkin" || (name.trim() && /^\d{10}$/.test(phone)));

  return (
    <Modal title="Add to the board" onClose={onClose}>
      <div className="flex gap-1 rounded-lg bg-stone-100 p-1 text-sm">
        {(
          [
            ["walkin", "Walk-in"],
            ["phone", "Phone booking"],
            ["block", "Block time"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" onClick={() => { setTab(k); setError(""); setConflicts(null); }} className={`flex-1 h-8 rounded-md ${tab === k ? "bg-white shadow font-medium" : "text-stone-600"}`}>
            {l}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-stone-600">Artist</span>
          <select value={artistId} onChange={(e) => setArtistId(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2">
            {board.artists.map((a) => (
              <option key={a._id} value={a._id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-stone-600">{tab === "block" ? "From" : "Start"}</span>
          <input type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2" />
        </label>
        {tab === "block" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-stone-600">Until</span>
              <input type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-stone-600">Why</span>
              <input value={note} maxLength={100} placeholder="Training, lunch…" onChange={(e) => setNote(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2" />
            </label>
          </>
        )}
      </div>

      {tab !== "block" && (
        <>
          <div className="space-y-2 text-sm">
            <span className="text-stone-600">Services</span>
            {picked.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {picked.map((id) => (
                  <button key={id} type="button" onClick={() => setPicked(picked.filter((p) => p !== id))} className="rounded-full bg-stone-900 text-white text-xs px-3 py-1">
                    {byId.get(id)?.name} ✕
                  </button>
                ))}
              </div>
            )}
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services…" className="w-full h-9 rounded-lg border border-stone-300 px-2" />
            <div className="flex flex-wrap gap-2">
              {matches.map((s) => (
                <button key={s.id} type="button" onClick={() => { setPicked([...picked, s.id]); setQuery(""); }} className="rounded-full border border-stone-300 text-xs px-3 py-1 hover:bg-stone-50">
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-stone-600">Name{tab === "walkin" ? " (optional)" : ""}</span>
              <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-stone-600">Mobile{tab === "walkin" ? " (optional)" : ""}</span>
              <input value={phone} inputMode="numeric" maxLength={10} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} className="h-9 rounded-lg border border-stone-300 px-2" />
            </label>
            <div className="col-span-2 flex gap-4">
              {(["female", "male"] as const).map((g) => (
                <label key={g} className="flex items-center gap-2">
                  <input type="radio" checked={gender === g} onChange={() => setGender(g)} /> {g === "female" ? "Woman" : "Man"}
                </label>
              ))}
            </div>
          </div>
          {tab === "phone" && <p className="text-xs text-stone-500">Booked as confirmed. The customer gets a WhatsApp confirmation; nothing is charged online.</p>}
        </>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {conflicts && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm space-y-2">
          <p className="text-red-800">In the way: {conflicts.map((c) => `${c.name}${c.ref ? ` (${c.ref})` : ""}`).join(", ")}</p>
          <button type="button" onClick={() => save(true)} disabled={busy} className="h-8 px-3 rounded-lg bg-red-600 text-white text-xs font-medium">
            Add anyway — I'll move one of them
          </button>
        </div>
      )}

      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => save(false)}
        className="w-full inline-flex items-center justify-center gap-2 h-11 rounded-lg bg-stone-900 text-white font-medium hover:bg-stone-800 disabled:opacity-40"
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {tab === "walkin" ? "Save walk-in" : tab === "phone" ? "Book" : "Block time"}
      </button>
    </Modal>
  );
}

// ── A booking ────────────────────────────────────────────────────────────────
function ItemPanel({ item, board, date, now, canAct, onClose, onDone }: { item: Item; board: Board; date: string; now: number; canAct: boolean; onClose: () => void; onDone: () => void }) {
  const navigate = useNavigate();
  const [moveTime, setMoveTime] = useState(hhmm(Date.parse(item.startAt)));
  const [moveArtist, setMoveArtist] = useState("");
  const [reason, setReason] = useState("");
  const post = (path: string, body?: unknown) => api(`/api/bookings/${item.appointmentId}/${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  const all = board.artists.flatMap((r) => r.items).filter((i) => i.appointmentId === item.appointmentId);
  const graceOver = now >= Date.parse(item.startAt) + board.noShowGraceMinutes * 60_000;
  const phone = /^\d{10}$/.test(item.contact) ? item.contact : null;
  const visitPath = `/visit-entry?appointment=${item.appointmentId}`;

  return (
    <Modal title={`${item.name} · ${item.ref}`} onClose={onClose}>
      <div className="text-sm space-y-1">
        <p>
          <span className="font-medium">{STATUS_LABEL[item.status]}</span>
          {item.channel === "walkin" ? " · walk-in" : item.channel === "web" ? " · booked online" : item.channel ? ` · ${item.channel}` : ""}
        </p>
        {all.map((i) => (
          <p key={i.startAt + i.service} className="text-stone-700">
            {time(i.startAt)}–{time(i.endAt)} · {i.service} · {rupees(i.price)}
          </p>
        ))}
        {item.deposit && (
          <p className="text-stone-700">
            {item.deposit.kind === "full" ? "Paid in full" : "Deposit"} {rupees(item.deposit.amount)} ({item.deposit.status}) — deducted at checkout
          </p>
        )}
        {item.status === "requested" && item.requestExpiresAt && <p className="text-amber-700">Approve by {time(item.requestExpiresAt)}, or it expires and is refunded.</p>}
        {item.status === "pending_payment" && item.holdExpiresAt && <p className="text-amber-700">Held until {time(item.holdExpiresAt)} while the customer pays.</p>}
        {item.lockConflict && <p className="text-red-700">Added over another booking — move one of them.</p>}
        {item.finishedAt && <p className="text-stone-700">Finished at {time(item.finishedAt)}</p>}
        {item.notes && <p className="text-stone-600">Customer note: {item.notes}</p>}
        {item.internalNote && <p className="text-stone-600">Staff note: {item.internalNote}</p>}
      </div>

      {phone && (
        <div className="flex gap-2">
          <a href={`tel:+91${phone}`} className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-stone-300 text-sm">
            <Phone className="w-4 h-4" /> {phone}
          </a>
          <a href={`https://wa.me/91${phone}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-stone-300 text-sm">
            <MessageCircle className="w-4 h-4" /> WhatsApp
          </a>
        </div>
      )}

      {canAct && (
        <div className="space-y-3 border-t border-stone-100 pt-3">
          <div className="flex flex-wrap gap-2">
            {item.status === "requested" && (
              <>
                <ActionButton label="Approve" onRun={async () => { await post("approve"); onDone(); }} />
                <ActionButton label="Decline" tone="light" confirm="Decline and refund everything?" onRun={async () => { await post("decline", { reason: reason || null }); onDone(); }} />
              </>
            )}
            {item.status === "confirmed" && (
              <ActionButton
                label="Check in → Visit Entry"
                onRun={async () => {
                  await post("check-in");
                  navigate(visitPath);
                }}
              />
            )}
            {item.status === "checked_in" && !item.visitId && !item.finishedAt && (
              <ActionButton label="Finished" onRun={async () => { await post("finish"); onDone(); }} />
            )}
            {item.status === "checked_in" && !item.visitId && <ActionButton label="Open Visit Entry" onRun={async () => navigate(visitPath)} />}
            {item.status === "confirmed" && graceOver && (
              <ActionButton label="No-show" tone="light" confirm="Mark as no-show? The fee is kept." onRun={async () => { await post("no-show"); onDone(); }} />
            )}
          </div>

          {["confirmed", "requested", "checked_in"].includes(item.status) && (
            <div className="rounded-lg border border-stone-200 p-3 space-y-2">
              <p className="text-sm font-medium text-stone-800">Move</p>
              <div className="flex flex-wrap items-end gap-2 text-sm">
                <input type="time" step={900} value={moveTime} onChange={(e) => setMoveTime(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2" />
                <select value={moveArtist} onChange={(e) => setMoveArtist(e.target.value)} className="h-9 rounded-lg border border-stone-300 px-2">
                  <option value="">Same artist</option>
                  {board.artists.map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <ActionButton label="Move" tone="light" onRun={async () => { await post("move", { startAt: istIso(date, moveTime), artistId: moveArtist || null }); onDone(); }} />
              </div>
            </div>
          )}

          {["confirmed", "checked_in"].includes(item.status) && (
            <div className="rounded-lg border border-stone-200 p-3 space-y-2">
              <p className="text-sm font-medium text-stone-800">Cancel</p>
              <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="w-full h-9 rounded-lg border border-stone-300 px-2 text-sm" />
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  label="Customer cancelled"
                  tone="light"
                  confirm={item.deposit?.status === "paid" ? "Cancel? ₹500 fee kept, rest refunded" : "Cancel this booking?"}
                  onRun={async () => { await post("cancel", { side: "customer", reason: reason || null }); onDone(); }}
                />
                <ActionButton
                  label="Salon cancels"
                  tone="danger"
                  confirm={item.deposit?.status === "paid" ? "Cancel and refund everything?" : "Cancel this booking?"}
                  onRun={async () => { await post("cancel", { side: "salon", reason: reason || null }); onDone(); }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
