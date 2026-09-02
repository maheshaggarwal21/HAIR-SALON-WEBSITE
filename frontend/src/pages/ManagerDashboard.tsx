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
import { LayoutDashboard, BarChart3, Scissors, Palette, CalendarPlus, Receipt, Users, Database } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import DashboardOverview from "@/pages/dashboard/shared/DashboardOverview";
import DashboardAnalyticsView from "@/pages/dashboard/shared/DashboardAnalyticsView";
import ServiceManagement from "@/pages/dashboard/ServiceManagement";
import ArtistManagement from "@/pages/dashboard/ArtistManagement";
import ArtistDashboardView from "@/pages/dashboard/ArtistDashboardView";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";
import DataPipeline from "@/pages/dashboard/DataPipeline";
import TeamManagement from "@/pages/dashboard/TeamManagement";
import RequirePermission from "@/components/RequirePermission";

import type { SidebarLink } from "@/layouts/DashboardLayout";

const managerLinks: SidebarLink[] = [
  { to: "/dashboard/manager", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/manager/analytics", label: "Analytics", icon: BarChart3, requiredPermission: "analytics.view" },
  { to: "/dashboard/manager/payments", label: "Payments", icon: Receipt, requiredPermission: "payments.view" },
  { to: "/dashboard/manager/data-pipeline", label: "Data Pipeline", icon: Database, requiredPermission: "datapipeline.view" },
  { to: "/dashboard/manager/services", label: "Services", icon: Scissors, requiredPermission: ["services.view", "services.crud"] },
  { to: "/dashboard/manager/artists", label: "Artists", icon: Palette, requiredPermission: ["artists.view", "artists.crud"] },
  { to: "/dashboard/manager/team", label: "Team", icon: Users, requiredPermission: ["team.view", "team.manage"] },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus, requiredPermission: "visit.create" },
];

const HOME = "/dashboard/manager";

/**
 * Sub-routes are permission-gated, not just hidden from the sidebar. Without
 * this, revoking `analytics.view` removed the nav link but typing the URL still
 * mounted the page — the API refused the data, so the user saw an empty screen
 * rather than an explanation.
 */
export default function ManagerDashboard() {
  return (
    <DashboardLayout sidebarLinks={managerLinks} pageTitle="Manager Dashboard">
      <Routes>
        <Route index element={<DashboardOverview />} />
        <Route
          path="analytics"
          element={
            <RequirePermission permission="analytics.view" backTo={HOME}>
              <DashboardAnalyticsView />
            </RequirePermission>
          }
        />
        <Route
          path="payments"
          element={
            <RequirePermission permission="payments.view" backTo={HOME}>
              <PaymentHistory />
            </RequirePermission>
          }
        />
        <Route
          path="data-pipeline"
          element={
            <RequirePermission permission="datapipeline.view" backTo={HOME}>
              <DataPipeline />
            </RequirePermission>
          }
        />
        <Route
          path="services"
          element={
            <RequirePermission permission={["services.view", "services.crud"]} backTo={HOME}>
              <ServiceManagement />
            </RequirePermission>
          }
        />
        <Route
          path="artists"
          element={
            <RequirePermission permission={["artists.view", "artists.crud"]} backTo={HOME}>
              <ArtistManagement />
            </RequirePermission>
          }
        />
        <Route
          path="artist-view/:id"
          element={
            <RequirePermission permission="artist_dashboard.view" backTo={HOME}>
              <ArtistDashboardView />
            </RequirePermission>
          }
        />
        <Route
          path="team"
          element={
            <RequirePermission permission={["team.view", "team.manage"]} backTo={HOME}>
              <TeamManagement />
            </RequirePermission>
          }
        />
      </Routes>
    </DashboardLayout>
  );
}
