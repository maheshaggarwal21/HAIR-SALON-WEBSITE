"use client";

/**
 * Live booking sheet (T2.19, T2.20, CF §5, DS §7). Used instead of the
 * request form once an artist is switched on for online booking (T2.22).
 *
 *   Who → Services → Artist → Time → Details (WhatsApp code) → Pay → Done
 *
 * Honesty rules (CLAUDE.md, DS §7):
 *   - only real free times are shown; "1 left" only when it is true AND
 *     informative (any artist chosen, one of several still free);
 *   - every price is the server's (POST /quote); the browser sends service ids
 *     and "full" or "deposit", never an amount;
 *   - the cancellation rule is spelled out under the Pay button BEFORE paying;
 *   - request services (colour, bridal…) say "Request sent", never "Booked".
 *
 * Payment: Razorpay Checkout opens over the sheet. Its handler calls
 * verify-payment, but the server's webhook is the source of truth — if the
 * handler never runs (it sometimes doesn't, in in-app browsers) the sheet
 * keeps asking the manage endpoint until the booking settles. While unpaid,
 * the slot is held for `holdMinutes` and a countdown shows how long is left.
 *
 * Group bookings: up to `maxGuests` people at the same time, each with their
 * own services; the server places each guest with a different chain (D9).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarPlus, MapPin, Minus, Plus, X } from "lucide-react";
import type { ManageView, PublicArtist, PublicBooking, PublicPackage, Quote, ServiceCard as Card, SiteInfo, Slot } from "@/lib/types";
import { addDays, dayParts, isOpenOn, rupees, todayIST, whatsappHref } from "@/lib/format";
import { TURNSTILE_SITE_KEY } from "@/lib/config";
import { pixelHeaders, track, trackOnce } from "@/lib/pixel";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ServiceCard } from "@/components/ui/ServiceCard";
import { readFirstTouch } from "@/components/UtmCapture";
import { Turnstile } from "./Turnstile";
import { useRequest } from "./RequestContext";

const STEPS = ["Who", "Services", "Artist", "Time", "Details", "Pay"] as const;
const MAX_ITEMS = 8;
const DATE_STRIP_DAYS = 30;
const PERIODS = [
  ["morning", "Morning"],
  ["afternoon", "Afternoon"],
  ["evening", "Evening"],
] as const;

interface Guest {
  for: "her" | "him";
  name: string;
  selected: string[];
}

interface Props {
  site: SiteInfo;
  services: { her: Card[]; him: Card[] };
  artists: PublicArtist[];
  packages: PublicPackage[];
}

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
interface RazorpayInstance {
  open: () => void;
  close: () => void;
}
declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => RazorpayInstance;
  }
}

function loadCheckout(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; message?: string; alternatives?: { startAt: string; time: string }[] } }> {
  const res = await fetch(`/api/public${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...pixelHeaders() }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** The clock, for event handlers and timers only (never read during render). */
const wallClock = () => Date.now();

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });

export function BookingSheet({ site, services, artists, packages }: Props) {
  const { isOpen: anyOpen, preset, openedAt, close, kind } = useRequest();
  const isOpen = anyOpen && kind === "book";
  const cfg = site.onlineBooking!;
  const now = openedAt;

  const [step, setStep] = useState(0);
  const [guests, setGuests] = useState<Guest[]>([{ for: "her", name: "", selected: [] }]);
  const isGroup = guests.length > 1;
  const [active, setActive] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  const [packageSlug, setPackageSlug] = useState<string | null>(null);
  const [artistSlug, setArtistSlug] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [patchDelay, setPatchDelay] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);

  const [phone, setPhone] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [verified, setVerified] = useState<string | null>(null); // bookingToken
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [policy, setPolicy] = useState(false);
  const [payKind, setPayKind] = useState<"full" | "deposit">("full");
  const [tsToken, setTsToken] = useState<string | null>(null);
  const [tsReset, setTsReset] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [alts, setAlts] = useState<{ startAt: string; time: string }[]>([]);
  const [made, setMade] = useState<{ booking: PublicBooking; manageToken: string; order: { id: string; amount: number; currency: string; keyId: string | null } | null } | null>(null);
  const [done, setDone] = useState<PublicBooking | null>(null);

  // Meta Pixel: setDone is reached from the payment handler AND the payment
  // watcher, so the event hangs off the state, once per ref. A booking the salon
  // still has to approve is a Lead; only a confirmed one is a Schedule.
  useEffect(() => {
    if (!done) return;
    const params = { content_name: done.guests[0]?.items[0]?.name ?? "Booking", value: done.pricing.total, currency: "INR" };
    if (done.status === "confirmed") trackOnce("Schedule", done.ref, params);
    else if (done.status === "requested") trackOnce("Lead", done.ref, params);
  }, [done]);

  // Meta Pixel: opening the sheet is the booking STARTED (InitiateCheckout), once per open.
  // Whoever gets this far and never books is the retargeting audience.
  const startedFor = useRef<Date | null>(null);
  useEffect(() => {
    if (!isOpen || !openedAt || startedFor.current === openedAt) return;
    startedFor.current = openedAt;
    const pkg = preset.packageSlug ? packages.find((p) => p.slug === preset.packageSlug) : null;
    track("InitiateCheckout", { content_name: pkg?.name ?? "Booking" });
  }, [isOpen, openedAt, preset.packageSlug, packages]);
  /** Wall clock for the hold countdown and resend timer, set from the interval (never read during render). */
  const [nowMs, setNowMs] = useState(0);
  const [appliedOpen, setAppliedOpen] = useState<Date | null>(null);

  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // ── Preset once per open (same pattern as RequestSheet) ──────────────────
  if (isOpen && openedAt && openedAt !== appliedOpen) {
    setAppliedOpen(openedAt);
    if (!made && !done) {
      const aud = preset.audience ?? guests[0].for;
      if (preset.audience || preset.optionIds?.length) {
        setGuests((g) => [{ ...g[0], for: aud, selected: preset.optionIds?.length ? preset.optionIds.slice(0, MAX_ITEMS) : aud !== g[0].for ? [] : g[0].selected }, ...g.slice(1)]);
      }
      if (preset.packageSlug) setPackageSlug(preset.packageSlug);
      if (preset.artistSlug) setArtistSlug(preset.artistSlug);
      // A preset with services skips "Who" — they came from a service or offer.
      if (preset.optionIds?.length || preset.packageSlug) setStep(1);
    }
  }

  // ── Focus, scroll lock, Escape ───────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => panel.current?.focus());
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(id);
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const reset = useCallback(() => {
    setStep(0);
    setGuests([{ for: "her", name: "", selected: [] }]);
    setActive(0);
    setPackageSlug(null);
    setDate(null);
    setSlots(null);
    setSlot(null);
    setQuote(null);
    setMade(null);
    setDone(null);
    setNotes("");
    setPolicy(false);
    setError("");
  }, []);

  const handleClose = useCallback(() => {
    close();
    returnFocus.current?.focus?.();
    if (done) reset();
  }, [close, done, reset]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && handleClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, handleClose]);

  // One-second clock for the hold countdown and the resend timer.
  useEffect(() => {
    if (!isOpen || (!made && !codeSent)) return;
    const t = setInterval(() => setNowMs(wallClock()), 1000);
    return () => clearInterval(t);
  }, [isOpen, made, codeSent]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const optionIndex = useMemo(() => {
    const m = new Map<string, { card: Card; price: number; label: string | null }>();
    for (const c of [...services.her, ...services.him]) for (const o of c.options) m.set(o.id, { card: c, price: o.price, label: o.label });
    return m;
  }, [services]);

  const g = guests[active];
  const list = useMemo(() => services[g.for].filter((c) => c.options.some((o) => o.bookingMode === "instant" || o.bookingMode === "request")), [services, g.for]);
  const categories = useMemo(() => [...new Set(list.map((c) => c.displayCategory).filter((c): c is string => Boolean(c)))], [list]);
  const shown = category ? list.filter((c) => c.displayCategory === category) : list;

  const pkg = packages.find((p) => p.slug === packageSlug) ?? null;
  const pkgIds = new Set(pkg?.items.map((i) => i.id) ?? []);
  const extrasOf = (x: Guest, idx: number) => x.selected.filter((id) => optionIndex.has(id) && !(idx === 0 && pkgIds.has(id)));
  const localTotal = (pkg?.price ?? 0) + guests.reduce((s, x, i) => s + extrasOf(x, i).reduce((n, id) => n + (optionIndex.get(id)?.price ?? 0), 0), 0);
  const everyoneHasSomething = guests.every((x, i) => extrasOf(x, i).length > 0 || (i === 0 && pkg));
  const total = quote?.total ?? localTotal;

  const dates = useMemo(() => {
    if (!now) return [];
    const today = todayIST(now);
    const out: string[] = [];
    for (let i = 0; i <= Math.min(site.horizonDays, DATE_STRIP_DAYS); i++) {
      const d = addDays(today, i);
      if (isOpenOn(site, d)) out.push(d);
    }
    return out;
  }, [site, now]);

  const guestPayload = () =>
    guests.map((x, i) => ({ for: x.for, services: extrasOf(x, i), ...(i > 0 && x.name.trim() ? { name: x.name.trim() } : {}) }));
  const availabilityQuery = (d: string) => {
    const q = new URLSearchParams({ date: d });
    guests.forEach((x, i) => q.append("g", extrasOf(x, i).join(",")));
    if (pkg) q.set("package", pkg.slug);
    if (artistSlug && !isGroup) q.set("artist", artistSlug);
    return q.toString();
  };

  // ── Actions ──────────────────────────────────────────────────────────────
  const toggle = (id: string) => {
    setError("");
    setGuests((all) =>
      all.map((x, i) => {
        if (i !== active) return x;
        if (x.selected.includes(id)) return { ...x, selected: x.selected.filter((s) => s !== id) };
        const card = optionIndex.get(id)?.card;
        const siblings = new Set(card?.pick === "many" ? [] : card?.options.map((o) => o.id) ?? []);
        const next = x.selected.filter((s) => !siblings.has(s));
        if (next.length >= MAX_ITEMS) {
          setError(`Up to ${MAX_ITEMS} services per person.`);
          return x;
        }
        return { ...x, selected: [...next, id] };
      })
    );
    setSlot(null);
    setQuote(null);
  };

  async function loadSlots(d: string) {
    setDate(d);
    setSlot(null);
    setSlots(null);
    setSlotsLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/public/availability?${availabilityQuery(d)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Couldn't load times.");
      setSlots(data.slots);
      setPatchDelay(Boolean(data.patchTestDelay));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load times.");
      setSlots([]);
    } finally {
      setSlotsLoading(false);
    }
  }

  async function loadQuote() {
    const r = await post<Quote>("/quote", { guests: guestPayload(), ...(pkg ? { packageSlug: pkg.slug } : {}) });
    if (!r.ok) throw new Error(r.data.message || "Couldn't price that. Try again.");
    setQuote(r.data);
    if (!r.data.payment.options.some((o) => o.kind === payKind)) setPayKind(r.data.payment.options[0].kind);
  }

  async function sendCode() {
    const digits = phone.replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(digits)) return setError("Enter a 10-digit mobile number.");
    setBusy(true);
    setError("");
    const r = await post<{ sent: boolean }>("/otp/send", { phone: digits, ...(tsToken ? { turnstileToken: tsToken } : {}) });
    setTsReset((n) => n + 1);
    setTsToken(null);
    setBusy(false);
    if (!r.ok) return setError(r.data.message || "Couldn't send a code. Try again.");
    setCodeSent(true);
    setNowMs(wallClock());
    setResendAt(wallClock() + 30_000);
  }

  async function verifyCode() {
    setBusy(true);
    setError("");
    const digits = phone.replace(/\D/g, "");
    const r = await post<{ bookingToken: string; customer: { name: string | null } | null }>("/otp/verify", { phone: digits, code });
    setBusy(false);
    if (!r.ok) return setError(r.data.message || "That code didn't match. Try again or resend.");
    setVerified(r.data.bookingToken);
    if (r.data.customer?.name && !name) setName(r.data.customer.name);
  }

  async function createAndPay() {
    if (!slot || !verified) return;
    if (name.trim().length < 2) return setError("Enter your name.");
    if (!policy) return setError("Please accept the booking policy.");
    setBusy(true);
    setError("");
    setAlts([]);
    const utm = readFirstTouch();
    const r = await post<{ booking: PublicBooking; manageToken: string; order: { id: string; amount: number; currency: string; keyId: string | null } | null }>("/appointments", {
      bookingToken: verified,
      phone: phone.replace(/\D/g, ""),
      name: name.trim(),
      guests: guestPayload(),
      ...(pkg ? { packageSlug: pkg.slug } : {}),
      startAt: slot.startAt,
      ...(artistSlug && !isGroup ? { artistSlug } : {}),
      payment: payKind,
      policyAccepted: true,
      whatsappOptIn: optIn,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(utm ? { utm } : {}),
      ...(tsToken ? { turnstileToken: tsToken } : {}),
    });
    setTsReset((n) => n + 1);
    setTsToken(null);
    if (!r.ok) {
      setBusy(false);
      if (r.data.error === "SLOT_TAKEN") {
        setAlts(r.data.alternatives || []);
        setSlot(null);
        setStep(3);
        if (date) loadSlots(date);
        return setError("That slot was just taken. Here are the nearest times.");
      }
      if (r.data.error === "OTP_EXPIRED") setVerified(null);
      return setError(r.data.message || "That didn't go through. Try again, or message us on WhatsApp.");
    }
    setMade(r.data);
    setNowMs(wallClock());
    setStep(5);
    setBusy(false);
    if (!r.data.order) return setDone(r.data.booking);
    openCheckout(r.data);
  }

  async function openCheckout(m = made) {
    if (!m?.order) return;
    setError("");
    const ok = await loadCheckout();
    if (!ok || !window.Razorpay) return setError("Couldn't open the payment window. Check your connection and tap Pay again.");
    const rzp = new window.Razorpay({
      key: m.order.keyId || cfg.razorpayKeyId,
      amount: m.order.amount,
      currency: m.order.currency,
      order_id: m.order.id,
      name: "The Experts",
      description: `Booking ${m.booking.ref}`,
      prefill: { name: name.trim(), contact: `+91${phone.replace(/\D/g, "")}` },
      theme: { color: "#2B2722" },
      handler: async (resp: RazorpayResponse) => {
        const v = await post<{ booking: PublicBooking }>(`/appointments/${m.booking.ref}/verify-payment`, resp);
        if (v.ok && v.data.booking && v.data.booking.status !== "pending_payment") setDone(v.data.booking);
        else watchUntilSettled(m.manageToken);
      },
      modal: {
        ondismiss: () => {
          // Closing the window isn't proof they didn't pay — keep checking for a while.
          watchUntilSettled(m.manageToken, 20_000);
          setError("Payment didn't go through. Your slot is still held — tap Pay to try again.");
        },
      },
    });
    rzp.open();
  }

  /** The webhook is the source of truth: ask the booking itself until it settles. */
  const watching = useRef(false);
  async function watchUntilSettled(token: string, forMs = 90_000) {
    if (watching.current) return;
    watching.current = true;
    const until = wallClock() + forMs;
    try {
      while (wallClock() < until) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(`/api/public/booking/${token}`);
        if (!res.ok) continue;
        const view = (await res.json()) as ManageView;
        if (view.booking.status !== "pending_payment") {
          if (["confirmed", "requested"].includes(view.booking.status)) setDone(view.booking);
          else setError("We received your payment but couldn't keep that time. The full amount will be refunded — we'll message you on WhatsApp.");
          return;
        }
      }
    } finally {
      watching.current = false;
    }
  }

  // ── Step gates ───────────────────────────────────────────────────────────
  /**
   * "1 left" only where it tells the customer something: they asked for any
   * artist and just one of several is still free then. With one artist chosen
   * every free time is "1 left", and a label on every button is pressure, not
   * information (CLAUDE.md, "Honesty in marketing UI").
   */
  const onlineArtists = artists.filter((a) => a.onlineBookable).length;
  const lastOne = (s: Slot) => !artistSlug && guests.length === 1 && onlineArtists > 1 && s.remaining === 1;

  /**
   * A group is served in parallel, so each person needs a different artist: the
   * sheet skips the artist step and the system matches each guest with whoever
   * is free (D46). One person keeps the choice.
   */
  const flow: readonly string[] = isGroup ? STEPS.filter((x) => x !== "Artist") : STEPS;
  const stepAfter = (from: number) => (isGroup && from === 1 ? 3 : from + 1);
  const stepBefore = (from: number) => (isGroup && from === 3 ? 1 : from - 1);

  const canNext = step === 1 ? everyoneHasSomething : step === 3 ? Boolean(slot) : true;
  async function next() {
    setError("");
    if (step === 3) {
      try {
        setBusy(true);
        await loadQuote();
      } catch (e) {
        setBusy(false);
        return setError(e instanceof Error ? e.message : "Couldn't price that.");
      }
      setBusy(false);
    }
    setStep(stepAfter(step));
  }

  const holdLeft = made?.booking.holdExpiresAt ? Math.max(0, Date.parse(made.booking.holdExpiresAt) - nowMs) : 0;
  const resendIn = Math.max(0, Math.ceil((resendAt - nowMs) / 1000));
  const waitingForTurnstile = Boolean(TURNSTILE_SITE_KEY) && !tsToken;
  const isRequestMode = quote?.mode === "request";
  const salonWa = whatsappHref(site.contact.whatsapp, made ? `Hi, about my booking ${made.booking.ref}.` : undefined);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={`fixed inset-0 z-50 ${isOpen ? "" : "pointer-events-none"}`} aria-hidden={!isOpen} inert={!isOpen}>
      <div onClick={handleClose} className={`absolute inset-0 bg-ink/50 transition-opacity duration-300 ${isOpen ? "opacity-100" : "opacity-0"}`} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Book an appointment"
        tabIndex={-1}
        className={`absolute bottom-0 left-0 right-0 flex max-h-[92dvh] flex-col rounded-t-[var(--radius-media)] bg-ivory text-ink outline-none transition-transform duration-[320ms] ease-[var(--ease-rise)]
          md:bottom-0 md:left-auto md:top-0 md:max-h-none md:w-[480px] md:rounded-none md:rounded-l-[var(--radius-card)]
          ${isOpen ? "translate-y-0 shadow-[var(--shadow-sheet)] md:translate-x-0" : "translate-y-full shadow-none md:translate-y-0 md:translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 md:px-6">
          {!done && step > 0 && step < 5 ? (
            <button onClick={() => setStep(stepBefore(step))} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-ivory-2" aria-label="Back">
              <ArrowLeft className="h-5 w-5" strokeWidth={1.5} />
            </button>
          ) : (
            <span className="w-11" />
          )}
          <div className="flex-1 text-center text-[13px] font-medium">
            {done ? (
              <span className="text-[15px] font-semibold">{done.status === "requested" ? "Request sent" : "Booked"}</span>
            ) : (
              <span>
                <span className="text-ink-muted">
                  Step {flow.indexOf(STEPS[step]) + 1} of {flow.length} ·{" "}
                </span>
                <span className="text-ink">{STEPS[step]}</span>
              </span>
            )}
          </div>
          <button onClick={handleClose} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-ivory-2" aria-label="Close">
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 md:px-6">
          {done ? (
            <Done booking={done} manageToken={made?.manageToken ?? ""} site={site} salonWa={salonWa} />
          ) : step === 0 ? (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">Who is coming?</h2>
              <div className="mt-5 grid gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setGuests((x) => [x[0]]);
                    setActive(0);
                    setStep(1);
                  }}
                  className="rounded-[var(--radius-card)] border border-line p-4 text-left hover:bg-ivory-2"
                >
                  <div className="font-semibold">Just me</div>
                  <div className="text-[14px] text-ink-muted">One person</div>
                </button>
                {cfg.maxGuests > 1 && (
                  <div className="rounded-[var(--radius-card)] border border-line p-4">
                    <div className="font-semibold">Me and others</div>
                    <div className="text-[14px] text-ink-muted">Up to {cfg.maxGuests} people at the same time, with different artists</div>
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        aria-label="Fewer people"
                        disabled={guests.length <= 1}
                        onClick={() => setGuests((x) => x.slice(0, -1))}
                        className="flex h-11 w-11 items-center justify-center rounded-full border border-line disabled:opacity-40"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="tabular text-[18px] font-semibold">{guests.length}</span>
                      <button
                        type="button"
                        aria-label="More people"
                        disabled={guests.length >= cfg.maxGuests}
                        onClick={() => setGuests((x) => [...x, { for: "her", name: "", selected: [] }])}
                        className="flex h-11 w-11 items-center justify-center rounded-full border border-line disabled:opacity-40"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                      <Button variant="secondary" className="ml-auto" disabled={guests.length < 2} onClick={() => setStep(1)}>
                        Continue
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : step === 1 ? (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">What would you like?</h2>
              {guests.length > 1 && (
                <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 md:-mx-6 md:px-6" role="tablist" aria-label="Person">
                  {guests.map((x, i) => (
                    <Chip key={i} selected={i === active} onClick={() => { setActive(i); setCategory(null); }}>
                      {i === 0 ? "You" : x.name.trim() || `Guest ${i + 1}`} {extrasOf(x, i).length || (i === 0 && pkg) ? "✓" : ""}
                    </Chip>
                  ))}
                </div>
              )}
              {active > 0 && (
                <label className="mt-4 block">
                  <span className="text-[13px] font-medium text-ink-muted">Their name (optional)</span>
                  <input
                    value={g.name}
                    maxLength={60}
                    onChange={(e) => setGuests((all) => all.map((x, i) => (i === active ? { ...x, name: e.target.value } : x)))}
                    className="mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 text-[16px]"
                  />
                </label>
              )}
              <div className="mt-4 flex gap-2" role="group" aria-label="Who is it for">
                {(["her", "him"] as const).map((a) => (
                  <Chip
                    key={a}
                    selected={g.for === a}
                    onClick={() => {
                      if (g.for === a) return;
                      setGuests((all) => all.map((x, i) => (i === active ? { ...x, for: a, selected: [] } : x)));
                      setCategory(null);
                    }}
                  >
                    {a === "her" ? "For her" : "For him"}
                  </Chip>
                ))}
              </div>

              {pkg && active === 0 && (
                <div className="mt-5 rounded-[var(--radius-card)] border border-gold-deep bg-sand/40 p-4 ring-1 ring-gold-deep">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-serif text-[24px] leading-tight">{pkg.name}</div>
                      <div className="mt-1 text-[14px] text-ink-muted">{pkg.items.map((i) => i.name).join(" · ")}</div>
                    </div>
                    <span className="tabular font-semibold">{rupees(pkg.price)}</span>
                  </div>
                  <button onClick={() => setPackageSlug(null)} className="mt-3 text-[13px] font-semibold text-gold-deep underline">
                    Remove package
                  </button>
                </div>
              )}

              {categories.length > 1 && (
                <div className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1 md:-mx-6 md:px-6">
                  <Chip selected={!category} onClick={() => setCategory(null)}>
                    All
                  </Chip>
                  {categories.map((c) => (
                    <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
                      {c}
                    </Chip>
                  ))}
                </div>
              )}
              <div className="mt-4 space-y-3">
                {shown.map((c) => (
                  <ServiceCard key={c.slug} service={c} selectedOptionIds={g.selected} onToggle={toggle} />
                ))}
              </div>
            </div>
          ) : step === 2 ? (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">Who would you like?</h2>
              <div className="mt-5 grid gap-2" role="radiogroup" aria-label="Artist">
                <ArtistOption selected={!artistSlug} onClick={() => setArtistSlug("")} title="Any available" hint="Most times to choose from" />
                {artists
                  .filter((a) => a.slug && a.onlineBookable)
                  .map((a) => (
                    <ArtistOption key={a.id} selected={artistSlug === a.slug} onClick={() => setArtistSlug(a.slug!)} title={a.name} hint={a.specialties.slice(0, 2).join(" · ") || null} />
                  ))}
              </div>
            </div>
          ) : step === 3 ? (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">When suits you?</h2>
              {isGroup && <p className="mt-2 text-[14px] text-ink-muted">We&apos;ll match each of you with a free artist, all at the same time.</p>}
              <div className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-2 md:-mx-6 md:px-6" role="group" aria-label="Day">
                {dates.map((d) => {
                  const p = dayParts(d);
                  const on = date === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      aria-label={p.long}
                      onClick={() => loadSlots(d)}
                      className={`flex h-[76px] w-[60px] shrink-0 flex-col items-center justify-center rounded-[var(--radius-control)] border text-center transition-colors ${
                        on ? "border-sand bg-sand text-gold-deep" : "border-line hover:bg-ivory-2"
                      }`}
                    >
                      <span className="text-[12px] font-semibold uppercase">{p.weekday}</span>
                      <span className="tabular text-[22px] font-semibold leading-none">{p.day}</span>
                      <span className="text-[12px]">{p.month}</span>
                    </button>
                  );
                })}
              </div>
              {alts.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {alts.map((a) => (
                    <Chip key={a.startAt} selected={false} onClick={() => { const s = slots?.find((x) => x.startAt === a.startAt); if (s) setSlot(s); }}>
                      {fmtTime(a.startAt)}
                    </Chip>
                  ))}
                </div>
              )}
              {!date ? (
                <p className="mt-5 text-[15px] text-ink-muted">Pick a day to see free times.</p>
              ) : slotsLoading ? (
                <p className="mt-5 text-[15px] text-ink-muted">Finding free times…</p>
              ) : slots && slots.length === 0 ? (
                <p className="mt-5 text-[15px] text-ink-muted">
                  No free times that day{artistSlug ? " with this artist" : ""}. Try another day{artistSlug ? " or Any available" : ""}.
                </p>
              ) : (
                <div className="mt-5 space-y-5">
                  {patchDelay && <p className="text-[14px] text-ink-muted">Colour needs a patch test 48 hours before, so the earliest times start then. Pop in any day for the test.</p>}
                  {PERIODS.map(([key, label]) => {
                    const inPeriod = (slots || []).filter((s) => s.period === key);
                    if (!inPeriod.length) return null;
                    return (
                      <div key={key}>
                        <div className="text-[13px] font-semibold uppercase tracking-[0.18em] text-gold-deep">{label}</div>
                        <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={label}>
                          {inPeriod.map((s) => {
                            const on = slot?.startAt === s.startAt;
                            return (
                              <button
                                key={s.startAt}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                onClick={() => setSlot(s)}
                                className={`flex min-h-[44px] flex-col items-center justify-center rounded-[var(--radius-control)] border text-[15px] font-semibold tabular ${
                                  on ? "border-sand bg-sand text-gold-deep" : "border-line hover:bg-ivory-2"
                                }`}
                              >
                                {fmtTime(s.startAt)}
                                {lastOne(s) && <span className="text-[11px] font-medium text-ink-muted">1 left</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {slot && (
                <div className="mt-5 rounded-[var(--radius-card)] border border-line bg-ivory-2 p-3 text-[14px]">
                  {slot.guests.map((gg, i) => (
                    <div key={gg.key}>
                      {slot.guests.length > 1 && <div className="font-semibold">{i === 0 ? "You" : guests[i]?.name || `Guest ${i + 1}`}</div>}
                      {gg.items.map((it) => (
                        <div key={it.serviceId + it.startAt} className="flex justify-between gap-3">
                          <span>{it.name}</span>
                          <span className="text-ink-muted">
                            {fmtTime(it.startAt)} · {it.artistName}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : step === 4 ? (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">Your details</h2>
              {!verified ? (
                <>
                  <p className="mt-1 text-[15px] text-ink-muted">We&apos;ll send a code to your WhatsApp to confirm it&apos;s you.</p>
                  <label className="mt-5 block">
                    <span className="text-[13px] font-medium text-ink-muted">Mobile number</span>
                    <div className="mt-1.5 flex h-12 items-center rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3">
                      <span className="pr-2 text-[16px] text-ink-muted">+91</span>
                      <input
                        value={phone}
                        onChange={(e) => { setPhone(e.target.value.replace(/[^\d ]/g, "").slice(0, 12)); setCodeSent(false); setCode(""); }}
                        inputMode="numeric"
                        autoComplete="tel-national"
                        className="h-full flex-1 bg-transparent text-[16px] tabular outline-none"
                      />
                    </div>
                  </label>
                  {codeSent && (
                    <label className="mt-4 block">
                      <span className="text-[13px] font-medium text-ink-muted">6-digit code from WhatsApp</span>
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        className="mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 text-[20px] tracking-[0.4em] tabular"
                      />
                    </label>
                  )}
                  <div className="mt-4">
                    <Turnstile onToken={setTsToken} resetKey={tsReset} />
                  </div>
                  <div className="mt-4 flex gap-3">
                    {!codeSent ? (
                      <Button className="w-full" disabled={busy || waitingForTurnstile} onClick={sendCode}>
                        {busy ? "Sending…" : "Send code"}
                      </Button>
                    ) : (
                      <>
                        <Button className="flex-1" disabled={busy || code.length !== 6} onClick={verifyCode}>
                          {busy ? "Checking…" : "Confirm code"}
                        </Button>
                        <Button variant="secondary" disabled={busy || resendIn > 0 || waitingForTurnstile} onClick={sendCode}>
                          {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend"}
                        </Button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="mt-1 text-[15px] text-success">Phone confirmed.</p>
                  <label className="mt-5 block">
                    <span className="text-[13px] font-medium text-ink-muted">Name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} className="mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 text-[16px]" />
                  </label>
                  <label className="mt-4 block">
                    <span className="text-[13px] font-medium text-ink-muted">Anything we should know? (optional)</span>
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 300))} rows={2} className="mt-1.5 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 py-2 text-[16px]" />
                  </label>

                  {quote && quote.payment.options.length > 0 && (
                    <fieldset className="mt-5">
                      <legend className="text-[13px] font-medium text-ink-muted">How would you like to pay?</legend>
                      <div className="mt-2 grid gap-2">
                        {quote.payment.options.map((o) => (
                          <label key={o.kind} className={`flex min-h-[52px] cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border px-4 ${payKind === o.kind ? "border-sand bg-sand" : "border-line"}`}>
                            <input type="radio" name="pay" checked={payKind === o.kind} onChange={() => setPayKind(o.kind)} className="h-5 w-5 accent-[var(--color-gold-deep)]" />
                            <span className="font-semibold">{o.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}

                  <label className="mt-5 flex items-start gap-3 text-[14px] leading-snug">
                    <input type="checkbox" checked={policy} onChange={(e) => setPolicy(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-gold-deep)]" />
                    <span>
                      I agree to the{" "}
                      <a href="/cancellation-policy" target="_blank" rel="noopener" className="font-semibold text-gold-deep underline underline-offset-2">cancellation policy</a>
                      ,{" "}
                      <a href="/terms" target="_blank" rel="noopener" className="font-semibold text-gold-deep underline underline-offset-2">terms</a> and{" "}
                      <a href="/privacy" target="_blank" rel="noopener" className="font-semibold text-gold-deep underline underline-offset-2">privacy policy</a>.
                    </span>
                  </label>
                  <label className="mt-3 flex items-start gap-3 text-[14px] leading-snug">
                    <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-gold-deep)]" />
                    <span>
                      Send me offers on WhatsApp. <span className="text-ink-muted">Optional — booking messages come either way.</span>
                    </span>
                  </label>
                  <div className="mt-4">
                    <Turnstile onToken={setTsToken} resetKey={tsReset} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">Payment</h2>
              {made && (
                <>
                  <p className="mt-2 text-[15px]">
                    {fmtDay(made.booking.startAt!)} at {fmtTime(made.booking.startAt!)} · ref <span className="font-semibold tabular">{made.booking.ref}</span>
                  </p>
                  {holdLeft > 0 ? (
                    <p className="mt-2 text-[15px] text-ink-muted">
                      Your slot is held for{" "}
                      <span className="tabular font-semibold text-ink">
                        {Math.floor(holdLeft / 60000)}:{String(Math.floor((holdLeft % 60000) / 1000)).padStart(2, "0")}
                      </span>{" "}
                      while you pay.
                    </p>
                  ) : (
                    <p className="mt-2 text-[15px] text-danger">The hold has run out. If you paid, we&apos;re still checking — don&apos;t pay twice.</p>
                  )}
                  <Button className="mt-5 w-full" disabled={holdLeft <= 0} onClick={() => openCheckout()}>
                    Pay {rupees((made.order?.amount ?? 0) / 100)}
                  </Button>
                </>
              )}
            </div>
          )}

          <p aria-live="polite" className="mt-4 min-h-[1.25rem] text-[14px] font-medium text-danger">
            {error}
          </p>
        </div>

        {/* Footer */}
        {!done && step >= 1 && step <= 4 && (
          <div className="border-t border-line px-4 py-3 md:px-6">
            <div className="mb-2 flex items-baseline justify-between text-[14px]">
              <span className="text-ink-muted">{quote ? (isRequestMode ? "Request · paid online, refunded if we can't do it" : "Total") : "Total so far"}</span>
              <span className="tabular text-[17px] font-semibold">{total ? rupees(total) : ""}</span>
            </div>
            {step < 4 ? (
              step !== 0 && (
                <Button className="w-full" disabled={!canNext || busy} onClick={next}>
                  {busy ? "One moment…" : "Continue"}
                </Button>
              )
            ) : verified ? (
              <>
                <Button className="w-full" disabled={busy || !policy || waitingForTurnstile} onClick={createAndPay}>
                  {busy ? "Holding your slot…" : isRequestMode ? "Send request and pay" : "Book and pay"}
                </Button>
                {quote && <p className="mt-2 text-center text-[12px] leading-snug text-ink-muted">{quote.payment.note}</p>}
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtistOption({ selected, onClick, title, hint }: { selected: boolean; onClick: () => void; title: string; hint: string | null }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex min-h-[56px] flex-col justify-center rounded-[var(--radius-control)] border px-4 text-left ${selected ? "border-sand bg-sand text-gold-deep" : "border-line hover:bg-ivory-2"}`}
    >
      <span className="font-semibold">{title}</span>
      {hint && <span className="text-[13px] text-ink-muted">{hint}</span>}
    </button>
  );
}

function Done({ booking, manageToken, site, salonWa }: { booking: PublicBooking; manageToken: string; site: SiteInfo; salonWa: string | null }) {
  const request = booking.status === "requested";
  return (
    <div>
      <h2 className="font-serif text-[34px] leading-tight">
        {request ? (
          <>
            Request <em className="text-gold">sent</em>.
          </>
        ) : (
          <>
            You&apos;re <em className="text-gold">booked</em>.
          </>
        )}
      </h2>
      <p className="mt-3 text-[16px] leading-[1.6]">
        {request
          ? "The salon will confirm on WhatsApp within 2 working hours. If we can't do that time, your payment is refunded in full."
          : "We've sent the details to your WhatsApp."}
      </p>
      <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-ivory-2 p-4 text-[15px]">
        <div className="flex justify-between">
          <span className="text-ink-muted">Reference</span>
          <span className="font-semibold tabular">{booking.ref}</span>
        </div>
        {booking.startAt && (
          <div className="mt-2 flex justify-between gap-4">
            <span className="text-ink-muted">When</span>
            <span className="text-right">
              {fmtDay(booking.startAt)}, {fmtTime(booking.startAt)}
            </span>
          </div>
        )}
        <ul className="mt-3 space-y-1 border-t border-line pt-3">
          {booking.guests.flatMap((g) =>
            g.items.map((i, idx) => (
              <li key={`${g.key}-${idx}`} className="flex justify-between gap-3">
                <span>
                  {i.name}
                  {i.artistName ? <span className="text-ink-muted"> · {i.artistName}</span> : null}
                </span>
                <span className="tabular">{rupees(i.price)}</span>
              </li>
            ))
          )}
        </ul>
        <div className="mt-3 flex justify-between border-t border-line pt-3 font-semibold">
          <span>Paid online</span>
          <span className="tabular">{rupees(booking.payment.amount)}</span>
        </div>
        {booking.payment.amount < booking.pricing.total && (
          <div className="mt-1 flex justify-between text-ink-muted">
            <span>To pay at the salon</span>
            <span className="tabular">{rupees(booking.pricing.total - booking.payment.amount)}</span>
          </div>
        )}
      </div>
      <div className="mt-6 grid gap-2">
        {manageToken && (
          <>
            <Button variant="secondary" href={`/api/public/booking/${manageToken}/calendar.ics`}>
              <CalendarPlus className="mr-2 h-4 w-4" /> Add to calendar
            </Button>
            <Button variant="secondary" href={`/booking/${manageToken}`}>
              Change or cancel
            </Button>
          </>
        )}
        {site.contact.mapUrl && (
          <Button variant="secondary" href={site.contact.mapUrl} target="_blank" rel="noopener">
            <MapPin className="mr-2 h-4 w-4" /> Directions
          </Button>
        )}
        {salonWa && (
          <Button variant="whatsapp" href={salonWa} target="_blank" rel="noopener">
            Message us
          </Button>
        )}
      </div>
    </div>
  );
}
