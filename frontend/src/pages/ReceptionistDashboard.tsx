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
 *   /dashboard/receptionist/today    → Today board: walk-ins, check-in (if granted bookings.view)
 *   /dashboard/receptionist/requests → Website requests (if granted bookings.view)
 *   /dashboard/receptionist/online-booking → Artists online, leave (bookings.view; edits need schedules.manage)
 *   /dashboard/receptionist/refunds  → Refunds (if granted bookings.refund)
 *   /dashboard/receptionist/cash-close → Close the Day: count the drawer (if granted cashclose.manage)
 *   /dashboard/receptionist/website  → Website hub: settings, menu, reels, offers (if granted website.manage)
 *
 * Receptionists can view payment records and navigate to New Visit Entry.
 * Additional sidebar links appear when the owner grants extra permissions.
 */

import { lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Receipt, CalendarPlus, BarChart3, Palette, Scissors, Users, Database, CalendarCheck, AlertTriangle, Globe, Banknote } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import PageBoundary from "@/components/PageBoundary";
import { useAuth } from "@/context/AuthContext";
const PaymentHistory = lazy(() => import("@/pages/dashboard/PaymentHistory"));
const DataPipeline = lazy(() => import("@/pages/dashboard/DataPipeline"));
const DashboardAnalyticsView = lazy(() => import("@/pages/dashboard/shared/DashboardAnalyticsView"));
const ArtistManagement = lazy(() => import("@/pages/dashboard/ArtistManagement"));
const ArtistDashboardView = lazy(() => import("@/pages/dashboard/ArtistDashboardView"));
const ServiceManagement = lazy(() => import("@/pages/dashboard/ServiceManagement"));
const TeamManagement = lazy(() => import("@/pages/dashboard/TeamManagement"));
const BookingRequests = lazy(() => import("@/pages/dashboard/BookingRequests"));
const TodayBoard = lazy(() => import("@/pages/dashboard/TodayBoard"));
const OnlineBooking = lazy(() => import("@/pages/dashboard/OnlineBooking"));
const Refunds = lazy(() => import("@/pages/dashboard/Refunds"));
const BookingsHub = lazy(() => import("@/pages/dashboard/hubs").then((m) => ({ default: m.BookingsHub })));
const NumberFixes = lazy(() => import("@/pages/dashboard/NumberFixes"));
const CashClose = lazy(() => import("@/pages/dashboard/CashClose"));
const WebsiteHub = lazy(() => import("@/pages/dashboard/hubs").then((m) => ({ default: m.WebsiteHub })));
import RequirePermission from "@/components/RequirePermission";

import type { SidebarLink } from "@/layouts/DashboardLayout";

const receptionistLinks: SidebarLink[] = [
  { to: "/dashboard/receptionist/bookings", label: "Bookings", icon: CalendarCheck, requiredPermission: ["bookings.view", "bookings.refund"] },
  { to: "/dashboard/receptionist/fix-numbers", label: "Fix Numbers", icon: AlertTriangle, requiredPermission: "datafixes.manage" },
  { to: "/dashboard/receptionist/website", label: "Website", icon: Globe, requiredPermission: "website.manage" },
  { to: "/dashboard/receptionist/payments", label: "Payment History", icon: Receipt, requiredPermission: "payments.view" },
  { to: "/dashboard/receptionist/cash-close", label: "Close the Day", icon: Banknote, requiredPermission: "cashclose.manage" },
  { to: "/dashboard/receptionist/data-pipeline", label: "Data Pipeline", icon: Database, requiredPermission: "datapipeline.view" },
  { to: "/dashboard/receptionist/analytics", label: "Analytics", icon: BarChart3, requiredPermission: "analytics.view" },
  { to: "/dashboard/receptionist/services", label: "Services", icon: Scissors, requiredPermission: ["services.view", "services.crud"] },
  { to: "/dashboard/receptionist/artists", label: "Artists", icon: Palette, requiredPermission: ["artists.view", "artists.crud"] },
  { to: "/dashboard/receptionist/team", label: "Team", icon: Users, requiredPermission: ["team.view", "team.manage"] },
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
    const rp = link.requiredPermission;
    if (!rp || isOwner) {
      const sub = link.to.replace("/dashboard/receptionist/", "");
      return <Navigate to={sub} replace />;
    }
    const has = Array.isArray(rp) ? rp.some((p) => perms.includes(p)) : perms.includes(rp);
    if (has) {
      const sub = link.to.replace("/dashboard/receptionist/", "");
      return <Navigate to={sub} replace />;
    }
  }
  // Fallback — shouldn't happen if at least one permission is granted
  return <Navigate to="/unauthorized" replace />;
}

const HOME = "/dashboard/receptionist";

/** Same URL-typing gap as the manager shell — see RequirePermission. */
/**
 * Each page below is its own chunk, fetched when its route opens. They used to
 * be imported eagerly, so every staff member downloaded the chart libraries
 * and the Excel writer before the first screen (the receptionist never opens
 * either).
 */
export default function ReceptionistDashboard() {
  return (
    <DashboardLayout sidebarLinks={receptionistLinks} pageTitle="Receptionist Dashboard">
      <PageBoundary>
      <Routes>
        <Route index element={<DefaultRedirect />} />
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
          path="analytics"
          element={
            <RequirePermission permission="analytics.view" backTo={HOME}>
              <DashboardAnalyticsView />
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
        <Route
          path="bookings"
          element={
            <RequirePermission permission={["bookings.view", "bookings.refund"]} backTo={HOME}>
              <BookingsHub />
            </RequirePermission>
          }
        />
        <Route
          path="fix-numbers"
          element={
            <RequirePermission permission="datafixes.manage" backTo={HOME}>
              <NumberFixes />
            </RequirePermission>
          }
        />
        <Route
          path="cash-close"
          element={
            <RequirePermission permission="cashclose.manage" backTo={HOME}>
              <CashClose />
            </RequirePermission>
          }
        />
        <Route
          path="website"
          element={
            <RequirePermission permission="website.manage" backTo={HOME}>
              <WebsiteHub />
            </RequirePermission>
          }
        />
        <Route
          path="today"
          element={
            <RequirePermission permission="bookings.view" backTo={HOME}>
              <TodayBoard />
            </RequirePermission>
          }
        />
        <Route
          path="online-booking"
          element={
            <RequirePermission permission="bookings.view" backTo={HOME}>
              <OnlineBooking />
            </RequirePermission>
          }
        />
        <Route
          path="refunds"
          element={
            <RequirePermission permission="bookings.refund" backTo={HOME}>
              <Refunds />
            </RequirePermission>
          }
        />
        <Route
          path="requests"
          element={
            <RequirePermission permission="bookings.view" backTo={HOME}>
              <BookingRequests />
            </RequirePermission>
          }
        />
      </Routes>
      </PageBoundary>
    </DashboardLayout>
  );
}
