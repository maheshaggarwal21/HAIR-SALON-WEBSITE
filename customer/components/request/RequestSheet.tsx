"use client";

/**
 * Request-lite booking sheet (T1.14, CF §6.1, DS §7).
 *
 * Services → Day & time of day → Details → Sent. It creates a REQUEST: there is
 * no live availability in Phase 1, so every word here says "request" and none
 * says "booked" or "confirmed" (CP1). The salon confirms the exact time by
 * phone or WhatsApp.
 *
 * Prices shown are display only. The API recomputes every price from its own
 * catalogue and refuses a request that tries to send one.
 *
 * Sheet: slides up from the bottom on mobile, in from the right on desktop
 * (DS §4 `sheet`); transform/opacity only; reduced motion collapses it to an
 * instant change via the global rule in globals.css. Escape closes it, focus
 * moves into it on open and back to the page on close.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { PublicArtist, PublicPackage, RequestResult, ServiceCard as Card, SiteInfo, WindowKey } from "@/lib/types";
import { addDays, clock, dayParts, isOpenOn, rupees, slaText, todayIST, whatsappHref, windowPassed } from "@/lib/format";
import { TURNSTILE_SITE_KEY } from "@/lib/config";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ServiceCard } from "@/components/ui/ServiceCard";
import { readFirstTouch } from "@/components/UtmCapture";
import { Turnstile } from "./Turnstile";
import { useRequest } from "./RequestContext";

const STEPS = ["Services", "Day & time", "Details"] as const;
const WINDOWS: WindowKey[] = ["morning", "afternoon", "evening"];
const MAX_ITEMS = 8;
const DATE_STRIP_DAYS = 30;

interface Props {
  site: SiteInfo;
  services: { her: Card[]; him: Card[] };
  artists: PublicArtist[];
  packages: PublicPackage[];
}

export function RequestSheet({ site, services, artists, packages }: Props) {
  const { isOpen, preset, openedAt, close } = useRequest();
  /**
   * The visitor's "now" is the moment they opened the sheet — never the
   * render, so the prerendered HTML can't bake in the build day's dates and
   * hydration can't disagree about what "today" is.
   */
  const now = openedAt;

  const [step, setStep] = useState(0);
  const [audience, setAudience] = useState<"her" | "him">("her");
  const [selected, setSelected] = useState<string[]>([]);
  const [packageSlug, setPackageSlug] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [timeOfDay, setTimeOfDay] = useState<WindowKey | null>(null);
  const [artistSlug, setArtistSlug] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tsReset, setTsReset] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RequestResult | null>(null);
  /** The open event this sheet last applied a preset for (see below). */
  const [appliedOpen, setAppliedOpen] = useState<Date | null>(null);

  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // ── Apply the preset once per open ───────────────────────────────────────
  // Adjusting state while rendering, keyed on the open event, is React's
  // recommended alternative to setting state inside an effect.
  if (isOpen && openedAt && openedAt !== appliedOpen) {
    setAppliedOpen(openedAt);
    if (!result) {
      if (preset.audience && preset.audience !== audience) {
        setAudience(preset.audience);
        setSelected([]);
        setCategory(null);
      }
      if (preset.packageSlug) setPackageSlug(preset.packageSlug);
      if (preset.artistSlug) setArtistSlug(preset.artistSlug);
      if (preset.optionIds?.length) {
        const add = preset.optionIds;
        setSelected((s) => [...new Set([...(preset.audience && preset.audience !== audience ? [] : s), ...add])].slice(0, MAX_ITEMS));
      }
    }
  }

  // ── Focus and scroll lock while open ─────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => panel.current?.focus());
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(id);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  const handleClose = useCallback(() => {
    close();
    returnFocus.current?.focus?.();
    // A sent request starts fresh next time; an unfinished one is kept.
    if (result) {
      setResult(null);
      setStep(0);
      setSelected([]);
      setPackageSlug(null);
      setDate(null);
      setTimeOfDay(null);
      setNotes("");
    }
  }, [close, result]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, handleClose]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const list = services[audience];
  const requestable = useMemo(
    () => list.filter((c) => c.options.some((o) => o.bookingMode !== "walkin_only")),
    [list]
  );
  const categories = useMemo(
    () => [...new Set(requestable.map((c) => c.displayCategory).filter((c): c is string => Boolean(c)))],
    [requestable]
  );
  const shown = category ? requestable.filter((c) => c.displayCategory === category) : requestable;

  const optionIndex = useMemo(() => {
    const m = new Map<string, { card: Card; label: string | null; price: number }>();
    for (const c of [...services.her, ...services.him]) {
      for (const o of c.options) m.set(o.id, { card: c, label: o.label, price: o.price });
    }
    return m;
  }, [services]);

  const pkg = packages.find((p) => p.slug === packageSlug) ?? null;
  const pkgIds = new Set(pkg?.items.map((i) => i.id) ?? []);
  const extras = selected.filter((id) => !pkgIds.has(id) && optionIndex.has(id));
  const total = (pkg?.price ?? 0) + extras.reduce((s, id) => s + (optionIndex.get(id)?.price ?? 0), 0);
  const itemCount = extras.length + (pkg ? 1 : 0);

  const dates = useMemo(() => {
    if (!now) return [];
    const today = todayIST(now);
    const out: string[] = [];
    const span = Math.min(site.horizonDays, DATE_STRIP_DAYS);
    for (let i = 0; i <= span; i++) {
      const d = addDays(today, i);
      if (!isOpenOn(site, d)) continue;
      // Today only if at least one window is still ahead.
      if (i === 0 && WINDOWS.every((w) => windowPassed(site, w, d, now))) continue;
      out.push(d);
    }
    return out;
  }, [site, now]);

  const toggle = (id: string) => {
    setError("");
    setSelected((s) => {
      if (s.includes(id)) return s.filter((x) => x !== id);
      // Variants of one service are alternatives: picking Medium replaces Short.
      const card = optionIndex.get(id)?.card;
      const siblings = new Set(card?.options.map((o) => o.id) ?? []);
      const next = s.filter((x) => !siblings.has(x));
      if (next.length >= MAX_ITEMS) {
        setError(`You can request up to ${MAX_ITEMS} services at once.`);
        return s;
      }
      return [...next, id];
    });
  };

  const switchAudience = (a: "her" | "him") => {
    if (a === audience) return;
    setAudience(a);
    setCategory(null);
    setSelected([]);
    setError("");
  };

  // ── Validation per step ──────────────────────────────────────────────────
  const phoneDigits = phone.replace(/\D/g, "");
  const phoneOk = /^[6-9]\d{9}$/.test(phoneDigits);
  const nameOk = name.trim().length >= 2;
  const canNext =
    step === 0 ? itemCount > 0 : step === 1 ? Boolean(date && timeOfDay && !windowPassed(site, timeOfDay, date, now ?? undefined)) : true;
  const waitingForTurnstile = Boolean(TURNSTILE_SITE_KEY) && !token;

  async function submit() {
    if (!date || !timeOfDay) return setStep(1);
    if (!nameOk || !phoneOk) return setError(!nameOk ? "Enter your name." : "Enter a 10-digit mobile number.");
    setSending(true);
    setError("");
    try {
      const utm = readFirstTouch();
      const res = await fetch("/api/public/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          services: extras,
          ...(pkg ? { packageSlug: pkg.slug } : {}),
          date,
          window: timeOfDay,
          for: audience,
          ...(artistSlug ? { artistSlug } : {}),
          name: name.trim(),
          phone: phoneDigits,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(utm ? { utm } : {}),
          whatsappOptIn: optIn,
          ...(token ? { turnstileToken: token } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTsReset((n) => n + 1);
        if (data.fields?.includes("date")) setStep(1);
        if (data.fields?.includes("services") || data.error === "SERVICE_UNAVAILABLE") setStep(0);
        setError(data.message || "That didn't go through. Try again, or message us on WhatsApp.");
        return;
      }
      setResult(data as RequestResult);
    } catch {
      setError("You seem to be offline. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  const salonWhatsApp = whatsappHref(
    site.contact.whatsapp,
    result ? `Hi, about my request ${result.ref}.` : undefined
  );

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className={`fixed inset-0 z-50 ${isOpen ? "" : "pointer-events-none"}`}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      {/* Backdrop */}
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-ink/50 transition-opacity duration-300 ${isOpen ? "opacity-100" : "opacity-0"}`}
      />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Request an appointment"
        tabIndex={-1}
        className={`absolute bottom-0 left-0 right-0 flex max-h-[92dvh] flex-col rounded-t-[var(--radius-media)] bg-ivory text-ink outline-none transition-transform duration-[320ms] ease-[var(--ease-rise)]
          md:bottom-0 md:left-auto md:top-0 md:max-h-none md:w-[480px] md:rounded-none md:rounded-l-[var(--radius-card)]
          ${isOpen ? "translate-y-0 shadow-[var(--shadow-sheet)] md:translate-x-0" : "translate-y-full shadow-none md:translate-y-0 md:translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 md:px-6">
          {!result && step > 0 ? (
            <button
              onClick={() => setStep(step - 1)}
              className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-ivory-2"
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" strokeWidth={1.5} />
            </button>
          ) : (
            <span className="w-11" />
          )}
          <div className="flex-1 text-center">
            {result ? (
              <span className="text-[15px] font-semibold">Request sent</span>
            ) : (
              <ol className="flex items-center justify-center gap-2 text-[13px] font-medium" aria-label="Steps">
                {STEPS.map((s, i) => (
                  <li
                    key={s}
                    aria-current={i === step ? "step" : undefined}
                    className={i === step ? "text-ink" : i < step ? "text-gold-deep" : "text-ink-muted"}
                  >
                    {s}
                    {i < STEPS.length - 1 && <span className="ml-2 text-ink-muted">›</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <button
            onClick={handleClose}
            className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-ivory-2"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 md:px-6">
          {result ? (
            <Done result={result} site={site} salonWhatsApp={salonWhatsApp} />
          ) : step === 0 ? (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">What would you like?</h2>
              <div className="mt-4 flex gap-2" role="group" aria-label="Who is it for">
                <Chip selected={audience === "her"} onClick={() => switchAudience("her")}>
                  For her
                </Chip>
                <Chip selected={audience === "him"} onClick={() => switchAudience("him")}>
                  For him
                </Chip>
              </div>

              {pkg && (
                <div className="mt-5 rounded-[var(--radius-card)] border border-gold-deep bg-sand/40 p-4 ring-1 ring-gold-deep">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-serif text-[24px] leading-tight">{pkg.name}</div>
                      <div className="mt-1 text-[14px] text-ink-muted">{pkg.items.map((i) => i.name).join(" · ")}</div>
                    </div>
                    <div className="text-right">
                      <span className="tabular font-semibold">{rupees(pkg.price)}</span>
                      {pkg.items.reduce((s, i) => s + i.price, 0) > pkg.price && (
                        <div className="tabular text-[12px] text-ink-muted">
                          {rupees(pkg.items.reduce((s, i) => s + i.price, 0))} separately
                        </div>
                      )}
                    </div>
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
                {shown.length ? (
                  shown.map((c) => (
                    <ServiceCard key={c.slug} service={c} selectedOptionIds={selected} onToggle={toggle} />
                  ))
                ) : (
                  <p className="text-[15px] text-ink-muted">
                    Nothing to request online here yet. Message us and we&apos;ll help.
                  </p>
                )}
              </div>
            </div>
          ) : step === 1 ? (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">When suits you?</h2>
              <p className="mt-1 text-[15px] text-ink-muted">Pick a day and a time of day. We&apos;ll agree the exact time with you.</p>

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
                      onClick={() => {
                        setDate(d);
                        if (timeOfDay && windowPassed(site, timeOfDay, d, now ?? undefined)) setTimeOfDay(null);
                      }}
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

              <div className="mt-5 grid gap-2" role="group" aria-label="Time of day">
                {WINDOWS.map((w) => {
                  const win = site.requestWindows[w];
                  const passed = date ? windowPassed(site, w, date, now ?? undefined) : false;
                  if (passed) return null;
                  const on = timeOfDay === w;
                  return (
                    <button
                      key={w}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setTimeOfDay(w)}
                      className={`flex min-h-[52px] items-center justify-between rounded-[var(--radius-control)] border px-4 text-left transition-colors ${
                        on ? "border-sand bg-sand text-gold-deep" : "border-line hover:bg-ivory-2"
                      }`}
                    >
                      <span className="font-semibold">{win.label}</span>
                      <span className="tabular text-[14px]">
                        {clock(win.start)} – {clock(win.end)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {artists.length > 0 && (
                <label className="mt-6 block">
                  <span className="text-[13px] font-medium text-ink-muted">Anyone you&apos;d like? (optional)</span>
                  <select
                    value={artistSlug}
                    onChange={(e) => setArtistSlug(e.target.value)}
                    className="mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 text-[15px]"
                  >
                    <option value="">No preference</option>
                    {artists
                      .filter((a) => a.slug)
                      .map((a) => (
                        <option key={a.id} value={a.slug!}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          ) : (
            <div>
              <h2 className="font-serif text-[30px] leading-tight">Your details</h2>
              <p className="mt-1 text-[15px] text-ink-muted">So we can call or WhatsApp you to fix the time.</p>

              <label className="mt-5 block">
                <span className="text-[13px] font-medium text-ink-muted">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  maxLength={60}
                  className="mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 text-[16px]"
                />
              </label>
              <label className="mt-4 block">
                <span className="text-[13px] font-medium text-ink-muted">Mobile number</span>
                <div className="mt-1.5 flex h-12 items-center rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3">
                  <span className="pr-2 text-[16px] text-ink-muted">+91</span>
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, "").slice(0, 12))}
                    inputMode="numeric"
                    autoComplete="tel-national"
                    className="h-full flex-1 bg-transparent text-[16px] tabular outline-none"
                  />
                </div>
              </label>
              <label className="mt-4 block">
                <span className="text-[13px] font-medium text-ink-muted">Anything we should know? (optional)</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value.slice(0, 300))}
                  rows={3}
                  className="mt-1.5 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 py-2 text-[16px]"
                />
              </label>
              <label className="mt-4 flex items-start gap-3 text-[14px] leading-snug">
                <input
                  type="checkbox"
                  checked={optIn}
                  onChange={(e) => setOptIn(e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-gold-deep)]"
                />
                <span>
                  Send me offers on WhatsApp. <span className="text-ink-muted">Optional — we&apos;ll message you about this request either way.</span>
                </span>
              </label>

              <div className="mt-5">
                <Turnstile onToken={setToken} resetKey={tsReset} />
              </div>
              {/* T1.25: legal pages linked from the form. New tab, so the request isn't lost. */}
              <p className="mt-4 text-[13px] leading-snug text-ink-muted">
                By sending this request you agree to our{" "}
                <a href="/terms" target="_blank" rel="noopener" className="font-semibold text-gold-deep underline underline-offset-2">
                  terms
                </a>
                ,{" "}
                <a href="/cancellation-policy" target="_blank" rel="noopener" className="font-semibold text-gold-deep underline underline-offset-2">
                  cancellation policy
                </a>{" "}
                and{" "}
                <a href="/privacy" target="_blank" rel="noopener" className="font-semibold text-gold-deep underline underline-offset-2">
                  privacy policy
                </a>
                .
              </p>
            </div>
          )}

          <p aria-live="polite" className="mt-4 min-h-[1.25rem] text-[14px] font-medium text-danger">
            {error}
          </p>
        </div>

        {/* Footer: running total + next */}
        {!result && (
          <div className="border-t border-line px-4 py-3 md:px-6">
            <div className="mb-2 flex items-baseline justify-between text-[14px]">
              <span className="text-ink-muted">
                {itemCount ? `${itemCount} selected · pay at the salon` : "Nothing selected yet"}
              </span>
              <span className="tabular text-[17px] font-semibold">{itemCount ? rupees(total) : ""}</span>
            </div>
            {step < 2 ? (
              <Button className="w-full" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Continue
              </Button>
            ) : (
              <Button className="w-full" disabled={sending || waitingForTurnstile} onClick={submit}>
                {sending ? "Sending…" : waitingForTurnstile ? "Checking you're human…" : "Send request"}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Done({ result, site, salonWhatsApp }: { result: RequestResult; site: SiteInfo; salonWhatsApp: string | null }) {
  const p = dayParts(result.requestedWindow.date);
  const win = site.requestWindows[result.requestedWindow.window];
  return (
    <div>
      <h2 className="font-serif text-[34px] leading-tight">
        Request <em className="text-gold">sent</em>.
      </h2>
      <p className="mt-3 text-[16px] leading-[1.6]">
        We&apos;ll call or WhatsApp you within {slaText(result.slaMinutes)} to agree the exact time. Nothing is fixed until
        we&apos;ve spoken.
      </p>
      <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-ivory-2 p-4 text-[15px]">
        <div className="flex justify-between">
          <span className="text-ink-muted">Reference</span>
          <span className="font-semibold tabular">{result.ref}</span>
        </div>
        <div className="mt-2 flex justify-between gap-4">
          <span className="text-ink-muted">You asked for</span>
          <span className="text-right">
            {p.long}, {win.label.toLowerCase()}
          </span>
        </div>
        <ul className="mt-3 space-y-1 border-t border-line pt-3">
          {result.packageName && <li className="font-medium">{result.packageName}</li>}
          {result.items.map((i, idx) => (
            <li key={idx} className="flex justify-between gap-3">
              <span>{i.name}</span>
              {!result.packageName && <span className="tabular">{rupees(i.price)}</span>}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-between border-t border-line pt-3 font-semibold">
          <span>Total, paid at the salon</span>
          <span className="tabular">{rupees(result.total)}</span>
        </div>
      </div>
      {salonWhatsApp && (
        <Button variant="whatsapp" className="mt-6 w-full" href={salonWhatsApp} target="_blank" rel="noopener">
          Message us about it
        </Button>
      )}
    </div>
  );
}
