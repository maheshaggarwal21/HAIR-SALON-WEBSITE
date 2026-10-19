import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/LegalPage";
import { getSite } from "@/lib/api";

export const metadata: Metadata = { title: "Terms", alternates: { canonical: "/terms" } };

/**
 * Terms of using the website and booking. Online booking (D49) is paid and
 * instant for every service, so the wording follows the live switch like the
 * cancellation policy does, and never describes a payment the site doesn't take.
 */
export default async function TermsPage() {
  const site = await getSite();
  const live = Boolean(site?.onlineBooking?.enabled);
  const hold = site?.onlineBooking?.holdMinutes ?? 10;

  return (
    <LegalPage title="Terms" intro="The simple rules for using this website and booking an appointment at The Experts.">
      {live ? (
        <>
          <h2>Booking online</h2>
          <p>
            Choose your services, an artist (or let us pick) and a time, verify your mobile number with a WhatsApp code, and pay. Your appointment is confirmed as soon as your payment
            reaches us, and we send the details on WhatsApp. We hold your time for {hold} minutes while you pay. If the payment arrives after we have had to give the time to someone
            else, we cancel and refund it in full, automatically.
          </p>
          <p>Your mobile number is how we reach you, so it has to be yours and correct. We may cancel and refund a booking made with a number that isn&apos;t.</p>

          <h2>Your artist</h2>
          <p>
            You can choose an artist or let us choose. If your artist can&apos;t make it, we move you to another artist at the same time and tell you on WhatsApp. If you&apos;d rather not
            go ahead, you can cancel for free.
          </p>

          <h2>Paying</h2>
          <p>
            You pay online when you book, in full or as a deposit with the rest at the salon. Payments are taken by Razorpay; we never see or store your card or UPI details. The payment
            step shows exactly what you pay, the balance, and the cancellation terms before you pay. Anything you add at the salon is charged at the website price. If you have a problem
            with a payment, message us first and we&apos;ll sort it out.
          </p>
        </>
      ) : (
        <>
          <h2>Requests</h2>
          <p>
            Sending the form on this website is a request, not a confirmed appointment. We call or WhatsApp you to agree an exact time. Your appointment is fixed once we have both
            agreed it. If we can&apos;t fit you in on the day you asked for, we&apos;ll suggest another time.
          </p>

          <h2>Paying</h2>
          <p>For now you pay at the salon after your visit. When online payment becomes available, the payment step will show exactly what you pay and the cancellation terms before you pay.</p>
        </>
      )}

      <h2>Prices</h2>
      <p>
        The price shown on the website is the price you pay for that service. Your final service — and its price — may change if you choose something different at the salon. Anything
        you add at the salon is charged at its website price.
      </p>

      <h2>Patch tests</h2>
      <p>
        Colour services marked “Patch test 48h before” need a skin test at the salon at least 48 hours before the colour appointment, so the earliest times we offer for them start
        then. We may postpone the colour if the test hasn&apos;t been done.
      </p>

      <h2>Changing or cancelling</h2>
      <p>
        See the <Link href="/cancellation-policy" className="underline">cancellation policy</Link>: what is free, what a late cancellation or no-show costs, and how refunds are sent.
      </p>

      <h2>The website</h2>
      <p>We keep the menu, prices and opening hours up to date, but mistakes can happen. If a price on the website is wrong, we&apos;ll tell you before your service.</p>
      <p>These terms are governed by the laws of India.</p>
    </LegalPage>
  );
}
