import type { Metadata } from "next";
import { LegalPage } from "@/components/site/LegalPage";

export const metadata: Metadata = { title: "Cancellation policy", alternates: { canonical: "/cancellation-policy" } };

export default function CancellationPolicyPage() {
  return (
    <LegalPage title="Cancellation policy" intro="How to change or cancel an appointment, and what happens to money you've paid.">
      <h2>Right now</h2>
      <p>Requests from this website are paid at the salon, so there&apos;s nothing to refund. To change or cancel, message us on WhatsApp or call the salon as early as you can, so we can offer the time to someone else.</p>

      <h2>When you pay online</h2>
      <p>Online payment is coming. Once it&apos;s live, every online booking is paid when you book — either in full, or ₹500 now and the rest at the salon. Then:</p>
      <ul>
        <li>If you cancel, or don&apos;t come, we keep ₹500 as a cancellation fee and refund the rest of what you paid. If you paid only the ₹500, it isn&apos;t refunded.</li>
        <li>If we cancel, or can&apos;t accept your booking, you get everything back.</li>
        <li>Moving your appointment to another time is free (up to twice), and your payment moves with it.</li>
      </ul>
      <p>Refunds go back to the card, UPI or account you paid with. Your bank may take a few working days to show it.</p>
      <p>The payment step repeats these terms before you pay.</p>
    </LegalPage>
  );
}
