/**
 * @file MediaInput.tsx
 * @description One photo or video for the website: paste a link, or upload a
 * file straight to Vercel Blob (the API only issues a one-time token — files
 * never pass through our server). If uploads aren't set up yet the API says
 * so, and the owner can still paste a link.
 */

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { Loader2, Upload, X } from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";

const IMAGE = "image/jpeg,image/png,image/webp,image/avif";
const VIDEO = "video/mp4,video/webm";

function safeName(name: string) {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "file";
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
  return `${base}.${ext}`;
}

export default function MediaInput({
  label,
  value,
  onChange,
  kind = "image",
  folder,
  hint,
}: {
  label: string;
  value: string | null;
  onChange: (url: string | null) => void;
  kind?: "image" | "video" | "any";
  folder: string;
  hint?: string;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const isVideo = value ? /\.(mp4|webm)(\?|$)/i.test(value) : kind === "video";

  async function onFile(f: File) {
    setError("");
    setProgress(0);
    try {
      const blob = await upload(`website/${folder}/${safeName(f.name)}`, f, {
        access: "public",
        handleUploadUrl: `${API}/api/website/media/upload`,
        multipart: f.size > 8 * 1024 * 1024,
        onUploadProgress: (p) => setProgress(Math.round(p.percentage)),
      });
      onChange(blob.url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      setError(/not set up|503/i.test(msg) ? "Uploads aren't set up yet. Paste a link instead." : msg);
    } finally {
      setProgress(null);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">{label}</label>
      <div className="flex gap-2 items-start">
        {value && (
          <div className="w-16 h-16 shrink-0 rounded-lg overflow-hidden bg-stone-100 border border-stone-200">
            {isVideo ? (
              <video src={value} muted className="w-full h-full object-cover" />
            ) : (
              <img src={value} alt="" className="w-full h-full object-cover" />
            )}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex gap-2">
            <input
              value={value ?? ""}
              onChange={(e) => onChange(e.target.value.trim() || null)}
              placeholder="https://… or upload"
              className="flex-1 min-w-0 h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
            />
            <button
              type="button"
              onClick={() => file.current?.click()}
              disabled={progress !== null}
              className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              {progress !== null ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {progress !== null ? `${progress}%` : "Upload"}
            </button>
            {value && (
              <button type="button" onClick={() => onChange(null)} aria-label={`Remove ${label}`} className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          {hint && <p className="mt-1 text-[11px] text-stone-500">{hint}</p>}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </div>
      </div>
      <input
        ref={file}
        type="file"
        hidden
        accept={kind === "image" ? IMAGE : kind === "video" ? VIDEO : `${IMAGE},${VIDEO}`}
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    </div>
  );
}
