/**
 * @file BreakGlassPanel.tsx
 * @description The emergency bypass code, plus the audit trail of who used it.
 *
 * This code skips the approval gate entirely for any gated account. That is the
 * point — it is the answer to "the owner's phone is dead and the salon can't
 * open" — but it also means it is the single most dangerous value in the system.
 * The UI is written to keep that fact in front of the owner rather than tucked
 * into a tooltip, and every use is logged and pushed to Telegram at the moment
 * it happens.
 *
 * The plaintext is never retrievable: the server bcrypt-hashes it and returns
 * it exactly once, on the response that sets it.
 */

import { useEffect, useState, useCallback } from "react";
import {
  LifeBuoy,
  Loader2,
  ShieldAlert,
  Trash2,
  History,
  RefreshCw,
} from "lucide-react";
import { managementApi, type SecurityPayload, type AuditEntry } from "./api";
import { PanelHeader, Card, Banner, SecretReveal, SectionTitle, useToast, timeAgo } from "./ui";

/** Actions worth surfacing in the security log, in plain language. */
const ACTION_LABEL: Record<string, string> = {
  "login.bypass_used":     "Emergency bypass code used",
  "login.approved":        "Sign-in approved",
  "login.denied":          "Sign-in denied",
  "login.otp_sent":        "SMS code sent",
  "login.otp_verified":    "Signed in with code",
  "login.otp_failed":      "Code attempts exhausted",
  "login.gated":           "Sign-in held for approval",
  "login.failed":          "Failed sign-in",
  "login.device_trusted":  "Device trusted",
  "bypass_code.set":       "Bypass code changed",
  "bypass_code.cleared":   "Bypass code removed",
  "permissions.changed":   "Permissions changed",
  "role_defaults.changed": "Role defaults changed",
  "approval_policy.changed": "Approval policy changed",
  "security_settings.changed": "Security settings changed",
  "staff.password_reset":  "Password reset",
  "staff.force_logout":    "Forced sign-out",
  "device.revoked":        "Device revoked",
  "telegram.linked":       "Telegram connected",
  "telegram.unlinked":     "Telegram disconnected",
};

const DANGEROUS = new Set(["login.bypass_used", "bypass_code.set", "bypass_code.cleared"]);

/**
 * Setting the bypass code is owner-only on the server too — team.manage is not
 * enough, since it would let a delegate mint a master key for themselves.
 */
export default function BreakGlassPanel({ isOwner }: { isOwner: boolean }) {
  const [data, setData] = useState<SecurityPayload | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const { showOk, showErr, element: toastEl } = useToast();

  const load = useCallback(async () => {
    try {
      const [sec, log] = await Promise.all([managementApi.security(), managementApi.audit(80)]);
      setData(sec);
      setAudit(log);
      setLoadError("");
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setCode = async (code?: string) => {
    const existing = data?.bypassCode.isSet;
    if (
      existing &&
      !window.confirm(
        "Replace the current emergency bypass code?\n\nThe old code stops working immediately. Anyone relying on a written copy will need the new one."
      )
    ) {
      return;
    }

    setBusy("set");
    try {
      const res = await managementApi.setBypassCode(code);
      setRevealed(res.code);
      setCustom("");
      await load();
    } catch (err) {
      showErr((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clearCode = async () => {
    if (
      !window.confirm(
        "Remove the emergency bypass code?\n\nIf Telegram and SMS both fail after this, gated staff will have no way to sign in at all."
      )
    ) {
      return;
    }
    setBusy("clear");
    try {
      await managementApi.clearBypassCode();
      await load();
      showOk("Bypass code removed");
    } catch (err) {
      showErr((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <Banner kind="error">{loadError}</Banner>;
  if (!data) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-stone-300" />
      </div>
    );
  }

  const { bypassCode } = data;
  const customValid = custom === "" || custom.trim().length >= 6;

  return (
    <div>
      <PanelHeader
        icon={LifeBuoy}
        title="Break glass"
        subtitle="The way in when Telegram and SMS have both failed"
      />

      <div className="space-y-5">
        <Banner kind="warn">
          <strong>This code bypasses the approval system completely.</strong> Anyone holding it can
          sign in as any gated staff member without the owner being asked. Treat it like a spare key
          to the salon: write it down, keep it somewhere physically secure, and don't send it to
          five people over WhatsApp. Every use is logged below and pushed to the owner's Telegram
          the moment it happens.
        </Banner>

        {revealed && (
          <SecretReveal
            value={revealed}
            title="Your new emergency bypass code"
            note="This is the only time it will be shown. Write it down now — if you lose it you'll have to generate a new one."
            onDismiss={() => setRevealed(null)}
          />
        )}

        {/* ── Status ── */}
        <Card className="p-6">
          <SectionTitle>Current code</SectionTitle>

          {bypassCode.isSet ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-700">
                <ShieldAlert className="w-4 h-4" />
                A bypass code is set
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
                <div>
                  <dt className="text-stone-400 uppercase tracking-wider font-semibold">Set</dt>
                  <dd className="text-stone-800 mt-1">{timeAgo(bypassCode.setAt)}</dd>
                </div>
                <div>
                  <dt className="text-stone-400 uppercase tracking-wider font-semibold">By</dt>
                  <dd className="text-stone-800 mt-1">{bypassCode.setByName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-stone-400 uppercase tracking-wider font-semibold">
                    Times used
                  </dt>
                  <dd
                    className={`mt-1 font-semibold ${
                      bypassCode.useCount > 0 ? "text-amber-700" : "text-stone-800"
                    }`}
                  >
                    {bypassCode.useCount}
                    {bypassCode.lastUsedAt && (
                      <span className="font-normal text-stone-500">
                        {" "}
                        · last {timeAgo(bypassCode.lastUsedAt)}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <Banner kind="error">
              No bypass code is set. If the owner is unreachable, gated staff currently have no way
              to sign in.
            </Banner>
          )}
        </Card>

        {/* ── Set a code ── */}
        {isOwner ? (
          <Card className="p-6">
            <SectionTitle hint="Choose your own, or let the system generate one that's hard to guess and easy to read out.">
              {bypassCode.isSet ? "Replace the code" : "Set a code"}
            </SectionTitle>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value.slice(0, 64))}
                placeholder="Type a custom code (min 6 characters)"
                autoComplete="off"
                className="flex-1 h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400 transition-all"
              />
              <button
                onClick={() => setCode(custom.trim() || undefined)}
                disabled={busy === "set" || !customValid}
                className="shrink-0 h-11 px-5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-sm font-medium transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {busy === "set" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {custom.trim() ? "Set this code" : "Generate one"}
              </button>
            </div>

            {!customValid && (
              <p className="text-xs text-red-600 mt-2">
                A custom code must be at least 6 characters.
              </p>
            )}

            {bypassCode.isSet && (
              <button
                onClick={clearCode}
                disabled={busy === "clear"}
                className="mt-4 flex items-center gap-2 text-xs text-red-600 hover:text-red-800 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove the bypass code entirely
              </button>
            )}
          </Card>
        ) : (
          <Banner kind="info">
            Only the owner can set or change the emergency bypass code, even with team management
            permission.
          </Banner>
        )}

        {/* ── Audit log ── */}
        <Card className="overflow-hidden">
          <div className="px-6 pt-6 pb-3 flex items-center justify-between">
            <SectionTitle>Security log</SectionTitle>
            <button
              onClick={load}
              className="text-xs text-stone-500 hover:text-stone-900 flex items-center gap-1.5 transition-colors"
            >
              <History className="w-3.5 h-3.5" /> Refresh
            </button>
          </div>

          {audit === null ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-stone-300" />
            </div>
          ) : audit.length === 0 ? (
            <p className="px-6 pb-8 text-sm text-stone-400">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100 max-h-[26rem] overflow-y-auto">
              {audit.map((entry) => (
                <li
                  key={entry._id}
                  className={`flex items-start gap-3 px-6 py-3 ${
                    DANGEROUS.has(entry.action) ? "bg-amber-50/60" : ""
                  }`}
                >
                  <span
                    className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                      DANGEROUS.has(entry.action) ? "bg-amber-500" : "bg-stone-300"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-stone-800 leading-snug">
                      {ACTION_LABEL[entry.action] ?? entry.action}
                      {entry.targetName && entry.targetName !== entry.actorName && (
                        <span className="text-stone-500"> — {entry.targetName}</span>
                      )}
                    </p>
                    <p className="text-[0.7rem] text-stone-400 mt-0.5">
                      {entry.actorName}
                      {entry.ip ? ` · ${entry.ip}` : ""} · {timeAgo(entry.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {toastEl}
    </div>
  );
}
