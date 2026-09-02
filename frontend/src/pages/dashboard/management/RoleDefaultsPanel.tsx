/**
 * @file RoleDefaultsPanel.tsx
 * @description The "Team" node — sets the permission set that each ROLE starts
 * with, so a newly added receptionist/manager/artist is provisioned correctly
 * without anyone ticking boxes by hand.
 *
 * These defaults apply at account creation only. Changing them deliberately
 * does NOT retro-apply: someone who had a permission individually revoked
 * should not silently get it back because the role default moved. The explicit
 * "Apply to all existing" button exists for when that IS what you want, and it
 * says plainly that it overwrites individual edits.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Users2, Save, Loader2, RefreshCw, Scissors, Receipt, BriefcaseBusiness } from "lucide-react";
import {
  managementApi,
  ASSIGNABLE_ROLES,
  ROLE_LABEL,
  type AssignableRole,
  type PermissionRegistry,
} from "./api";
import { PanelHeader, Card, PermissionChecklist, Banner, useToast } from "./ui";

const ROLE_ICON: Record<AssignableRole, React.ElementType> = {
  receptionist: Receipt,
  manager: BriefcaseBusiness,
  artist: Scissors,
};

const ROLE_BLURB: Record<AssignableRole, string> = {
  receptionist: "Front desk — takes payments and creates visit entries.",
  manager: "Runs the floor — analytics, artists, and day-to-day operations.",
  artist: "Stylists. Most only need their own dashboard, so this starts empty.",
};

export default function RoleDefaultsPanel({ canManage }: { canManage: boolean }) {
  const [registry, setRegistry] = useState<PermissionRegistry | null>(null);
  const [defaults, setDefaults] = useState<Record<AssignableRole, string[]> | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [role, setRole] = useState<AssignableRole>("receptionist");
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [loadError, setLoadError] = useState("");
  const { showOk, showErr, element: toastEl } = useToast();

  useEffect(() => {
    managementApi
      .getRoleDefaults()
      .then((data) => {
        setRegistry(data.registry);
        setDefaults(data.roleDefaults);
        setOriginal(JSON.stringify(data.roleDefaults));
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  const dirty = defaults ? JSON.stringify(defaults) !== original : false;

  const toggle = (key: string) => {
    setDefaults((prev) => {
      if (!prev) return prev;
      const current = prev[role] ?? [];
      return {
        ...prev,
        [role]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
      };
    });
  };

  const save = async () => {
    if (!defaults) return;
    setSaving(true);
    try {
      const res = await managementApi.saveRoleDefaults(defaults);
      setDefaults(res.roleDefaults);
      setOriginal(JSON.stringify(res.roleDefaults));
      showOk("Role defaults saved");
    } catch (err) {
      showErr((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const applyToExisting = async () => {
    const count = defaults?.[role]?.length ?? 0;
    const confirmed = window.confirm(
      `Overwrite permissions for EVERY active ${ROLE_LABEL[role].toLowerCase()} with these ${count} permission(s)?\n\nAny individual changes you've made to those accounts will be lost. This cannot be undone.`
    );
    if (!confirmed) return;

    setApplying(true);
    try {
      const res = await managementApi.applyRoleDefaults(role);
      showOk(`Applied to ${res.updated} ${ROLE_LABEL[role].toLowerCase()} account(s)`);
    } catch (err) {
      showErr((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  if (loadError) return <Banner kind="error">{loadError}</Banner>;

  if (!registry || !defaults) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-stone-300" />
      </div>
    );
  }

  return (
    <div>
      <PanelHeader
        icon={Users2}
        title="Role defaults"
        subtitle="What each role can access the moment their account is created"
        action={
          canManage && (
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-5 py-2.5 hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          )
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[15rem_1fr] gap-5">
        {/* Role selector */}
        <div className="space-y-2">
          {ASSIGNABLE_ROLES.map((r) => {
            const Icon = ROLE_ICON[r];
            const active = r === role;
            const count = defaults[r]?.length ?? 0;
            return (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`w-full text-left rounded-xl border p-4 transition-all ${
                  active
                    ? "border-amber-400 bg-amber-50/60 shadow-sm"
                    : "border-stone-200 bg-white hover:border-stone-300"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className={`w-4 h-4 ${active ? "text-amber-600" : "text-stone-400"}`} />
                  <span className="font-semibold text-sm text-stone-900">{ROLE_LABEL[r]}</span>
                </div>
                <p className="text-xs text-stone-500 mt-1.5 leading-relaxed">{ROLE_BLURB[r]}</p>
                <p className="text-[0.7rem] font-medium text-stone-400 mt-2 uppercase tracking-wider">
                  {count} permission{count === 1 ? "" : "s"}
                </p>
              </button>
            );
          })}
        </div>

        {/* Checklist */}
        <Card className="p-6">
          <motion.div key={role} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <h3 className="text-base font-bold text-stone-900">
                  New {ROLE_LABEL[role].toLowerCase()} accounts start with
                </h3>
                <p className="text-xs text-stone-500 mt-1 leading-relaxed max-w-md">
                  Changing this affects future accounts only. Existing staff keep whatever they
                  have now.
                </p>
              </div>

              {canManage && (
                <button
                  onClick={applyToExisting}
                  disabled={applying || dirty}
                  title={
                    dirty
                      ? "Save your changes first"
                      : "Overwrite every existing account of this role"
                  }
                  className="shrink-0 flex items-center gap-2 text-xs text-stone-600 hover:text-stone-900 border border-stone-200 hover:border-stone-300 rounded-lg px-3 py-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {applying ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  Apply to all existing
                </button>
              )}
            </div>

            <PermissionChecklist
              registry={registry}
              selected={defaults[role] ?? []}
              onToggle={toggle}
              disabled={!canManage}
            />
          </motion.div>
        </Card>
      </div>

      {toastEl}
    </div>
  );
}
