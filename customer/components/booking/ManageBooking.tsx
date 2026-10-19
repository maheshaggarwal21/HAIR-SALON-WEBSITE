"use client";

/**
 * Manage a booking from the WhatsApp link (CF §9, T2.21, DS §6.2).
 *
 *   view · add to calendar · directions · move to another time · cancel
 *
 * The cost of cancelling is shown BEFORE the customer confirms (D47: free until
 * the notice period, after that the fee is kept and the rest refunded). Moving keeps the payment, up to the
 * salon's limit and only before the cut-off. A link older than a day asks for
 * a fresh WhatsApp code first, so a forwarded message can't cancel someone's
 * appointment.
 */

import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, MapPin } from "lucide-react";
import type { ManageView, Slot } from "@/lib/types";
import { addDays, dayParts, isOpenOn, rupees, todayIST, whatsappHref } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Turnstile } from "@/components/request/Turnstile";
import { TURNSTILE_SITE_KEY } from "@/lib/config";

const STATUS_TEXT: Record<string, string> = {
  pending_payment: "Waiting for payment",
  requested: "Requested — the salon will confirm on WhatsApp",
  confirmed: "Confirmed",
  checked_in: "You're at the salon",
  completed: "Completed — thank you",
  cancelled: "Cancelled",
  declined: "The salon couldn't take this booking",
  expired: "Expired",
  no_show: "Missed",
};

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });

async function post<T>(path: string, body: unknown) {
  const res = await fetch(`/api/public${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  return { ok: res.ok, data };
}

export function ManageBooking({ token }: { token: string }) {
  const [view, setView] = useState<ManageView | null>(null);
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<"none" | "cancel" | "move">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // Fresh WhatsApp code (links older than a day).
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [bookingToken, setBookingToken] = useState<string | null>(null);
  const [ts, setTs] = useState<string | null>(null);
  const [tsReset, setTsReset] = useState(0);
  // Move.
  const [today, setToday] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/public/booking/${token}`, { cache: "no-store" });
    if (res.status === 404) return setMissing(true);
    if (res.ok) setView(await res.json());
  }, [token]);

  useEffect(() => {
    // Fetching on mount: the data lives in an API, not React state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (missing) return <p className="text-[16px]">We couldn&apos;t find that booking. Check the link in your WhatsApp message, or message us.</p>;
  if (!view) return <p className="text-ink-muted">Loading your booking…</p>;

  const b = view.booking;
  const wa = whatsappHref(view.salon.whatsapp, `Hi, about my booking ${b.ref}.`);
  const needsCode = view.rules.needsOtp && !bookingToken;

  async function sendCode() {
    const digits = phone.replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(digits)) return setError("Enter the mobile number you booked with.");
    setBusy(true);
    setError("");
    const r = await post("/otp/send", { phone: digits, ...(ts ? { turnstileToken: ts } : {}) });
    setTsReset((n) => n + 1);
    setTs(null);
    setBusy(false);
    if (!r.ok) return setError(r.data.message || "Couldn't send a code.");
    setCodeSent(true);
  }

  async function verify() {
    setBusy(true);
    setError("");
    const r = await post<{ bookingToken: string }>("/otp/verify", { phone: phone.replace(/\D/g, ""), code });
    setBusy(false);
    if (!r.ok) return setError(r.data.message || "That code didn't match.");
    setBookingToken(r.data.bookingToken);
  }

  async function cancel() {
    setBusy(true);
    setError("");
    const r = await post(`/booking/${token}/cancel`, bookingToken ? { bookingToken } : {});
    setBusy(false);
    if (!r.ok) {
      if (r.data.error === "OTP_REQUIRED") setBookingToken(null);
      return setError(r.data.message || "That didn't go through. Message us on WhatsApp.");
    }
    setMode("none");
    setNote("Your booking is cancelled. We've sent the details to WhatsApp.");
    load();
  }

  async function pickDate(d: string) {
    setDate(d);
    setSlot(null);
    setSlots(null);
    const res = await fetch(`/api/public/booking/${token}/availability?date=${d}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    setSlots(res.ok ? data.slots : []);
  }

  async function move() {
    if (!slot) return;
    setBusy(true);
    setError("");
    const r = await post(`/booking/${token}/reschedule`, { startAt: slot.startAt, ...(bookingToken ? { bookingToken } : {}) });
    setBusy(false);
    if (!r.ok) {
      if (r.data.error === "SLOT_TAKEN" && date) pickDate(date);
      return setError(r.data.message || "That time was just taken. Pick another.");
    }
    setMode("none");
    setNote("Moved. We've sent the new time to WhatsApp.");
    load();
  }

  const dates = today && view ? Array.from({ length: 28 }, (_, i) => addDays(today, i)).filter((d) => isOpenOn(view.salon, d)).slice(0, 21) : [];

  return (
    <div>
      <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-gold-deep">Booking {b.ref}</p>
      <h1 className="mt-2 font-serif text-[40px] leading-[1.05] md:text-[56px]">
        {b.startAt ? (
          <>
            {fmtDay(b.startAt)}, <em className="text-gold">{fmtTime(b.startAt)}</em>.
          </>
        ) : (
          "Your booking."
        )}
      </h1>
      <p className="mt-3 text-[16px]">{STATUS_TEXT[b.status] || b.status}</p>
      {note && <p className="mt-3 text-[15px] font-medium text-success" aria-live="polite">{note}</p>}

      <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-ivory-2 p-4 text-[15px]">
        <ul className="space-y-1">
          {b.guests.flatMap((g) =>
            g.items.map((i, idx) => (
              <li key={`${g.key}-${idx}`} className="flex justify-between gap-3">
                <span>
                  {i.name}
                  {i.artistName ? <span className="text-ink-muted"> · {i.artistName}</span> : null}
                  {i.startAt ? <span className="text-ink-muted"> · {fmtTime(i.startAt)}</span> : null}
                </span>
                <span className="tabular">{rupees(i.price)}</span>
              </li>
            ))
          )}
        </ul>
        <div className="mt-3 flex justify-between border-t border-line pt-3 font-semibold">
          <span>Total</span>
          <span className="tabular">{rupees(b.pricing.total)}</span>
        </div>
        {b.payment.amount > 0 && !["none", "pending"].includes(b.payment.status) && (
          <div className="mt-1 flex justify-between text-ink-muted">
            <span>Paid online</span>
            <span className="tabular">{rupees(b.payment.amount)}</span>
          </div>
        )}
        {b.payment.status === "paid" && b.pricing.total > b.payment.amount && ["confirmed", "requested"].includes(b.status) && (
          <div className="mt-1 flex justify-between text-ink-muted">
            <span>To pay at the salon</span>
            <span className="tabular">{rupees(b.pricing.total - b.payment.amount)}</span>
          </div>
        )}
        {view.refund && (
          <div className="mt-1 flex justify-between text-ink-muted">
            <span>Refund {view.refund.status === "processed" ? "sent" : "on its way"}</span>
            <span className="tabular">{rupees(view.refund.amount)}</span>
          </div>
        )}
      </div>

      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {b.startAt && ["confirmed", "requested"].includes(b.status) && (
          <Button variant="secondary" href={`/api/public/booking/${token}/calendar.ics`}>
            <CalendarPlus className="mr-2 h-4 w-4" /> Add to calendar
          </Button>
        )}
        {view.salon.mapUrl && (
          <Button variant="secondary" href={view.salon.mapUrl} target="_blank" rel="noopener">
            <MapPin className="mr-2 h-4 w-4" /> Directions
          </Button>
        )}
        {view.rules.canReschedule && mode === "none" && (
          <Button
            variant="secondary"
            onClick={() => {
              setMode("move");
              setToday(todayIST(new Date()));
            }}
          >
            Move to another time
          </Button>
        )}
        {view.rules.canCancel && mode === "none" && (
          <Button variant="secondary" onClick={() => setMode("cancel")}>
            Cancel booking
          </Button>
        )}
        {wa && (
          <Button variant="whatsapp" href={wa} target="_blank" rel="noopener">
            Message us
          </Button>
        )}
      </div>

      {mode !== "none" && needsCode && (
        <div className="mt-6 rounded-[var(--radius-card)] border border-line p-4">
          <p className="text-[15px]">For your security, confirm it&apos;s you with a WhatsApp code (number ending {view.phoneHint.slice(-2)}).</p>
          <div className="mt-3 flex h-12 items-center rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3">
            <span className="pr-2 text-ink-muted">+91</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, "").slice(0, 12))} inputMode="numeric" className="h-full flex-1 bg-transparent tabular outline-none" />
          </div>
          {codeSent && (
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              className="mt-3 h-12 w-full rounded-[var(--radius-control)] border border-line bg-ivory-2 px-3 text-[18px] tracking-[0.3em] tabular"
            />
          )}
          <div className="mt-3">
            <Turnstile onToken={setTs} resetKey={tsReset} />
          </div>
          <div className="mt-3">
            {codeSent ? (
              <Button disabled={busy || code.length !== 6} onClick={verify}>
                Confirm code
              </Button>
            ) : (
              <Button disabled={busy || (Boolean(TURNSTILE_SITE_KEY) && !ts)} onClick={sendCode}>
                Send code
              </Button>
            )}
          </div>
        </div>
      )}

      {mode === "cancel" && !needsCode && (
        <div className="mt-6 rounded-[var(--radius-card)] border border-line p-4">
          <p className="text-[16px] font-semibold">Cancel this booking?</p>
          <p className="mt-1 text-[15px] text-ink-muted">
            {view.rules.cancel.kept > 0
              ? `${rupees(view.rules.cancel.kept)} is kept as a cancellation fee${view.rules.cancel.refund > 0 ? ` and ${rupees(view.rules.cancel.refund)} is refunded to you` : ""}.`
              : view.rules.cancel.refund > 0
                ? `${rupees(view.rules.cancel.refund)} is refunded to you.`
                : "Nothing has been paid, so nothing is charged."}
            {view.rules.canReschedule ? " You can move it to another time instead, free." : ""}
          </p>
          <div className="mt-4 flex gap-2">
            <Button disabled={busy} onClick={cancel}>
              {busy ? "Cancelling…" : "Yes, cancel"}
            </Button>
            <Button variant="secondary" onClick={() => setMode("none")}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {mode === "move" && !needsCode && (
        <div className="mt-6 rounded-[var(--radius-card)] border border-line p-4">
          <p className="text-[16px] font-semibold">Pick a new time</p>
          <p className="mt-1 text-[14px] text-ink-muted">
            Your payment moves with it. {view.rules.reschedulesLeft} change{view.rules.reschedulesLeft === 1 ? "" : "s"} left.
          </p>
          <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-2">
            {dates.map((d) => {
              const p = dayParts(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={date === d}
                  onClick={() => pickDate(d)}
                  className={`flex h-[72px] w-[58px] shrink-0 flex-col items-center justify-center rounded-[var(--radius-control)] border ${date === d ? "border-sand bg-sand text-gold-deep" : "border-line"}`}
                >
                  <span className="text-[12px] font-semibold uppercase">{p.weekday}</span>
                  <span className="tabular text-[20px] font-semibold leading-none">{p.day}</span>
                  <span className="text-[12px]">{p.month}</span>
                </button>
              );
            })}
          </div>
          {date && !slots && <p className="mt-3 text-ink-muted">Finding free times…</p>}
          {slots && slots.length === 0 && <p className="mt-3 text-ink-muted">No free times that day. Try another.</p>}
          {slots && slots.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((s) => (
                <button
                  key={s.startAt}
                  type="button"
                  aria-pressed={slot?.startAt === s.startAt}
                  onClick={() => setSlot(s)}
                  className={`min-h-[44px] rounded-[var(--radius-control)] border text-[15px] font-semibold tabular ${slot?.startAt === s.startAt ? "border-sand bg-sand text-gold-deep" : "border-line"}`}
                >
                  {fmtTime(s.startAt)}
                </button>
              ))}
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <Button disabled={!slot || busy} onClick={move}>
              {busy ? "Moving…" : slot ? `Move to ${fmtTime(slot.startAt)}` : "Move"}
            </Button>
            <Button variant="secondary" onClick={() => setMode("none")}>
              Back
            </Button>
          </div>
        </div>
      )}

      <p aria-live="polite" className="mt-4 min-h-[1.25rem] text-[14px] font-medium text-danger">
        {error}
      </p>
    </div>
  );
}
