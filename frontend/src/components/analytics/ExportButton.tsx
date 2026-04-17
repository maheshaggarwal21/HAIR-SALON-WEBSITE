/**
 * @file ExportButton.tsx
 * @description Button that downloads salon visits as an Excel (.xlsx) file.
 *
 * Uses a fetch-based download so the session cookie is sent.
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

interface Props {
  api: string;
  qs: string;
}

export default function ExportButton({ api, qs }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleExport = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${api}/api/analytics/export?${qs}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "salon-export.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Export failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleExport}
        disabled={loading}
        className="flex items-center gap-2 bg-white hover:bg-stone-100 border border-stone-200 rounded-lg px-4 py-2 text-sm font-medium text-stone-700 shadow-sm transition-colors disabled:opacity-60"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        Export Excel
      </button>
      {error && <span className="text-sm text-red-500">{error}</span>}
    </div>
  );
}
