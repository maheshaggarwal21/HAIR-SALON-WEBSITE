/**
 * @file CopyId.tsx
 * @description A payment id (or any long id) with a small copy button. Uses navigator.clipboard and falls back to
 * a temporary textarea when it is unavailable (plain http, older browsers). The id wraps instead of widening the
 * row, so a long id cannot break the layout on a phone. Shows "Copied" for a moment.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

function fallbackCopy(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(el);
  }
}

export default function CopyId({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        ok = fallbackCopy(id);
      } catch {
        ok = false;
      }
    }
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  };

  return (
    <span className="flex min-w-0 items-start gap-2">
      <span className="min-w-0 break-all font-mono text-xs text-stone-500">{id}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy payment id ${id}`}
        title="Copy the payment id"
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50"
      >
        {state === "copied" ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
        <span role="status" aria-live="polite">
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
        </span>
      </button>
    </span>
  );
}
