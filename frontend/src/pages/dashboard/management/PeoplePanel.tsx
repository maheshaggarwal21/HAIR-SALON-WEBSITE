/**
 * @file PeoplePanel.tsx
 * @description The unified roster — every artist, receptionist and manager in
 * one list, regardless of which collection they live in.
 *
 * Selecting a person opens a detail drawer with everything the owner can do to
 * that account: individual permissions, per-person OTP override, temp password,
 * force logout, and trusted-device revocation.
 *
 * Artists without a linked login appear too (they exist for visit attribution),
 * but their access controls are disabled with an explanation rather than hidden
 * — otherwise the owner cannot tell "no permissions" from "no account".
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  UsersRound,
  Search,
  Loader2,
  KeyRound,
  LogOut,
  ShieldCheck,
  Laptop,
  Trash2,
  X,
  Save,
  UserX,
  Check,
} from "lucide-react";
import {
  managementApi,
  ROLE_LABEL,
  type RosterEntry,
  type PermissionRegistry,
  type TrustedDeviceRow,
  type StaffRole,
} from "./api";
import {
  PanelHeader,
  Card,
  PermissionChecklist,
  Banner,
  SecretReveal,
  TriToggle,
  SectionTitle,
  useToast,
  timeAgo,
} from "./ui";

const ROLE_CHIP: Record<StaffRole, string> = {
  owner:        "bg-purple-50 text-purple-700 border-purple-200",
  manager:      "bg-amber-50 text-amber-700 border-amber-200",
  receptionist: "bg-blue-50 text-blue-700 border-blue-200",
  artist:       "bg-rose-50 text-rose-700 border-rose-200",
};

type RoleFilter = StaffRole | "all";

export default function PeoplePanel({ canManage }: { canManage: boolean }) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [registry, setRegistry] = useState<PermissionRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** Reveal-once state for the inline "Reset password" action on a roster row. */
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [quickResetResult, setQuickResetResult] =
    useState<{ name: string; password: string } | null>(null);

  const { showOk, showErr, element: toastEl } = useToast();

  const load = useCallback(async () => {
    try {
      const data = await managementApi.roster();
      setRoster(data.roster);
      setRegistry(data.registry);
      setLoadError("");
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster
      .filter((r) => roleFilter === "all" || r.role === roleFilter)
      .filter(
        (r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q) ||
          (r.phone ?? "").includes(q)
      );
  }, [roster, query, roleFilter]);

  const selected = roster.find((r) => r.id === selectedId) ?? null;

  /**
   * Reset from the roster row. Confirms first: this immediately invalidates the
   * person's current password and signs them out everywhere, so a mis-click on
   * the wrong row would strand a staff member mid-shift.
   */
  const quickReset = async (person: RosterEntry) => {
    if (!person.userId) return;
    const confirmed = window.confirm(
      `Generate a new temporary password for ${person.name}?\n\nTheir current password stops working immediately and they'll be signed out everywhere. You'll get the new one to read out to them.`
    );
    if (!confirmed) return;

    setResettingId(person.userId);
    try {
      const res = await managementApi.tempPassword(person.userId);
      setQuickResetResult({ name: person.name, password: res.password });
      await load();
    } catch (err) {
      showErr((err as Error).message);
    } finally {
      setResettingId(null);
    }
  };

  const counts = useMemo(() => {
    const byRole = { receptionist: 0, manager: 0, artist: 0, owner: 0 } as Record<StaffRole, number>;
    roster.forEach((r) => { byRole[r.role] += 1; });
    return byRole;
  }, [roster]);

  if (loadError) return <Banner kind="error">{loadError}</Banner>;

  return (
    <div>
      <PanelHeader
        icon={UsersRound}
        title="People"
        subtitle="Everyone in the salon — artists, reception and management in one list"
      />

      {/* Shown once after an inline reset — the server cannot return it again. */}
      {quickResetResult && (
        <div className="mb-5">
          <SecretReveal
            value={quickResetResult.password}
            title={`Temporary password for ${quickResetResult.name}`}
            note="Read this out to them now. They'll be forced to choose their own password at next sign-in. It cannot be shown again."
            onDismiss={() => setQuickResetResult(null)}
          />
        </div>
      )}

      {/* Search + role filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email or phone"
            className="w-full h-11 pl-10 pr-4 rounded-xl border border-stone-200 bg-white text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400 transition-all"
          />
        </div>

        <div className="flex gap-1 rounded-xl border border-stone-200 bg-white p-1 overflow-x-auto">
          {(["all", "receptionist", "manager", "artist", "owner"] as RoleFilter[]).map((r) => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-all ${
                roleFilter === r
                  ? "bg-stone-900 text-white"
                  : "text-stone-500 hover:text-stone-900 hover:bg-stone-50"
              }`}
            >
              {r === "all" ? `All (${roster.length})` : `${ROLE_LABEL[r]} (${counts[r]})`}
            </button>
          ))}
        </div>
      </div>

      {/* Roster */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-stone-300" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-20 text-center text-sm text-stone-400">No one matches that search.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {filtered.map((person) => (
              // A row is a flex container rather than one big <button> so the
              // quick-reset action can sit inside it — nesting a button in a
              // button is invalid HTML and breaks keyboard navigation.
              <li
                key={person.id}
                className="flex items-stretch hover:bg-stone-50/70 transition-colors"
              >
                <button
                  onClick={() => setSelectedId(person.id)}
                  className="flex-1 min-w-0 flex items-center gap-4 px-5 py-4 text-left"
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold uppercase shrink-0 ${
                      person.isActive ? "bg-amber-100 text-amber-700" : "bg-stone-100 text-stone-400"
                    }`}
                  >
                    {person.name.charAt(0)}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-stone-900 text-sm truncate">
                        {person.name}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[0.68rem] font-medium border capitalize ${ROLE_CHIP[person.role]}`}
                      >
                        {ROLE_LABEL[person.role]}
                      </span>
                      {!person.isActive && (
                        <span className="px-2 py-0.5 rounded-full text-[0.68rem] font-medium border bg-stone-100 text-stone-500 border-stone-200">
                          Inactive
                        </span>
                      )}
                      {!person.hasLogin && (
                        <span className="px-2 py-0.5 rounded-full text-[0.68rem] font-medium border bg-stone-50 text-stone-400 border-stone-200">
                          No login
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-stone-500 mt-0.5 truncate">
                      {person.email || person.phone || "—"}
                    </p>
                  </div>

                  <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
                    {person.effectiveApproval && (
                      <span className="flex items-center gap-1 text-[0.68rem] font-medium text-amber-700">
                        <ShieldCheck className="w-3 h-3" /> Approval required
                      </span>
                    )}
                    <span className="text-[0.68rem] text-stone-400">
                      {person.hasLogin ? `${person.permissions.length} perms` : "directory only"}
                      {" · "}
                      {person.lastLoginAt ? timeAgo(person.lastLoginAt) : "never signed in"}
                    </span>
                  </div>
                </button>

                {/* Quick reset — the most common action, without opening the drawer. */}
                {canManage && person.hasLogin && person.role !== "owner" && (
                  <button
                    onClick={() => quickReset(person)}
                    disabled={resettingId === person.userId}
                    title={`Reset ${person.name}'s password`}
                    className="shrink-0 flex items-center gap-1.5 self-center mr-4 text-xs text-stone-500 hover:text-stone-900 border border-stone-200 hover:border-stone-300 rounded-lg px-3 py-2 transition-all disabled:opacity-50"
                  >
                    {resettingId === person.userId ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="w-3.5 h-3.5" />
                    )}
                    <span className="hidden md:inline">Reset password</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AnimatePresence>
        {selected && registry && (
          <PersonDrawer
            person={selected}
            registry={registry}
            canManage={canManage}
            onClose={() => setSelectedId(null)}
            onChanged={load}
            notifyOk={showOk}
            notifyErr={showErr}
          />
        )}
      </AnimatePresence>

      {toastEl}
    </div>
  );
}

// ─── Detail drawer ───────────────────────────────────────────────────────────

function PersonDrawer({
  person,
  registry,
  canManage,
  onClose,
  onChanged,
  notifyOk,
  notifyErr,
}: {
  person: RosterEntry;
  registry: PermissionRegistry;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  notifyOk: (m: string) => void;
  notifyErr: (m: string) => void;
}) {
  const [perms, setPerms] = useState<string[]>(person.permissions);
  const [approval, setApproval] = useState<boolean | null>(person.requiresApproval);
  const [savingPerms, setSavingPerms] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [devices, setDevices] = useState<TrustedDeviceRow[] | null>(null);

  const editable = canManage && person.hasLogin && person.role !== "owner";
  const permsDirty = JSON.stringify([...perms].sort()) !== JSON.stringify([...person.permissions].sort());

  // Trusted devices are only meaningful for accounts that can sign in.
  useEffect(() => {
    if (!person.userId) return;
    managementApi.devices(person.userId).then(setDevices).catch(() => setDevices([]));
  }, [person.userId]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      notifyErr((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const savePerms = () =>
    run("perms", async () => {
      setSavingPerms(true);
      await managementApi.setPermissions(person.userId!, perms);
      await onChanged();
      notifyOk("Permissions updated");
      setSavingPerms(false);
    });

  const saveApproval = (value: boolean | null) =>
    run("approval", async () => {
      setApproval(value);
      await managementApi.setApproval(person.userId!, { requiresApproval: value });
      await onChanged();
      notifyOk("Approval policy updated");
    });

  const generatePassword = () =>
    run("password", async () => {
      const res = await managementApi.tempPassword(person.userId!);
      setTempPassword(res.password);
      await onChanged();
    });

  const forceLogout = () =>
    run("logout", async () => {
      const res = await managementApi.forceLogout(person.userId!);
      notifyOk(
        res.sessionsDestroyed > 0
          ? `Signed out of ${res.sessionsDestroyed} session(s)`
          : "No active sessions to end"
      );
    });

  const revokeDevice = (deviceId: string) =>
    run(`device-${deviceId}`, async () => {
      await managementApi.revokeDevice(deviceId);
      setDevices((prev) => prev?.filter((d) => d.id !== deviceId) ?? null);
      notifyOk("Device revoked — next sign-in needs approval again");
    });

  const revokeAll = () =>
    run("devices", async () => {
      const res = await managementApi.revokeAllDevices(person.userId!);
      setDevices([]);
      notifyOk(`Revoked ${res.revoked} device(s)`);
    });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />

      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "tween", duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-lg bg-white h-full overflow-y-auto shadow-2xl"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-stone-200 px-6 py-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-stone-900 truncate">{person.name}</h3>
            <p className="text-xs text-stone-500 mt-0.5 truncate">
              {person.email || person.phone} · {ROLE_LABEL[person.role]}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-stone-400 hover:text-stone-800 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-6 space-y-8">
          {person.role === "owner" && (
            <Banner kind="info">
              The owner bypasses all permission checks and is never gated behind approval.
            </Banner>
          )}

          {!person.hasLogin && (
            <Banner kind="warn">
              This artist has no login account — they exist for visit attribution only. Add an email
              and password from the Artists page to give them dashboard access.
            </Banner>
          )}

          {tempPassword && (
            <SecretReveal
              value={tempPassword}
              title={`Temporary password for ${person.name}`}
              note="Give this to them directly. They'll be forced to choose their own password at next sign-in. It cannot be shown again."
              onDismiss={() => setTempPassword(null)}
            />
          )}

          {/*
            ── Account actions ──
            Deliberately first. Resetting a password is the single most common
            reason the owner opens this drawer; behind an 11-row permission
            checklist it was invisible without scrolling.
          */}
          {editable && (
            <section>
              <SectionTitle>Account actions</SectionTitle>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <ActionButton
                  icon={KeyRound}
                  label="Generate temp password"
                  hint="Forces a change at next sign-in"
                  busy={busy === "password"}
                  onClick={generatePassword}
                />
                <ActionButton
                  icon={LogOut}
                  label="Force sign-out"
                  hint="Ends every active session now"
                  busy={busy === "logout"}
                  onClick={forceLogout}
                />
              </div>
              {person.mustChangePassword && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-700">
                  <UserX className="w-3.5 h-3.5" />
                  Must set a new password at next sign-in
                </p>
              )}
            </section>
          )}

          {/* ── Permissions ── */}
          {person.role !== "owner" && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <SectionTitle hint="Overrides the role default for this person only.">
                  Individual permissions
                </SectionTitle>
                {editable && permsDirty && (
                  <button
                    onClick={savePerms}
                    disabled={savingPerms}
                    className="shrink-0 flex items-center gap-1.5 bg-stone-900 text-white text-xs rounded-lg px-3 py-2 hover:bg-stone-800 disabled:opacity-50 transition-colors"
                  >
                    {savingPerms ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Save className="w-3.5 h-3.5" />
                    )}
                    Save
                  </button>
                )}
              </div>
              <PermissionChecklist
                registry={registry}
                selected={perms}
                disabled={!editable}
                onToggle={(key) =>
                  setPerms((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))
                }
              />
            </section>
          )}

          {/* ── Login approval ── */}
          {person.role !== "owner" && person.hasLogin && (
            <section>
              <SectionTitle hint="“Inherit” follows whatever this role is set to in Login Approval.">
                Owner approval on sign-in
              </SectionTitle>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <TriToggle
                  value={approval}
                  onChange={saveApproval}
                  inheritLabel="Inherit role"
                  disabled={!editable || busy === "approval"}
                />
                <span
                  className={`text-xs font-medium ${
                    person.effectiveApproval ? "text-amber-700" : "text-stone-400"
                  }`}
                >
                  {person.effectiveApproval ? "Currently gated" : "Currently signs in directly"}
                </span>
              </div>
            </section>
          )}

          {/* ── Trusted devices ── */}
          {person.hasLogin && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <SectionTitle hint="Devices that can skip the approval step until the trust window expires.">
                  Trusted devices
                </SectionTitle>
                {canManage && devices && devices.length > 0 && (
                  <button
                    onClick={revokeAll}
                    disabled={busy === "devices"}
                    className="shrink-0 text-xs text-red-600 hover:text-red-800 transition-colors disabled:opacity-50"
                  >
                    Revoke all
                  </button>
                )}
              </div>

              {devices === null ? (
                <Loader2 className="w-4 h-4 animate-spin text-stone-300" />
              ) : devices.length === 0 ? (
                <p className="text-xs text-stone-400 py-2">
                  No trusted devices — every sign-in needs approval.
                </p>
              ) : (
                <ul className="space-y-2">
                  {devices.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center gap-3 rounded-xl border border-stone-200 px-4 py-3"
                    >
                      <Laptop className="w-4 h-4 text-stone-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-stone-800 truncate">{d.label}</p>
                        <p className="text-[0.7rem] text-stone-400 mt-0.5">
                          via {d.grantedVia} · used {timeAgo(d.lastUsedAt)} · expires{" "}
                          {new Date(d.trustedUntil).toLocaleString("en-IN", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: true,
                          })}
                        </p>
                      </div>
                      {canManage && (
                        <button
                          onClick={() => revokeDevice(d.id)}
                          disabled={busy === `device-${d.id}`}
                          aria-label={`Revoke ${d.label}`}
                          className="shrink-0 text-stone-400 hover:text-red-600 transition-colors disabled:opacity-50"
                        >
                          {busy === `device-${d.id}` ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </motion.aside>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  hint,
  busy,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  hint: string;
  busy: boolean;
  onClick: () => void;
}) {
  const [done, setDone] = useState(false);

  const handle = async () => {
    await onClick();
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };

  return (
    <button
      onClick={handle}
      disabled={busy}
      className="flex items-start gap-2.5 rounded-xl border border-stone-200 hover:border-stone-300 hover:bg-stone-50 px-4 py-3 text-left transition-all disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin text-stone-400 mt-0.5 shrink-0" />
      ) : done ? (
        <Check className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
      ) : (
        <Icon className="w-4 h-4 text-stone-500 mt-0.5 shrink-0" />
      )}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-stone-800">{label}</span>
        <span className="block text-[0.7rem] text-stone-400 mt-0.5">{hint}</span>
      </span>
    </button>
  );
}
