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
 *   /dashboard/manager/requests  → Website requests (bookings.view)
 *   /dashboard/manager/website   → Website settings (website.manage)
 *   /dashboard/manager/website-offers → Offers: bar + pop-up (website.manage, CF D29)
 *   /dashboard/manager/artist-skills → Artist skills (artists.view to see, artists.crud to change; CF D35)
 */

import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { LayoutDashboard, BarChart3, Scissors, Palette, CalendarPlus, Receipt, Users, Database, Inbox, Globe, Store, Clapperboard, Megaphone, UserCog } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
const DashboardOverview = lazy(() => import("@/pages/dashboard/shared/DashboardOverview"));
const DashboardAnalyticsView = lazy(() => import("@/pages/dashboard/shared/DashboardAnalyticsView"));
const ServiceManagement = lazy(() => import("@/pages/dashboard/ServiceManagement"));
const ArtistManagement = lazy(() => import("@/pages/dashboard/ArtistManagement"));
const ArtistDashboardView = lazy(() => import("@/pages/dashboard/ArtistDashboardView"));
const PaymentHistory = lazy(() => import("@/pages/dashboard/PaymentHistory"));
const DataPipeline = lazy(() => import("@/pages/dashboard/DataPipeline"));
const TeamManagement = lazy(() => import("@/pages/dashboard/TeamManagement"));
const BookingRequests = lazy(() => import("@/pages/dashboard/BookingRequests"));
const WebsiteSettings = lazy(() => import("@/pages/dashboard/WebsiteSettings"));
const WebsiteMenu = lazy(() => import("@/pages/dashboard/WebsiteMenu"));
const WebsiteReels = lazy(() => import("@/pages/dashboard/WebsiteReels"));
const WebsiteOffers = lazy(() => import("@/pages/dashboard/WebsiteOffers"));
const ArtistSkills = lazy(() => import("@/pages/dashboard/ArtistSkills"));
import RequirePermission from "@/components/RequirePermission";

import type { SidebarLink } from "@/layouts/DashboardLayout";

const managerLinks: SidebarLink[] = [
  { to: "/dashboard/manager", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/manager/requests", label: "Website Requests", icon: Inbox, requiredPermission: "bookings.view" },
  { to: "/dashboard/manager/analytics", label: "Analytics", icon: BarChart3, requiredPermission: "analytics.view" },
  { to: "/dashboard/manager/payments", label: "Payments", icon: Receipt, requiredPermission: "payments.view" },
  { to: "/dashboard/manager/data-pipeline", label: "Data Pipeline", icon: Database, requiredPermission: "datapipeline.view" },
  { to: "/dashboard/manager/services", label: "Services", icon: Scissors, requiredPermission: ["services.view", "services.crud"] },
  { to: "/dashboard/manager/artists", label: "Artists", icon: Palette, requiredPermission: ["artists.view", "artists.crud"] },
  { to: "/dashboard/manager/artist-skills", label: "Artist Skills", icon: UserCog, requiredPermission: "artists.view" },
  { to: "/dashboard/manager/team", label: "Team", icon: Users, requiredPermission: ["team.view", "team.manage"] },
  { to: "/dashboard/manager/website", label: "Website Settings", icon: Globe, requiredPermission: "website.manage" },
  { to: "/dashboard/manager/website-menu", label: "Website Menu", icon: Store, requiredPermission: "website.manage" },
  { to: "/dashboard/manager/website-reels", label: "Website Reels", icon: Clapperboard, requiredPermission: "website.manage" },
  { to: "/dashboard/manager/website-offers", label: "Website Offers", icon: Megaphone, requiredPermission: "website.manage" },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus, requiredPermission: "visit.create" },
];

const HOME = "/dashboard/manager";

/**
 * Sub-routes are permission-gated, not just hidden from the sidebar. Without
 * this, revoking `analytics.view` removed the nav link but typing the URL still
 * mounted the page — the API refused the data, so the user saw an empty screen
 * rather than an explanation.
 */
/**
 * Each page below is its own chunk, fetched when its route opens. They used to
 * be imported eagerly, so every staff member downloaded the chart libraries
 * and the Excel writer before the first screen (the receptionist never opens
 * either).
 */
function PageFallback() {
  return <div className="py-16 text-center text-sm text-stone-400">Loading…</div>;
}

export default function ManagerDashboard() {
  return (
    <DashboardLayout sidebarLinks={managerLinks} pageTitle="Manager Dashboard">
      <Suspense fallback={<PageFallback />}>
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
        <Route
          path="requests"
          element={
            <RequirePermission permission="bookings.view" backTo={HOME}>
              <BookingRequests />
            </RequirePermission>
          }
        />
        <Route
          path="website"
          element={
            <RequirePermission permission="website.manage" backTo={HOME}>
              <WebsiteSettings />
            </RequirePermission>
          }
        />
        <Route
          path="website-menu"
          element={
            <RequirePermission permission="website.manage" backTo={HOME}>
              <WebsiteMenu />
            </RequirePermission>
          }
        />
        <Route
          path="website-reels"
          element={
            <RequirePermission permission="website.manage" backTo={HOME}>
              <WebsiteReels />
            </RequirePermission>
          }
        />
        <Route
          path="artist-skills"
          element={
            <RequirePermission permission="artists.view" backTo={HOME}>
              <ArtistSkills />
            </RequirePermission>
          }
        />
        <Route
          path="website-offers"
          element={
            <RequirePermission permission="website.manage" backTo={HOME}>
              <WebsiteOffers />
            </RequirePermission>
          }
        />
      </Routes>
      </Suspense>
    </DashboardLayout>
  );
}
