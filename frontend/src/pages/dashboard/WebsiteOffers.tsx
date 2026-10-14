/**
 * @file WebsiteOffers.tsx
 * @description Website offers (CF D29, T3.1 brought forward; website.manage).
 * The owner creates an offer with real start and end dates. While it runs, the
 * website shows a colourful bar above the header on every page and, if chosen,
 * a pop-up with a small poster. Nothing shows before the start date or after
 * the end date, and an offer can be paused without deleting it.
 *
 * Honesty (CLAUDE.md): the site shows the real end date. No fake countdowns or
 * "only N left".
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Megaphone, Pause, Pencil, Play, Plus, Save, Trash2, X } from "lucide-react";
import MediaInput from "@/components/website/MediaInput";

const API = import.meta.env.VITE_BACKEND_URL || "";

type Theme = "festive" | "rose" | "emerald" | "midnight";
type Status = "scheduled" | "live" | "ended" | "paused";

interface Offer {
  _id?: string;
  name: string;
  startDate: string;
  endDate: string;
  active: boolean;
  theme: Theme;
  showBar: boolean;
  showPopup: boolean;
  content: { eyebrow: string | null; headline: string; body: string | null; image: string | null; ctaLabel: string; ctaHref: string };
  popup: { delaySeconds: number; frequency: "session" | "day" };
  status?: Status;
}

/** Preview colours. Mirror customer/app/globals.css `.offer-theme-*`. */
const THEMES: { key: Theme; label: string; a: string; b: string; glow: string }[] = [
  { key: "festive", label: "Festive maroon", a: "#5c0b26", b: "#9d1747", glow: "#f2c66d" },
  { key: "rose", label: "Rose", a: "#8a1846", b: "#b62a63", glow: "#ffd3e3" },
  { key: "emerald", label: "Emerald", a: "#08402f", b: "#0f6e50", glow: "#f2c66d" },
  { key: "midnight", label: "Midnight", a: "#17153a", b: "#3b2d78", glow: "#f2c66d" },
];

const STATUS_STYLE: Record<Status, string> = {
  live: "bg-emerald-100 text-emerald-800",
  scheduled: "bg-amber-100 text-amber-800",
  paused: "bg-stone-200 text-stone-700",
  ended: "bg-stone-100 text-stone-500",
};
const STATUS_LABEL: Record<Status, string> = { live: "Live now", scheduled: "Scheduled", paused: "Paused", ended: "Ended" };

const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const nice = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const blank = (): Offer => ({
  name: "",
  startDate: todayIST(),
  endDate: todayIST(),
  active: true,
  theme: "festive",
  showBar: true,
  showPopup: true,
  content: { eyebrow: "Festive offer", headline: "", body: null, image: null, ctaLabel: "See the offer", ctaHref: "/offers/karva-chauth" },
  popup: { delaySeconds: 6, frequency: "day" },
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/website${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Request failed");
  return d as T;
}

const inputClass =
  "w-full h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 placeholder:text-stone-400";
const labelClass = "block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider";

export default function WebsiteOffers() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [editing, setEditing] = useState<Offer | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** Deleting is permanent, so the bin asks once more. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = () =>
    api<Offer[]>("/campaigns")
      .then(setOffers)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      const { _id, name, startDate, endDate, active, theme, showBar, showPopup, content, popup } = editing;
      const body = { name, startDate, endDate, active, theme, showBar, showPopup, content, popup };
      await api(_id ? `/campaigns/${_id}` : "/campaigns", { method: _id ? "PATCH" : "POST", body: JSON.stringify(body) });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function togglePause(o: Offer) {
    try {
      await api(`/campaigns/${o._id}`, { method: "PATCH", body: JSON.stringify({ active: !o.active }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    }
  }

  async function remove(id: string) {
    try {
      await api(`/campaigns/${id}`, { method: "DELETE" });
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  const set = (patch: Partial<Offer>) => editing && setEditing({ ...editing, ...patch });
  const setContent = (patch: Partial<Offer["content"]>) => editing && setEditing({ ...editing, content: { ...editing.content, ...patch } });
  const theme = THEMES.find((t) => t.key === editing?.theme) ?? THEMES[0];

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="max-w-3xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
            <Megaphone className="w-6 h-6 text-amber-500" /> Website Offers
          </h2>
          <p className="text-sm text-stone-500 mt-1">
            While an offer runs, the website shows a colourful bar on every page and, if you want, a pop-up with your poster. It
            switches on and off by itself on the dates you choose (Patiala time).
          </p>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(blank())}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-stone-900 text-white text-sm font-semibold hover:bg-stone-800"
          >
            <Plus className="w-4 h-4" /> New offer
          </button>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {editing && (
        <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-stone-900">{editing._id ? "Edit offer" : "New offer"}</h3>
            <button onClick={() => setEditing(null)} aria-label="Close editor" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Live preview of the bar */}
          <div>
            <span className={labelClass}>Preview</span>
            <div
              className="rounded-lg px-4 py-2.5 text-white text-sm flex items-center gap-3 overflow-hidden"
              style={{ background: `linear-gradient(110deg, ${theme.a}, ${theme.b} 45%, ${theme.a})` }}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: theme.glow }} />
              {editing.content.eyebrow && (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shrink-0" style={{ background: theme.glow, color: theme.a }}>
                  {editing.content.eyebrow}
                </span>
              )}
              <span className="font-semibold truncate">{editing.content.headline || "Your headline"}</span>
              <span className="ml-auto shrink-0 opacity-90 hidden sm:inline">
                Till {nice(editing.endDate)} · {editing.content.ctaLabel || "See the offer"} →
              </span>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div className="sm:col-span-3">
              <label className={labelClass}>Offer name (only staff see this)</label>
              <input value={editing.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="e.g. Karva Chauth 2026" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Starts</label>
              <input type="date" value={editing.startDate} onChange={(e) => set({ startDate: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Ends (last day)</label>
              <input type="date" value={editing.endDate} min={editing.startDate} onChange={(e) => set({ endDate: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Colour</label>
              <div className="flex gap-2 h-11 items-center">
                {THEMES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => set({ theme: t.key })}
                    aria-label={t.label}
                    aria-pressed={editing.theme === t.key}
                    title={t.label}
                    className={`h-9 w-9 rounded-full border-2 ${editing.theme === t.key ? "border-stone-900" : "border-transparent"}`}
                    style={{ background: `linear-gradient(135deg, ${t.a}, ${t.b})` }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>Small label</label>
              <input value={editing.content.eyebrow ?? ""} onChange={(e) => setContent({ eyebrow: e.target.value || null })} maxLength={30} placeholder="Festive offer" className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Headline</label>
              <input value={editing.content.headline} onChange={(e) => setContent({ headline: e.target.value })} maxLength={90} placeholder="Karva Chauth glow: hair, skin and makeup for ₹2,500" className={inputClass} />
            </div>
            <div className="sm:col-span-3">
              <label className={labelClass}>Details (pop-up only, optional)</label>
              <textarea
                value={editing.content.body ?? ""}
                onChange={(e) => setContent({ body: e.target.value || null })}
                maxLength={220}
                rows={2}
                placeholder="What's included, who it's for"
                className="w-full px-4 py-2.5 rounded-xl border border-stone-200 bg-stone-50 text-sm"
              />
            </div>
            <div>
              <label className={labelClass}>Button text</label>
              <input value={editing.content.ctaLabel} onChange={(e) => setContent({ ctaLabel: e.target.value })} maxLength={30} className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Button goes to</label>
              <input list="offer-links" value={editing.content.ctaHref} onChange={(e) => setContent({ ctaHref: e.target.value })} placeholder="/offers/karva-chauth" className={inputClass} />
              <datalist id="offer-links">
                <option value="/offers/karva-chauth">Karva Chauth page</option>
                <option value="/services">Full menu</option>
                <option value="/services?for=her">Menu: for her</option>
                <option value="/services?for=him">Menu: for him</option>
              </datalist>
            </div>
          </div>

          <MediaInput
            label="Pop-up poster (optional)"
            folder="offers"
            value={editing.content.image}
            onChange={(u) => setContent({ image: u })}
            hint="Upright or square image. Without a poster the pop-up uses the offer colour with your headline."
          />

          <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-stone-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={editing.showBar} onChange={(e) => set({ showBar: e.target.checked })} /> Show the bar on every page
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={editing.showPopup} onChange={(e) => set({ showPopup: e.target.checked })} /> Show a pop-up
            </label>
          </div>

          {editing.showPopup && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Pop-up appears after (seconds)</label>
                <input
                  type="number"
                  min={5}
                  max={60}
                  value={editing.popup.delaySeconds}
                  onChange={(e) => set({ popup: { ...editing.popup, delaySeconds: Math.min(60, Math.max(5, Number(e.target.value) || 5)) } })}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Show the pop-up</label>
                <select
                  value={editing.popup.frequency}
                  onChange={(e) => set({ popup: { ...editing.popup, frequency: e.target.value as "session" | "day" } })}
                  className={inputClass}
                >
                  <option value="day">Once a day per visitor</option>
                  <option value="session">Once per visit</option>
                </select>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="h-10 px-4 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !editing.name.trim() || !editing.content.headline.trim() || !editing.content.ctaHref.trim()}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-stone-900 text-white text-sm font-semibold hover:bg-stone-800 disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save offer
            </button>
          </div>
        </section>
      )}

      {!offers ? (
        !error && (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
          </div>
        )
      ) : offers.length === 0 ? (
        <p className="text-sm text-stone-500">No offers yet. Create one and it appears on the website on its start date.</p>
      ) : (
        <div className="space-y-3">
          {offers.map((o) => {
            const t = THEMES.find((x) => x.key === o.theme) ?? THEMES[0];
            return (
              <div key={o._id} className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-4 flex flex-wrap items-center gap-3">
                <span className="h-10 w-10 rounded-lg shrink-0" style={{ background: `linear-gradient(135deg, ${t.a}, ${t.b})` }} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-900">{o.name}</span>
                    {o.status && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[o.status]}`}>{STATUS_LABEL[o.status]}</span>}
                  </div>
                  <p className="text-sm text-stone-500 truncate">
                    {nice(o.startDate)} – {nice(o.endDate)} · {[o.showBar && "bar", o.showPopup && "pop-up"].filter(Boolean).join(" + ") || "hidden"} · {o.content.headline}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setEditing(o)} aria-label="Edit offer" className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => togglePause(o)}
                    aria-label={o.active ? "Pause offer" : "Resume offer"}
                    title={o.active ? "Pause" : "Resume"}
                    className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100"
                  >
                    {o.active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                  {confirmDelete === o._id ? (
                    <button onClick={() => remove(o._id!)} className="h-10 px-3 rounded-lg bg-red-600 text-white text-sm font-semibold">
                      Delete?
                    </button>
                  ) : (
                    <button onClick={() => setConfirmDelete(o._id!)} aria-label="Delete offer" className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
