"use client";

/**
 * LeadForm — the "Interested?" form on the home page. Name, mobile number and an optional question; no day, no time,
 * no package. It becomes a LEAD the salon sees in the staff app (Bookings → Leads) and calls back. It is not a booking and
 * it is not marketing consent: the number is used only to answer this enquiry.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { mobileDigits, nameOk, postLead, QUERY_MAX } from "@/lib/leads";
import { whatsappHref } from "@/lib/format";
import { track } from "@/lib/pixel";

export function LeadForm({ whatsapp }: { whatsapp: string | null }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [query, setQuery] = useState("");
  const [trap, setTrap] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const digits = mobileDigits(phone);
  const ready = nameOk(name) && digits !== "" && !sending;

  async function submit() {
    setSending(true);
    setError("");
    const r = await postLead({ name, phone: digits, query, source: "landing", trap });
    setSending(false);
    if (!r.ok) return setError(r.message);
    if (!r.duplicate) track("Lead", { content_name: "Home page: interested" });
    setDone(true);
  }

  if (done) {
    const wa = whatsappHref(whatsapp, "Hi, I just left my details on your website.");
    return (
      <div role="status" className="rounded-[var(--radius-card)] border border-line bg-ivory p-6 md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">Details received</p>
        <h3 className="mt-3 font-serif text-[30px] leading-tight md:text-[38px]">Thank you, {name.trim().split(" ")[0] || "and welcome"}.</h3>
        <p className="mt-3 text-[16px] leading-[1.6]">We have your details and will call or WhatsApp you soon.</p>
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
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <label className={label}>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} className={field} />
        </label>
        <label className={label}>
          Mobile number
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel-national" placeholder="10-digit WhatsApp number" className={field} />
        </label>
      </div>
      <label className={`${label} block`}>
        Any other query (optional)
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={QUERY_MAX}
          rows={3}
          placeholder="e.g. Do you do bridal trials? What is a good time on Saturday?"
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
      <Button type="submit" className="w-full md:w-auto" disabled={!ready}>
        {sending ? "Sending…" : "Send my details"}
      </Button>
      <p className="text-[13px] leading-[1.5] text-ink-muted">We will call or WhatsApp you about this enquiry only. This is not a booking, and we do not send offers unless you ask.</p>
    </form>
  );
}
