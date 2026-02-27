/**
 * @file ReceptionistDashboard.tsx
 * @description Receptionist's dashboard with sidebar nav.
 *
 * Routes:
 *   /dashboard/receptionist          → Payment History (default)
 *   /dashboard/receptionist/payments → Payment History
 *   /dashboard/receptionist/analytics → Analytics (if granted analytics.view)
 *   /dashboard/receptionist/artists  → Artist Directory (if granted artists.view)
 *
 * Receptionists can view payment records and navigate to New Visit Entry.
 * Additional sidebar links appear when the owner grants extra permissions.
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { Receipt, CalendarPlus, BarChart3, Palette } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";
import DashboardAnalyticsView from "@/pages/dashboard/shared/DashboardAnalyticsView";
import ArtistManagement from "@/pages/dashboard/ArtistManagement";

import type { SidebarLink } from "@/layouts/DashboardLayout";

const receptionistLinks: SidebarLink[] = [
  { to: "/dashboard/receptionist/payments", label: "Payment History", icon: Receipt, requiredPermission: "payments.view" },
  { to: "/dashboard/receptionist/analytics", label: "Analytics", icon: BarChart3, requiredPermission: "analytics.view" },
  { to: "/dashboard/receptionist/artists", label: "Artist Directory", icon: Palette, requiredPermission: "artists.view" },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus },
];

export default function ReceptionistDashboard() {
  return (
    <DashboardLayout sidebarLinks={receptionistLinks} pageTitle="Receptionist Dashboard">
      <Routes>
        <Route index element={<Navigate to="payments" replace />} />
        <Route path="payments" element={<PaymentHistory />} />
        <Route path="analytics" element={<DashboardAnalyticsView />} />
        <Route path="artists" element={<ArtistManagement />} />
      </Routes>
    </DashboardLayout>
  );
}
