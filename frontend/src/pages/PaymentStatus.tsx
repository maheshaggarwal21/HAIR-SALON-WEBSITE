/**
 * @file PaymentStatus.tsx
 * @description Payment confirmation / failure page.
 *
 * Supports two payment flows:
 *   Flow A — Razorpay Order (embedded checkout): query params include
 *             `payment_id`, `amount`, `name`, `phone`.
 *   Flow B — Razorpay Payment Link (legacy): query params include
 *             standard Razorpay callback fields that are verified
 *             server-side via /api/verify-payment.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Scissors,
  User,
  Phone,
  Hash,
  CalendarCheck,
  AlertTriangle,
  Banknote,
  CreditCard,
} from "lucide-react";
import { SparklesCore } from "@/components/ui/sparkles";

interface PaymentDetails {
  success: boolean;
  payment_id: string;
  amount: number;
  currency: string;
  name: string;
  phone: string;
  status: string;
  error?: string;
  method?: "online" | "cash" | "partial";
  cashAmount?: number;
  totalAmount?: number;
}

type VerifyState = "loading" | "success" | "failed" | "invalid";

export default function PaymentStatus() {
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<VerifyState>("loading");
  const [details, setDetails] = useState<PaymentDetails | null>(null);

  useEffect(() => {
    // ── Flow A: Razorpay Order (embedded checkout) or Cash / Partial ────────
    const paymentId = searchParams.get("payment_id");
    const amount    = searchParams.get("amount");
    const name      = searchParams.get("name");
    const phone     = searchParams.get("phone");
    const method    = searchParams.get("method"); // "cash" | "partial" | "online" | null

    if (paymentId && amount) {
      setDetails({
        success: true,
        payment_id: paymentId,
        amount: Number(amount),
        currency: "INR",
        name: name ?? "",
        phone: phone ?? "",
        status: method === "cash" ? "cash" : "captured",
        method: (method as "cash" | "partial" | "online") ?? "online",
        cashAmount: Number(searchParams.get("cash_amount") || 0),
        totalAmount: Number(searchParams.get("total_amount") || amount),
      });
      setState("success");
      return;
    }

    // ── Flow B: Razorpay Payment Link (legacy) ───────────────────────────────
    const linkPaymentId = searchParams.get("razorpay_payment_id");
    const linkId        = searchParams.get("razorpay_payment_link_id");
    const refId         = searchParams.get("razorpay_payment_link_reference_id");
    const linkStatus    = searchParams.get("razorpay_payment_link_status");
    const signature     = searchParams.get("razorpay_signature");

    if (linkPaymentId && linkId && signature) {
      const params = new URLSearchParams({
        razorpay_payment_id: linkPaymentId,
        razorpay_payment_link_id: linkId,
        razorpay_payment_link_reference_id: refId ?? "",
        razorpay_payment_link_status: linkStatus ?? "",
        razorpay_signature: signature,
      });

      fetch(`${import.meta.env.VITE_BACKEND_URL || ""}/api/verify-payment?${params}`, {
        credentials: "include",
      })
        .then((r) => r.json())
        .then((data: PaymentDetails) => {
          setDetails(data);
          setState(data.success ? "success" : "failed");
        })
        .catch(() => setState("failed"));
      return;
    }

    setState("invalid");
  }, [searchParams]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#f5f0e8" }}>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-stone-200 bg-white/90 backdrop-blur-sm">
        <div className="mx-auto max-w-lg px-6 py-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-stone-900">
            <Scissors className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-stone-900 leading-none">
              The Experts
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">Payment Confirmation</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-12 flex items-start justify-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="w-full"
        >
          {/* Loading */}
          {state === "loading" && (
            <div className="flex flex-col items-center gap-4 py-24">
              <Loader2 className="w-12 h-12 text-stone-400 animate-spin" />
              <p className="text-stone-500 text-sm">Verifying your payment…</p>
            </div>
          )}

          {/* Invalid */}
          {state === "invalid" && (
            <div className="rounded-2xl border border-stone-200 bg-white shadow-sm p-10 text-center">
              <XCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-stone-900 mb-2">Invalid Page</h2>
              <p className="text-stone-500 text-sm mb-6">
                No payment information found. Please go back and try again.
              </p>
              <a
                href="/"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 text-white text-sm font-medium hover:bg-stone-700 transition-colors"
              >
                ← Back to visit entry
              </a>
            </div>
          )}

          {/* Success */}
          {state === "success" && details && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-2xl border border-stone-200 bg-white shadow-sm overflow-hidden"
            >
              {/* Green top stripe */}
              <div className="h-1.5 bg-linear-to-r from-emerald-400 to-teal-400" />

              <div className="p-8 flex flex-col items-center gap-6">
                {/* Icon with sparkles */}
                <div className="relative w-28 h-28 flex items-center justify-center">
                  <div className="absolute inset-0 rounded-full overflow-hidden opacity-50">
                    <SparklesCore
                      background="transparent"
                      minSize={0.3}
                      maxSize={1}
                      particleDensity={100}
                      particleColor="#34d399"
                    />
                  </div>
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 180, delay: 0.15 }}
                  >
                    <CheckCircle2 className="w-20 h-20 text-emerald-500 drop-shadow-[0_0_16px_rgba(52,211,153,0.5)]" />
                  </motion.div>
                </div>

                <div className="text-center">
                  <motion.h2
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="text-2xl font-bold text-stone-900 mb-1"
                  >
                    {details.method === "cash"
                      ? "Cash Payment Recorded!"
                      : details.method === "partial"
                        ? "Split Payment Successful!"
                        : "Payment Successful!"}
                  </motion.h2>
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                    className="text-stone-500 text-sm"
                  >
                    {details.method === "cash"
                      ? "The full amount was collected in cash. See you soon!"
                      : details.method === "partial"
                        ? "Part paid in cash, remainder paid online. See you soon!"
                        : "Your visit payment is confirmed. See you soon!"}
                  </motion.p>
                </div>

                {/* Amount box */}
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.35 }}
                  className="w-full rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-center"
                >
                  {details.method === "partial" ? (
                    <>
                      <p className="text-xs text-stone-500 mb-1 uppercase tracking-widest">
                        Total Amount
                      </p>
                      <p className="text-3xl font-bold text-emerald-600 mb-3">
                        ₹{Number(details.totalAmount ?? details.amount).toLocaleString("en-IN")}
                      </p>
                      <div className="flex items-center justify-center gap-4 text-sm">
                        <span className="flex items-center gap-1.5 text-emerald-700">
                          <Banknote className="w-4 h-4" />
                          Cash: ₹{(details.cashAmount ?? 0).toLocaleString("en-IN")}
                        </span>
                        <span className="text-stone-300">|</span>
                        <span className="flex items-center gap-1.5 text-blue-600">
                          <CreditCard className="w-4 h-4" />
                          Online: ₹{details.amount.toLocaleString("en-IN")}
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-stone-500 mb-1 uppercase tracking-widest">
                        {details.method === "cash" ? "Cash Collected" : "Amount Paid"}
                      </p>
                      <p className="text-4xl font-bold text-emerald-600">
                        ₹{details.amount.toLocaleString("en-IN")}
                      </p>
                      {details.method === "cash" && (
                        <div className="flex items-center justify-center gap-1.5 mt-2 text-sm text-emerald-700">
                          <Banknote className="w-4 h-4" />
                          Paid in cash at counter
                        </div>
                      )}
                    </>
                  )}
                </motion.div>

                {/* Details */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.45 }}
                  className="w-full space-y-2"
                >
                  <DetailRow icon={<User className="w-4 h-4" />} label="Customer" value={details.name} />
                  <DetailRow icon={<Phone className="w-4 h-4" />} label="Mobile" value={`+91 ${details.phone}`} />
                  {details.method !== "cash" && (
                    <DetailRow icon={<Hash className="w-4 h-4" />} label="Payment ID" value={details.payment_id} mono />
                  )}
                  <DetailRow
                    icon={<CalendarCheck className="w-4 h-4" />}
                    label="Date"
                    value={new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                  />
                  <DetailRow
                    icon={details.method === "cash" ? <Banknote className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
                    label="Method"
                    value={
                      details.method === "cash"
                        ? "Cash"
                        : details.method === "partial"
                          ? "Split (Cash + Online)"
                          : "Online (Razorpay)"
                    }
                  />
                </motion.div>

                {/* CTA */}
                {searchParams.get("visit_warning") && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2.5 text-sm text-amber-700"
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      Payment was collected, but the visit record could not be saved.
                      Please inform the manager so it can be recorded manually.
                    </span>
                  </motion.div>
                )}

                <motion.a
                  href="/"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.55 }}
                  whileHover={{ scale: 1.015 }}
                  whileTap={{ scale: 0.985 }}
                  className="w-full h-11 rounded-xl bg-stone-900 hover:bg-stone-700 transition-colors text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Scissors className="w-4 h-4" />
                  Record Another Visit
                </motion.a>
              </div>
            </motion.div>
          )}

          {/* Failed */}
          {state === "failed" && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="rounded-2xl border border-stone-200 bg-white shadow-sm overflow-hidden"
            >
              <div className="h-1.5 bg-linear-to-r from-red-400 to-rose-400" />
              <div className="p-8 flex flex-col items-center gap-5 text-center">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 180, delay: 0.1 }}
                >
                  <XCircle className="w-16 h-16 text-red-400" />
                </motion.div>
                <div>
                  <h2 className="text-xl font-bold text-stone-900 mb-1">Payment Failed</h2>
                  <p className="text-stone-500 text-sm">
                    {details?.error || "We could not verify your payment. Please try again."}
                  </p>
                </div>
                <a
                  href="/"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 text-white text-sm font-medium hover:bg-stone-700 transition-colors"
                >
                  ← Try again
                </a>
              </div>
            </motion.div>
          )}

          {/* Footer */}
          <p className="text-center text-xs text-stone-400 mt-5 flex items-center justify-center gap-1">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
            </svg>
            Secured by Razorpay · 256-bit SSL encryption
          </p>
        </motion.div>
      </main>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
  mono = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-4 py-2.5 gap-3">
      <div className="flex items-center gap-2 text-stone-400 shrink-0">
        {icon}
        <span className="text-xs text-stone-500">{label}</span>
      </div>
      <span
        className={`text-sm text-stone-900 text-right truncate max-w-48 ${
          mono ? "font-mono text-xs text-stone-600" : "font-medium"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
