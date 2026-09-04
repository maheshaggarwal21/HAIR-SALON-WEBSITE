/**
 * @file usePermission.ts
 * @description Tiny hook for PBAC checks — reads from AuthContext, never hits the API.
 *
 * - Owner role always returns true (exempt from PBAC).
 * - All other roles (including artist): checks user.permissions[].
 *
 * Usage:
 *   const canViewAnalytics = usePermission('analytics.view');
 *   if (!canViewAnalytics) return null;
 */

import { useAuth } from "../context/AuthContext";

export function usePermission(key: string): boolean {
  const { user } = useAuth();
  if (!user) return false;
  if (user.role === "owner") return true; // owner is always exempt
  return user.permissions.includes(key);
}

/**
 * For permission keys that TAKE ACCESS AWAY rather than grant it —
 * currently only `payments.today_only`.
 *
 * Do NOT use usePermission() for these. It answers "does this account have the
 * key?", and for the owner that is unconditionally true, so a restriction key
 * read through it applies the restriction to the one person who should never
 * have it. That exact mistake shipped once: the owner's Payment History locked
 * itself to today.
 *
 * The server draws the same distinction — every restriction check there is
 * guarded by `req.session.role !== "owner"`.
 *
 * @returns true when this account IS restricted
 */
export function useRestriction(key: string): boolean {
  const { user } = useAuth();
  if (!user) return false;
  if (user.role === "owner") return false; // never restrict the owner
  return user.permissions.includes(key);
}
