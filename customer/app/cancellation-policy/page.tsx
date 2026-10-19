import type { Metadata } from "next";
import { LegalPage } from "@/components/site/LegalPage";
import { getSite } from "@/lib/api";

export const metadata: Metadata = { title: "Cancellation policy", alternates: { canonical: "/cancellation-policy" } };

/**
 * The rules in CF §5.2 / D47. The wording follows whether online booking is
 * live (T2.22), so the page never describes a payment the site doesn't take.
 */
export default async function CancellationPolicyPage() {
  const site = await getSite();
  const live = Boolean(site?.onlineBooking?.enabled);
  const percent = site?.onlineBooking?.cancellationFeePercent ?? 30;
  const notice = site?.onlineBooking?.noticeHours ?? 24;
  const minFee = site?.onlineBooking?.cancellationFeeMin ?? 100;
  const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  return (
    <LegalPage title="Cancellation policy" intro="How to change or cancel an appointment, and what happens to money you've paid.">
      {!live && (
        <>
          <h2>Requests</h2>
          <p>Requests from this website are paid at the salon, so there&apos;s nothing to refund. To change or cancel, message us on WhatsApp or call the salon as early as you can, so we can offer the time to someone else.</p>
        </>
      )}

      <h2>{live ? "Online bookings" : "When you pay online"}</h2>
      <p>
        {live ? "" : "Online payment is coming. Once it's live, "}Every online booking is paid when you book — either in full, or a deposit ({percent}% of your bill) now and the rest at the salon. Then:
      </p>
      <ul>
        <li>
          <strong>Cancel or move up to {notice} hours before: free.</strong> Everything you paid is refunded, and moving your appointment keeps your payment with it (up to twice).
        </li>
        <li>
          <strong>Later than that, or if you don&apos;t come:</strong> we keep {percent}% of your bill as a cancellation fee (rounded to the nearest ₹10, at least {rupee(minFee)}) and refund the rest. If you paid only the deposit, the deposit is the fee.
        </li>
        <li>If we cancel, or can&apos;t accept your booking, you get everything back, automatically.</li>
      </ul>

      {live && (
        <>
          <h2>If we change your artist</h2>
          <p>
            If the artist you chose can&apos;t make it (illness, leave, or they have left the salon), we move you to another artist at the same time and tell you on WhatsApp. If you&apos;d
            rather not go ahead, you can cancel for free whatever the notice, and get everything back.
          </p>

          <h2>How refunds are sent</h2>
          <ul>
            <li>When <strong>we</strong> cancel or can&apos;t accept your booking, the refund is sent automatically, in full.</li>
            <li>When <strong>you</strong> cancel, we check the booking and send the refund by hand, so it can take a few working days to start.</li>
            <li>It goes back to the card, UPI or account you paid with. Your bank may take up to 5–7 working days to show it.</li>
            <li>We message you on WhatsApp when the refund has been sent.</li>
          </ul>

          <h2>The fee we keep</h2>
          <p>
            If we keep a cancellation fee, it is for the time we held for you and couldn&apos;t offer to anyone else. We tell you the exact amount before you confirm a cancellation. If you
            think it isn&apos;t fair in your case, message us. We can waive it.
          </p>
        </>
      )}

      <p>
        {live
          ? "Cancel or move from the link in your booking message on WhatsApp, or message us. "
          : ""}
        {!live && "Refunds go back to the card, UPI or account you paid with. Your bank may take a few working days to show it."}
      </p>
      <p>The payment step repeats these terms before you pay.</p>
    </LegalPage>
  );
}
