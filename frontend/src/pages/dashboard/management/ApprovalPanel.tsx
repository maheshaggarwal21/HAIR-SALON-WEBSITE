/**
 * @file ApprovalPanel.tsx
 * @description The "OTP" node — who has to be approved before they can sign in,
 * and how the owner receives that request.
 *
 * Layered policy, shown in the order it resolves:
 *   master switch → per-role gate → per-person override (edited in People)
 *
 * The trust window is the setting that decides whether the client keeps this
 * feature turned on. At 12h a staff member is approved once at the start of a
 * shift rather than on every sign-in, so it is surfaced prominently rather than
 * buried with the other numbers.
 */

import { useEffect, useState, useCallback } from "react";
import {
  ShieldCheck,
  Loader2,
  Send,
  Link2,
  Unlink,
  Copy,
  Check,
  Clock,
  Phone,
  MessageCircle,
} from "lucide-react";
import {
  managementApi,
  ASSIGNABLE_ROLES,
  ROLE_LABEL,
  type SecurityPayload,
  type SecuritySettings,
  type RosterEntry,
} from "./api";
import {
  PanelHeader,
  Card,
  Toggle,
  NumberField,
  Banner,
  SectionTitle,
  useToast,
} from "./ui";

export default function ApprovalPanel({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<SecurityPayload | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState<{ deepLink: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const { showOk, showErr, element: toastEl } = useToast();

  const load = useCallback(async () => {
    try {
      const [sec, ros] = await Promise.all([managementApi.security(), managementApi.roster()]);
      setData(sec);
      setRoster(ros.roster);
      setLoadError("");
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Optimistic patch — the toggles must feel instant. Reverts on failure. */
  const patch = async (changes: Partial<SecuritySettings>) => {
    if (!data) return;
    const previous = data.settings;
    setData({ ...data, settings: { ...previous, ...changes } });
    setSaving(true);
    try {
      await managementApi.saveSecurity(changes);
      await load();
    } catch (err) {
      setData({ ...data, settings: previous });
      showErr((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const connectTelegram = async () => {
    setBusy("link");
    try {
      const res = await managementApi.linkTelegram();
      setLink({ deepLink: res.deepLink, code: res.code });
    } catch (err) {
      showErr((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const run = async (key: string, fn: () => Promise<void>, okMessage: string) => {
    setBusy(key);
    try {
      await fn();
      showOk(okMessage);
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

  const { settings, channels, approvers } = data;
  const me = approvers[0];
  const gatedPeople = roster.filter((r) => r.effectiveApproval);
  const overrides = roster.filter((r) => r.requiresApproval !== null);

  return (
    <div>
      <PanelHeader
        icon={ShieldCheck}
        title="Login approval"
        subtitle="Require the owner to approve a sign-in before it completes"
      />

      <div className="space-y-5">
        {/* ── Channel readiness ── */}
        {!channels.telegramConfigured && (
          <Banner kind="warn">
            <strong>Telegram isn't set up on the server yet.</strong> Create a bot with @BotFather,
            put the token in <code className="font-mono text-xs">TELEGRAM_BOT_TOKEN</code>, and set{" "}
            <code className="font-mono text-xs">TELEGRAM_WEBHOOK_SECRET</code>. Until then, gated
            logins fall straight through to the SMS code path.
          </Banner>
        )}
        {!channels.smsConfigured && (
          <Banner kind="info">
            <strong>SMS fallback is inactive</strong> — MSG91 needs DLT registration to clear.
            Until then, if the owner doesn't tap Approve in time, the code is delivered over
            Telegram instead so the fallback still works.
          </Banner>
        )}

        {/* ── Master switch ── */}
        <Card className="p-6">
          <Toggle
            checked={settings.approvalGateEnabled}
            onChange={(v) => patch({ approvalGateEnabled: v })}
            disabled={!canManage || saving}
            label="Require approval for gated staff"
            description="Master switch. Turn this off to let everyone sign in directly without changing any of the settings below."
          />

          {settings.approvalGateEnabled && gatedPeople.length === 0 && (
            <div className="mt-3">
              <Banner kind="info">
                The gate is on, but no role or person is set to require approval yet — so nobody is
                actually being gated. Turn on a role below.
              </Banner>
            </div>
          )}
        </Card>

        {/* ── Per-role gate ── */}
        <Card className="p-6">
          <SectionTitle hint="A person can override their role from the People panel.">
            Which roles need approval
          </SectionTitle>

          <div className="divide-y divide-stone-100">
            {ASSIGNABLE_ROLES.map((role) => {
              const inRole = roster.filter((r) => r.role === role && r.hasLogin).length;
              return (
                <Toggle
                  key={role}
                  checked={settings.roleRequiresApproval[role]}
                  onChange={(v) =>
                    patch({
                      roleRequiresApproval: { ...settings.roleRequiresApproval, [role]: v },
                    })
                  }
                  disabled={!canManage || saving || !settings.approvalGateEnabled}
                  label={ROLE_LABEL[role]}
                  description={`${inRole} account${inRole === 1 ? "" : "s"} with a login`}
                />
              );
            })}
          </div>

          {overrides.length > 0 && (
            <p className="mt-4 pt-4 border-t border-stone-100 text-xs text-stone-500 leading-relaxed">
              <strong className="text-stone-700">{overrides.length} person-level override
              {overrides.length === 1 ? "" : "s"}:</strong>{" "}
              {overrides
                .map((o) => `${o.name} (${o.requiresApproval ? "always" : "never"})`)
                .join(", ")}
            </p>
          )}
        </Card>

        {/* ── Trust window ── */}
        <Card className="p-6">
          <SectionTitle hint="The single most important setting for whether staff tolerate this feature.">
            How often approval is needed
          </SectionTitle>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <NumberField
              label="Trust window"
              suffix="hours"
              min={0}
              max={168}
              value={settings.trustedWindowHours}
              onChange={(v) => patch({ trustedWindowHours: v })}
              hint={
                settings.trustedWindowHours === 0
                  ? "Every single sign-in needs approval. Expect complaints."
                  : `After one approval, that device signs in freely for ${settings.trustedWindowHours}h — roughly once per shift.`
              }
            />
            <NumberField
              label="Wait for Telegram"
              suffix="seconds"
              min={30}
              max={600}
              value={settings.approvalTimeoutSeconds}
              onChange={(v) => patch({ approvalTimeoutSeconds: v })}
              hint="How long to wait for a tap before falling back to a code."
            />
            <NumberField
              label="Code valid for"
              suffix="minutes"
              min={1}
              max={30}
              value={settings.otpExpiryMinutes}
              onChange={(v) => patch({ otpExpiryMinutes: v })}
            />
            <NumberField
              label="Wrong-code attempts"
              suffix="tries"
              min={1}
              max={10}
              value={settings.maxOtpAttempts}
              onChange={(v) => patch({ maxOtpAttempts: v })}
            />
          </div>

          <div className="mt-5 pt-5 border-t border-stone-100">
            <Toggle
              checked={settings.failOpenIfUnreachable}
              onChange={(v) => patch({ failOpenIfUnreachable: v })}
              disabled={!canManage || saving}
              label="Let staff in if the owner can't be reached at all"
              description="Off is safer: staff use the emergency bypass code instead. Turn this on only if being locked out would cost more than an unapproved sign-in."
            />
          </div>
        </Card>

        {/* ── Telegram connection ── */}
        <Card className="p-6">
          <SectionTitle hint="Approval requests arrive here as a message with Approve and Deny buttons.">
            Where approval requests go
          </SectionTitle>

          {me?.telegramLinked ? (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-2 rounded-xl bg-green-50 border border-green-200 px-4 py-2.5 text-sm text-green-800">
                <MessageCircle className="w-4 h-4" />
                Telegram connected
                {me.telegramUsername && (
                  <span className="text-green-600">@{me.telegramUsername}</span>
                )}
              </span>

              {canManage && (
                <>
                  <button
                    onClick={() =>
                      run("test", () => managementApi.testTelegram().then(() => {}), "Test message sent")
                    }
                    disabled={busy === "test"}
                    className="flex items-center gap-2 text-sm text-stone-600 hover:text-stone-900 border border-stone-200 hover:border-stone-300 rounded-xl px-4 py-2.5 transition-all disabled:opacity-50"
                  >
                    {busy === "test" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    Send test
                  </button>
                  <button
                    onClick={() =>
                      run(
                        "unlink",
                        async () => {
                          await managementApi.unlinkTelegram();
                          await load();
                        },
                        "Telegram disconnected"
                      )
                    }
                    disabled={busy === "unlink"}
                    className="flex items-center gap-2 text-sm text-red-600 hover:text-red-800 border border-red-100 hover:border-red-200 rounded-xl px-4 py-2.5 transition-all disabled:opacity-50"
                  >
                    <Unlink className="w-4 h-4" /> Disconnect
                  </button>
                </>
              )}
            </div>
          ) : link ? (
            <div className="space-y-3">
              <Banner kind="info">
                Open this link on the phone that should receive approvals, then press{" "}
                <strong>Start</strong> in Telegram. The link works once and expires in 15 minutes.
              </Banner>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-stone-50 border border-stone-200 px-4 py-3 text-xs text-stone-700 break-all">
                  {link.deepLink}
                </code>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(link.deepLink).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  }}
                  className="shrink-0 h-11 px-4 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-sm transition-colors flex items-center gap-2"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <a
                href={link.deepLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-sm text-amber-700 hover:text-amber-900 font-medium"
              >
                <Link2 className="w-4 h-4" /> Open in Telegram
              </a>
            </div>
          ) : (
            <button
              onClick={connectTelegram}
              disabled={!canManage || busy === "link" || !channels.telegramConfigured}
              className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-5 py-2.5 hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy === "link" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <MessageCircle className="w-4 h-4" />
              )}
              Connect Telegram
            </button>
          )}

          {/* SMS destination */}
          <div className="mt-5 pt-5 border-t border-stone-100">
            <PhoneField
              approverId={me?.id}
              current={me?.phone ?? null}
              masked={me?.maskedPhone ?? null}
              canManage={canManage}
              onSaved={load}
              notifyOk={showOk}
              notifyErr={showErr}
            />
          </div>
        </Card>

        {/* ── Who is gated right now ── */}
        <Card className="p-6">
          <SectionTitle>Currently gated ({gatedPeople.length})</SectionTitle>
          {gatedPeople.length === 0 ? (
            <p className="text-sm text-stone-400">Nobody. Everyone signs in directly.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {gatedPeople.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-xs text-amber-800"
                >
                  <Clock className="w-3 h-3" />
                  {p.name}
                  <span className="text-amber-500">{ROLE_LABEL[p.role]}</span>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>

      {toastEl}
    </div>
  );
}

/** Editable SMS destination for the approver. */
function PhoneField({
  approverId,
  current,
  masked,
  canManage,
  onSaved,
  notifyOk,
  notifyErr,
}: {
  approverId?: string;
  current: string | null;
  masked: string | null;
  canManage: boolean;
  onSaved: () => Promise<void>;
  notifyOk: (m: string) => void;
  notifyErr: (m: string) => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(current ?? ""), [current]);

  const dirty = value !== (current ?? "");
  const valid = value === "" || /^[6-9]\d{9}$/.test(value);

  const save = async () => {
    if (!approverId || !valid) return;
    setSaving(true);
    try {
      await managementApi.setPhone(approverId, value || null);
      await onSaved();
      notifyOk("SMS number saved");
    } catch (err) {
      notifyErr((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1.5">
        SMS fallback number
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          <span className="absolute left-10 top-1/2 -translate-y-1/2 text-sm text-stone-400 pointer-events-none">
            +91
          </span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 10))}
            disabled={!canManage}
            placeholder="9876543210"
            className="w-full h-11 pl-[4.4rem] pr-4 rounded-xl border border-stone-200 bg-stone-50 text-sm text-stone-900 placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400 transition-all disabled:opacity-60"
          />
        </div>
        {canManage && dirty && (
          <button
            onClick={save}
            disabled={!valid || saving}
            className="shrink-0 h-11 px-5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-sm transition-colors disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
          </button>
        )}
      </div>
      {!valid && (
        <p className="text-xs text-red-600 mt-1.5">Enter a valid 10-digit Indian mobile number.</p>
      )}
      {!dirty && masked && (
        <p className="text-xs text-stone-400 mt-1.5">
          Codes go to {masked} when the owner doesn't respond on Telegram.
        </p>
      )}
    </div>
  );
}
