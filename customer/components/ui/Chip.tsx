/**
 * Chip — DESIGN.md §5. Selectable pill, 36px tall (44px tap area via padding
 * on touch). Selected = sand fill + gold-deep text. Uses aria-pressed so
 * screen readers announce the toggle state.
 */

import type { ComponentProps } from "react";

export function Chip({
  selected = false,
  tone = "light",
  className = "",
  children,
  ...rest
}: ComponentProps<"button"> & { selected?: boolean; tone?: "light" | "dark" }) {
  const state = selected
    ? "bg-sand text-gold-deep border-sand"
    : tone === "dark"
      ? "border-line-dark text-ivory hover:bg-ivory/10"
      : "border-line text-ink hover:bg-ivory-2";
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-full border text-[14px] font-medium transition-colors duration-150 whitespace-nowrap disabled:opacity-40 ${state} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
