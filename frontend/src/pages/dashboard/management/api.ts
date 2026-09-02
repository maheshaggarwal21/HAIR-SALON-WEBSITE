/**
 * @file api.ts
 * @description Typed client for /api/management, shared by every Management panel.
 *
 * One thin wrapper (`call`) so error handling, credentials, and JSON parsing are
 * identical everywhere, and a panel never has to remember `credentials: "include"`.
 */

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────

export type StaffRole = "receptionist" | "manager" | "artist" | "owner";
export type AssignableRole = "receptionist" | "manager" | "artist";

export const ASSIGNABLE_ROLES: AssignableRole[] = ["receptionist", "manager", "artist"];

export const ROLE_LABEL: Record<StaffRole, string> = {
  receptionist: "Receptionist",
  manager: "Manager",
  artist: "Artist",
  owner: "Owner",
};

export interface RosterEntry {
  id: string;
  source: "user" | "artist";
  userId: string | null;
  artistId?: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: StaffRole;
  isActive: boolean;
  hasLogin: boolean;
  permissions: string[];
  /** null = inherit the role default; true/false = explicit override. */
  requiresApproval: boolean | null;
  approverUserId: string | null;
  effectiveApproval: boolean;
  mustChangePassword: boolean;
  telegramLinked: boolean;
  lastLoginAt: string | null;
  commission?: number;
  registrationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionRegistry {
  permissions: string[];
  labels: Record<string, string>;
  groups: Array<{ label: string; keys: string[] }>;
  roles: AssignableRole[];
}

export interface SecuritySettings {
  approvalGateEnabled: boolean;
  roleRequiresApproval: Record<AssignableRole, boolean>;
  defaultApproverUserId: string | null;
  trustedWindowHours: number;
  approvalTimeoutSeconds: number;
  otpExpiryMinutes: number;
  maxOtpAttempts: number;
  failOpenIfUnreachable: boolean;
}

export interface ApproverInfo {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  maskedPhone: string | null;
  telegramLinked: boolean;
  telegramUsername: string | null;
  telegramLinkedAt: string | null;
}

export interface SecurityPayload {
  settings: SecuritySettings;
  bypassCode: {
    isSet: boolean;
    setAt: string | null;
    setByName: string | null;
    lastUsedAt: string | null;
    useCount: number;
  };
  channels: { telegramConfigured: boolean; smsConfigured: boolean };
  approvers: ApproverInfo[];
}

export interface TrustedDeviceRow {
  id: string;
  label: string;
  ip: string | null;
  grantedVia: "telegram" | "otp" | "bypass";
  trustedUntil: string;
  lastUsedAt: string;
  createdAt: string;
}

export interface AuditEntry {
  _id: string;
  action: string;
  actorName: string;
  actorRole: string | null;
  targetName: string | null;
  meta: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

// ── Transport ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/management${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message =
      (data as { error?: string }).error ??
      (data as { errors?: Array<{ msg: string }> }).errors?.[0]?.msg ??
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

// ── Endpoints ────────────────────────────────────────────────────────────────

export const managementApi = {
  roster: () => call<{ roster: RosterEntry[]; registry: PermissionRegistry }>("/roster"),

  getRoleDefaults: () =>
    call<{ roleDefaults: Record<AssignableRole, string[]>; registry: PermissionRegistry }>(
      "/role-defaults"
    ),

  saveRoleDefaults: (roleDefaults: Partial<Record<AssignableRole, string[]>>) =>
    call<{ roleDefaults: Record<AssignableRole, string[]> }>("/role-defaults", {
      method: "PUT",
      ...json({ roleDefaults }),
    }),

  applyRoleDefaults: (role: AssignableRole) =>
    call<{ ok: true; updated: number; permissions: string[] }>(`/role-defaults/${role}/apply`, {
      method: "POST",
    }),

  setPermissions: (userId: string, permissions: string[]) =>
    call<{ id: string; permissions: string[] }>(`/staff/${userId}/permissions`, {
      method: "PUT",
      ...json({ permissions }),
    }),

  security: () => call<SecurityPayload>("/security"),

  saveSecurity: (patch: Partial<SecuritySettings>) =>
    call<{ ok: true; changed: Record<string, unknown> }>("/security", {
      method: "PATCH",
      ...json(patch),
    }),

  setApproval: (
    userId: string,
    patch: { requiresApproval?: boolean | null; approverUserId?: string | null }
  ) =>
    call<{ id: string; requiresApproval: boolean | null; effectiveApproval: boolean }>(
      `/staff/${userId}/approval`,
      { method: "PATCH", ...json(patch) }
    ),

  setPhone: (userId: string, phone: string | null) =>
    call<{ id: string; phone: string | null; maskedPhone: string | null }>(
      `/staff/${userId}/contact`,
      { method: "PATCH", ...json({ phone }) }
    ),

  tempPassword: (userId: string, opts?: { password?: string; forceChange?: boolean }) =>
    call<{ ok: true; password: string; mustChangePassword: boolean }>(
      `/staff/${userId}/temp-password`,
      { method: "POST", ...json(opts ?? {}) }
    ),

  forceLogout: (userId: string) =>
    call<{ ok: true; sessionsDestroyed: number }>(`/staff/${userId}/force-logout`, {
      method: "POST",
    }),

  devices: (userId: string) => call<TrustedDeviceRow[]>(`/staff/${userId}/devices`),

  revokeDevice: (deviceId: string) =>
    call<{ ok: true }>(`/devices/${deviceId}`, { method: "DELETE" }),

  revokeAllDevices: (userId: string) =>
    call<{ ok: true; revoked: number }>(`/staff/${userId}/devices`, { method: "DELETE" }),

  setBypassCode: (code?: string) =>
    call<{ ok: true; code: string; setAt: string }>("/bypass-code", {
      method: "PUT",
      ...json(code ? { code } : {}),
    }),

  clearBypassCode: () => call<{ ok: true }>("/bypass-code", { method: "DELETE" }),

  linkTelegram: () =>
    call<{ code: string; deepLink: string; botUsername: string; expiresAt: string }>(
      "/telegram/link",
      { method: "POST" }
    ),

  unlinkTelegram: () => call<{ ok: true }>("/telegram/link", { method: "DELETE" }),

  testTelegram: () => call<{ ok: true }>("/telegram/test", { method: "POST" }),

  audit: (limit = 100) => call<AuditEntry[]>(`/audit?limit=${limit}`),
};
