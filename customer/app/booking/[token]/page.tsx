/**
 * `/booking/[token]` — the customer's own booking (DS §6.2, CF §9, T2.21).
 * Reached from the link in the confirmation WhatsApp.
 *
 * Private by nature: never indexed, never cached, and everything is fetched in
 * the browser from /api/public/booking/<token> so no booking ever sits in a
 * shared cache. The token is unguessable (CF D40); the page shows only what the
 * customer already knows plus the salon's contact.
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { ManageBooking } from "@/components/booking/ManageBooking";

export const metadata: Metadata = {
  title: "Your booking",
  robots: { index: false, follow: false },
};

/**
 * Tokens are private and unknown at build time. One placeholder lets the
 * shared shell prerender (as /artists does); real links render on request.
 */
export async function generateStaticParams() {
  return [{ token: "preview" }];
}

export default function BookingPage({ params }: PageProps<"/booking/[token]">) {
  return (
    <main className="mx-auto w-full max-w-[640px] px-4 py-12 md:px-0 md:py-20">
      <Suspense fallback={<p className="text-ink-muted">Loading your booking…</p>}>
        <TokenBridge params={params} />
      </Suspense>
    </main>
  );
}

async function TokenBridge({ params }: { params: PageProps<"/booking/[token]">["params"] }) {
  const { token } = await params;
  return <ManageBooking token={token} />;
}
