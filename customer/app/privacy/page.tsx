import type { Metadata } from "next";
import { LegalPage } from "@/components/site/LegalPage";

export const metadata: Metadata = { title: "Privacy", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" intro="What we collect when you use this website or visit the salon, why, and what you can ask us to do with it.">
      <h2>Who we are</h2>
      <p>The Experts is a hair and beauty salon at Green Park Colony, near Sunrise Hotel, Sirhind–Patiala Rd, Patiala. We decide how your information is used.</p>

      <h2>What we collect</h2>
      <ul>
        <li>When you send a request: your name, mobile number, the services you chose, the day and time of day you asked for, any note you write, and whether the visit is for a woman or a man.</li>
        <li>Which ad or link brought you to the site, if the link said so (for example an Instagram ad). We keep this in your browser for 30 days and send it with your request.</li>
        <li>Whether you ticked “Send me offers on WhatsApp”. It is unticked unless you tick it.</li>
        <li>When you visit the salon: the services you had, what you paid and how, and who served you.</li>
      </ul>
      <p>We don&apos;t collect health information, except the date of a colour patch test so we know when you&apos;re clear to colour. We don&apos;t use advertising or tracking cookies on this website.</p>

      <h2>Why we use it</h2>
      <ul>
        <li>To arrange and confirm your appointment, and to call or WhatsApp you about it.</li>
        <li>To keep records of the services and payments at the salon.</li>
        <li>To send you offers on WhatsApp — only if you said yes. You can say stop at any time.</li>
        <li>To understand which ads and posts bring customers, as totals, not to follow you around the internet.</li>
      </ul>

      <h2>Who else handles it</h2>
      <p>
        We use companies that run parts of the service for us: website and server hosting (Vercel), our database (MongoDB Atlas), a spam check on forms (Cloudflare Turnstile),
        payments at the salon (Razorpay), messages to the salon owner (Telegram) and, when it starts, WhatsApp messages to you through a WhatsApp Business provider. They only use
        your information to provide that service to us. We don&apos;t sell your information.
      </p>

      <h2>Photos</h2>
      <p>We only put a client&apos;s before-and-after photos on the website or social media if that client has agreed to it.</p>

      <h2>How long we keep it</h2>
      <p>As long as you are a customer and as long as we need it for our records and the law. Ask us and we&apos;ll delete what we don&apos;t have to keep.</p>

      <h2>Your choices</h2>
      <p>
        Under India&apos;s Digital Personal Data Protection Act, 2023, you can ask to see the information we hold about you, correct it, or delete it, and you can withdraw your
        consent to marketing messages. Message or call the salon, or ask at the desk.
      </p>
    </LegalPage>
  );
}
