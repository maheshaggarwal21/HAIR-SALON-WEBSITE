/**
 * @file ArtistDashboardLayout.tsx
 * @description Artist dashboard with sidebar nav and permission-gated sub-routes.
 *
 * Routes:
 *   /dashboard/artist            → My Stats (personal commission analytics)
 *   /dashboard/artist/analytics  → Analytics (if granted analytics.view)
 *   /dashboard/artist/payments   → Payment History (if granted payments.view)
 *   /dashboard/artist/services   → Service Catalogue (if granted services.view)
 *   /dashboard/artist/artists    → Artist Directory (if granted artists.view)
 *   /visit-entry                 → New Visit Entry (if granted visit.create, external link)
 */

import { Routes, Route } from "react-router-dom";
import {
  LayoutDashboard,
  BarChart3,
  Scissors,
  Palette,
  CalendarPlus,
  Receipt,
} from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import ArtistStatsView from "@/pages/dashboard/ArtistStatsView";
import DashboardAnalyticsView from "@/pages/dashboard/shared/DashboardAnalyticsView";
import ServiceManagement from "@/pages/dashboard/ServiceManagement";
import ArtistManagement from "@/pages/dashboard/ArtistManagement";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";

import type { SidebarLink } from "@/layouts/DashboardLayout";

const artistLinks: SidebarLink[] = [
  { to: "/dashboard/artist", label: "My Stats", icon: LayoutDashboard },
  {
    to: "/dashboard/artist/analytics",
    label: "Analytics",
    icon: BarChart3,
    requiredPermission: "analytics.view",
  },
  {
    to: "/dashboard/artist/payments",
    label: "Payments",
    icon: Receipt,
    requiredPermission: "payments.view",
  },
  {
    to: "/dashboard/artist/services",
    label: "Services",
    icon: Scissors,
    requiredPermission: ["services.view", "services.crud"],
  },
  {
    to: "/dashboard/artist/artists",
    label: "Artists",
    icon: Palette,
    requiredPermission: ["artists.view", "artists.crud"],
  },
  {
    to: "/visit-entry",
    label: "New Visit Entry",
    icon: CalendarPlus,
    requiredPermission: "visit.create",
  },
];

export default function ArtistDashboardLayout() {
  return (
    <DashboardLayout sidebarLinks={artistLinks} pageTitle="Artist Dashboard">
      <Routes>
        <Route index element={<ArtistStatsView />} />
        <Route path="analytics" element={<DashboardAnalyticsView />} />
        <Route path="payments" element={<PaymentHistory />} />
        <Route path="services" element={<ServiceManagement />} />
        <Route path="artists" element={<ArtistManagement />} />
      </Routes>
    </DashboardLayout>
  );
}
