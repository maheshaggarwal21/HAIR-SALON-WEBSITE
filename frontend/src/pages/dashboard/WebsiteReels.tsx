/**
 * @file WebsiteReels.tsx
 * @description The website's reels wall (T1.20, website.manage). Upload a
 * short 9:16 video (or paste a link), add a caption, optionally tag the
 * service it shows ("Request this look"), hide or delete. The website shows up
 * to 9 visible reels in this order.
 *
 * Keep videos short and small — under ~8 MB, 720p — so they load quickly on
 * phones (DS §9).
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Clapperboard, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import MediaInput from "@/components/website/MediaInput";

const API = import.meta.env.VITE_BACKEND_URL || "";

interface Reel {
  _id: string;
  mediaUrl: string;
  mediaType: "video" | "image";
  thumbnailUrl: string | null;
  caption: string | null;
  visible: boolean;
  serviceId: string | null;
  sortOrder: number;
  permalink: string | null;
}
interface Svc {
  _id: string;
  name: string;
  publicName?: string | null;
  showOnWebsite?: boolean;
}

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

export default function WebsiteReels() {
  const [reels, setReels] = useState<Reel[] | null>(null);
  const [services, setServices] = useState<Svc[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{ mediaUrl: string | null; caption: string; serviceId: string; permalink: string | null }>({
    mediaUrl: null,
    caption: "",
    serviceId: "",
    permalink: null,
  });
  const [adding, setAdding] = useState(false);
  /** Deleting is permanent, so the bin asks once more. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    api<Reel[]>("/reels").then(setReels).catch((e) => setError(e.message));
    api<Svc[]>("/services")
      .then((s) => setServices(s.filter((x) => x.showOnWebsite)))
      .catch(() => setServices([]));
  }, []);

  async function add() {
    if (!draft.mediaUrl) return;
    setAdding(true);
    setError("");
    try {
      const reel = await api<Reel>("/reels", {
        method: "POST",
        body: JSON.stringify({
          mediaUrl: draft.mediaUrl,
          mediaType: /\.(mp4|webm)(\?|$)/i.test(draft.mediaUrl) ? "video" : "image",
          caption: draft.caption || null,
          serviceId: draft.serviceId || null,
          permalink: draft.permalink,
          sortOrder: (reels?.length ?? 0) * 10,
        }),
      });
      setReels((r) => [...(r ?? []), reel]);
      setDraft({ mediaUrl: null, caption: "", serviceId: "", permalink: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  }

  async function update(r: Reel, patch: Partial<Reel>) {
    try {
      const out = await api<Reel>(`/reels/${r._id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setReels((list) => list?.map((x) => (x._id === r._id ? out : x)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  }

  async function remove(r: Reel) {
    try {
      await api(`/reels/${r._id}`, { method: "DELETE" });
      setReels((list) => list?.filter((x) => x._id !== r._id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  const svcName = (id: string | null) => {
    const s = services.find((x) => x._id === id);
    return s ? s.publicName || s.name : null;
  };

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <Clapperboard className="w-6 h-6 text-amber-500" /> Website Reels
        </h2>
        <p className="text-sm text-stone-500 mt-0.5">
          Short videos of real work for the home page. Upright (9:16), under about 8 MB. Only post clients who agreed to be shown.
        </p>
      </div>

      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-6 space-y-3">
        <h3 className="font-semibold text-stone-900">Add a reel</h3>
        <MediaInput label="Video or photo" value={draft.mediaUrl} onChange={(u) => setDraft({ ...draft, mediaUrl: u })} kind="any" folder="reels" />
        <div className="grid sm:grid-cols-2 gap-3">
          <input
            value={draft.caption}
            maxLength={300}
            onChange={(e) => setDraft({ ...draft, caption: e.target.value })}
            placeholder="Caption, e.g. Balayage on long hair"
            className="h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
          />
          <select
            value={draft.serviceId}
            onChange={(e) => setDraft({ ...draft, serviceId: e.target.value })}
            className="h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
          >
            <option value="">Service shown (optional)</option>
            {services.map((s) => (
              <option key={s._id} value={s._id}>
                {s.publicName || s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={add}
          disabled={!draft.mediaUrl || adding}
          className="inline-flex items-center gap-2 h-10 px-5 rounded-lg bg-stone-900 text-white text-sm font-medium disabled:opacity-40"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add reel
        </button>
      </section>

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

      {!reels ? (
        <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
      ) : reels.length === 0 ? (
        <p className="text-sm text-stone-500">No reels yet. The reels section stays hidden on the website until you add one.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {reels.map((r) => (
            <div key={r._id} className={`bg-white rounded-xl border border-stone-200/80 shadow-sm overflow-hidden ${r.visible ? "" : "opacity-60"}`}>
              <div className="aspect-[9/16] bg-stone-100">
                {r.mediaType === "video" ? (
                  <video src={r.mediaUrl} muted playsInline controls preload="metadata" className="w-full h-full object-cover" />
                ) : (
                  <img src={r.mediaUrl} alt="" className="w-full h-full object-cover" />
                )}
              </div>
              <div className="p-3 space-y-2">
                <input
                  defaultValue={r.caption ?? ""}
                  maxLength={300}
                  placeholder="Caption"
                  onBlur={(e) => e.target.value !== (r.caption ?? "") && update(r, { caption: e.target.value || null })}
                  className="w-full h-9 px-2 rounded-lg border border-stone-200 bg-stone-50 text-xs"
                />
                {svcName(r.serviceId) && <p className="text-[11px] text-stone-500 truncate">Shows: {svcName(r.serviceId)}</p>}
                <div className="flex gap-1.5">
                  <button
                    onClick={() => update(r, { visible: !r.visible })}
                    className="flex-1 inline-flex items-center justify-center gap-1 h-8 rounded-lg border border-stone-200 text-xs text-stone-700"
                  >
                    {r.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />} {r.visible ? "Shown" : "Hidden"}
                  </button>
                  {confirmDelete === r._id ? (
                    <button onClick={() => remove(r)} className="h-8 px-2 rounded-lg bg-red-600 text-white text-xs font-medium">
                      Delete?
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(r._id)}
                      aria-label="Delete reel"
                      className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-stone-200 text-stone-500 hover:text-red-600"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
