/**
 * @file ManagerDashboard.tsx
 * @description Manager's dashboard with sidebar nav and sub-routes.
 *
 * Routes:
 *   /dashboard/manager           → Overview (stats + charts)
 *   /dashboard/manager/analytics → Full analytics view
 *   /dashboard/manager/services  → Service catalogue (read-only)
 *   /dashboard/manager/artists   → Artist directory (CRUD)
 */

import { Routes, Route } from "react-router-dom";
import { LayoutDashboard, BarChart3, Scissors, Palette, CalendarPlus, Receipt } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import DashboardOverview from "@/pages/dashboard/shared/DashboardOverview";
import DashboardAnalyticsView from "@/pages/dashboard/shared/DashboardAnalyticsView";
import ServicesView from "@/pages/dashboard/shared/ServicesView";
import ArtistManagement from "@/pages/dashboard/ArtistManagement";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";

const managerLinks = [
  { to: "/dashboard/manager", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/manager/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/dashboard/manager/payments", label: "Payments", icon: Receipt },
  { to: "/dashboard/manager/services", label: "Services", icon: Scissors },
  { to: "/dashboard/manager/artists", label: "Artists", icon: Palette },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus },
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
      </Routes>
    </DashboardLayout>
  );
}
