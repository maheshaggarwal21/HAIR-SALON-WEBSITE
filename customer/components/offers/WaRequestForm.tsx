"use client";

/**
 * WaRequestForm — the unpaid "request a time" form (D62), used on offer pages and on
 * /book?src=wa. Day and time, name, phone. No payment step, no code.
 *
 * Two outcomes, decided by one thing: whether a bundle is chosen.
 *   - bundle chosen (or an offer with fixed services): day and time are asked and it is sent as a REQUEST (Website requests);
 *   - an offer with bundles and NONE chosen: no day or time, and it is sent as a LEAD (Bookings → Leads): name, number
 *     and the question. Either way the button says "Book a request" and "Any other query" is optional.
 *
 * What it sends is only what the customer typed plus WHICH services (ids from the server's
 * own menu or the offer). The server decides the price and checks the time; this form is a
 * convenience, never the authority. The hidden "website" box is a trap for bots: people
 * never see or fill it.
 *
 * Honest wording: this is a REQUEST. Nothing is booked until the salon confirms it on
 * WhatsApp, and nothing is paid now.
 */

import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { addDays, clock, dayParts, isOpenOn, nowMinutesIST, rupees, todayIST, whatsappHref } from "@/lib/format";
import type { OfferPackage, SiteInfo } from "@/lib/types";
import { pixelHeaders, track, trackOnce } from "@/lib/pixel";
import { readFirstTouch } from "@/components/UtmCapture";
import { postLead, QUERY_MAX } from "@/lib/leads";

const DAYS_SHOWN = 14;
const STEP = 30;
const LEAD_MINUTES = 120;

export interface WaPick {
  id: string;
  name: string;
}

interface Result {
  package?: { name: string; price: number };
  ref: string;
  date: string;
  time: string;
  items: { name: string }[];
  duplicate: boolean;
  /** A group (D67). Absent for one person. */
  people?: number;
  total?: number;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Start times on the half hour inside opening hours, leaving room for the services; today's soonest ones removed. */
function timesFor(site: SiteInfo, date: string, minutesNeeded: number): string[] {
  const key = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const intervals = site.openingHours[key] || [];
  const earliest = date === todayIST() ? nowMinutesIST() + LEAD_MINUTES : -1;
  const out: string[] = [];
  for (const w of intervals) {
    for (let m = toMin(w.open); m + minutesNeeded <= toMin(w.close); m += STEP) if (m >= earliest) out.push(hhmm(m));
  }
  return out;
}

export function WaRequestForm({
  site,
  campaign: campaignProp,
  offerSlug,
  fixedServices,
  packages,
  menu,
  initialServiceIds,
  initialPhone,
  minutesNeeded = 60,
}: {
  site: SiteInfo;
  /** Ad tag. When not given, it is read from the page address (?c=karwa). The server tidies it again. */
  campaign?: string | null;
  /** On an offer page: the offer's address. The server books the OFFER's services. */
  offerSlug?: string | null;
  /** Shown as the list being booked (offer pages). */
  fixedServices?: WaPick[];
  /** The offer's packages (D64): the customer chooses one. Its price and services come from the offer, not from this form. */
  packages?: OfferPackage[];
  /** /book?src=wa: what the customer may choose from. */
  menu?: WaPick[];
  initialServiceIds?: string[];
  initialPhone?: string;
  minutesNeeded?: number;
}) {
  const params = useSearchParams();
  const campaign = campaignProp ?? params.get("c");
  const days = useMemo(() => {
    const today = todayIST();
    return Array.from({ length: DAYS_SHOWN + 1 }, (_, i) => addDays(today, i)).filter((d) => isOpenOn(site, d));
  }, [site]);
  const [picked, setPicked] = useState<string[]>(initialServiceIds ?? []);
  const [pkgSlug, setPkgSlug] = useState("");
  const chosen = packages?.find((p) => p.slug === pkgSlug) ?? null;
  const [date, setDate] = useState<string>("");
  const [time, setTime] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState((initialPhone ?? "").replace(/\D/g, "").slice(-10));
  const [trap, setTrap] = useState("");
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [leadSent, setLeadSent] = useState(false);
  // An offer with bundles and none chosen is a lead, not a request.
  const leadMode = Boolean(packages?.length) && !chosen;

  // How many people (D67). 1 = the form as it always was: nothing extra is sent.
  const maxPeople = Math.max(1, site.onlineBooking?.maxGuests ?? 1);
  const [people, setPeople] = useState(1);
  const [guestNames, setGuestNames] = useState<string[]>([]);

  const needed = chosen ? chosen.durationMinutes : minutesNeeded;
  const chosenPrice = chosen ? chosen.price : null;
  // Cheap to compute; no manual memo (the React Compiler memoises, and a manual one trips its lint rule here).
  const times = date ? timesFor(site, date, needed) : [];
  const phoneDigits = phone.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  const phoneOk = /^[6-9]\d{9}$/.test(phoneDigits);
  const needsPick = !offerSlug && !fixedServices;
  const namesOk = guestNames.slice(0, people - 1).every((n) => !n.trim() || /^[\p{L}\p{M} .'-]{2,60}$/u.test(n.trim()));
  const nameFine = name.trim().length >= 2;
  const ready = leadMode
    ? nameFine && phoneOk && !sending
    : Boolean(date && time && nameFine && phoneOk && namesOk && (!needsPick || picked.length > 0)) && !sending;

  // Meta Pixel: the first touch inside the form is the request STARTED (InitiateCheckout),
  // once per page view. Pointer as well as focus: Safari doesn't focus a tapped button.
  const started = useRef(false);
  function markStarted() {
    if (started.current) return;
    started.current = true;
    track("InitiateCheckout", { content_name: offerSlug ?? campaign ?? "Request" });
  }

  async function submit() {
    setSending(true);
    setError("");
    if (leadMode) {
      const r = await postLead({ name, phone: phoneDigits, query, source: "offer_page", offerSlug, campaign, trap });
      setSending(false);
      if (!r.ok) return setError(r.message);
      if (!r.duplicate) track("Lead", { content_name: offerSlug ?? campaign ?? "Lead" });
      setLeadSent(true);
      return;
    }
    const utm = readFirstTouch();
    try {
      const res = await fetch("/api/public/requests/wa", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...pixelHeaders() },
        body: JSON.stringify({
          ...(offerSlug ? { offerSlug, ...(chosen ? { packageSlug: chosen.slug } : {}) } : { services: picked }),
          ...(campaign ? { campaign } : {}),
          ...(utm ? { utm } : {}),
          date,
          time,
          name: name.trim(),
          phone: phoneDigits,
          website: trap,
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(people > 1 ? { people, guestNames: Array.from({ length: people - 1 }, (_, i) => (guestNames[i] ?? "").trim()) } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "That didn't go through. Try again, or message us on WhatsApp.");
        return;
      }
      setResult(data as Result);
      const r = data as Result;
      if (!r.duplicate) {
        trackOnce("Lead", r.ref, { content_name: r.package?.name ?? r.items[0]?.name ?? "Request", ...(r.package ? { value: r.package.price, currency: "INR" } : {}) });
      }
    } catch {
      setError("You seem to be offline. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (leadSent) {
    const wa = whatsappHref(site.contact.whatsapp, "Hi, I just left my details on your offer page.");
    return (
      <div role="status" className="rounded-[var(--radius-card)] border border-line bg-ivory-2 p-6 md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">Request sent</p>
        <h3 className="mt-3 font-serif text-[30px] leading-tight md:text-[38px]">Thank you, {name.trim().split(" ")[0] || "and welcome"}.</h3>
        <p className="mt-3 text-[16px] leading-[1.6]">We have your details and will call or WhatsApp you soon. Nothing is booked or paid.</p>
        {wa && (
          <div className="mt-5">
            <Button variant="whatsapp" href={wa} target="_blank" rel="noreferrer">
              Message us on WhatsApp
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (result) {
    const wa = whatsappHref(site.contact.whatsapp, `Hi, about my request ${result.ref}.`);
    return (
      <div role="status" className="rounded-[var(--radius-card)] border border-line bg-ivory-2 p-6 md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{result.duplicate ? "Already with us" : "Request sent"}</p>
        <h3 className="mt-3 font-serif text-[30px] leading-tight md:text-[38px]">Thank you, {name.trim().split(" ")[0] || "and welcome"}.</h3>
        <p className="mt-3 text-[16px] leading-[1.6]">
          We have your request{result.package ? <> for <b>{result.package.name}</b> ({rupees(result.package.price)}{result.people ? <> each, {rupees(result.total ?? result.package.price * result.people)} for {result.people} people</> : null})</> : result.people ? <> for <b>{result.people} people</b></> : null} for <b>{dayParts(result.date).long}</b> at <b>{clock(result.time)}</b>. It is <b>not booked yet</b>: we will confirm it on WhatsApp.
          Nothing is paid now.
        </p>
        <p className="mt-2 text-[14px] text-ink-muted">
          Your reference is <span className="font-mono">{result.ref}</span>.
        </p>
        {wa && (
          <div className="mt-5">
            <Button variant="whatsapp" href={wa} target="_blank" rel="noreferrer">
              Message us on WhatsApp
            </Button>
          </div>
        )}
      </div>
    );
  }

  const field = "mt-2 h-12 w-full rounded-[var(--radius-control)] border border-line bg-ivory px-4 text-[16px] outline-none focus:border-gold-deep";
  const label = "block text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-muted";

  return (
    <form
      className="space-y-6"
      onPointerDownCapture={markStarted}
      onFocusCapture={markStarted}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      {packages && packages.length > 0 && (
        <fieldset className="min-w-0">
          <legend className={label}>Choose your package</legend>
          <div className="mt-2 grid gap-3">
            {packages.map((p) => {
              const on = p.slug === pkgSlug;
              return (
                <label key={p.slug} className={`block cursor-pointer rounded-[var(--radius-card)] border p-4 transition-colors ${on ? "border-ink bg-ivory-2 ring-1 ring-ink" : "border-line bg-ivory hover:bg-ivory-2"}`}>
                  {/* A tap on the chosen package takes it off again (a radio does not do that by itself, so the click decides). */}
                  <input type="radio" name="package" value={p.slug} checked={on} onChange={() => {}} onClick={() => { setPkgSlug(on ? "" : p.slug); setTime(""); }} className="sr-only" />
                  <span className="flex items-baseline justify-between gap-4">
                    <span className="font-serif text-[22px] leading-tight">{p.name}</span>
                    <span className="tabular text-[22px] font-semibold">{rupees(p.price)}</span>
                  </span>
                  <ul className="mt-3 grid gap-x-6 gap-y-1 text-[15px] sm:grid-cols-2">
                    {p.services.map((n, i) => (
                      <li key={i}>· {n}</li>
                    ))}
                  </ul>
                  <span className="mt-3 block text-[13px] text-ink-muted">About {p.durationMinutes >= 60 ? `${Math.round((p.durationMinutes / 60) * 2) / 2} ${Math.round((p.durationMinutes / 60) * 2) / 2 === 1 ? "hour" : "hours"}` : `${p.durationMinutes} minutes`}</span>
                  <span className={`mt-2 inline-block rounded-full px-3 py-1 text-[13px] font-semibold ${on ? "bg-ink text-ivory" : "border border-line text-ink-muted"}`}>{on ? "Selected · tap again to remove" : "Tap to choose"}</span>
                </label>
              );
            })}
          </div>
          {leadMode && <p className="mt-3 text-[14px] text-ink-muted">Not sure yet? You can skip this and just leave your number below. We will call you.</p>}
        </fieldset>
      )}

      {fixedServices && (
        <div>
          <span className={label}>What you are asking for</span>
          <ul className="mt-2 space-y-1 text-[16px]">
            {fixedServices.map((s) => (
              <li key={s.id}>· {s.name}</li>
            ))}
          </ul>
        </div>
      )}

      {needsPick && menu && (
        <div>
          <span className={label}>Services</span>
          <select
            multiple
            value={picked}
            onChange={(e) => setPicked(Array.from(e.target.selectedOptions).map((o) => o.value))}
            className="mt-2 h-44 w-full rounded-[var(--radius-control)] border border-line bg-ivory p-2 text-[16px]"
            aria-label="Services (hold Ctrl or Cmd to pick more than one)"
          >
            {menu.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[13px] text-ink-muted">Tap to choose. On a computer, hold Ctrl or Cmd to pick more than one.</p>
        </div>
      )}

      {!leadMode && (
      <fieldset className="min-w-0">
        <legend className={label}>Day</legend>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {days.map((d) => {
            const p = dayParts(d);
            const on = d === date;
            return (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setDate(d);
                  setTime("");
                }}
                aria-pressed={on}
                className={`min-w-[64px] shrink-0 rounded-[var(--radius-control)] border px-3 py-2 text-center ${on ? "border-ink bg-ink text-ivory" : "border-line bg-ivory hover:bg-ivory-2"}`}
              >
                <span className="block text-[12px] uppercase">{p.weekday}</span>
                <span className="block text-[20px] font-semibold tabular">{p.day}</span>
                <span className="block text-[12px]">{p.month}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      )}

      {!leadMode && date && (
        <fieldset className="min-w-0">
          <legend className={label}>Time</legend>
          {times.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {times.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTime(t)}
                  aria-pressed={t === time}
                  className={`h-11 rounded-full border px-4 text-[15px] tabular ${t === time ? "border-ink bg-ink text-ivory" : "border-line bg-ivory hover:bg-ivory-2"}`}
                >
                  {clock(t)}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[15px] text-ink-muted">No more times that day. Pick another day.</p>
          )}
        </fieldset>
      )}

      {!leadMode && maxPeople > 1 && (
        <fieldset className="min-w-0">
          <legend className={label}>How many people?</legend>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              aria-label="One fewer person"
              disabled={people <= 1}
              onClick={() => setPeople((n) => Math.max(1, n - 1))}
              className="h-11 w-11 rounded-full border border-line bg-ivory text-[20px] hover:bg-ivory-2 disabled:opacity-40"
            >
              −
            </button>
            <span className="tabular w-8 text-center text-[20px] font-semibold" aria-live="polite">
              {people}
            </span>
            <button
              type="button"
              aria-label="One more person"
              disabled={people >= maxPeople}
              onClick={() => setPeople((n) => Math.min(maxPeople, n + 1))}
              className="h-11 w-11 rounded-full border border-line bg-ivory text-[20px] hover:bg-ivory-2 disabled:opacity-40"
            >
              +
            </button>
            <span className="text-[14px] text-ink-muted">Up to {maxPeople}. Everyone has the same {chosen ? "package" : "services"}, at the same time.</span>
          </div>
          {people > 1 && chosenPrice != null && (
            <p className="mt-2 text-[15px]">
              {rupees(chosenPrice)} × {people} = <b className="tabular">{rupees(chosenPrice * people)}</b>
            </p>
          )}
          {people > 1 && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {Array.from({ length: people - 1 }, (_, i) => (
                <label key={i} className={label}>
                  Person {i + 2} (name is optional)
                  <input
                    value={guestNames[i] ?? ""}
                    onChange={(e) => setGuestNames((prev) => Array.from({ length: Math.max(prev.length, i + 1) }, (_, k) => (k === i ? e.target.value : prev[k] ?? "")))}
                    maxLength={60}
                    autoComplete="off"
                    className={field}
                  />
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className={label}>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} className={field} />
        </label>
        <label className={label}>
          Mobile number
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="10-digit WhatsApp number"
            className={field}
          />
        </label>
      </div>

      <label className={`${label} block`}>
        Any other query (optional)
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={QUERY_MAX}
          rows={3}
          placeholder="e.g. Can my mother come along? Do you do bridal trials?"
          className="mt-2 w-full rounded-[var(--radius-control)] border border-line bg-ivory px-4 py-3 text-[16px] outline-none focus:border-gold-deep"
        />
      </label>

      {/* Bot trap: invisible to people (off-screen, not focusable, ignored by password managers). */}
      <div aria-hidden className="pointer-events-none absolute -left-[9999px] top-0 h-0 w-0 overflow-hidden opacity-0">
        <label>
          Website
          <input value={trap} onChange={(e) => setTrap(e.target.value)} tabIndex={-1} autoComplete="off" name="website" className="h-0 w-0 border-0 p-0" />
        </label>
      </div>

      {error && (
        <p role="alert" className="text-[15px] text-danger">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={!ready}>
        {sending ? "Sending…" : "Book a request"}
      </Button>
      <p className="text-[13px] leading-[1.5] text-ink-muted">
        {leadMode
          ? "This is not a booking. We will call or WhatsApp you about your enquiry only, and we do not send offers unless you ask."
          : "This is a request, not a booking. We confirm it on WhatsApp, and you pay at the salon after your visit. By sending it you agree that we message you on WhatsApp about this visit (confirmation, any change and a reminder). We will use your number only for this visit."}
      </p>
    </form>
  );
}
