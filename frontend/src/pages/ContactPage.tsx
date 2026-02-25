/**
 * @file ContactPage.tsx
 * @description Public Contact Us page for The Experts Hair Salon.
 */

import { motion } from "framer-motion";
import { MapPin, Phone, Mail, Clock, Instagram } from "lucide-react";
import AppLayout from "@/layouts/AppLayout";

const contactDetails = [
  {
    icon: MapPin,
    label: "Address",
    value: "Near: Sunrise Motel, Sirhind Road Patial, Punjab 147004",
    href: "https://share.google/K0R6KU00DnUpnOoTq",
  },
  {
    icon: Phone,
    label: "Phone",
    value: "+91 98148 30550",
    href: "tel:+919814830550",
  },
  {
    icon: Mail,
    label: "Email",
    value: "theexpertssalon@gmail.com",
    href: "mailto:theexpertssalon@gmail.com",
  },
  {
    icon: Instagram,
    label: "Instagram",
    value: "@theexperts.salon",
    href: "https://instagram.com/theexperts.salon",
  },
];

const hours = [
  { day: "Monday – Friday", time: "09:00 AM – 09:00 PM" },
  { day: "Saturday", time: "09:00 AM – 09:00 PM" },
];

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
};

export default function ContactPage() {
  return (
    <AppLayout subtitle="Contact Us">
      <div className="mx-auto max-w-4xl w-full px-6 pt-16 pb-20">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-stone-300/60 bg-white/80 backdrop-blur-sm shadow-sm mb-5 text-xs font-semibold text-stone-500 tracking-[0.18em] uppercase">
            Get In Touch
          </span>
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-stone-900 leading-tight mb-4">
            Contact <span className="text-amber-600">Us</span>
          </h1>
          <p className="text-lg text-stone-500 font-light max-w-2xl mx-auto leading-relaxed">
            Have a question or want to learn more? We'd love to hear from you.
            Reach out through any of the channels below.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-12">
          {/* Contact cards */}
          {contactDetails.map(({ icon: Icon, label, value, href }, i) => (
            <motion.a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...fadeUp}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="rounded-2xl border border-stone-200/80 bg-white shadow-sm p-6 flex items-start gap-4 hover:border-amber-300/60 hover:shadow-md transition-all duration-200 group"
            >
              <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center shrink-0 group-hover:bg-amber-100 transition-colors">
                <Icon className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-xs font-semibold text-stone-400 uppercase tracking-[0.12em] mb-1">
                  {label}
                </p>
                <p className="text-sm text-stone-700 font-medium">{value}</p>
              </div>
            </motion.a>
          ))}
        </div>

        {/* Business hours */}
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5 }}
          className="rounded-2xl border border-stone-200/80 bg-white shadow-sm p-8 sm:p-10 mb-12"
        >
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-amber-600" />
            </div>
            <h2 className="text-sm font-semibold text-stone-400 uppercase tracking-[0.15em]">
              Business Hours
            </h2>
          </div>
          <div className="space-y-3">
            {hours.map(({ day, time }) => (
              <div
                key={day}
                className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0"
              >
                <span className="text-sm text-stone-700 font-medium">{day}</span>
                <span className="text-sm text-stone-500">{time}</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Map */}
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5 }}
          className="rounded-2xl border border-stone-200/80 bg-stone-50 shadow-sm overflow-hidden"
        >
          <iframe
            title="The Experts Hair Salon Location"
            src="https://maps.google.com/maps?q=Near+Sunrise+Motel+Sirhind+Road+Patiala+Punjab+147004&output=embed"
            width="100%"
            height="320"
            style={{ border: 0 }}
            allowFullScreen
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className="w-full"
          />
        </motion.div>
      </div>
    </AppLayout>
  );
}
