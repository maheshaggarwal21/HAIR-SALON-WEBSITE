/**
 * @file SignInForm.tsx
 * @description Sign-in form UI component.
 *
 * Pure presentational component — handles its own local field state
 * and visual feedback. No routing logic lives here.
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Mail, Lock, Scissors, ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";

// ── Tiny reusable field wrapper ────────────────────────────────────────────────
function FormField({
  id,
  label,
  type,
  value,
  onChange,
  placeholder,
  icon: Icon,
  error,
  rightSlot,
  autoComplete,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  icon: React.ElementType;
  error?: string;
  rightSlot?: React.ReactNode;
  autoComplete?: string;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-white/70 tracking-wide uppercase">
        {label}
      </label>

      <div
        className={cn(
          "relative flex items-center rounded-xl border transition-all duration-200",
          focused
            ? "border-amber-400/80 shadow-[0_0_0_3px_rgba(180,140,80,0.18)]"
            : error
            ? "border-red-400/70"
            : "border-white/15 hover:border-white/30",
          "bg-white/8 backdrop-blur-sm",
        )}
        style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
      >
        {/* Left icon */}
        <Icon
          className={cn(
            "absolute left-3.5 w-4 h-4 transition-colors duration-200 pointer-events-none",
            focused ? "text-amber-400" : "text-white/35",
          )}
        />

        <input
          id={id}
          type={type}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          className="w-full h-13 pl-11 pr-11 bg-transparent text-base text-white placeholder:text-white/30 focus:outline-none"
        />

        {/* Right slot (e.g. show/hide password) */}
        {rightSlot && (
          <div className="absolute right-3 flex items-center">{rightSlot}</div>
        )}
      </div>

      {/* Inline error */}
      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="text-xs text-red-400 font-medium"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function SignInForm() {
  const navigate = useNavigate();
  const { user, login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // If already logged in, redirect based on role
  useEffect(() => {
    if (!user) return;
    if (user.role === "receptionist") navigate("/dashboard/receptionist");
    else if (user.role === "manager") navigate("/dashboard/manager");
    else if (user.role === "owner") navigate("/dashboard/owner");
    else if (user.role === "artist") navigate("/dashboard/artist");
  }, [user, navigate]);

  // Simple client-side validation
  const validate = () => {
    const e: { email?: string; password?: string } = {};
    if (!email.trim()) e.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Enter a valid email";
    if (!password) e.password = "Password is required";
    else if (password.length < 6) e.password = "Password must be at least 6 characters";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError("");
    if (!validate()) return;

    setLoading(true);
    const result = await login(email, password);
    setLoading(false);

    if (!result.success) {
      setSubmitError(result.error || "Sign in failed. Please try again.");
      return;
    }

    if (result.role === "receptionist") navigate("/dashboard/receptionist");
    else if (result.role === "manager") navigate("/dashboard/manager");
    else if (result.role === "owner") navigate("/dashboard/owner");
    else if (result.role === "artist") navigate("/dashboard/artist");
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 32, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="w-full max-w-[26rem]"
    >
      {/* ── Glass card ── */}
      <div
        className="rounded-2xl px-5 sm:px-8 py-8 sm:py-10"
        style={{
          background: "rgba(12, 10, 7, 0.78)",
          backdropFilter: "blur(36px)",
          WebkitBackdropFilter: "blur(36px)",
          border: "1px solid rgba(180, 140, 60, 0.18)",
          boxShadow:
            "0 32px 80px rgba(0,0,0,0.72), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.07)",
        }}
      >
        {/* Logo + title */}
        <div className="flex flex-col items-center mb-9">
          {/* Premium logo mark */}
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mb-5"
            style={{
              background: "linear-gradient(145deg, rgba(180,130,40,0.22) 0%, rgba(120,80,20,0.12) 100%)",
              border: "1px solid rgba(180,140,60,0.35)",
              boxShadow: "0 4px 24px rgba(180,130,40,0.18), inset 0 1px 0 rgba(255,255,255,0.08)",
            }}
          >
            <Scissors className="w-6 h-6 text-amber-400" strokeWidth={1.75} />
          </div>
          <h1
            className="text-[1.65rem] font-black text-white tracking-tight leading-none"
            style={{ letterSpacing: "-0.02em" }}
          >
            Welcome back
          </h1>
          <p className="text-[0.82rem] text-white/40 mt-2 tracking-wide">
            Sign in to your salon dashboard
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
          <FormField
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={(v) => { setEmail(v); setErrors((p) => ({ ...p, email: undefined })); }}
            placeholder="you@example.com"
            icon={Mail}
            error={errors.email}
            autoComplete="email"
          />

          <FormField
            id="password"
            label="Password"
            type={showPw ? "text" : "password"}
            value={password}
            onChange={(v) => { setPassword(v); setErrors((p) => ({ ...p, password: undefined })); }}
            placeholder="••••••••"
            icon={Lock}
            error={errors.password}
            autoComplete="current-password"
            rightSlot={
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="text-white/35 hover:text-white/70 transition-colors duration-150"
                tabIndex={-1}
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            }
          />

          {/* Server error */}
          <AnimatePresence>
            {submitError && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="rounded-xl bg-red-500/15 border border-red-400/25 px-4 py-2.5 text-sm text-red-400 text-center"
              >
                {submitError}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Submit */}
          <motion.button
            type="submit"
            disabled={loading}
            whileHover={{ scale: loading ? 1 : 1.025, y: loading ? 0 : -1 }}
            whileTap={{ scale: loading ? 1 : 0.97 }}
            className={cn(
              "relative mt-1 h-12 w-full rounded-xl flex items-center justify-center gap-2.5",
              "bg-amber-500 hover:bg-amber-400 active:bg-amber-600",
              "text-stone-950 font-bold text-base tracking-wide",
              "transition-colors duration-200",
              "disabled:opacity-60 disabled:cursor-not-allowed",
              "overflow-hidden group",
            )}
            style={{
              boxShadow: loading
                ? "none"
                : "0 4px 28px rgba(217,119,6,0.45), 0 1px 0 rgba(255,255,255,0.18) inset",
            }}
          >
            {/* Shimmer */}
            <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-linear-to-r from-transparent via-white/20 to-transparent" />

            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing in…</span>
              </>
            ) : (
              <>
                <span>Sign In</span>
                <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </>
            )}
          </motion.button>
        </form>

        {/* Back to home */}
        <div className="text-center mt-6">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white/65 transition-colors duration-200 font-medium tracking-wide"
          >
            ← Back to home
          </Link>
        </div>
      </div>

      {/* Bottom tagline */}
      <p className="text-center text-[0.72rem] text-white/20 mt-5 tracking-[0.12em] uppercase">
        The Experts Hair Salon &nbsp;·&nbsp; Premium Management
      </p>
    </motion.div>
  );
}
