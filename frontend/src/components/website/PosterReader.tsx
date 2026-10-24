/**
 * @file PosterReader.tsx
 * @description "Fill the packages from a poster" (D64), inside an offer's page section.
 *
 * The owner uploads a photo of the offer poster and presses "Read the poster". She gets a DRAFT:
 * each package with its ONE total price and the services listed under it, exactly as printed.
 * Each service is only CHECKED BY NAME against the salon's service list (found / similar names /
 * not found); there are no per-service prices and no price rules, because poster packages often
 * include services that are not on the list. She edits anything, then adds the packages to the
 * offer page. Nothing is saved by reading; it is saved when she saves the offer.
 *
 * The reading is done by an AI model on the server (a few rupees or less per poster) and can get
 * a word or a price wrong, which is why every name and price stays editable.
 */

import { useState } from "react";
import { Check, HelpCircle, Loader2, ScanText, Trash2 } from "lucide-react";
import MediaInput from "@/components/website/MediaInput";

const API = import.meta.env.VITE_BACKEND_URL || "";

export interface PosterPackage {
  name: string;
  price: number;
  services: string[];
  durationMinutes: number;
}

interface DraftService {
  text: string;
  menuName: string | null;
  similar: string[];
}
interface DraftPackage {
  name: string;
  price: number | null;
  services: DraftService[];
}

/** One package while the owner is checking it. `checked` keeps the name check only for lines she has not edited. */
interface EditLine {
  text: string;
  menuName: string | null;
  similar: string[];
  edited: boolean;
}
interface EditPackage {
  use: boolean;
  name: string;
  price: string;
  lines: EditLine[];
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const field =
  "w-full h-10 px-3 rounded-lg border border-stone-200 bg-white text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400";

function toEditable(packages: DraftPackage[], title: string | null): EditPackage[] {
  return packages.map((p) => ({
    use: true,
    name: (title && `${title} · ${p.name}`.length <= 60 ? `${title} · ${p.name}` : p.name).slice(0, 60),
    price: p.price != null ? String(p.price) : "",
    lines: p.services.map((s) => ({ text: s.text, menuName: s.menuName, similar: s.similar, edited: false })),
  }));
}

export default function PosterReader({
  onAddPackages,
  onAddPicture,
  canAddPicture,
}: {
  onAddPackages: (packages: PosterPackage[]) => void;
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
      setPkgs(toEditable(data.packages as DraftPackage[], data.title ?? null));
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
    if (!p.name.trim()) return "Give the package a name.";
    const price = Number(p.price);
    if (!Number.isInteger(price) || price < 1) return "Enter the package price in whole rupees.";
    if (!p.lines.some((l) => l.text.trim())) return "List at least one service.";
    return null;
  }

  function add() {
    const out: PosterPackage[] = pkgs
      .filter((p) => p.use && !problem(p))
      .map((p) => ({ name: p.name.trim().slice(0, 60), price: Number(p.price), services: p.lines.map((l) => l.text.trim()).filter(Boolean), durationMinutes: 120 }));
    if (!out.length) return;
    onAddPackages(out);
    setDone(`${out.length} package${out.length > 1 ? "s" : ""} added below. Check the time each one takes, then save the offer.`);
    setDraft(null);
    setPkgs([]);
  }

  const addable = pkgs.filter((p) => p.use && !problem(p)).length;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-4">
      <div>
        <h4 className="font-semibold text-stone-900 flex items-center gap-2">
          <ScanText className="w-4 h-4 text-amber-600" /> Fill the packages from a poster
        </h4>
        <p className="mt-1 text-xs text-stone-600">
          Upload your offer poster. We read each package's total price and the services listed under it. Each service name is checked against your service list. You check everything before it is added.
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
        {reading && <span className="text-xs text-stone-500">This takes about 10 to 30 seconds.</span>}
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
          {draft.title && (
            <p className="text-sm text-stone-700">
              Poster title: <b>{draft.title}</b>
            </p>
          )}
          {draft.notes.length > 0 && (
            <ul className="rounded-lg border border-amber-300 bg-amber-100/60 px-3 py-2 text-xs text-amber-900 space-y-1">
              {draft.notes.map((n, i) => (
                <li key={i}>⚠ {n}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-stone-600">
            Each service shows whether its name is on your service list. <b>Not on your list is fine</b>: the package keeps it as printed. Fix any wording or price the reader got wrong.
          </p>

          {pkgs.map((p, i) => {
            const msg = p.use ? problem(p) : null;
            return (
              <div key={i} className={`rounded-xl border bg-white p-4 space-y-3 ${p.use ? "border-stone-200" : "border-stone-100 opacity-60"}`}>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex items-center gap-2 text-sm font-semibold text-stone-800 pb-2.5">
                    <input type="checkbox" checked={p.use} onChange={(e) => setPkg(i, { use: e.target.checked })} /> Add
                  </label>
                  <div className="flex-1 basis-48">
                    <label className="block text-xs font-semibold text-stone-600 mb-1 uppercase tracking-wider">Package name</label>
                    <input value={p.name} maxLength={60} onChange={(e) => setPkg(i, { name: e.target.value })} className={field} />
                  </div>
                  <div className="w-40">
                    <label className="block text-xs font-semibold text-stone-600 mb-1 uppercase tracking-wider">Total price (₹)</label>
                    <input value={p.price} inputMode="numeric" onChange={(e) => setPkg(i, { price: e.target.value.replace(/\D/g, "") })} className={field} />
                  </div>
                </div>

                <ul className="space-y-2">
                  {p.lines.map((l, k) => (
                    <li key={k} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-center">
                      <input
                        value={l.text}
                        maxLength={80}
                        onChange={(e) => setLine(i, k, { text: e.target.value, edited: true })}
                        aria-label={`Service ${k + 1}`}
                        className={field}
                      />
                      <span className="text-xs">
                        {l.edited ? (
                          <span className="text-stone-400">Checked when you save</span>
                        ) : l.menuName ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <Check className="w-3.5 h-3.5" /> On your list{l.menuName.toLowerCase().replace(/[^a-z0-9]/g, "") !== l.text.toLowerCase().replace(/[^a-z0-9]/g, "") ? `: ${l.menuName}` : ""}
                          </span>
                        ) : l.similar.length ? (
                          <span className="inline-flex items-start gap-1 text-amber-700">
                            <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Several on your list: {l.similar.join(", ")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-stone-500">
                            <HelpCircle className="w-3.5 h-3.5" /> Not on your list (kept as printed)
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        aria-label="Leave this service out"
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
                    {p.lines.filter((l) => l.text.trim()).length} services · {p.price ? rupees(Number(p.price)) : "no price yet"}
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
            Add {addable} package{addable === 1 ? "" : "s"} to the offer page
          </button>
          <p className="text-xs text-stone-500">Nothing is saved yet. The packages appear below for one last look, and the offer is saved when you press Save.</p>
        </div>
      )}
    </div>
  );
}
