/**
 * @file DisplayPage.tsx
 * @description The customer-facing counter tablet at /display (D60, part A).
 *
 * It is a dumb screen. It shows what the server tells it to show: the customer's bill
 * (name, services at their final prices, what to pay) with the QR while a payment is pending, a "thank you" for a few seconds once paid, and otherwise
 * the salon's name, turning into a soft slideshow of the salon after 30 quiet seconds. It never receives the customer's phone number,
 * the staff member's name or the payment reference; it has no staff login, and holds one secret: the device token it received when the
 * owner paired it with a one-time code (Management → Counter display).
 *
 * Polling is told to it by the server: ~2.5 s while a payment is active, every 20 s
 * while the salon is open, every 5 minutes overnight (see utils/counter.js idlePollMs).
 * A setTimeout chain, not setInterval, so a slow reply never stacks requests.
 *
 * Mounted outside AuthProvider (main.tsx): no session check, no staff bundle.
 */

import { useEffect, useState } from "react";
import UpiQr from "@/components/UpiQr";
import {
  clearDeviceToken,
  fetchDisplayState,
  getDeviceToken,
  pairThisTablet,
  type DisplayState,
} from "@/services/counter";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

function Shell({ children, offline }: { children: React.ReactNode; offline?: boolean }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-stone-950 px-6 text-center text-stone-50 select-none">
      {children}
      {offline && <p className="absolute bottom-4 text-sm text-stone-500">Reconnecting…</p>}
    </div>
  );
}

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await pairThisTablet(code.trim());
      onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pair");
      setBusy(false);
    }
  };

  return (
    <Shell>
      <p className="font-serif text-3xl tracking-wide">The Experts</p>
      <form onSubmit={submit} className="mt-10 flex w-full max-w-xs flex-col gap-4">
        <label htmlFor="code" className="text-sm uppercase tracking-widest text-stone-400">
          Pairing code
        </label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="rounded-xl bg-stone-900 px-4 py-4 text-center text-4xl tracking-[0.4em] outline-none ring-1 ring-stone-700 focus:ring-amber-400"
          placeholder="••••••"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="rounded-xl bg-amber-400 px-4 py-3 text-lg font-semibold text-stone-950 disabled:opacity-40"
        >
          {busy ? "Pairing…" : "Pair this tablet"}
        </button>
        <p className="text-xs text-stone-500">The owner makes this code in the staff app: Management → Counter display. It works once, for 5 minutes.</p>
      </form>
    </Shell>
  );
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return (
    <p className="mt-4 text-stone-500">
      QR valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </p>
  );
}

/** The salon's own photos, bundled with the app (public/display, ~250 KB in all): no network call, no API. */
const SLIDES = [
  { src: "/display/1-sign.webp", alt: "The Experts: Skin, Hair, Makeup" },
  { src: "/display/2-salon-floor.webp", alt: "Inside The Experts salon" },
  { src: "/display/3-haircut-beard.webp", alt: "A haircut and beard by The Experts" },
  { src: "/display/4-hair-colour.webp", alt: "Hair colour at The Experts" },
  { src: "/display/5-styling-station.webp", alt: "A styling station at The Experts", portrait: true },
];
/** Idle for this long (no payment shown) before the welcome screen turns into the slideshow. */
const SLIDESHOW_AFTER_MS = 30_000;
const SLIDE_MS = 7000;

/**
 * Idle screen: the salon's name for the first 30 seconds (it is also the "thank you" tail after a
 * payment), then a slow, soft slideshow of the salon. Mounted only while the tablet is idle, so
 * it starts counting from the moment the last payment screen goes away, and a new payment
 * replaces it instantly.
 */
function IdleScreen({ offline }: { offline: boolean }) {
  const [slideshow, setSlideshow] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setSlideshow(true);
    }, SLIDESHOW_AFTER_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!slideshow) return;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), SLIDE_MS);
    return () => window.clearInterval(t);
  }, [slideshow]);

  if (!slideshow) {
    return (
      <Shell offline={offline}>
        <p className="font-serif text-5xl tracking-wide">The Experts</p>
        <p className="mt-3 text-lg uppercase tracking-[0.4em] text-stone-500">Hair Salon</p>
      </Shell>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-stone-950 select-none">
      <style>{`
        @keyframes expertsDrift { from { transform: scale(1.02); } to { transform: scale(1.12); } }
        @media (prefers-reduced-motion: reduce) { .experts-drift { animation: none !important; } }
      `}</style>
      {SLIDES.map((slide, i) => {
        const active = i === index;
        return (
          <div key={slide.src} className="absolute inset-0 transition-opacity duration-[1400ms] ease-in-out" style={{ opacity: active ? 1 : 0 }} aria-hidden={!active}>
            {slide.portrait && (
              // A tall photo on a wide screen: a blurred copy fills the sides so nothing is cropped.
              <img src={slide.src} alt="" draggable={false} className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" />
            )}
            <img
              src={slide.src}
              alt={slide.alt}
              draggable={false}
              className={`experts-drift absolute inset-0 h-full w-full ${slide.portrait ? "object-contain" : "object-cover"}`}
              style={active ? { animation: `expertsDrift ${SLIDE_MS + 1600}ms ease-out forwards` } : undefined}
            />
          </div>
        );
      })}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-10 pb-8 pt-24">
        <p className="font-serif text-3xl tracking-wide text-white">The Experts</p>
        <p className="text-sm uppercase tracking-[0.35em] text-stone-300">Skin · Hair · Makeup</p>
      </div>
      {offline && <p className="absolute right-4 top-4 text-xs text-white/50">Reconnecting…</p>}
    </div>
  );
}

export default function DisplayPage() {
  const [paired, setPaired] = useState<boolean>(() => !!getDeviceToken());
  const [state, setState] = useState<DisplayState | null>(null);
  const [offline, setOffline] = useState(false);

  // Keep the screen awake where the browser allows it. Best effort: a refused request changes nothing.
  useEffect(() => {
    if (!paired) return;
    let lock: { release: () => Promise<void> } | null = null;
    const grab = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        lock = (await wl?.request("screen")) ?? null;
      } catch {
        /* not allowed, or not supported */
      }
    };
    void grab();
    const onVisible = () => document.visibilityState === "visible" && void grab();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [paired]);

  // One poll after another, each waiting as long as the server asked.
  useEffect(() => {
    if (!paired) return;
    let stopped = false;
    let timer: number | undefined;
    const run = async () => {
      const r = await fetchDisplayState();
      if (stopped) return;
      let wait = 5000;
      if (r.kind === "unpaired") {
        clearDeviceToken();
        setState(null);
        setPaired(false);
        return; // stop polling until paired again
      }
      if (r.kind === "state") {
        setOffline(false);
        setState(r.state);
        wait = r.state.nextPollMs;
      } else if (r.kind === "throttled") {
        wait = r.retryMs;
      } else {
        setOffline(true);
      }
      timer = window.setTimeout(() => void run(), wait);
    };
    void run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [paired]);

  if (!paired) return <PairScreen onPaired={() => setPaired(true)} />;

  if (state?.mode === "payment") {
    const b = state.bill;
    return (
      <div className="fixed inset-0 overflow-y-auto bg-stone-950 text-stone-50 select-none">
        <div className="mx-auto flex min-h-full max-w-6xl flex-col items-stretch justify-center gap-8 px-6 py-6 lg:flex-row lg:items-center lg:gap-14 lg:px-12">
          {/* The bill: the server's own figures */}
          <div className="flex-1">
            <p className="text-sm uppercase tracking-[0.3em] text-stone-400">{b.customerName ? "Bill for" : "Your bill"}</p>
            {b.customerName && <p className="mt-1 break-words font-serif text-4xl leading-tight sm:text-5xl">{b.customerName}</p>}
            <ul className="mt-6 divide-y divide-stone-800 text-xl sm:text-2xl">
              {b.lines.map((l) => (
                <li key={l.name} className="flex items-baseline justify-between gap-6 py-3">
                  <span className="break-words">
                    {l.name}
                    {l.quantity > 1 && <span className="ml-2 text-stone-400">× {l.quantity}</span>}
                  </span>
                  <span className="tabular-nums text-stone-300">{rupees(l.amount)}</span>
                </li>
              ))}
            </ul>
            {b.cashAmount > 0 && (
              <dl className="mt-4 space-y-2 text-lg text-stone-300 sm:text-xl">
                <div className="flex justify-between gap-6">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{rupees(b.total)}</dd>
                </div>
                <div className="flex justify-between gap-6">
                  <dt>Paid in cash</dt>
                  <dd className="tabular-nums text-emerald-400">− {rupees(b.cashAmount)}</dd>
                </div>
              </dl>
            )}
            <div className="mt-5 flex items-baseline justify-between gap-6 border-t border-stone-700 pt-4">
              <span className="text-xl uppercase tracking-[0.25em] text-stone-400">To pay</span>
              <span className="text-6xl font-semibold tabular-nums sm:text-7xl">{rupees(state.amount)}</span>
            </div>
          </div>

          {/* The QR */}
          <div className="flex flex-col items-center lg:w-[min(46vh,38vw)] lg:shrink-0">
            <div className="w-[min(60vw,46vh)] lg:w-full">
              {state.qr ? <UpiQr qr={state.qr} /> : <p className="text-stone-400">Please ask the desk for another way to pay.</p>}
            </div>
            <p className="mt-5 text-2xl">Scan with any UPI app</p>
            <Countdown until={state.expiresAt} />
          </div>
        </div>
        {offline && <p className="fixed bottom-3 left-0 right-0 text-center text-sm text-stone-500">Reconnecting…</p>}
      </div>
    );
  }

  if (state?.mode === "paid") {
    return (
      <Shell offline={offline}>
        <div className="flex h-28 w-28 items-center justify-center rounded-full bg-emerald-500 text-6xl text-white">✓</div>
        <p className="mt-8 text-5xl font-semibold">Payment received</p>
        <p className="mt-3 text-3xl tabular-nums text-stone-300">{rupees(state.amount)}</p>
        <p className="mt-6 text-xl text-stone-400">{state.customerName ? `Thank you, ${state.customerName}!` : "Thank you!"}</p>
      </Shell>
    );
  }

  return <IdleScreen offline={offline} />;
}
