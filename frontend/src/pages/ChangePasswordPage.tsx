/**
 * @file ChangePasswordPage.tsx
 * @description Forced and voluntary password change.
 *
 * When the owner issues a temp password, the account is flagged
 * mustChangePassword; PasswordChangeGuard in main.tsx redirects every route
 * here until it is cleared, so a shared temporary credential cannot become the
 * account's permanent password.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { KeyRound, Loader2, Check } from "lucide-react";
import { useAuth, type Role } from "@/context/AuthContext";

const HOME_BY_ROLE: Record<Role, string> = {
  receptionist: "/dashboard/receptionist",
  manager:      "/dashboard/manager",
  owner:        "/dashboard/owner",
  artist:       "/dashboard/artist",
};

const inputClass =
  "w-full h-12 px-4 rounded-xl bg-white/8 border border-white/15 focus:border-amber-400/80 focus:outline-none text-white text-sm placeholder:text-white/25 transition-colors";

export default function ChangePasswordPage() {
  const { user, changePassword } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const forced = Boolean(user?.mustChangePassword);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (next.length < 8) return setError("Your new password must be at least 8 characters.");
    if (next !== confirm) return setError("The two new passwords don't match.");
    if (next === current) return setError("Choose a password different from your current one.");

    setSaving(true);
    const result = await changePassword(current, next);
    setSaving(false);

    if (!result.success) return setError(result.error || "Could not change your password.");

    setDone(true);
    // changePassword() refreshes the auth context, clearing mustChangePassword,
    // so the guard will let this navigation through.
    setTimeout(() => navigate(HOME_BY_ROLE[user!.role] ?? "/signin", { replace: true }), 900);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "radial-gradient(circle at 50% 0%, #1c1710 0%, #0b0906 60%)" }}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-[26rem] rounded-2xl px-7 py-9"
        style={{
          background: "rgba(12, 10, 7, 0.8)",
          border: "1px solid rgba(180, 140, 60, 0.18)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
        }}
      >
        <div className="flex flex-col items-center mb-7">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mb-5"
            style={{
              background: "linear-gradient(145deg, rgba(180,130,40,0.22), rgba(120,80,20,0.12))",
              border: "1px solid rgba(180,140,60,0.35)",
            }}
          >
            {done ? (
              <Check className="w-6 h-6 text-green-400" />
            ) : (
              <KeyRound className="w-6 h-6 text-amber-400" />
            )}
          </div>
          <h1 className="text-[1.4rem] font-black text-white tracking-tight">
            {done ? "Password updated" : forced ? "Set a new password" : "Change password"}
          </h1>
          {forced && !done && (
            <p className="mt-2 text-sm text-white/45 text-center leading-relaxed">
              You're signed in with a temporary password. Choose your own before continuing.
            </p>
          )}
        </div>

        {!done && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder={forced ? "Temporary password" : "Current password"}
              autoComplete="current-password"
              className={inputClass}
              style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
            />
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="New password (min 8 characters)"
              autoComplete="new-password"
              className={inputClass}
              style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
              className={inputClass}
              style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
            />

            {error && (
              <p className="rounded-xl bg-red-500/12 border border-red-400/25 px-4 py-2.5 text-xs text-red-300 text-center">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={saving}
              className="mt-1 h-12 w-full rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-bold text-base transition-colors flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? "Saving…" : "Update password"}
            </button>
          </form>
        )}
      </motion.div>
    </div>
  );
}
