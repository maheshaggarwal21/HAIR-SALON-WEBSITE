/**
 * @file ReceptionistDashboard.tsx
 * @description Receptionist's dashboard with sidebar nav.
 *
 * Routes:
 *   /dashboard/receptionist          → Payment History (default)
 *   /dashboard/receptionist/payments → Payment History
 *   /dashboard/receptionist/analytics → Analytics (if granted analytics.view)
 *   /dashboard/receptionist/artists  → Artist Directory (if granted artists.view)
 *   /dashboard/receptionist/services → Services (if granted services.view)
 *   /dashboard/receptionist/team     → Team Management (if granted team.view)
 *
 * Receptionists can view payment records and navigate to New Visit Entry.
 * Additional sidebar links appear when the owner grants extra permissions.
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { Receipt, CalendarPlus, BarChart3, Palette, Scissors, Users } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";
import DashboardAnalyticsView from "@/pages/dashboard/shared/DashboardAnalyticsView";
import ArtistManagement from "@/pages/dashboard/ArtistManagement";
import ArtistDashboardView from "@/pages/dashboard/ArtistDashboardView";
import ServiceManagement from "@/pages/dashboard/ServiceManagement";
import TeamManagement from "@/pages/dashboard/TeamManagement";

import type { SidebarLink } from "@/layouts/DashboardLayout";

const receptionistLinks: SidebarLink[] = [
  { to: "/dashboard/receptionist/payments", label: "Payment History", icon: Receipt, requiredPermission: "payments.view" },
  { to: "/dashboard/receptionist/analytics", label: "Analytics", icon: BarChart3, requiredPermission: "analytics.view" },
  { to: "/dashboard/receptionist/services", label: "Services", icon: Scissors, requiredPermission: "services.view" },
  { to: "/dashboard/receptionist/artists", label: "Artists", icon: Palette, requiredPermission: "artists.view" },
  { to: "/dashboard/receptionist/team", label: "Team", icon: Users, requiredPermission: "team.view" },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus, requiredPermission: "visit.create" },
];

/** Redirect to the first sidebar link the user has permission for. */
function DefaultRedirect() {
  const { user } = useAuth();
  const perms = user?.permissions ?? [];
  const isOwner = user?.role === "owner";

  for (const link of receptionistLinks) {
    // Skip external links (like /visit-entry)
    if (!link.to.startsWith("/dashboard/receptionist/")) continue;
    if (!link.requiredPermission || isOwner || perms.includes(link.requiredPermission)) {
      const sub = link.to.replace("/dashboard/receptionist/", "");
      return <Navigate to={sub} replace />;
    }
  }
  // Fallback — shouldn't happen if at least one permission is granted
  return <Navigate to="/unauthorized" replace />;
}

export default function ReceptionistDashboard() {
  return (
    <DashboardLayout sidebarLinks={receptionistLinks} pageTitle="Receptionist Dashboard">
      <Routes>
        <Route index element={<DefaultRedirect />} />
        <Route path="payments" element={<PaymentHistory />} />
        <Route path="analytics" element={<DashboardAnalyticsView />} />
        <Route path="services" element={<ServiceManagement />} />
        <Route path="artists" element={<ArtistManagement />} />
        <Route path="artist-view/:id" element={<ArtistDashboardView />} />
        <Route path="team" element={<TeamManagement />} />
      </Routes>
    </DashboardLayout>
  );
}
