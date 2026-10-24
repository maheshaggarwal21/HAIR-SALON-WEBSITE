/**
 * @file BookingRequests.tsx
 * @description Website requests inbox (T1.10). Phase 1 "request-lite": the
 * customer asked for a day and a time of day; reception calls or WhatsApps
 * them, agrees a time, and records it here with "Confirm with time".
 *
 * Built to process one request in under 30 seconds (CP1):
 *   - one tap to call or WhatsApp, with the message prefilled;
 *   - time chips inside the window the customer chose, so the usual case is
 *     two taps (time → Confirm);
 *   - refreshes itself every 30s so a new request shows up without reloading.
 *
 * WhatsApp-ad requests (D62) are UNPAID and ask for a specific time. They sit in their own
 * "Requested (unpaid)" section: Confirm (the time can be changed first) or Decline, and the
 * customer is told on WhatsApp either way. An offer-page request shows its offer so the desk
 * can give the matching discount by hand; nothing is discounted automatically.
 *
 * Phase 1 requests hold no time, so check the artist's day as you would for a
 * phone booking. Phase 2 requests made through the booking engine already
 * HOLD their time and are paid (deposit or full, D18): they show "Holds …"
 * and a one-tap Approve; Decline refunds everything (CF §6, T2.10).
 *
 * Permissions: bookings.view to see, bookings.manage to act. All times shown
 * in IST regardless of the device's timezone.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Inbox,
  Phone,
  MessageCircle,
  CalendarCheck,
  XCircle,
  Loader2,
  RefreshCw,
  StickyNote,
  Megaphone,
  Ban,
} from "lucide-react";
import { usePermission } from "@/hooks/usePermission";
import HeldMessages from "@/pages/dashboard/HeldMessages";

const API = import.meta.env.VITE_BACKEND_URL || "";
const IST = "Asia/Kolkata";
const REFRESH_MS = 30_000;

// ── Types ────────────────────────────────────────────────────────────────────
type Status = "requested" | "confirmed" | "declined" | "cancelled";
type WindowKey = "morning" | "afternoon" | "evening";

interface RequestItem {
  name: string;
  price: number;
  durationMin: number | null;
  artistName: string | null;
}

interface BookingRequest {
  _id: string;
  ref: string;
  status: Status;
  name: string;
  contact: string;
  gender: string | null;
  items: RequestItem[];
  total: number;
  discount: number;
  requestedWindow: { date: string | null; window: WindowKey | null; time?: string | null };
  preferredArtistName: string | null;
  startAt: string | null;
  endAt: string | null;
  notes: string | null;
  internalNote: string | null;
  utm: { source?: string; medium?: string; campaign?: string } | null;
  /** "wa_ad" for a request from a WhatsApp ad link or offer page (D62). */
  channel?: string | null;
  campaign?: string | null;
  offer?: { slug: string; headline: string | null; price: number | null; priceNote: string | null } | null;
  /** The package the customer chose on an offer page (D64): its name, ONE price and the services as printed on the poster. */
  package?: { name: string; price: number; services: string[]; durationMinutes: number | null } | null;
  /** A request with no money taken. */
  unpaid?: boolean;
  createdAt: string;
  lastChange: { to: string; by: string | null; at: string; reason: string | null } | null;
  /** Phase 2: an engine request holds its time until this moment. */
  requestExpiresAt?: string | null;
  deposit?: { kind: string; amount: number; status: string } | null;
  refund?: { amount: number; status: string; error: string | null } | null;
  /** A group request (D67): who is coming. Absent for one person. */
  people?: number;
  guests?: { guestKey: string; name: string | null }[];
  /** Confirmed WITHOUT blocking the artist's calendar (a package with no time set, or none of its services on the menu). */
  noLock?: boolean;
  noLockReason?: string | null;
}

interface RequestWindow {
  label: string;
  start: string;
  end: string;
}

interface Artist {
  id: string;
  name: string;
}

const TABS: { key: Status; label: string }[] = [
  { key: "requested", label: "New" },
  { key: "confirmed", label: "Confirmed" },
  { key: "declined", label: "Declined" },
  { key: "cancelled", label: "Cancelled" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** "2026-10-29" → "Thu 29 Oct". Parsed as UTC midnight so no timezone can shift the day. */
function dayLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function istDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: IST,
  });
}

function istTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST });
}

function todayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
}

function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/** "13:30" → "1:30 pm" */
function clockLabel(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Every 30 minutes from start up to (not including) end. */
function windowSlots(w: RequestWindow | undefined) {
  if (!w) return [];
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const out: string[] = [];
  for (let m = toMin(w.start); m < toMin(w.end); m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}

function whatsappLink(r: BookingRequest) {
  const when = r.requestedWindow.date ? ` for ${dayLabel(r.requestedWindow.date)}` : "";
  const text = `Hi ${r.name}, this is The Experts about your request ${r.ref}${when}. `;
  return `https://wa.me/91${r.contact}?text=${encodeURIComponent(text)}`;
}

const inputClass =
  "h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400";

// ── Component ────────────────────────────────────────────────────────────────
export default function BookingRequests() {
  const canManage = usePermission("bookings.manage");
  const [tab, setTab] = useState<Status>("requested");
  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [counts, setCounts] = useState<Partial<Record<Status, number>>>({});
  const [windows, setWindows] = useState<Partial<Record<WindowKey, RequestWindow>>>({});
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await fetch(`${API}/api/bookings/requests?status=${tab}`, { credentials: "include" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load requests");
        setRequests(data.requests);
        setCounts(data.counts || {});
        setWindows(data.requestWindows || {});
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load requests");
      } finally {
        setLoading(false);
      }
    },
    [tab]
  );

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    fetch(`${API}/api/form-data`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setArtists(Array.isArray(d.artists) ? d.artists : []))
      .catch(() => setArtists([]));
  }, []);

  // WhatsApp-ad requests get their own section on the New tab (D62).
  const waRequests = useMemo(() => requests.filter((r) => r.channel === "wa_ad"), [requests]);
  const otherRequests = useMemo(() => requests.filter((r) => r.channel !== "wa_ad"), [requests]);

  /** Replace one row after an action, or drop it if it left this tab. */
  const applyUpdate = (updated: BookingRequest) => {
    setRequests((rows) =>
      updated.status === tab ? rows.map((r) => (r._id === updated._id ? updated : r)) : rows.filter((r) => r._id !== updated._id)
    );
    if (updated.status !== tab) load(true);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
            <Inbox className="w-6 h-6 text-amber-500" /> Website Requests
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            Customers asked for a day and time of day. Call or WhatsApp them, agree a time, then confirm it here.
          </p>
        </div>
        <button
          onClick={() => load()}
          className="flex items-center gap-2 text-sm text-stone-600 border border-stone-200 rounded-xl px-4 py-2 hover:bg-stone-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <HeldMessages />

      {/* Tabs */}
      <div className="flex gap-2 mb-5 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors whitespace-nowrap ${
              tab === t.key
                ? "bg-stone-900 text-white border-stone-900"
                : "bg-white text-stone-600 border-stone-200 hover:bg-stone-50"
            }`}
          >
            {t.label}
            {counts[t.key] ? (
              <span
                className={`ml-2 inline-flex min-w-5 h-5 px-1.5 items-center justify-center rounded-full text-xs ${
                  t.key === "requested" ? "bg-amber-500 text-white" : "bg-stone-200 text-stone-700"
                }`}
              >
                {counts[t.key]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {loading && !requests.length ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
        </div>
      ) : !requests.length ? (
        <div className="bg-white rounded-xl border border-stone-200/80 p-10 text-center text-stone-500 text-sm">
          {tab === "requested" ? "No new requests. They appear here within seconds of being sent." : "Nothing here yet."}
        </div>
      ) : (
        <div className="space-y-4">
          {tab === "requested" && waRequests.length > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
                <h3 className="text-sm font-semibold text-emerald-900">Requested (unpaid) · from WhatsApp ads and offer pages</h3>
                <span className="text-xs text-emerald-800/80">Nothing is paid or held. Confirm to book it; the customer is told on WhatsApp.</span>
              </div>
              {waRequests.map((r) => (
                <RequestCard key={r._id} request={r} canManage={canManage} windows={windows} artists={artists} onUpdated={applyUpdate} />
              ))}
            </div>
          )}
          {tab === "requested" && waRequests.length > 0 && otherRequests.length > 0 && (
            <h3 className="px-1 pt-2 text-sm font-semibold text-stone-700">Website requests and paid bookings</h3>
          )}
          {(tab === "requested" ? otherRequests : requests).map((r) => (
            <RequestCard
              key={r._id}
              request={r}
              canManage={canManage}
              windows={windows}
              artists={artists}
              onUpdated={applyUpdate}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}

/** 90 → "1 h 30 min", 120 → "2 hours" */
function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  if (!m) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${h} h ${m} min`;
}

// ── One request ──────────────────────────────────────────────────────────────
function RequestCard({
  request: r,
  canManage,
  windows,
  artists,
  onUpdated,
}: {
  request: BookingRequest;
  canManage: boolean;
  windows: Partial<Record<WindowKey, RequestWindow>>;
  artists: Artist[];
  onUpdated: (r: BookingRequest) => void;
}) {
  const [mode, setMode] = useState<"none" | "confirm" | "decline" | "cancel">("none");
  const [date, setDate] = useState(r.requestedWindow.date || todayIST());
  // A WhatsApp-ad request asked for a specific time: start from it, and the desk can change it.
  const [time, setTime] = useState(r.requestedWindow.time || "");
  const [artistId, setArtistId] = useState("");
  // A group (D67): one artist per person, and a way to ask the system for free ones.
  const people = r.guests && r.guests.length > 1 ? r.guests : null;
  const [artistIds, setArtistIds] = useState<Record<string, string>>({});
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string[]>([]);
  const [alternatives, setAlternatives] = useState<{ time: string; suggestions: { guestKey: string; artistId: string | null }[] }[]>([]);
  const isWa = r.channel === "wa_ad";
  const [reason, setReason] = useState("");
  const [note, setNote] = useState(r.internalNote || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const win = r.requestedWindow.window ? windows[r.requestedWindow.window] : undefined;
  const slots = useMemo(() => windowSlots(win), [win]);
  const isPast = !!r.requestedWindow.date && r.requestedWindow.date < todayIST();

  async function act(path: string, method: "POST" | "PATCH", body: object) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`${API}/api/bookings/${r._id}/${path}`, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setMode("none");
      onUpdated(data.request);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const personLabel = (key: string, idx: number) => r.guests?.find((g) => g.guestKey === key)?.name || `Person ${idx + 1}`;
  const everyoneHasArtist = !people || people.every((g) => artistIds[g.guestKey]);
  const sharedArtist = people ? people.some((g, i) => artistIds[g.guestKey] && people.some((h, j) => j < i && artistIds[h.guestKey] === artistIds[g.guestKey])) : false;

  function applySuggestions(list: { guestKey: string; artistId: string | null }[]) {
    setArtistIds((prev) => ({ ...prev, ...Object.fromEntries(list.filter((x) => x.artistId).map((x) => [x.guestKey, x.artistId as string])) }));
  }

  async function suggest() {
    setSuggesting(true);
    setErr("");
    setSuggestNote([]);
    setAlternatives([]);
    try {
      const res = await fetch(`${API}/api/bookings/${r._id}/suggest-artists`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, time }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't suggest artists");
      applySuggestions(data.suggestions || []);
      const notes: string[] = [];
      if (data.reason) notes.push(data.reason);
      for (const [i, s] of (data.suggestions || []).entries()) if (!s.artistId && s.reason) notes.push(`${personLabel(s.guestKey, i)}: ${s.reason}`);
      setSuggestNote(notes);
      setAlternatives(data.alternatives || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't suggest artists");
    } finally {
      setSuggesting(false);
    }
  }

  const totalMins = r.items.reduce((s, i) => s + (i.durationMin || 60), 0);

  return (
    <div className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/* Who */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-semibold text-stone-900">{r.name}</span>
            {r.gender && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-600">
                {r.gender === "female" ? "For her" : r.gender === "male" ? "For him" : r.gender}
              </span>
            )}
            <span className="text-xs font-mono text-stone-400">{r.ref}</span>
            {r.people && <span className="text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 font-medium">{r.people} people</span>}
            {isWa && (
              <>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">WhatsApp ad</span>
                {r.campaign && <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-700">#{r.campaign}</span>}
                {r.unpaid && r.status === "requested" && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Unpaid</span>}
              </>
            )}
          </div>
          <div className="text-sm text-stone-500 mt-0.5">
            {r.contact} · received {timeAgo(r.createdAt)}
          </div>
        </div>

        {/* Contact */}
        <div className="flex gap-2">
          <a
            href={`tel:+91${r.contact}`}
            className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50"
          >
            <Phone className="w-4 h-4" /> Call
          </a>
          <a
            href={whatsappLink(r)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-emerald-200 text-sm text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
          >
            <MessageCircle className="w-4 h-4" /> WhatsApp
          </a>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        {/* What */}
        <div>
          {r.package ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold text-stone-900">{r.package.name}</span>
                <span className="tabular-nums text-lg font-semibold text-stone-900">{rupees(r.package.price)}</span>
              </div>
              <ul className="mt-1.5 list-disc pl-5 text-sm text-stone-700 space-y-0.5">
                {r.package.services.map((n, idx) => (
                  <li key={idx}>{n}</li>
                ))}
              </ul>
              <div className="mt-1.5 text-xs text-stone-500">{r.people ? `The package price from the offer is for each person (${r.people} people, ${rupees(r.total)} in all). ` : "The package price from the offer. "}Nothing is charged yet: give it when you bill.</div>
            </div>
          ) : (
            <>
          <ul className="text-sm text-stone-700 space-y-1">
            {r.items.map((i, idx) => (
              <li key={idx} className="flex justify-between gap-3">
                <span>
                  {i.name}
                  {i.artistName && <span className="text-stone-400"> · {i.artistName}</span>}
                </span>
                <span className="tabular-nums text-stone-500">{rupees(i.price)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-sm font-semibold text-stone-900 border-t border-stone-100 mt-2 pt-2">
            <span>
              Total{r.discount ? <span className="font-normal text-stone-400"> (package −{rupees(r.discount)})</span> : null}
            </span>
            <span className="tabular-nums">{rupees(r.total)}</span>
          </div>
            </>
          )}
          {!r.package && <div className="text-xs text-stone-400 mt-1">About {Math.round(totalMins / 15) * 15} min in total</div>}
          {r.package?.durationMinutes ? <div className="text-xs text-stone-400 mt-1">Allow about {Math.round(r.package.durationMinutes / 15) * 15} min</div> : null}
          {r.deposit && (
            <div className="text-xs text-sky-700 mt-1">
              {r.deposit.kind === "full" ? "Paid in full" : "Deposit"} {rupees(r.deposit.amount)} online ({r.deposit.status})
            </div>
          )}
          {r.refund && <div className="text-xs text-amber-700 mt-0.5">Refund {rupees(r.refund.amount)} — {r.refund.status}</div>}
        </div>

        {/* When */}
        <div className="text-sm space-y-1.5">
          {r.status === "requested" && r.startAt && r.requestExpiresAt ? (
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-amber-700 font-medium">
                <CalendarCheck className="w-4 h-4" /> Holds {istDateTime(r.startAt)}
              </div>
              <div className="text-xs text-stone-500">Approve by {istDateTime(r.requestExpiresAt)}, or it expires and is refunded.</div>
            </div>
          ) : r.status === "confirmed" && r.startAt ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-emerald-700 font-medium">
                <CalendarCheck className="w-4 h-4" /> {istDateTime(r.startAt)}
                {r.endAt && <span className="font-normal text-stone-400">→ {istTime(r.endAt)}</span>}
              </div>
              {r.noLock && (
                <div className="rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-xs text-amber-800">
                  {r.noLockReason || "No lock taken: the artist's calendar is not blocked for this booking."}
                </div>
              )}
            </div>
          ) : r.requestedWindow.date ? (
            <div className={isPast ? "text-red-600" : "text-stone-900"}>
              <span className="font-medium">{dayLabel(r.requestedWindow.date)}</span>
              {r.requestedWindow.time && <span className="font-medium"> · {clockLabel(r.requestedWindow.time)}</span>}
              {win && !r.requestedWindow.time && (
                <span className="text-stone-500">
                  {" "}
                  · {win.label} ({clockLabel(win.start)}–{clockLabel(win.end)})
                </span>
              )}
              {isPast && <span className="ml-1 text-xs">(day has passed)</span>}
            </div>
          ) : null}
          {r.preferredArtistName && <div className="text-stone-600">Prefers {r.preferredArtistName}</div>}
          {r.notes && <div className="text-stone-600 italic">“{r.notes}”</div>}
          {r.offer && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div className="font-semibold">Offer: {r.offer.headline || r.offer.slug}</div>
              {r.offer.price != null && !r.package && (
                <div>
                  Offer price {rupees(r.offer.price)}
                  {r.offer.priceNote ? ` ${r.offer.priceNote}` : ""}
                </div>
              )}
              <div className="mt-0.5 text-amber-800/80">{r.package ? "They chose the package above. Give its price at billing; nothing is applied automatically." : "Menu prices above. Give this offer's discount at billing; nothing is applied automatically."}</div>
            </div>
          )}
          {(r.utm?.source || r.utm?.campaign) && (
            <div className="flex items-center gap-1.5 text-xs text-stone-500">
              <Megaphone className="w-3.5 h-3.5" />
              {[r.utm.source, r.utm.medium, r.utm.campaign].filter(Boolean).join(" / ")}
            </div>
          )}
          {r.lastChange && r.status !== "requested" && (
            <div className="text-xs text-stone-400">
              {r.lastChange.to} by {r.lastChange.by || "—"} {timeAgo(r.lastChange.at)}
              {r.lastChange.reason ? ` · ${r.lastChange.reason}` : ""}
            </div>
          )}
        </div>
      </div>

      {/* Staff note */}
      {canManage && (
        <div className="mt-4 flex items-start gap-2">
          <StickyNote className="w-4 h-4 text-stone-400 mt-2.5 shrink-0" />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              if (note !== (r.internalNote || "")) act("note", "PATCH", { note });
            }}
            maxLength={500}
            placeholder="Staff note (only staff see this) — e.g. called, no answer"
            className={`${inputClass} flex-1`}
          />
        </div>
      )}

      {/* Actions */}
      {canManage && r.status === "requested" && mode === "none" && (
        <div className="flex flex-wrap gap-2 mt-4">
          {r.startAt && r.requestExpiresAt ? (
            <button
              disabled={busy}
              onClick={() => act("confirm", "POST", {})}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarCheck className="w-4 h-4" />} Approve {istTime(r.startAt)}
            </button>
          ) : (
          <button
            onClick={() => setMode("confirm")}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-stone-900 text-white text-sm font-medium hover:bg-stone-800"
          >
            <CalendarCheck className="w-4 h-4" /> {isWa && r.requestedWindow.time ? `Confirm ${clockLabel(r.requestedWindow.time)}` : "Confirm with time"}
          </button>
          )}
          <button
            onClick={() => setMode("decline")}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-stone-200 text-sm text-stone-600 hover:bg-stone-50"
          >
            <XCircle className="w-4 h-4" /> Decline
          </button>
        </div>
      )}
      {canManage && r.status === "confirmed" && mode === "none" && (
        <div className="mt-4">
          <button
            onClick={() => setMode("cancel")}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-stone-200 text-sm text-stone-600 hover:bg-stone-50"
          >
            <Ban className="w-4 h-4" /> Cancel booking
          </button>
        </div>
      )}

      {mode === "confirm" && (
        <div className="mt-4 rounded-xl bg-stone-50 border border-stone-200 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-semibold uppercase tracking-wider text-stone-500">Date</label>
            <input type="date" value={date} min={todayIST()} onChange={(e) => setDate(e.target.value)} className={inputClass} />
            {!people && (
              <>
                <label className="text-xs font-semibold uppercase tracking-wider text-stone-500 ml-2">Artist (required)</label>
                <select value={artistId} onChange={(e) => setArtistId(e.target.value)} className={inputClass} aria-required="true">
                  <option value="">Choose an artist…</option>
                  {artists.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          {people && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">Artist for each person (required)</div>
                <button
                  type="button"
                  onClick={suggest}
                  disabled={!date || !time || suggesting}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-stone-300 bg-white text-sm text-stone-800 hover:bg-stone-50 disabled:opacity-40"
                >
                  {suggesting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Suggest artists
                </button>
              </div>
              {people.map((g, i) => (
                <div key={g.guestKey} className="flex flex-wrap items-center gap-3">
                  <span className="w-32 text-sm text-stone-800 truncate">{personLabel(g.guestKey, i)}</span>
                  <select
                    value={artistIds[g.guestKey] || ""}
                    onChange={(e) => setArtistIds((prev) => ({ ...prev, [g.guestKey]: e.target.value }))}
                    aria-label={`Artist for ${personLabel(g.guestKey, i)}`}
                    className={inputClass}
                  >
                    <option value="">Choose an artist…</option>
                    {artists.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {sharedArtist && <p className="text-xs text-amber-700">The same artist is chosen for more than one person: they will be done one after another, so it takes longer.</p>}
              {suggestNote.map((n, i) => (
                <p key={i} className="text-xs text-amber-700">
                  {n}
                </p>
              ))}
              {alternatives.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
                  <span>Times when everyone fits:</span>
                  {alternatives.map((a) => (
                    <button
                      key={a.time}
                      type="button"
                      onClick={() => {
                        setTime(a.time);
                        applySuggestions(a.suggestions);
                        setAlternatives([]);
                        setSuggestNote([]);
                      }}
                      className="h-8 px-3 rounded-full border border-stone-200 bg-white text-stone-800 hover:bg-stone-100 tabular-nums"
                    >
                      {clockLabel(a.time)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-2">
              Time {isWa && r.requestedWindow.time ? (
                <span className="normal-case font-normal tracking-normal">— they asked for {clockLabel(r.requestedWindow.time)}; change it if needed</span>
              ) : (
                win && <span className="normal-case font-normal tracking-normal">— their {win.label.toLowerCase()} window</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <button
                  key={s}
                  onClick={() => setTime(s)}
                  className={`h-9 px-3 rounded-full text-sm border tabular-nums ${
                    time === s ? "bg-amber-500 text-white border-amber-500" : "bg-white border-stone-200 text-stone-700 hover:bg-stone-100"
                  }`}
                >
                  {clockLabel(s)}
                </button>
              ))}
              <input
                type="time"
                step={900}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                aria-label="Other time"
                className={`${inputClass} h-9`}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              disabled={!date || !time || (people ? !everyoneHasArtist : !artistId) || busy}
              title={(people ? !everyoneHasArtist : !artistId) ? (people ? "Choose an artist for every person" : "Choose the artist who will do this booking") : undefined}
              onClick={() => act("confirm", "POST", people ? { date, time, artistIds } : { date, time, artistId })}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-emerald-600 text-white text-sm font-medium disabled:opacity-40 hover:bg-emerald-700"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Confirm {time ? clockLabel(time) : ""}
            </button>
            <button onClick={() => setMode("none")} className="h-10 px-4 rounded-lg text-sm text-stone-500 hover:bg-stone-100">
              Back
            </button>
          </div>
          <p className="text-xs text-stone-500">
            Confirming holds {people ? "each artist's" : "this artist's"} time{r.package?.durationMinutes ? ` for the whole package (${durationLabel(r.package.durationMinutes)}${people ? " each" : ""})` : ""}, so the website can't sell it again. If someone is already booked then, you'll be told who and nothing is saved.{" "}
            {isWa ? "The customer gets a WhatsApp confirmation with this time." : "Tell the customer the time on WhatsApp; the website doesn't message them for this kind of request."}
          </p>
        </div>
      )}

      {(mode === "decline" || mode === "cancel") && (
        <div className="mt-4 rounded-xl bg-stone-50 border border-stone-200 p-4 space-y-3">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            placeholder={mode === "decline" ? "Reason (optional) — e.g. fully booked that day" : "Reason (optional) — e.g. customer called to cancel"}
            className={`${inputClass} w-full`}
          />
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => act(mode, "POST", { reason })}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-red-600 text-white text-sm font-medium disabled:opacity-40 hover:bg-red-700"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === "decline" ? (isWa ? "Decline and tell them" : "Decline request") : "Cancel booking"}
            </button>
            <button onClick={() => setMode("none")} className="h-10 px-4 rounded-lg text-sm text-stone-500 hover:bg-stone-100">
              Back
            </button>
          </div>
        </div>
      )}

      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
    </div>
  );
}
