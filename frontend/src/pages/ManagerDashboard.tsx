/**
 * @file ManagerDashboard.tsx
 * @description Manager's dashboard with sidebar nav and sub-routes.
 *
 * Routes:
 *   /dashboard/manager           → Overview (stats + charts)
 *   /dashboard/manager/analytics → Full analytics view
 *   /dashboard/manager/services  → Service catalogue (read-only)
 *   /dashboard/manager/artists   → Artist directory (CRUD)
 *   /dashboard/manager/team      → Team management (if granted team.view)
 */

import { Routes, Route } from "react-router-dom";
import { LayoutDashboard, BarChart3, Scissors, Palette, CalendarPlus, Receipt, Users } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import DashboardOverview from "@/pages/dashboard/shared/DashboardOverview";
import DashboardAnalyticsView from "@/pages/dashboard/shared/DashboardAnalyticsView";
import ServicesView from "@/pages/dashboard/shared/ServicesView";
import ArtistManagement from "@/pages/dashboard/ArtistManagement";
import ArtistDashboardView from "@/pages/dashboard/ArtistDashboardView";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";
import TeamManagement from "@/pages/dashboard/TeamManagement";

import type { SidebarLink } from "@/layouts/DashboardLayout";

const managerLinks: SidebarLink[] = [
  { to: "/dashboard/manager", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/manager/analytics", label: "Analytics", icon: BarChart3, requiredPermission: "analytics.view" },
  { to: "/dashboard/manager/payments", label: "Payments", icon: Receipt, requiredPermission: "payments.view" },
  { to: "/dashboard/manager/services", label: "Services", icon: Scissors, requiredPermission: "services.view" },
  { to: "/dashboard/manager/artists", label: "Artists", icon: Palette, requiredPermission: "artists.view" },
  { to: "/dashboard/manager/team", label: "Team", icon: Users, requiredPermission: "team.view" },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus, requiredPermission: "visit.create" },
];

export default function ManagerDashboard() {
  return (
    <DashboardLayout sidebarLinks={managerLinks} pageTitle="Manager Dashboard">
      <Routes>
        <Route index element={<DashboardOverview />} />
        <Route path="analytics" element={<DashboardAnalyticsView />} />
        <Route path="payments" element={<PaymentHistory />} />
        <Route path="services" element={<ServicesView />} />
        <Route path="artists" element={<ArtistManagement />} />
        <Route path="artist-view/:id" element={<ArtistDashboardView />} />
        <Route path="team" element={<TeamManagement />} />
      </Routes>
    </DashboardLayout>
  );
}
