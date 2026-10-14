import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/LegalPage";

export const metadata: Metadata = { title: "Terms", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  return (
    <LegalPage title="Terms" intro="The simple rules for using this website and requesting an appointment at The Experts.">
      <h2>Requests</h2>
      <p>
        Sending the form on this website is a request, not a confirmed appointment. We call or WhatsApp you to agree an exact time. Your appointment is fixed once we have both
        agreed it. If we can&apos;t fit you in on the day you asked for, we&apos;ll suggest another time.
      </p>

      <h2>Prices</h2>
      <p>
        The price shown on the website is the price you pay for that service. Services marked “Consultation first” are confirmed after we&apos;ve talked about your hair or skin,
        and the final service — and its price — may change if you choose something different at the salon. Anything you add at the salon is charged at its normal price.
      </p>

      <h2>Paying</h2>
      <p>For now you pay at the salon after your visit. When online payment becomes available, the payment step will show exactly what you pay and the cancellation terms before you pay.</p>

      <h2>Patch tests</h2>
      <p>Colour services marked “Patch test 48h before” need a skin test at the salon at least 48 hours before the colour appointment. We may postpone the colour if the test hasn&apos;t been done.</p>

      <h2>Changing or cancelling</h2>
      <p>
        See the <Link href="/cancellation-policy" className="underline">cancellation policy</Link>.
      </p>

      <h2>The website</h2>
      <p>We keep the menu, prices and opening hours up to date, but mistakes can happen. If a price on the website is wrong, we&apos;ll tell you before your service.</p>
      <p>These terms are governed by the laws of India.</p>
    </LegalPage>
  );
}
