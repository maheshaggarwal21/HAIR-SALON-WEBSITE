/**
 * @file PrivacyPolicyPage.tsx
 * @description Privacy Policy page for The Experts Hair Salon.
 */

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { ShieldCheck, Scissors } from "lucide-react";
import AppLayout from "@/layouts/AppLayout";

const LAST_UPDATED = "24 February 2026";

interface SectionProps {
  title: string;
  children: React.ReactNode;
  index: number;
}

function Section({ title, children, index }: SectionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.15 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.55, ease: "easeOut", delay: index * 0.07 }}
      className="mb-10"
    >
      <h2 className="text-xl font-bold text-stone-800 mb-3 flex items-center gap-2">
        <span
          className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-[11px] font-black text-amber-600 shrink-0"
          style={{ background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)" }}
        >
          {String(index + 1).padStart(2, "0")}
        </span>
        {title}
      </h2>
      <div className="text-sm text-stone-500 leading-relaxed space-y-2 font-light pl-9">
        {children}
      </div>
    </motion.div>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <AppLayout>
      {/* Hero banner */}
      <div
        className="relative overflow-hidden pt-28 pb-16 px-6 text-center"
        style={{ background: "linear-gradient(160deg, #2a1a0e 0%, #1c120a 60%, #140d06 100%)" }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(180,140,60,0.18) 0%, transparent 70%)",
          }}
        />
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 flex flex-col items-center gap-4"
        >
          <div className="w-14 h-14 rounded-2xl bg-amber-600 flex items-center justify-center shadow-lg ring-1 ring-amber-400/30">
            <ShieldCheck className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-white leading-tight">
            Privacy Policy
          </h1>
          <p className="text-sm text-white/40 font-light">Last updated: {LAST_UPDATED}</p>
        </motion.div>
        {/* Bottom fade */}
        <div
          className="absolute bottom-0 left-0 right-0 h-10 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, transparent, #faf8f4)" }}
        />
      </div>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-6 py-16">
        {/* Intro */}
        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="text-base text-stone-500 leading-relaxed mb-12 font-light border-l-4 border-amber-400/60 pl-5"
        >
          At <strong className="text-stone-700 font-semibold">The Experts Hair Salon</strong>, your
          privacy is important to us. This Privacy Policy explains how we collect, use, store, and
          protect your personal information when you visit our salon or use our digital platforms.
          By engaging with our services, you agree to the practices described below.
        </motion.p>

        <Section index={0} title="Information We Collect">
          <p>
            We may collect the following types of personal information to provide and improve our
            services:
          </p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>
              <strong className="text-stone-600">Identity & Contact:</strong> Full name, phone
              number, and email address provided when booking an appointment or registering an
              account.
            </li>
            <li>
              <strong className="text-stone-600">Visit Information:</strong> Services availed,
              assigned artist, visit date and time, and payment details.
            </li>
            <li>
              <strong className="text-stone-600">Payment Data:</strong> Transaction IDs and payment
              status processed securely through Razorpay. We do not store your card or bank
              credentials on our servers.
            </li>
            <li>
              <strong className="text-stone-600">Usage Data:</strong> Browser type, IP address,
              pages visited, and interaction patterns on our web platform, collected via standard
              server logs and analytics tools.
            </li>
          </ul>
        </Section>

        <Section index={1} title="How We Use Your Information">
          <p>Your information is used solely for legitimate business purposes, including:</p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>Scheduling and managing your salon appointments.</li>
            <li>Processing payments and issuing digital receipts.</li>
            <li>Communicating appointment reminders, confirmations, or updates.</li>
            <li>Improving our services through aggregated analytics.</li>
            <li>Complying with applicable legal and regulatory obligations.</li>
          </ul>
          <p className="mt-2">
            We do <strong className="text-stone-600">not</strong> sell, rent, or trade your
            personal information to any third party for marketing purposes.
          </p>
        </Section>

        <Section index={2} title="Data Storage & Security">
          <p>
            All personal data is stored on secure, password-protected servers hosted via Vercel and
            MongoDB Atlas. We implement industry-standard security measures including:
          </p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>HTTPS/TLS encryption for all data in transit.</li>
            <li>Hashed password storage — plain-text passwords are never stored.</li>
            <li>Session-based authentication with role-based access controls.</li>
            <li>Regular security audits and dependency updates.</li>
          </ul>
          <p className="mt-2">
            While we take reasonable precautions, no system is completely infallible. We encourage
            you to keep your login credentials confidential.
          </p>
        </Section>

        <Section index={3} title="Cookies & Tracking">
          <p>
            Our platform may use essential cookies to maintain your session and authentication
            state. We do not use advertising or cross-site tracking cookies. You may configure your
            browser to block cookies, though this may affect certain features of the platform.
          </p>
        </Section>

        <Section index={4} title="Third-Party Services">
          <p>
            We integrate with the following third-party services to power our platform. Each
            service operates under its own Privacy Policy:
          </p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>
              <strong className="text-stone-600">Razorpay</strong> — Secure payment processing.
            </li>
            <li>
              <strong className="text-stone-600">MongoDB Atlas</strong> — Cloud database hosting.
            </li>
            <li>
              <strong className="text-stone-600">Vercel</strong> — Application deployment and
              hosting.
            </li>
          </ul>
          <p className="mt-2">
            We are not responsible for the privacy practices of these third-party providers.
          </p>
        </Section>

        <Section index={5} title="Data Retention">
          <p>
            We retain your personal data for as long as is necessary to provide our services or as
            required by law. Visit records and payment history may be retained for up to{" "}
            <strong className="text-stone-600">5 years</strong> for accounting and compliance
            purposes. You may request deletion of your data by contacting us (see below).
          </p>
        </Section>

        <Section index={6} title="Your Rights">
          <p>You have the right to:</p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>Access the personal data we hold about you.</li>
            <li>Request correction of inaccurate or incomplete data.</li>
            <li>Request deletion of your personal data, subject to legal obligations.</li>
            <li>Withdraw consent for optional communications at any time.</li>
          </ul>
          <p className="mt-2">
            To exercise any of these rights, please contact us at{" "}
            <a
              href="mailto:hello@theexperts.in"
              className="text-amber-600 hover:underline font-medium"
            >
              hello@theexperts.in
            </a>
            .
          </p>
        </Section>

        <Section index={7} title="Children's Privacy">
          <p>
            Our digital platform is intended for use by adults aged 18 and above. We do not
            knowingly collect personal information from children under 18. If you believe a minor
            has provided us with personal data, please contact us immediately so we can remove it.
          </p>
        </Section>

        <Section index={8} title="Changes to This Policy">
          <p>
            We reserve the right to update this Privacy Policy at any time. Changes will be
            reflected on this page with an updated "Last updated" date. We encourage you to review
            this policy periodically. Continued use of our services following any update constitutes
            acceptance of the revised policy.
          </p>
        </Section>

        <Section index={9} title="Contact Us">
          <p>
            For any questions, concerns, or requests regarding this Privacy Policy, please reach
            out to us:
          </p>
          <ul className="list-none space-y-1 mt-1">
            <li>
              <strong className="text-stone-600">The Experts Hair Salon</strong>
            </li>
            <li> Near: Sunrise Motel, Sirhind Road Patial, Punjab 147004</li>
            <li>
              Phone:{" "}
              <a href="tel:+919814830550" className="text-amber-600 hover:underline font-medium">
                +91 98148 30550
              </a>
            </li>
            <li>
              Email:{" "}
              <a
                href="mailto: theexpertssalon@gmail.com"
                className="text-amber-600 hover:underline font-medium"
              >
                theexpertssalon@gmail.com
              </a>
            </li>
          </ul>
        </Section>
      </main>

      {/* Footer strip */}
      <div
        className="py-8 text-center"
        style={{ background: "linear-gradient(160deg, #2a1a0e 0%, #1c120a 60%, #140d06 100%)" }}
      >
        <div className="flex items-center justify-center gap-2 mb-2">
          <div className="h-8 w-8 rounded-lg bg-amber-600 flex items-center justify-center">
            <Scissors className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-bold text-white tracking-tight">The Experts</span>
        </div>
        <p className="text-[11px] text-white/30 tracking-wide">
          © {new Date().getFullYear()} The Experts Hair Salon · All rights reserved
        </p>
      </div>
    </AppLayout>
  );
}
