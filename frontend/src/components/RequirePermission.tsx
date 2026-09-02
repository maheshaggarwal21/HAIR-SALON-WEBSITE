/**
 * @file RequirePermission.tsx
 * @description Wraps a dashboard sub-route in a PBAC check.
 *
 * ProtectedRoute guards the dashboard shells by role, but the sub-routes inside
 * them (/dashboard/manager/analytics and friends) were previously ungated: the
 * sidebar hid the link, yet typing the URL still mounted the page. The API
 * refused the data, so nothing leaked — but the user saw a broken screen rather
 * than an explanation. This renders AccessDenied instead.
 *
 * Accepts a single key or an array (any-of), matching how DashboardLayout
 * filters sidebar links, so a route and its nav entry can share one value.
 */

import { useAuth } from "@/context/AuthContext";
import AccessDenied from "@/components/AccessDenied";

interface Props {
  permission: string | string[];
  /** Dashboard root to offer as "Go back". */
  backTo?: string;
  children: React.ReactNode;
}

export default function RequirePermission({ permission, backTo, children }: Props) {
  const { user } = useAuth();

  // Owner bypasses PBAC entirely, mirroring authorizePermission on the server.
  if (user?.role === "owner") return <>{children}</>;

  const perms = user?.permissions ?? [];
  const allowed = Array.isArray(permission)
    ? permission.some((p) => perms.includes(p))
    : perms.includes(permission);

  if (!allowed) {
    return (
      <AccessDenied
        permission={Array.isArray(permission) ? permission.join(" or ") : permission}
        backTo={backTo}
      />
    );
  }

  return <>{children}</>;
}
