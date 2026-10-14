/**
 * Button — DESIGN.md §5. Variants: primary (gold fill, white label),
 * secondary (outline; `tone` picks ink-on-ivory or ivory-on-ink), ghost,
 * whatsapp (outline + icon). 48px tall on mobile, 52px on desktop.
 *
 * Renders an <a> when given `href`, otherwise a <button>. One gold-filled
 * button per viewport (DS §3.1) — use `secondary` for the rest.
 */

import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "whatsapp";
type Tone = "light" | "dark";

const base =
  "inline-flex items-center justify-center gap-2 h-12 md:h-[52px] px-6 rounded-[var(--radius-control)] text-[15px] font-semibold transition-colors duration-200 disabled:opacity-40 disabled:pointer-events-none select-none";

function classes(variant: Variant, tone: Tone) {
  switch (variant) {
    case "primary":
      return "bg-ink text-ivory hover:bg-ink-2";
    case "secondary":
      return tone === "dark"
        ? "border border-ivory/60 text-ivory hover:bg-ivory/10"
        : "border border-ink text-ink hover:bg-ink/5";
    case "ghost":
      return tone === "dark" ? "text-ivory hover:bg-ivory/10" : "text-ink hover:bg-ink/5";
    case "whatsapp":
      return tone === "dark"
        ? "border border-ivory/60 text-ivory hover:bg-ivory/10"
        : "border border-line text-ink bg-ivory hover:bg-ivory-2";
  }
}

function WhatsAppIcon() {
  // Simple outline mark; no brand assets beyond the generic glyph.
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3.5 20.5l1.3-4A8.5 8.5 0 1 1 8 19.3l-4.5 1.2z" strokeLinejoin="round" />
      <path d="M9 8.8c0 3 2.4 5.9 5.6 6.4l1.1-1.2-1.8-.9-.8.8c-1.1-.4-2.1-1.4-2.6-2.5l.8-.8-.8-1.8-1.3 1z" strokeLinejoin="round" />
    </svg>
  );
}

interface Common {
  variant?: Variant;
  tone?: Tone;
  className?: string;
  children: ReactNode;
}

type AsButton = Common & Omit<ComponentProps<"button">, "className" | "children"> & { href?: undefined };
type AsLink = Common & Omit<ComponentProps<"a">, "className" | "children"> & { href: string };

export function Button(props: AsButton | AsLink) {
  const { variant = "primary", tone = "light", className = "", children, ...rest } = props;
  const cls = `${base} ${classes(variant, tone)} ${className}`;
  const content = (
    <>
      {variant === "whatsapp" && <WhatsAppIcon />}
      {children}
    </>
  );
  if ("href" in rest && rest.href) {
    return (
      <a className={cls} {...(rest as ComponentProps<"a">)}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={cls} {...(rest as ComponentProps<"button">)}>
      {content}
    </button>
  );
}
