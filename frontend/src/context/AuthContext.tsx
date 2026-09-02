/**
 * @file AuthContext.tsx
 * @description Global auth state — session-based login/logout with role awareness.
 *
 * On mount, checks GET /api/auth/me to restore any existing session.
 *
 * Login is no longer a single round trip. When a staff member's account is
 * gated behind owner approval, POST /api/auth/login returns a *pending* result
 * instead of a session, and the caller drives the rest of the flow:
 *
 *   login()      → { status: "authenticated" } | { status: "pending", … } | { status: "error" }
 *   pollStatus() → poll while pending; resolves to authenticated / otp_fallback / failed
 *   verifyOtp()  → submit the code the owner relayed
 *   submitBypassCode()  → break-glass code when every channel is down
 *
 * The session cookie is set by whichever request completes the login, so
 * nothing here ever touches a token.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

// ── Types ────────────────────────────────────────────────────────────────────
export type Role = "receptionist" | "manager" | "owner" | "artist";

/** Mirrors PendingLogin.STATUSES on the server. */
export type GateStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "otp_fallback"
  | "otp_verified"
  | "otp_failed";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  permissions: string[]; // PBAC — permission keys fetched from /api/auth/me
  mustChangePassword?: boolean;
}

export interface PendingLoginState {
  pendingId: string;
  status: GateStatus;
  approverName?: string;
  channel?: "telegram" | "sms" | "none";
  timeoutSeconds?: number;
  expiresAt?: string;
  otpExpiresAt?: string | null;
  otpSentTo?: string | null;
  /** False when no channel could actually deliver the code. */
  otpDelivered?: boolean;
  attemptsLeft?: number;
}

export type LoginResult =
  | { status: "authenticated"; user: AuthUser }
  | { status: "pending"; pending: PendingLoginState }
  | { status: "error"; error: string; code?: string };

export type GateResult =
  | { status: "authenticated"; user: AuthUser }
  | { status: "pending"; pending: PendingLoginState }
  | { status: "failed"; error: string; terminal: boolean; attemptsLeft?: number };

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  pollStatus: (pendingId: string) => Promise<GateResult>;
  verifyOtp: (pendingId: string, code: string) => Promise<GateResult>;
  submitBypassCode: (pendingId: string, code: string) => Promise<GateResult>;
  changePassword: (
    currentPassword: string,
    newPassword: string
  ) => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

// ── Context + hook ───────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};

const API = import.meta.env.VITE_BACKEND_URL || "";

/** Statuses from which no further progress is possible — stop polling. */
const TERMINAL_FAILURES: GateStatus[] = ["denied", "expired", "otp_failed"];

const FAILURE_COPY: Record<string, string> = {
  denied: "The owner denied this sign-in request.",
  expired: "This sign-in request expired. Please sign in again.",
  otp_failed: "Too many incorrect codes. Please sign in again.",
};

// ── Provider ─────────────────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/auth/me`, { credentials: "include" });
      setUser(res.ok ? await res.json() : null);
    } catch {
      /* offline — keep whatever we already had */
    }
  }, []);

  // Restore session on mount
  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = async (email: string, password: string): Promise<LoginResult> => {
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        return {
          status: "error",
          error: data.error || data.errors?.[0]?.msg || "Sign in failed",
          code: data.code,
        };
      }

      // Discriminate on the presence of a pendingId, NOT on status === "pending".
      // When the approver has no Telegram linked the server skips the dead
      // 90-second wait and hands back status "otp_fallback" on this very first
      // response — matching only "pending" here would fall through and set the
      // user to undefined.
      if (data.status !== "authenticated" && data.pendingId) {
        return { status: "pending", pending: data as PendingLoginState };
      }

      setUser(data.user);
      return { status: "authenticated", user: data.user };
    } catch {
      return { status: "error", error: "Network error. Check your connection." };
    }
  };

  /**
   * Normalises every gate endpoint's response into one shape, so the login
   * screen doesn't need to know which of the three resolved the request.
   */
  const interpret = useCallback(
    (res: Response, data: Record<string, unknown>): GateResult => {
      if (res.ok && data.status === "authenticated") {
        const u = data.user as AuthUser;
        setUser(u);
        return { status: "authenticated", user: u };
      }

      const status = data.status as GateStatus | undefined;

      if (status && TERMINAL_FAILURES.includes(status)) {
        return {
          status: "failed",
          error: (data.error as string) || FAILURE_COPY[status],
          terminal: true,
        };
      }

      if (!res.ok) {
        return {
          status: "failed",
          error: (data.error as string) || "Something went wrong.",
          // 4xx that isn't a known terminal state means "try again", except
          // 403/404/409 which mean this request is unusable.
          terminal: [403, 404, 409].includes(res.status),
          attemptsLeft: data.attemptsLeft as number | undefined,
        };
      }

      return { status: "pending", pending: data as unknown as PendingLoginState };
    },
    []
  );

  const pollStatus = useCallback(
    async (pendingId: string): Promise<GateResult> => {
      try {
        const res = await fetch(`${API}/api/auth/login-status/${pendingId}`, {
          credentials: "include",
        });
        return interpret(res, await res.json());
      } catch {
        // A dropped poll is not fatal — the caller keeps polling.
        return { status: "failed", error: "Connection lost. Retrying…", terminal: false };
      }
    },
    [interpret]
  );

  const submitCode = useCallback(
    async (path: string, pendingId: string, code: string): Promise<GateResult> => {
      try {
        const res = await fetch(`${API}/api/auth/${path}/${pendingId}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        return interpret(res, await res.json());
      } catch {
        return { status: "failed", error: "Network error. Check your connection.", terminal: false };
      }
    },
    [interpret]
  );

  const verifyOtp = useCallback(
    (pendingId: string, code: string) => submitCode("verify-otp", pendingId, code),
    [submitCode]
  );

  const submitBypassCode = useCallback(
    (pendingId: string, code: string) => submitCode("bypass", pendingId, code),
    [submitCode]
  );

  const changePassword = async (currentPassword: string, newPassword: string) => {
    try {
      const res = await fetch(`${API}/api/auth/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || data.errors?.[0]?.msg || "Could not change password" };
      }
      await refresh();
      return { success: true };
    } catch {
      return { success: false, error: "Network error. Check your connection." };
    }
  };

  const logout = async () => {
    await fetch(`${API}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, login, pollStatus, verifyOtp, submitBypassCode, changePassword, refresh, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
