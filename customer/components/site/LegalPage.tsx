/** Shared layout for the legal pages (T1.25): one readable column, dated. */

import type { ReactNode } from "react";

export const LEGAL_UPDATED = "14 October 2026";

export function LegalPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <main className="flex-1 bg-ivory px-4 pb-28 pt-12 md:px-16 md:pb-32 md:pt-20">
      <article className="mx-auto max-w-[720px] text-[16px] leading-[1.7] [&_h2]:mt-10 [&_h2]:font-serif [&_h2]:text-[28px] [&_h2]:leading-tight [&_li]:mt-2 [&_p]:mt-4 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">Last updated {LEGAL_UPDATED}</p>
        <h1 className="mt-4 font-serif text-[44px] leading-none md:text-[64px]">{title}</h1>
        <p className="mt-6! text-[18px] text-ink-muted">{intro}</p>
        {children}
      </article>
    </main>
  );
}
