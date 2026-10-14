/**
 * @file ArtistSkills.tsx
 * @description Which artist may be booked for which services (CF D35).
 *
 * Two levels, so the owner sets a few rules instead of every artist × every
 * service:
 *   - a rule per gender (women / men / other artists), used by every artist
 *     who follows it;
 *   - an artist's own rule, which replaces their gender's rule.
 * A rule is "all services", or any mix of whole sections (Threading), menu
 * sub-groups (Face waxing) and single services. Everyone starts on "all".
 *
 * Working hours are the salon's (9 am – 9 pm, closed Tuesday, set in Website
 * Settings) for every artist until individual schedules are added in Phase 2.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Check, ChevronDown, Loader2, Save, UserCog, Users } from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";

type Gender = "female" | "male" | "other";
interface Rule {
  all: boolean;
  categories: string[];
  groups: string[];
  services: string[];
}
interface TreeService {
  _id: string;
  name: string;
  audience: string | null;
}
interface TreeGroup {
  slug: string;
  title: string;
  services: TreeService[];
}
interface TreeSection {
  category: string;
  groups: TreeGroup[];
}
interface ArtistRow {
  _id: string;
  name: string;
  gender: Gender | null;
  skillMode: "inherit" | "custom";
  rule: Rule | null;
  allowed: number;
}
interface Data {
  defaults: Record<Gender, Rule>;
  defaultsAllowed: Record<Gender, number>;
  artists: ArtistRow[];
  tree: TreeSection[];
  totalServices: number;
}

const GENDERS: [Gender, string][] = [
  ["female", "Women artists"],
  ["male", "Men artists"],
  ["other", "Other / not set"],
];
const genderOf = (g: Gender | null): Gender => (g === "female" || g === "male" ? g : "other");
const ruleName = (g: Gender) => ({ female: "women's", male: "men's", other: "default" })[g];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/artist-skills${path}`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Request failed");
  return d as T;
}

type Selection = { kind: "gender"; gender: Gender } | { kind: "artist"; id: string };

export default function ArtistSkills() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Selection>({ kind: "gender", gender: "female" });
  const [draft, setDraft] = useState<Rule | null>(null);
  const [mode, setMode] = useState<"inherit" | "custom">("inherit");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  const load = () =>
    api<Data>("/")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const artist = sel.kind === "artist" ? data?.artists.find((a) => a._id === sel.id) : undefined;

  // Load the editor whenever the selection or the data changes.
  useEffect(() => {
    if (!data) return;
    setSaved("");
    if (sel.kind === "gender") {
      setMode("custom");
      setDraft(structuredClone(data.defaults[sel.gender]));
    } else if (artist) {
      setMode(artist.skillMode);
      setDraft(structuredClone(artist.rule ?? data.defaults[genderOf(artist.gender)]));
    }
  }, [data, sel, artist]);

  const editing = draft ?? { all: true, categories: [], groups: [], services: [] };
  const readOnly = sel.kind === "artist" && mode === "inherit";

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      if (sel.kind === "gender") await api(`/defaults/${sel.gender}`, { method: "PATCH", body: JSON.stringify({ rule: draft }) });
      else await api(`/${sel.id}`, { method: "PATCH", body: JSON.stringify(mode === "inherit" ? { mode } : { mode, rule: draft }) });
      await load();
      setSaved("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return (
      <div className="flex justify-center py-16">{error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="w-6 h-6 animate-spin text-stone-400" />}</div>
    );
  }

  const title =
    sel.kind === "gender" ? GENDERS.find(([g]) => g === sel.gender)![1] : artist ? `${artist.name}` : "";

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="max-w-6xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <UserCog className="w-6 h-6 text-amber-500" /> Artist skills
        </h2>
        <p className="text-sm text-stone-500 mt-1">
          Who can be booked for which services. Set a rule for all women or all men artists, and give any artist their own rule.
          Everyone can do everything until you change it. Working hours follow the salon's hours (Website Settings).
        </p>
      </div>
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        {/* Left: gender rules + artists */}
        <aside className="space-y-5">
          <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-2">
            <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-stone-500 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> By gender
            </p>
            {GENDERS.map(([g, label]) => (
              <button
                key={g}
                onClick={() => setSel({ kind: "gender", gender: g })}
                className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center justify-between gap-2 ${
                  sel.kind === "gender" && sel.gender === g ? "bg-amber-50 text-amber-900" : "hover:bg-stone-50"
                }`}
              >
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs text-stone-500 tabular-nums">
                  {data.defaults[g].all ? "All services" : `${data.defaultsAllowed[g]} / ${data.totalServices}`}
                </span>
              </button>
            ))}
          </section>
          <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-2">
            <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-stone-500">Artists ({data.artists.length})</p>
            {data.artists.length === 0 && <p className="px-3 py-2 text-sm text-stone-400">No active artists.</p>}
            {data.artists.map((a) => (
              <button
                key={a._id}
                onClick={() => setSel({ kind: "artist", id: a._id })}
                className={`w-full text-left px-3 py-2.5 rounded-lg ${sel.kind === "artist" && sel.id === a._id ? "bg-amber-50 text-amber-900" : "hover:bg-stone-50"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{a.name}</span>
                  <span className="text-xs text-stone-500 tabular-nums shrink-0">
                    {a.allowed === data.totalServices ? "All" : `${a.allowed} / ${data.totalServices}`}
                  </span>
                </span>
                <span className="block text-xs text-stone-400">
                  {a.skillMode === "custom" ? "Own rule" : `Follows the ${ruleName(genderOf(a.gender))} rule`}
                </span>
              </button>
            ))}
          </section>
        </aside>

        {/* Right: the editor */}
        <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="font-semibold text-stone-900">{title}</h3>
            <div className="flex items-center gap-3">
              {saved && <span className="text-sm text-emerald-700">{saved}</span>}
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-stone-900 text-white text-sm font-semibold hover:bg-stone-800 disabled:opacity-40"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
              </button>
            </div>
          </div>

          {sel.kind === "artist" && artist && (
            <div className="mb-5 flex flex-wrap gap-2">
              {(
                [
                  ["inherit", `Follow the ${ruleName(genderOf(artist.gender))} rule`],
                  ["custom", "Own rule"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`h-9 px-4 rounded-full border text-sm ${mode === m ? "bg-stone-900 text-white border-stone-900" : "border-stone-200 text-stone-700 hover:bg-stone-50"}`}
                >
                  {label}
                </button>
              ))}
              {!artist.gender && <span className="text-xs text-stone-400 self-center">Gender not set for this artist (Artists page).</span>}
            </div>
          )}

          <RuleEditor rule={editing} tree={data.tree} readOnly={readOnly} onChange={setDraft} />
        </section>
      </div>
    </motion.div>
  );
}

/** "All services", or a tree of sections → sub-groups → services to tick. */
function RuleEditor({ rule, tree, readOnly, onChange }: { rule: Rule; tree: TreeSection[]; readOnly: boolean; onChange: (r: Rule) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const set = (patch: Partial<Rule>) => !readOnly && onChange({ ...rule, ...patch });

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const sec of tree) {
      let n = 0;
      for (const g of sec.groups)
        for (const s of g.services) if (rule.all || rule.categories.includes(sec.category) || rule.groups.includes(g.slug) || rule.services.includes(s._id)) n++;
      out[sec.category] = n;
    }
    return out;
  }, [rule, tree]);

  return (
    <div className={readOnly ? "opacity-60 pointer-events-none select-none" : ""}>
      <label className="flex items-center gap-3 rounded-lg border border-stone-200 px-4 py-3 mb-4 cursor-pointer hover:bg-stone-50">
        <Box on={rule.all} onClick={() => set({ all: !rule.all })} />
        <span>
          <span className="text-sm font-semibold text-stone-900">All services</span>
          <span className="block text-xs text-stone-500">Untick to choose sections, sub-groups or single services.</span>
        </span>
      </label>

      {!rule.all && (
        <div className="space-y-2">
          {tree.map((sec) => {
            const secOn = rule.categories.includes(sec.category);
            const total = sec.groups.reduce((n, g) => n + g.services.length, 0);
            return (
              <div key={sec.category} className="rounded-lg border border-stone-200">
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <Box on={secOn} onClick={() => set({ categories: toggle(rule.categories, sec.category) })} />
                  <button onClick={() => setOpen({ ...open, [sec.category]: !open[sec.category] })} className="flex-1 flex items-center justify-between gap-2 text-left">
                    <span className="text-sm font-semibold text-stone-900">{sec.category}</span>
                    <span className="flex items-center gap-2 text-xs text-stone-500 tabular-nums">
                      {counts[sec.category]} / {total}
                      <ChevronDown className={`w-4 h-4 transition-transform ${open[sec.category] ? "rotate-180" : ""}`} />
                    </span>
                  </button>
                </div>
                {open[sec.category] && (
                  <div className="border-t border-stone-100 px-4 py-2 space-y-1">
                    {sec.groups.map((g) => {
                      const gOn = secOn || rule.groups.includes(g.slug);
                      const single = g.services.length === 1;
                      const key = `${sec.category}|${g.slug}`;
                      return (
                        <div key={g.slug}>
                          <div className="flex items-center gap-3 py-1.5 pl-4">
                            <Box
                              on={gOn || (single && rule.services.includes(g.services[0]._id))}
                              disabled={secOn}
                              onClick={() => (single ? set({ services: toggle(rule.services, g.services[0]._id) }) : set({ groups: toggle(rule.groups, g.slug) }))}
                            />
                            {single ? (
                              <span className="text-sm text-stone-800">{g.services[0].name}</span>
                            ) : (
                              <button onClick={() => setOpen({ ...open, [key]: !open[key] })} className="flex-1 flex items-center justify-between gap-2 text-left">
                                <span className="text-sm text-stone-800">{g.title}</span>
                                <span className="flex items-center gap-2 text-xs text-stone-400">
                                  {g.services.length} services <ChevronDown className={`w-4 h-4 transition-transform ${open[key] ? "rotate-180" : ""}`} />
                                </span>
                              </button>
                            )}
                          </div>
                          {!single && open[key] && (
                            <div className="pl-12 pb-1 space-y-1">
                              {g.services.map((s) => (
                                <div key={s._id} className="flex items-center gap-3 py-1">
                                  <Box on={gOn || rule.services.includes(s._id)} disabled={gOn} onClick={() => set({ services: toggle(rule.services, s._id) })} />
                                  <span className="text-sm text-stone-700">
                                    {s.name}
                                    {s.audience && s.audience !== "unisex" && <span className="text-xs text-stone-400"> · {s.audience === "her" ? "women" : "men"}</span>}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Checkbox; `disabled` = already covered by a ticked parent (shown ticked). */
function Box({ on, disabled = false, onClick }: { on: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`h-5 w-5 shrink-0 rounded-[5px] border flex items-center justify-center ${
        on ? "bg-stone-900 border-stone-900 text-white" : "border-stone-300 bg-white"
      } ${disabled ? "opacity-50" : ""}`}
    >
      {on && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
    </button>
  );
}
