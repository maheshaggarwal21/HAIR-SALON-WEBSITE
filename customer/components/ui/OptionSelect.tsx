"use client";

/**
 * Option dropdown (CF D34): a button that opens an ordered list of a service's
 * options, each with its price on the right and a tick on the chosen one.
 * Replaces the wrap of option chips, which read as a jumble once a card holds
 * ten options.
 *
 * `multiple` lets the request sheet tick several options of one card
 * (Eyebrows + Upper lip); the service page picks exactly one.
 *
 * Accessible listbox pattern: Enter / Space / ↓ opens, ↑ ↓ Home End move,
 * Enter / Space picks, Escape or a click outside closes, focus returns to the
 * button. The list opens upwards when there's no room below.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ServiceOption } from "@/lib/types";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function OptionSelect({
  options,
  value,
  onChange,
  multiple = false,
  label = "Choose an option",
  placeholder = "Choose an option",
  tone = "light",
  size = "md",
}: {
  options: ServiceOption[];
  /** Selected option ids (one for single mode). */
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  label?: string;
  placeholder?: string;
  tone?: "light" | "dark";
  size?: "md" | "lg";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [upward, setUpward] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const chosen = options.filter((o) => value.includes(o.id));
  const summary =
    chosen.length === 0
      ? placeholder
      : chosen.length === 1
        ? chosen[0].label ?? "Option"
        : `${chosen.length} selected`;
  const price =
    chosen.length === 0 ? null : chosen.length === 1 ? rupees(chosen[0].price) : rupees(chosen.reduce((s, o) => s + o.price, 0));

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openList = () => {
    const r = button.current?.getBoundingClientRect();
    setUpward(Boolean(r && window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom));
    const first = options.findIndex((o) => value.includes(o.id));
    setActive(first >= 0 ? first : 0);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const pick = (o: ServiceOption) => {
    if (multiple) {
      onChange(value.includes(o.id) ? value.filter((v) => v !== o.id) : [...value, o.id]);
    } else {
      onChange([o.id]);
      close();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const dark = tone === "dark";
  const field = dark ? "border-line-dark bg-ink-2 text-ivory" : "border-line bg-ivory text-ink";
  const muted = dark ? "text-ivory-muted" : "text-ink-muted";

  return (
    <div ref={box} className="relative w-full">
      <span id={`${id}-label`} className="sr-only">
        {label}
      </span>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKey}
        className={`flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border px-4 text-left transition-colors hover:border-gold-deep focus-visible:border-gold-deep ${field} ${
          size === "lg" ? "h-14 text-[16px]" : "h-12 text-[15px]"
        }`}
      >
        <span id={`${id}-value`} className={`min-w-0 truncate ${chosen.length ? "font-medium" : muted}`}>
          {summary}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {price && <span className="tabular font-semibold">{price}</span>}
          <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""} ${muted}`} strokeWidth={1.75} />
        </span>
      </button>

      {open && (
        <ul
          ref={list}
          role="listbox"
          aria-labelledby={`${id}-label`}
          aria-multiselectable={multiple || undefined}
          aria-activedescendant={`${id}-o${active}`}
          tabIndex={-1}
          onKeyDown={onKey}
          className={`absolute left-0 right-0 z-30 max-h-[300px] overflow-y-auto overscroll-contain rounded-[var(--radius-control)] border py-1.5 shadow-[var(--shadow-sheet)] ${
            upward ? "bottom-full mb-2" : "top-full mt-2"
          } ${dark ? "border-line-dark bg-ink-2 text-ivory" : "border-line bg-ivory text-ink"}`}
        >
          {options.map((o, i) => {
            const on = value.includes(o.id);
            return (
              <li
                key={o.id}
                id={`${id}-o${i}`}
                data-i={i}
                role="option"
                aria-selected={on}
                onPointerMove={() => setActive(i)}
                onClick={() => pick(o)}
                className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 text-[15px] ${
                  i === active ? (dark ? "bg-ivory/10" : "bg-ivory-2") : ""
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-5 w-5 shrink-0 items-center justify-center ${
                    multiple ? `rounded-[5px] border ${on ? "border-ink bg-ink text-ivory" : dark ? "border-line-dark" : "border-line"}` : ""
                  }`}
                >
                  {on && <Check className={`h-4 w-4 ${multiple ? "" : "text-gold-deep"}`} strokeWidth={2.25} />}
                </span>
                <span className={`min-w-0 flex-1 ${on ? "font-semibold" : ""}`}>{o.label ?? "Option"}</span>
                <span className={`tabular shrink-0 ${on ? "font-semibold" : muted}`}>
                  {o.regularPrice && o.regularPrice > o.price && <s className="mr-1.5 text-[12px] opacity-60">{rupees(o.regularPrice)}</s>}
                  {rupees(o.price)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
