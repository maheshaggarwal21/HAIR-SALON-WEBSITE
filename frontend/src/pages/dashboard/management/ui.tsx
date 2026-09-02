/**
 * @file ui.tsx
 * @description Small presentational primitives shared by the Management panels.
 *
 * Kept together so the four panels stay visually consistent without each one
 * re-inventing a toggle or a card header.
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Copy, X, AlertTriangle, Info } from "lucide-react";
import type { PermissionRegistry } from "./api";

// ── Panel chrome ─────────────────────────────────────────────────────────────

export function PanelHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ElementType;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center shrink-0">
          <Icon className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-stone-900 leading-tight">{title}</h2>
          {subtitle && <p className="text-sm text-stone-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-white rounded-2xl border border-stone-200/80 shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">{children}</p>
      {hint && <p className="text-xs text-stone-400 mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
}) {
  return (
    <label
      className={`flex items-start justify-between gap-4 py-3 ${
        disabled ? "opacity-50" : "cursor-pointer"
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-stone-800">{label}</span>
        {description && (
          <span className="block text-xs text-stone-500 mt-0.5 leading-relaxed">{description}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 ${
          checked ? "bg-amber-500" : "bg-stone-300"
        } ${disabled ? "cursor-not-allowed" : ""}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
    </label>
  );
}

/**
 * Three-state control for a per-person override of a role policy.
 * "Inherit" is a real, meaningful value — not just an unset checkbox — so it
 * gets an equal slot rather than being the absence of a choice.
 */
export function TriToggle({
  value,
  onChange,
  inheritLabel,
  disabled,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  inheritLabel: string;
  disabled?: boolean;
}) {
  const options: Array<{ v: boolean | null; label: string }> = [
    { v: null, label: inheritLabel },
    { v: true, label: "Always" },
    { v: false, label: "Never" },
  ];

  return (
    <div
      className={`inline-flex rounded-lg border border-stone-200 bg-stone-50 p-0.5 ${
        disabled ? "opacity-50 pointer-events-none" : ""
      }`}
    >
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            value === o.v
              ? "bg-white text-stone-900 shadow-sm"
              : "text-stone-500 hover:text-stone-800"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1.5">
        {label}
      </label>
      <div className="relative">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
          }}
          className="w-full h-11 px-4 pr-16 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400 transition-all"
        />
        {suffix && (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-stone-400 pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      {hint && <p className="text-xs text-stone-400 mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

// ── Permission checklist ─────────────────────────────────────────────────────

export function PermissionChecklist({
  registry,
  selected,
  onToggle,
  disabled,
  /** Permissions coming from the role default — rendered as a subtle hint. */
  inheritedFrom,
}: {
  registry: PermissionRegistry;
  selected: string[];
  onToggle: (key: string) => void;
  disabled?: boolean;
  inheritedFrom?: string[];
}) {
  const inherited = new Set(inheritedFrom ?? []);

  return (
    <div className="space-y-5">
      {registry.groups.map((group) => (
        <div key={group.label}>
          <p className="text-[0.7rem] font-semibold text-stone-400 uppercase tracking-wider mb-2">
            {group.label}
          </p>
          <div className="space-y-1">
            {group.keys.map((key) => {
              const checked = selected.includes(key);
              return (
                <label
                  key={key}
                  className={`flex items-start gap-3 rounded-lg p-2 transition-colors ${
                    disabled ? "opacity-50" : "cursor-pointer hover:bg-stone-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onToggle(key)}
                    className="mt-0.5 w-4 h-4 rounded border-stone-300 text-amber-600 focus:ring-amber-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-stone-700 leading-snug">
                      {registry.labels[key] ?? key}
                    </span>
                    {inherited.has(key) && !checked && (
                      <span className="block text-[0.7rem] text-amber-600 mt-0.5">
                        In this role's defaults
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export function Banner({
  kind = "info",
  children,
}: {
  kind?: "info" | "warn" | "error" | "success";
  children: React.ReactNode;
}) {
  const styles = {
    info:    "bg-blue-50 border-blue-200 text-blue-800",
    warn:    "bg-amber-50 border-amber-200 text-amber-800",
    error:   "bg-red-50 border-red-200 text-red-700",
    success: "bg-green-50 border-green-200 text-green-700",
  }[kind];

  const Icon = kind === "warn" || kind === "error" ? AlertTriangle : Info;

  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${styles}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * Reveal-once secret display. Used for temp passwords and the bypass code —
 * both are returned by the server exactly once and cannot be read back, so the
 * copy button matters more than usual.
 */
export function SecretReveal({
  value,
  title,
  note,
  onDismiss,
}: {
  value: string;
  title: string;
  note?: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard permission denied — the value is visible on screen anyway.
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-sm font-bold text-amber-900">{title}</p>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-amber-500 hover:text-amber-800 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-lg bg-white border border-amber-200 px-4 py-3 font-mono text-lg tracking-wider text-stone-900 break-all">
          {value}
        </code>
        <button
          onClick={copy}
          className="shrink-0 h-12 px-4 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-sm font-medium transition-colors flex items-center gap-2"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="text-xs text-amber-800 mt-3 leading-relaxed">
        {note ?? "Write this down now — it cannot be shown again."}
      </p>
    </motion.div>
  );
}

/** Transient success/error line that clears itself. */
export function Toast({ message, kind }: { message: string; kind: "ok" | "err" }) {
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        className={`fixed bottom-6 right-6 z-[60] rounded-xl px-5 py-3 text-sm font-medium shadow-lg ${
          kind === "ok" ? "bg-stone-900 text-white" : "bg-red-600 text-white"
        }`}
      >
        {message}
      </motion.div>
    </AnimatePresence>
  );
}

/** Hook powering <Toast> — returns a setter and the element to render. */
export function useToast() {
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "err" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  return {
    toast,
    showOk:  (message: string) => setToast({ message, kind: "ok" }),
    showErr: (message: string) => setToast({ message, kind: "err" }),
    element: toast ? <Toast message={toast.message} kind={toast.kind} /> : null,
  };
}

/** Consistent relative-time rendering across panels. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
