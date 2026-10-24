/**
 * @file PosterReader.tsx
 * @description "Fill the bundles from a poster" (D63), inside an offer's Bundles section.
 *
 * The owner uploads a photo of the offer poster, presses "Read the poster", and gets a DRAFT:
 * each package with its price and every service line, each line already matched to the salon's
 * own menu where that is clear. She checks and changes anything, then adds the packages as
 * bundles. Nothing is saved by reading, and nothing reaches the website until she saves the
 * offer; the server checks every price against the real menu again at that moment.
 *
 * The reading is done by an AI model on the server (a few rupees per poster) and can be wrong
 * about a word or a price: that is why every line stays editable and unsure lines are marked.
 */

import { useMemo, useState } from "react";
import { Loader2, ScanText, Search, Trash2 } from "lucide-react";
import MediaInput from "@/components/website/MediaInput";

const API = import.meta.env.VITE_BACKEND_URL || "";

export interface PosterMenuService {
  _id: string;
  name: string;
  publicName?: string | null;
  publicPrice?: number | null;
  audience?: string | null;
}
export interface PosterBundle {
  name: string;
  description: string | null;
  audience: "her" | "him" | "unisex";
  serviceIds: string[];
  price: number;
}

interface Cand {
  serviceId: string;
  name: string;
  price: number;
  score: number;
}
interface DraftLine {
  line: string;
  match: Cand | null;
  candidates: Cand[];
}
interface DraftPackage {
  name: string;
  price: number | null;
  regularPrice: number | null;
  lines: DraftLine[];
}
interface Draft {
  title: string | null;
  notes: string[];
  packages: DraftPackage[];
}

/** What the owner can still change before adding. `serviceId` null = skip this line. */
interface EditLine {
  text: string;
  serviceId: string | null;
  candidates: Cand[];
  unsure: boolean;
}
interface EditPackage {
  use: boolean;
  name: string;
  price: string;
  regularPrice: number | null;
  lines: EditLine[];
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const nameOf = (s: PosterMenuService) => s.publicName || s.name;
const field =
  "w-full h-10 px-3 rounded-lg border border-stone-200 bg-white text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400";

function toEditable(d: Draft, title: string | null): EditPackage[] {
  return d.packages.map((p) => ({
    use: true,
    name: (title && `${title} · ${p.name}`.length <= 60 ? `${title} · ${p.name}` : p.name).slice(0, 60),
    price: p.price != null ? String(p.price) : "",
    regularPrice: p.regularPrice,
    lines: p.lines.map((l) => ({ text: l.line, serviceId: l.match?.serviceId ?? null, candidates: l.candidates, unsure: !l.match })),
  }));
}

/** A tiny menu search for a line the reader could not match on its own. */
function LineSearch({ menu, onPick }: { menu: PosterMenuService[]; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const hits = q.trim() ? menu.filter((s) => `${s.name} ${s.publicName ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  return (
    <div className="relative">
      <Search className="absolute left-3 top-3 w-4 h-4 text-stone-400" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your menu…" className={`${field} pl-9`} />
      {hits.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full rounded-xl border border-stone-200 bg-white shadow-lg overflow-hidden">
          {hits.map((s) => (
            <li key={s._id}>
              <button
                type="button"
                onClick={() => {
                  onPick(s._id);
                  setQ("");
                }}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-left hover:bg-amber-50"
              >
                <span>{nameOf(s)}</span>
                <span className="text-stone-500 tabular-nums">{rupees(s.publicPrice ?? 0)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PosterReader({
  menu,
  onAddBundles,
  onAddPicture,
  canAddPicture,
}: {
  menu: PosterMenuService[];
  onAddBundles: (bundles: PosterBundle[]) => void;
  /** Lets the owner also use the poster as one of the offer page's pictures. */
  onAddPicture?: (url: string) => void;
  canAddPicture?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{ title: string | null; notes: string[] } | null>(null);
  const [pkgs, setPkgs] = useState<EditPackage[]>([]);
  const [done, setDone] = useState("");
  const byId = useMemo(() => new Map(menu.map((s) => [s._id, s])), [menu]);

  async function read() {
    if (!url) return;
    setReading(true);
    setError("");
    setDone("");
    setDraft(null);
    try {
      const res = await fetch(`${API}/api/website/campaigns/read-poster`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Reading the poster didn't work.");
      setDraft({ title: data.title ?? null, notes: data.notes ?? [] });
      setPkgs(toEditable(data as Draft, data.title ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reading the poster didn't work.");
    } finally {
      setReading(false);
    }
  }

  const setPkg = (i: number, patch: Partial<EditPackage>) => setPkgs((all) => all.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const setLine = (i: number, k: number, patch: Partial<EditLine>) =>
    setPkgs((all) => all.map((p, j) => (j === i ? { ...p, lines: p.lines.map((l, m) => (m === k ? { ...l, ...patch } : l)) } : p)));

  /** Why a package cannot be added yet, in plain words; null when it can. */
  function problem(p: EditPackage): string | null {
    const ids = [...new Set(p.lines.map((l) => l.serviceId).filter((x): x is string => Boolean(x)))];
    if (ids.length < 2) return "Pick at least two services from your menu.";
    const total = ids.reduce((n, id) => n + (byId.get(id)?.publicPrice ?? 0), 0);
    const price = Number(p.price);
    if (!p.name.trim()) return "Give the bundle a name.";
    if (!Number.isInteger(price) || price < 1) return "Enter the bundle price in whole rupees.";
    if (price >= total) return `The bundle price must be below ${rupees(total)}, what these services cost separately on your menu.`;
    return null;
  }

  function add() {
    const out: PosterBundle[] = [];
    for (const p of pkgs) {
      if (!p.use || problem(p)) continue;
      const ids = [...new Set(p.lines.map((l) => l.serviceId).filter((x): x is string => Boolean(x)))];
      const aud = new Set(ids.map((id) => byId.get(id)?.audience));
      out.push({
        name: p.name.trim().slice(0, 60),
        description: null,
        audience: aud.size === 1 && (aud.has("her") || aud.has("him")) ? ([...aud][0] as "her" | "him") : "unisex",
        serviceIds: ids,
        price: Number(p.price),
      });
    }
    if (!out.length) return;
    onAddBundles(out);
    setDone(`${out.length} bundle${out.length > 1 ? "s" : ""} added below. Check them, then save the offer.`);
    setDraft(null);
    setPkgs([]);
  }

  const addable = pkgs.filter((p) => p.use && !problem(p)).length;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-4">
      <div>
        <h4 className="font-semibold text-stone-900 flex items-center gap-2">
          <ScanText className="w-4 h-4 text-amber-600" /> Fill the bundles from a poster
        </h4>
        <p className="mt-1 text-xs text-stone-600">
          Upload your offer poster. We read the packages, prices and services off it and match them to your menu. You check every line before anything is added.
        </p>
      </div>

      <MediaInput label="Poster picture" folder="offers" value={url} onChange={(u) => { setUrl(u); setDone(""); }} hint="A clear JPG, PNG or WebP of the poster, under 5 MB. A phone screenshot works." />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!url || reading}
          onClick={read}
          className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-stone-900 text-white text-sm font-semibold disabled:opacity-40 hover:bg-stone-800"
        >
          {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanText className="w-4 h-4" />} {reading ? "Reading…" : "Read the poster"}
        </button>
        {reading && <span className="text-xs text-stone-500">This takes about 15 to 30 seconds.</span>}
        {url && !reading && canAddPicture && onAddPicture && (
          <button type="button" onClick={() => onAddPicture(url)} className="text-xs font-semibold text-stone-700 underline">
            Also use this poster as an offer page picture
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {done && <p className="text-sm text-emerald-700 font-medium">{done}</p>}

      {draft && (
        <div className="space-y-4">
          {draft.title && <p className="text-sm text-stone-700">Poster title: <b>{draft.title}</b></p>}
          {draft.notes.length > 0 && (
            <ul className="rounded-lg border border-amber-300 bg-amber-100/60 px-3 py-2 text-xs text-amber-900 space-y-1">
              {draft.notes.map((n, i) => (
                <li key={i}>⚠ {n}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-stone-600">
            Lines marked <span className="font-semibold text-amber-700">check</span> could not be matched for sure. Choose the right service, or remove the line. Poster prices are copied as printed.
          </p>

          {pkgs.map((p, i) => {
            const msg = p.use ? problem(p) : null;
            const ids = [...new Set(p.lines.map((l) => l.serviceId).filter((x): x is string => Boolean(x)))];
            const total = ids.reduce((n, id) => n + (byId.get(id)?.publicPrice ?? 0), 0);
            return (
              <div key={i} className={`rounded-xl border bg-white p-4 space-y-3 ${p.use ? "border-stone-200" : "border-stone-100 opacity-60"}`}>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex items-center gap-2 text-sm font-semibold text-stone-800 pb-2.5">
                    <input type="checkbox" checked={p.use} onChange={(e) => setPkg(i, { use: e.target.checked })} /> Add
                  </label>
                  <div className="flex-1 basis-48">
                    <label className="block text-xs font-semibold text-stone-600 mb-1 uppercase tracking-wider">Bundle name</label>
                    <input value={p.name} maxLength={60} onChange={(e) => setPkg(i, { name: e.target.value })} className={field} />
                  </div>
                  <div className="w-36">
                    <label className="block text-xs font-semibold text-stone-600 mb-1 uppercase tracking-wider">Price (₹)</label>
                    <input value={p.price} inputMode="numeric" onChange={(e) => setPkg(i, { price: e.target.value.replace(/\D/g, "") })} className={field} />
                  </div>
                </div>
                {p.regularPrice != null && <p className="text-xs text-stone-500">The poster shows {rupees(p.regularPrice)} crossed out. We don't copy that: the website works out the saving from your menu prices.</p>}

                <ul className="space-y-2">
                  {p.lines.map((l, k) => (
                    <li key={k} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_1fr_auto] sm:items-center">
                      <span className="text-sm text-stone-600 italic">
                        “{l.text}” {l.unsure && !l.serviceId && <span className="not-italic text-xs font-semibold text-amber-700">check</span>}
                      </span>
                      {l.serviceId ? (
                        <select value={l.serviceId} onChange={(e) => setLine(i, k, { serviceId: e.target.value || null })} className={field}>
                          {l.serviceId && !l.candidates.some((c) => c.serviceId === l.serviceId) && byId.get(l.serviceId) && (
                            <option value={l.serviceId}>{nameOf(byId.get(l.serviceId)!)} — {rupees(byId.get(l.serviceId)!.publicPrice ?? 0)}</option>
                          )}
                          {l.candidates.map((c) => (
                            <option key={c.serviceId} value={c.serviceId}>
                              {c.name} — {rupees(c.price)}
                            </option>
                          ))}
                          <option value="">Not on my menu (leave out)</option>
                        </select>
                      ) : (
                        <div className="space-y-1.5">
                          {l.candidates.length > 0 && (
                            <select value="" onChange={(e) => setLine(i, k, { serviceId: e.target.value || null })} className={field}>
                              <option value="">Choose the right service…</option>
                              {l.candidates.map((c) => (
                                <option key={c.serviceId} value={c.serviceId}>
                                  {c.name} — {rupees(c.price)}
                                </option>
                              ))}
                            </select>
                          )}
                          <LineSearch menu={menu} onPick={(id) => setLine(i, k, { serviceId: id })} />
                        </div>
                      )}
                      <button
                        type="button"
                        aria-label="Leave this line out"
                        onClick={() => setPkg(i, { lines: p.lines.filter((_, m) => m !== k) })}
                        className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-2 text-sm">
                  <span className="text-stone-600">
                    {ids.length} service{ids.length === 1 ? "" : "s"} · {rupees(total)} separately on your menu
                  </span>
                  {msg && <span className="text-red-600 text-xs">{msg}</span>}
                </div>
              </div>
            );
          })}

          <button
            type="button"
            disabled={addable === 0}
            onClick={add}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-emerald-600 text-white text-sm font-semibold disabled:opacity-40 hover:bg-emerald-700"
          >
            Add {addable} bundle{addable === 1 ? "" : "s"} to this offer
          </button>
          <p className="text-xs text-stone-500">Nothing is saved yet. The bundles appear below for one last look, and the offer is saved when you press Save.</p>
        </div>
      )}
    </div>
  );
}
