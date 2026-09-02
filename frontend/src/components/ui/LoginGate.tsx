/**
 * @file LoginGate.tsx
 * @description The screens a staff member sees after their password is accepted
 * but before they are signed in — the owner-approval gate.
 *
 * Three states, driven entirely by the server's pending status:
 *
 *   pending      → "Waiting for owner approval", polling every 2.5s
 *   otp_fallback → code entry, because the owner didn't tap in time
 *   failed       → terminal, requires starting over
 *
 * The break-glass bypass entry is available from every non-terminal state, not
 * just after the OTP arrives: its entire purpose is to work when Telegram AND
 * SMS have both failed, which is a situation the user may be in from second one.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  Loader2,
  KeyRound,
  AlertTriangle,
  ArrowLeft,
  MessageCircle,
  Smartphone,
} from "lucide-react";
import { useAuth, type PendingLoginState, type GateResult } from "@/context/AuthContext";

const POLL_INTERVAL_MS = 2500;
/** Wrong tries before the client makes the user pause, mirroring the server cap. */
const CLIENT_ATTEMPT_LIMIT = 3;
const COOLDOWN_SECONDS = 15;

interface Props {
  initial: PendingLoginState;
  onAuthenticated: () => void;
  onRestart: () => void;
}

export default function LoginGate({ initial, onAuthenticated, onRestart }: Props) {
  const { pollStatus, verifyOtp, submitBypassCode } = useAuth();

  const [pending, setPending] = useState<PendingLoginState>(initial);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [wrongTries, setWrongTries] = useState(0);
  const [cooldown, setCooldown] = useState(0);

  const [bypassMode, setBypassMode] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number>(initial.timeoutSeconds ?? 90);

  // A ref, not state: the polling effect must read the live value without
  // re-subscribing on every tick.
  const stoppedRef = useRef(false);

  const applyResult = useCallback(
    (result: GateResult) => {
      if (result.status === "authenticated") {
        stoppedRef.current = true;
        onAuthenticated();
        return true;
      }
      if (result.status === "pending") {
        setPending((prev) => ({ ...prev, ...result.pending }));
        return false;
      }
      if (result.terminal) {
        stoppedRef.current = true;
        setFatal(result.error);
        return true;
      }
      setNotice(result.error);
      if (typeof result.attemptsLeft === "number") {
        setPending((prev) => ({ ...prev, attemptsLeft: result.attemptsLeft }));
      }
      return false;
    },
    [onAuthenticated]
  );

  // ── Poll the gate ──────────────────────────────────────────────────────────
  useEffect(() => {
    stoppedRef.current = false;
    let timer: number | undefined;

    const tick = async () => {
      if (stoppedRef.current) return;
      const done = applyResult(await pollStatus(pending.pendingId));
      if (!done && !stoppedRef.current) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      stoppedRef.current = true;
      if (timer) window.clearTimeout(timer);
    };
    // pendingId is stable for the lifetime of this component.
  }, [pending.pendingId, applyResult, pollStatus]);

  // ── Countdown on the waiting screen ────────────────────────────────────────
  useEffect(() => {
    if (pending.status !== "pending" || !pending.expiresAt) return;
    const target = new Date(pending.expiresAt).getTime();
    const id = window.setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    }, 500);
    return () => window.clearInterval(id);
  }, [pending.status, pending.expiresAt]);

  // ── Client-side cooldown after repeated wrong codes ────────────────────────
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  const handleSubmitCode = async () => {
    if (!code.trim() || submitting || cooldown > 0) return;
    setSubmitting(true);
    setNotice(null);

    const result = bypassMode
      ? await submitBypassCode(pending.pendingId, code.trim())
      : await verifyOtp(pending.pendingId, code.trim());

    setSubmitting(false);

    const done = applyResult(result);
    if (!done && result.status === "failed") {
      setCode("");
      const tries = wrongTries + 1;
      setWrongTries(tries);
      if (tries >= CLIENT_ATTEMPT_LIMIT) {
        setCooldown(COOLDOWN_SECONDS);
        setWrongTries(0);
      }
    }
  };

  // ── Terminal failure ───────────────────────────────────────────────────────
  if (fatal) {
    return (
      <Shell icon={<AlertTriangle className="w-6 h-6 text-red-400" />} title="Sign-in blocked">
        <p className="text-sm text-white/55 text-center leading-relaxed">{fatal}</p>
        <button
          onClick={onRestart}
          className="mt-7 h-11 w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-bold text-sm transition-colors flex items-center justify-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back to sign in
        </button>
      </Shell>
    );
  }

  const awaitingCode = pending.status === "otp_fallback" || bypassMode;

  // ── Code entry (OTP relay, or break-glass) ─────────────────────────────────
  if (awaitingCode) {
    return (
      <Shell
        icon={<KeyRound className="w-6 h-6 text-amber-400" />}
        title={bypassMode ? "Emergency bypass" : "Enter the code"}
      >
        <p className="text-sm text-white/50 text-center leading-relaxed">
          {bypassMode ? (
            <>Enter the emergency bypass code your owner keeps for outages.</>
          ) : pending.otpDelivered && pending.otpSentTo ? (
            <>
              The owner didn't respond in time, so we sent a code to{" "}
              <span className="text-white/80 font-medium">{pending.otpSentTo}</span>. Ask them to
              read it out to you.
            </>
          ) : pending.otpDelivered ? (
            <>Ask the owner for the code that was just sent to them.</>
          ) : (
            // Neither SMS nor Telegram could deliver. Don't send them hunting
            // for a message that was never sent — point at the way out.
            <>
              <span className="text-amber-300/90">We couldn't reach the owner on any channel.</span>{" "}
              Use the emergency bypass code, or ask the owner to check their
              Telegram connection.
            </>
          )}
        </p>

        <input
          autoFocus
          value={code}
          onChange={(e) =>
            setCode(
              bypassMode
                ? e.target.value.toUpperCase().slice(0, 32)
                : e.target.value.replace(/\D/g, "").slice(0, 6)
            )
          }
          onKeyDown={(e) => e.key === "Enter" && handleSubmitCode()}
          inputMode={bypassMode ? "text" : "numeric"}
          placeholder={bypassMode ? "BYPASS CODE" : "······"}
          // A password manager has nothing useful to offer here, and an autofill
          // popover over a 6-digit field is actively in the way.
          autoComplete="one-time-code"
          className="mt-6 w-full h-14 rounded-xl bg-white/8 border border-white/15 focus:border-amber-400/80 focus:outline-none text-center text-white text-2xl tracking-[0.4em] placeholder:text-white/20 placeholder:tracking-[0.3em] transition-colors"
          style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
        />

        {typeof pending.attemptsLeft === "number" && pending.attemptsLeft < 5 && !bypassMode && (
          <p className="mt-2 text-xs text-white/35 text-center">
            {pending.attemptsLeft} attempt{pending.attemptsLeft === 1 ? "" : "s"} remaining
          </p>
        )}

        {notice && <Notice>{notice}</Notice>}

        {cooldown > 0 && (
          <p className="mt-3 text-xs text-amber-400/80 text-center">
            Too many wrong tries — wait {cooldown}s before trying again.
          </p>
        )}

        <button
          onClick={handleSubmitCode}
          disabled={submitting || cooldown > 0 || !code.trim()}
          className="mt-5 h-12 w-full rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-stone-950 font-bold text-base transition-colors flex items-center justify-center gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {submitting ? "Checking…" : "Continue"}
        </button>

        <div className="mt-5 flex items-center justify-between text-xs">
          <button
            onClick={() => {
              setBypassMode((b) => !b);
              setCode("");
              setNotice(null);
            }}
            className="text-white/35 hover:text-white/70 transition-colors"
          >
            {bypassMode ? "Use the code from the owner" : "Use emergency bypass code"}
          </button>
          <button onClick={onRestart} className="text-white/35 hover:text-white/70 transition-colors">
            Cancel
          </button>
        </div>
      </Shell>
    );
  }

  // ── Waiting on the owner ───────────────────────────────────────────────────
  return (
    <Shell icon={<ShieldCheck className="w-6 h-6 text-amber-400" />} title="Waiting for approval">
      <p className="text-sm text-white/50 text-center leading-relaxed">
        {pending.approverName ? (
          <>
            We've sent a request to <span className="text-white/80 font-medium">{pending.approverName}</span>.
            They just need to tap Approve.
          </>
        ) : (
          <>We've sent an approval request to the owner.</>
        )}
      </p>

      <div className="mt-7 flex items-center justify-center gap-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
        </span>
        <span className="text-sm text-white/60 tabular-nums">
          {secondsLeft > 0 ? `Falling back to an SMS code in ${secondsLeft}s` : "Sending an SMS code…"}
        </span>
      </div>

      <div className="mt-7 flex items-center justify-center gap-5 text-[0.7rem] text-white/25 uppercase tracking-wider">
        <span className="flex items-center gap-1.5">
          <MessageCircle className="w-3.5 h-3.5" />
          {pending.channel === "sms" ? "Telegram unavailable" : "Sent to Telegram"}
        </span>
        <span className="flex items-center gap-1.5">
          <Smartphone className="w-3.5 h-3.5" /> SMS backup ready
        </span>
      </div>

      {notice && <Notice>{notice}</Notice>}

      <div className="mt-7 flex items-center justify-between text-xs">
        <button
          onClick={() => setBypassMode(true)}
          className="text-white/35 hover:text-white/70 transition-colors"
        >
          Owner unreachable?
        </button>
        <button onClick={onRestart} className="text-white/35 hover:text-white/70 transition-colors">
          Cancel
        </button>
      </div>
    </Shell>
  );
}

// ── Presentation helpers ─────────────────────────────────────────────────────

function Shell({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="w-full max-w-[26rem]"
    >
      <div
        className="rounded-2xl px-6 sm:px-8 py-9"
        style={{
          background: "rgba(12, 10, 7, 0.78)",
          backdropFilter: "blur(36px)",
          WebkitBackdropFilter: "blur(36px)",
          border: "1px solid rgba(180, 140, 60, 0.18)",
          boxShadow:
            "0 32px 80px rgba(0,0,0,0.72), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.07)",
        }}
      >
        <div className="flex flex-col items-center mb-6">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mb-5"
            style={{
              background:
                "linear-gradient(145deg, rgba(180,130,40,0.22) 0%, rgba(120,80,20,0.12) 100%)",
              border: "1px solid rgba(180,140,60,0.35)",
            }}
          >
            {icon}
          </div>
          <h1 className="text-[1.4rem] font-black text-white tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </motion.div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <AnimatePresence>
      <motion.p
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="mt-4 rounded-xl bg-red-500/12 border border-red-400/25 px-4 py-2.5 text-xs text-red-300 text-center"
      >
        {children}
      </motion.p>
    </AnimatePresence>
  );
}
