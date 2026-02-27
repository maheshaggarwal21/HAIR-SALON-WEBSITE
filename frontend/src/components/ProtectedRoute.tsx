/**
 * @file ProtectedRoute.tsx
 * @description Role-gated route wrapper.
 *
 * While the auth state is loading, shows a spinner.
 * If no user → redirect to /signin.
 * If user's role is not in `allowedRoles` → redirect to /unauthorized.
 */

import { Navigate } from "react-router-dom";
import { useAuth, type Role } from "@/context/AuthContext";

interface Props {
  allowedRoles: Role[];
  requiredPermission?: string; // optional PBAC key check
  children: React.ReactNode;
}

export default function ProtectedRoute({ allowedRoles, requiredPermission, children }: Props) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: "#faf8f4" }}
      >
        <div className="w-10 h-10 rounded-full border-4 border-stone-200 border-t-amber-500 animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/signin" replace />;
  if (!allowedRoles.includes(user.role)) return <Navigate to="/unauthorized" replace />;

  // PBAC check — owner is always exempt
  if (requiredPermission && user.role !== "owner") {
    if (!user.permissions.includes(requiredPermission)) {
      return <Navigate to="/unauthorized" replace />;
    }
  }

  return <>{children}</>;
}
