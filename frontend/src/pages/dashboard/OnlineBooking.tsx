/**
 * @file OnlineBooking.tsx
 * @description Which artists the website may book, how much of their day,
 * their hours, and their leave (CF §2.1, T2.1, T2.18, T2.22).
 *
 *   - "Online booking" switch per artist (`onlineBookable`). Off = the website
 *     never offers their time; bookings already made stay. Switching everyone
 *     off is the rollback for the whole booking engine (CP4).
 *   - Share: the most of an artist's working day the website may sell, so
 *     walk-ins always find someone free (Q4).
 *   - Hours: the salon's hours (D36) or their own per weekday.
 *   - Leave: whole days or a few hours. Saved at once; bookings the artist had
 *     in that time move to a free artist for the same time (D48). A customer who
 *     named the artist is told on WhatsApp who they have instead and why (the
 *     reason typed here). A booking nobody can take stays put and is listed for
 *     reception — nothing is ever cancelled automatically.
 *
 * Seeing needs bookings.view; changing needs schedules.manage (owner always).
 * Times are IST whatever the device's timezone.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CalendarOff, Globe, Loader2, Plus, Save, Trash2, AlertTriangle } from "lucide-react";
import { usePermission } from "@/hooks/usePermission";

const API = import.meta.env.VITE_BACKEND_URL || "";
const IST = "Asia/Kolkata";
const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;
type Day = (typeof DAYS)[number][0];
type Period = { start: string; end: string };
type Weekly = Partial<Record<Day, Period[]>> | null;

interface ArtistRow {
  _id: string;
  name: string;
  displayName: string | null;
  gender: string | null;
  onlineBookable: boolean;
  onlineShare: number;
  weekly: Weekly;
}
interface Leave {
  _id: string;
  artistId: string;
  artistName: string;
  startAt: string;
  endAt: string;
  reason: string | null;
}
interface LeaveResult {
  moved: { _id: string; ref: string; name: string; from: string[]; to: string[]; customerTold: boolean }[];
  flagged: { _id: string; ref: string; name: string; contact: string; startAt: string; reason: string }[];
}
interface Data {
  artists: ArtistRow[];
  timeOff: Leave[];
  openingHours: Record<Day, { open: string; close: string }[]>;
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
  const res = await fetch(`${API}/api/schedules${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  // A reply that is not JSON (the app's own page, a proxy error) must never be read as data.
  if (!(res.headers.get("content-type") || "").includes("json")) throw new ApiError("The server sent an unexpected reply. Reload the page and try again.", res.status, {});
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(d.error || "Request failed", res.status, d);
  return d as T;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST });
const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());

/** Leave that covers whole IST days reads "Mon 3 Nov – Wed 5 Nov"; otherwise times. */
function leaveLabel(l: Leave) {
  const s = new Date(l.startAt);
  const e = new Date(l.endAt);
  const time = (d: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: IST }).format(d);
  const day = (d: Date) => d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: IST });
  if (time(s) === "00:00" && time(e) === "00:00") {
    const last = new Date(e.getTime() - 1);
    return day(s) === day(last) ? day(s) : `${day(s)} – ${day(last)}`;
  }
  return `${fmt(l.startAt)} – ${day(s) === day(e) ? time(e) : fmt(l.endAt)}`;
}

export default function OnlineBooking() {
  const canEdit = usePermission("schedules.manage");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api<Data>("")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  if (!data) {
    return <div className="flex justify-center py-16">{error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="w-6 h-6 animate-spin text-stone-400" />}</div>;
  }

  const onCount = data.artists.filter((a) => a.onlineBookable).length;

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="max-w-5xl space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <Globe className="w-6 h-6" /> Online booking
        </h2>
        <p className="text-sm text-stone-500 mt-1">
          {onCount === 0
            ? "No artist takes online bookings yet — the website sends requests only."
            : `${onCount} of ${data.artists.length} artists can be booked on the website.`}{" "}
          Turning an artist off never cancels bookings they already have.
        </p>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </div>

      <section className="space-y-3">
        {data.artists.map((a) => (
          <ArtistCard key={a._id} artist={a} openingHours={data.openingHours} canEdit={canEdit} onSaved={load} />
        ))}
      </section>

      <LeaveSection data={data} canEdit={canEdit} onChanged={load} />
    </motion.div>
  );
}

// ─── One artist ──────────────────────────────────────────────────────────────

function ArtistCard({ artist, openingHours, canEdit, onSaved }: { artist: ArtistRow; openingHours: Data["openingHours"]; canEdit: boolean; onSaved: () => void }) {
  const [on, setOn] = useState(artist.onlineBookable);
  const [share, setShare] = useState(artist.onlineShare);
  const [weekly, setWeekly] = useState<Weekly>(artist.weekly);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setOn(artist.onlineBookable);
    setShare(artist.onlineShare);
    setWeekly(artist.weekly);
  }, [artist]);

  const dirty = on !== artist.onlineBookable || share !== artist.onlineShare || JSON.stringify(weekly) !== JSON.stringify(artist.weekly);

  async function save(patch?: Partial<ArtistRow>) {
    setSaving(true);
    setMsg("");
    try {
      await api(`/artists/${artist._id}`, {
        method: "PATCH",
        body: JSON.stringify(patch ?? { onlineBookable: on, onlineShare: share, weekly }),
      });
      setMsg("Saved");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  /** Start custom hours from the salon's, so the owner only edits the differences. */
  function useCustom() {
    const w: Partial<Record<Day, Period[]>> = {};
    for (const [d] of DAYS) w[d] = (openingHours[d] || []).map((p) => ({ start: p.open, end: p.close }));
    setWeekly(w);
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[10rem]">
          <p className="font-medium text-stone-900">{artist.name}</p>
          <p className="text-xs text-stone-500">
            {artist.displayName && artist.displayName !== artist.name ? `Website: ${artist.displayName} · ` : ""}
            {weekly ? "Own hours" : "Salon hours"} · up to {share}% online
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            disabled={!canEdit || saving}
            onClick={() => {
              setOn(!on);
              // The switch saves at once: it is the one control reception reaches for in a hurry.
              save({ onlineBookable: !on });
            }}
            className={`relative h-6 w-11 rounded-full transition ${on ? "bg-emerald-600" : "bg-stone-300"} disabled:opacity-50`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? "left-[1.375rem]" : "left-0.5"}`} />
          </button>
          <span className={on ? "text-emerald-700 font-medium" : "text-stone-500"}>{on ? "Online" : "Off"}</span>
        </label>

        <label className="text-sm text-stone-600 flex items-center gap-2">
          Share
          <select
            value={share}
            disabled={!canEdit}
            onChange={(e) => setShare(Number(e.target.value))}
            className="h-9 rounded-lg border border-stone-300 px-2 text-sm"
          >
            {[25, 50, 75, 100].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </select>
        </label>

        <button type="button" onClick={() => setOpen(!open)} className="text-sm text-stone-600 underline underline-offset-2">
          {open ? "Hide hours" : "Hours"}
        </button>

        {canEdit && dirty && (
          <button
            type="button"
            disabled={saving}
            onClick={() => save()}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-stone-900 text-white text-sm font-medium hover:bg-stone-800 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        )}
        {msg && <span className={`text-xs ${msg === "Saved" ? "text-emerald-700" : "text-red-600"}`}>{msg}</span>}
      </div>

      {open && (
        <div className="mt-4 border-t border-stone-100 pt-4 space-y-3">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={weekly === null} disabled={!canEdit} onChange={() => setWeekly(null)} /> Salon hours
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={weekly !== null} disabled={!canEdit} onChange={useCustom} /> Own hours
            </label>
          </div>
          {weekly && (
            <div className="grid gap-2 sm:grid-cols-2">
              {DAYS.map(([d, label]) => {
                const p = weekly[d]?.[0];
                const off = !p;
                return (
                  <div key={d} className="flex items-center gap-2 text-sm">
                    <span className="w-10 text-stone-600">{label}</span>
                    <label className="flex items-center gap-1 text-xs text-stone-500">
                      <input
                        type="checkbox"
                        checked={!off}
                        disabled={!canEdit}
                        onChange={(e) => setWeekly({ ...weekly, [d]: e.target.checked ? [{ start: "09:00", end: "21:00" }] : [] })}
                      />
                      works
                    </label>
                    {!off && (
                      <>
                        <input
                          type="time"
                          step={900}
                          value={p.start}
                          disabled={!canEdit}
                          onChange={(e) => setWeekly({ ...weekly, [d]: [{ ...p, start: e.target.value }] })}
                          className="h-8 rounded border border-stone-300 px-1"
                        />
                        <span>–</span>
                        <input
                          type="time"
                          step={900}
                          value={p.end}
                          disabled={!canEdit}
                          onChange={(e) => setWeekly({ ...weekly, [d]: [{ ...p, end: e.target.value }] })}
                          className="h-8 rounded border border-stone-300 px-1"
                        />
                      </>
                    )}
                    {off && <span className="text-xs text-stone-400">day off</span>}
                  </div>
                );
              })}
              <p className="sm:col-span-2 text-xs text-stone-500">Hours outside the salon's opening hours are ignored.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Leave ───────────────────────────────────────────────────────────────────

function LeaveSection({ data, canEdit, onChanged }: { data: Data; canEdit: boolean; onChanged: () => void }) {
  const today = todayIST();
  const [form, setForm] = useState({ artistId: "", startDate: today, endDate: today, partDay: false, startTime: "14:00", endTime: "18:00", reason: "" });
  const [result, setResult] = useState<LeaveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function submit() {
    setBusy(true);
    setMsg("");
    setResult(null);
    try {
      const out = await api<LeaveResult>("/time-off", {
        method: "POST",
        body: JSON.stringify({
          artistId: form.artistId,
          startDate: form.startDate,
          endDate: form.partDay ? form.startDate : form.endDate,
          startTime: form.partDay ? form.startTime : null,
          endTime: form.partDay ? form.endTime : null,
          reason: form.reason || null,
        }),
      });
      setResult(out);
      setForm({ ...form, reason: "" });
      setMsg("Leave saved");
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/time-off/${id}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to remove");
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 space-y-4">
      <h3 className="font-semibold text-stone-900 flex items-center gap-2">
        <CalendarOff className="w-5 h-5" /> Leave and blocked time
      </h3>

      {canEdit && (
        <div className="grid gap-3 sm:grid-cols-6 items-end text-sm">
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="text-stone-600">Artist</span>
            <select value={form.artistId} onChange={(e) => setForm({ ...form, artistId: e.target.value })} className="h-9 rounded-lg border border-stone-300 px-2">
              <option value="">Choose…</option>
              {data.artists.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-stone-600">{form.partDay ? "Day" : "From"}</span>
            <input type="date" min={today} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} className="h-9 rounded-lg border border-stone-300 px-2" />
          </label>
          {form.partDay ? (
            <div className="flex items-center gap-1">
              <input type="time" step={900} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="h-9 rounded-lg border border-stone-300 px-1 w-full" />
              <span>–</span>
              <input type="time" step={900} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="h-9 rounded-lg border border-stone-300 px-1 w-full" />
            </div>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-stone-600">To (incl.)</span>
              <input type="date" min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="h-9 rounded-lg border border-stone-300 px-2" />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-stone-600">Reason</span>
            <input value={form.reason} maxLength={200} placeholder="Leave, training…" onChange={(e) => setForm({ ...form, reason: e.target.value })} className="h-9 rounded-lg border border-stone-300 px-2" />
          </label>
          <button
            type="button"
            disabled={busy || !form.artistId}
            onClick={() => submit()}
            className="inline-flex items-center justify-center gap-2 h-9 px-3 rounded-lg bg-stone-900 text-white font-medium hover:bg-stone-800 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add
          </button>
          <label className="sm:col-span-6 flex items-center gap-2 text-xs text-stone-600">
            <input type="checkbox" checked={form.partDay} onChange={(e) => setForm({ ...form, partDay: e.target.checked })} /> Only part of a day
          </label>
        </div>
      )}

      {msg && <p className={`text-sm ${msg === "Leave saved" ? "text-emerald-700" : "text-red-600"}`}>{msg}</p>}

      {result && (result.moved.length > 0 || result.flagged.length > 0) && (
        <div className="space-y-2 text-sm">
          {result.moved.length > 0 && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
              <p className="font-medium text-emerald-800">Moved to other artists, same time:</p>
              <ul className="mt-1 space-y-1 text-stone-700">
                {result.moved.map((m) => (
                  <li key={m._id}>
                    {m.ref} · {m.name} — {m.from.join(", ")} → {m.to.join(", ")}
                    {m.customerTold ? " · customer told on WhatsApp" : " · customer not told (chose any artist)"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.flagged.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="flex items-center gap-2 font-medium text-amber-800">
                <AlertTriangle className="w-4 h-4" /> Needs you — nobody was free. Move or cancel these on the Today board:
              </p>
              <ul className="mt-1 space-y-1 text-stone-700">
                {result.flagged.map((f) => (
                  <li key={f._id}>
                    {f.ref} · {f.name} · {f.contact} — {fmt(f.startAt)} ({f.reason})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {data.timeOff.length === 0 ? (
        <p className="text-sm text-stone-500">No leave coming up.</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {data.timeOff.map((l) => (
            <li key={l._id} className="flex items-center gap-3 py-2 text-sm">
              <span className="font-medium text-stone-800 w-40 truncate">{l.artistName}</span>
              <span className="flex-1 text-stone-600">{leaveLabel(l)}{l.reason ? ` · ${l.reason}` : ""}</span>
              {canEdit && (
                <button type="button" onClick={() => remove(l._id)} aria-label="Remove leave" className="p-1.5 rounded hover:bg-stone-100 text-stone-500">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
