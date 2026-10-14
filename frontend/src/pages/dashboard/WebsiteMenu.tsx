/**
 * @file WebsiteMenu.tsx
 * @description What each service looks like on the customer website (owner,
 * website.manage). The internal name, list price and category stay in
 * Service Management; this screen edits only the public layer:
 *
 *   - on the website or not, and "Signature" (featured on the home page);
 *   - website name, one-line description, full description;
 *   - for her / him / everyone, website category, sort order;
 *   - "Consultation first" and "Patch test 48h before" badges;
 *   - website price — normally half the list price (D12); change it only for
 *     an exception;
 *   - the service's own photo (uploaded to Vercel Blob). It replaces the
 *     stock photo on the website; removing it brings the stock photo back.
 *
 * Switching a service on fills in a URL name and the half price if they are
 * empty. Every save is audited and refreshes the website within seconds.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Loader2, Search, Sparkles, Store } from "lucide-react";
import MediaInput from "@/components/website/MediaInput";

const API = import.meta.env.VITE_BACKEND_URL || "";

const CATEGORIES = ["Hair", "Colour", "Treatments", "Skin", "Waxing", "Threading", "Hands & feet", "Makeup", "Grooming"];
const AUDIENCES = [
  ["her", "For her"],
  ["him", "For him"],
  ["unisex", "Everyone"],
] as const;

interface WebService {
  _id: string;
  name: string;
  category?: string;
  price: number;
  durationMinutes?: number | null;
  showOnWebsite?: boolean;
  featured?: boolean;
  slug?: string;
  publicName?: string | null;
  publicPrice?: number | null;
  audience?: "her" | "him" | "unisex" | null;
  displayCategory?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  bookingMode?: string;
  requiresConsultation?: boolean;
  requiresPatchTest?: boolean;
  sortOrder?: number;
  images?: string[];
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const input = "w-full h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50";
const labelCls = "block text-[11px] font-semibold text-stone-500 mb-1 uppercase tracking-wider";

export default function WebsiteMenu() {
  const [services, setServices] = useState<WebService[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off" | "featured">("all");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/api/website/services`, { credentials: "include" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed to load");
        setServices(d);
      })
      .catch((e) => setError(e.message));
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (services ?? []).filter(
      (s) =>
        (!needle || s.name.toLowerCase().includes(needle) || (s.publicName ?? "").toLowerCase().includes(needle)) &&
        (filter === "all" ||
          (filter === "on" && s.showOnWebsite) ||
          (filter === "off" && !s.showOnWebsite) ||
          (filter === "featured" && s.featured))
    );
  }, [services, q, filter]);

  const onCount = (services ?? []).filter((s) => s.showOnWebsite).length;

  async function save(s: WebService, patch: Partial<WebService>) {
    const res = await fetch(`${API}/api/website/services/${s._id}/public`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Failed to save");
    setServices((list) => list?.map((x) => (x._id === s._id ? { ...x, ...d } : x)) ?? null);
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <Store className="w-6 h-6 text-amber-500" /> Website Menu
        </h2>
        <p className="text-sm text-stone-500 mt-0.5">
          Choose what customers see on the website and how it reads. {services && `${onCount} of ${services.length} services are on the website.`}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <label className="relative flex-1 min-w-56">
          <Search className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services" className={`${input} pl-9`} />
        </label>
        {(
          [
            ["all", "All"],
            ["on", "On website"],
            ["off", "Not on website"],
            ["featured", "Signature"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`h-10 px-4 rounded-full text-sm border ${filter === k ? "bg-stone-900 text-white border-stone-900" : "bg-white border-stone-200 text-stone-600"}`}
          >
            {l}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}
      {!services ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-stone-200/80 shadow-sm divide-y divide-stone-100">
          {shown.map((s) => (
            <Row key={s._id} s={s} open={open === s._id} onToggle={() => setOpen(open === s._id ? null : s._id)} save={save} />
          ))}
          {!shown.length && <p className="p-6 text-sm text-stone-500">No services match.</p>}
        </div>
      )}
    </motion.div>
  );
}

function Row({
  s,
  open,
  onToggle,
  save,
}: {
  s: WebService;
  open: boolean;
  onToggle: () => void;
  save: (s: WebService, patch: Partial<WebService>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<Partial<WebService>>({});
  const v = { ...s, ...draft };
  const half = Math.round(s.price * 0.5);

  async function run(patch: Partial<WebService>) {
    setBusy(true);
    setErr("");
    try {
      await save(s, patch);
      setDraft({});
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function toggleOnWebsite() {
    if (s.showOnWebsite) return run({ showOnWebsite: false });
    // Going live needs a URL name and a website price; fill sensible ones in.
    return run({
      showOnWebsite: true,
      ...(s.slug ? {} : { slug: slugify(s.publicName || s.name) }),
      ...(s.publicPrice == null ? { publicPrice: half } : {}),
      ...(!s.bookingMode || s.bookingMode === "hidden" ? { bookingMode: "request" } : {}),
    });
  }

  const set = (k: keyof WebService, value: unknown) => setDraft((d) => ({ ...d, [k]: value }));

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onToggle} className="flex-1 min-w-48 text-left flex items-center gap-2">
          <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`} />
          <span>
            <span className="text-sm font-medium text-stone-900">{s.publicName || s.name}</span>
            {s.publicName && s.publicName !== s.name && <span className="text-xs text-stone-400"> · {s.name}</span>}
            <span className="block text-xs text-stone-500">
              {[s.displayCategory, s.audience === "her" ? "For her" : s.audience === "him" ? "For him" : s.audience ? "Everyone" : null]
                .filter(Boolean)
                .join(" · ") || "No website category yet"}
            </span>
          </span>
        </button>
        <span className="text-sm tabular-nums text-stone-600">
          ₹{(s.publicPrice ?? half).toLocaleString("en-IN")}
          <span className="text-xs text-stone-400"> (list ₹{s.price.toLocaleString("en-IN")})</span>
        </span>
        <button
          disabled={busy || !s.showOnWebsite}
          onClick={() => run({ featured: !s.featured })}
          title="Signature: shown in the home page's signature services"
          className={`inline-flex items-center gap-1 h-8 px-3 rounded-full text-xs border disabled:opacity-40 ${
            s.featured ? "bg-amber-50 border-amber-300 text-amber-800" : "border-stone-200 text-stone-500"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" /> Signature
        </button>
        <button
          disabled={busy}
          onClick={toggleOnWebsite}
          className={`h-8 px-3 rounded-full text-xs font-semibold border disabled:opacity-50 ${
            s.showOnWebsite ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "border-stone-200 text-stone-500"
          }`}
        >
          {busy ? "Saving…" : s.showOnWebsite ? "On website" : "Not on website"}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}

      {open && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 pl-6">
          <div className="sm:col-span-2">
            <label className={labelCls}>Website name</label>
            <input className={input} value={v.publicName ?? ""} placeholder={s.name} onChange={(e) => set("publicName", e.target.value || null)} />
          </div>
          <div>
            <label className={labelCls}>Who it's for</label>
            <select className={input} value={v.audience ?? ""} onChange={(e) => set("audience", e.target.value || null)}>
              <option value="">—</option>
              {AUDIENCES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Website category</label>
            <select className={input} value={v.displayCategory ?? ""} onChange={(e) => set("displayCategory", e.target.value || null)}>
              <option value="">—</option>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <label className={labelCls}>One line for the menu (up to 160 characters)</label>
            <input
              className={input}
              maxLength={160}
              value={v.shortDescription ?? ""}
              placeholder="e.g. Frizz-free, glossy hair for up to 4 months."
              onChange={(e) => set("shortDescription", e.target.value || null)}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <label className={labelCls}>Full description (service page)</label>
            <textarea
              className={`${input} h-24 py-2`}
              maxLength={4000}
              value={v.description ?? ""}
              onChange={(e) => set("description", e.target.value || null)}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <MediaInput
              label="Website photo (optional)"
              folder="services"
              value={v.images?.[0] ?? null}
              onChange={(u) => set("images", u ? [u] : [])}
              hint="Replaces the stock photo on the website. Shown 3:2 (landscape), so keep the face or hands near the centre. Remove it to go back to the stock photo."
            />
          </div>
          <div>
            <label className={labelCls}>Website price (₹)</label>
            <input
              className={input}
              inputMode="numeric"
              value={v.publicPrice ?? ""}
              placeholder={String(half)}
              onChange={(e) => set("publicPrice", e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")))}
            />
            <p className="mt-1 text-[11px] text-stone-400">Normally half the list price: ₹{half.toLocaleString("en-IN")}</p>
          </div>
          <div>
            <label className={labelCls}>Order in its category</label>
            <input className={input} inputMode="numeric" value={v.sortOrder ?? 0} onChange={(e) => set("sortOrder", Number(e.target.value.replace(/\D/g, "")) || 0)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-stone-700 self-end h-10">
            <input type="checkbox" checked={Boolean(v.requiresConsultation)} onChange={(e) => set("requiresConsultation", e.target.checked)} />
            Consultation first
          </label>
          <label className="flex items-center gap-2 text-sm text-stone-700 self-end h-10">
            <input type="checkbox" checked={Boolean(v.requiresPatchTest)} onChange={(e) => set("requiresPatchTest", e.target.checked)} />
            Patch test 48h before
          </label>
          <div className="sm:col-span-2 lg:col-span-4 flex gap-2">
            <button
              disabled={busy || !Object.keys(draft).length}
              onClick={() => run(draft)}
              className="h-10 px-5 rounded-lg bg-stone-900 text-white text-sm font-medium disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            {Object.keys(draft).length > 0 && (
              <button onClick={() => setDraft({})} className="h-10 px-4 rounded-lg text-sm text-stone-500 hover:bg-stone-100">
                Discard
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
