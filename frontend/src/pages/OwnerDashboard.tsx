/**
 * @file OwnerDashboard.tsx
 * @description Owner's dashboard with sidebar nav and sub-routes.
 *
 * Routes:
 *   /dashboard/owner           → Overview (stats + charts)
 *   /dashboard/owner/analytics → Full analytics view
 *   /dashboard/owner/services  → Service catalogue (full CRUD)
 *   /dashboard/owner/artists   → Artist directory (CRUD)
 *   /dashboard/owner/team      → Team management (CRUD users)
 *   /dashboard/owner/requests  → Website requests (T1.10)
 *   /dashboard/owner/website   → Website settings: contact, hours, media (T1.5)
 *   /dashboard/owner/website-menu  → Website menu: what each service shows (T1.18)
 *   /dashboard/owner/website-reels → Reels wall (T1.20)
 *   /dashboard/owner/website-offers → Offers: bar + pop-up (CF D29)
 *   /dashboard/owner/artist-skills → Who can be booked for which services (CF D35)
 *   /dashboard/owner/today          → Today board: timeline, walk-ins, desk actions (T2.14)
 *   /dashboard/owner/online-booking → Artists on/off online, hours, leave (T2.1, T2.22)
 *   /dashboard/owner/refunds        → Refunds owed to online customers (T2.17)
 *   /dashboard/owner/discounts      → Who gave how much discount (D60)
 *   /dashboard/owner/cash-close     → Close the day: count the drawer (D60)
 */

import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { LayoutDashboard, BarChart3, Scissors, Users, Palette, CalendarPlus, Receipt, Database, Network, Globe, UserCog, CalendarCheck, AlertTriangle, Percent, Banknote } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import PageBoundary from "@/components/PageBoundary";
const Management = lazy(() => import("@/pages/dashboard/Management"));
const DashboardOverview = lazy(() => import("@/pages/dashboard/shared/DashboardOverview"));
const DashboardAnalyticsView = lazy(() => import("@/pages/dashboard/shared/DashboardAnalyticsView"));
const ServiceManagement = lazy(() => import("@/pages/dashboard/ServiceManagement"));
const TeamManagement = lazy(() => import("@/pages/dashboard/TeamManagement"));
const ArtistManagement = lazy(() => import("@/pages/dashboard/ArtistManagement"));
const ArtistDashboardView = lazy(() => import("@/pages/dashboard/ArtistDashboardView"));
const PaymentHistory = lazy(() => import("@/pages/dashboard/PaymentHistory"));
const DataPipeline = lazy(() => import("@/pages/dashboard/DataPipeline"));
const BookingRequests = lazy(() => import("@/pages/dashboard/BookingRequests"));
const WebsiteMenu = lazy(() => import("@/pages/dashboard/WebsiteMenu"));
const WebsiteReels = lazy(() => import("@/pages/dashboard/WebsiteReels"));
const WebsiteOffers = lazy(() => import("@/pages/dashboard/WebsiteOffers"));
const ArtistSkills = lazy(() => import("@/pages/dashboard/ArtistSkills"));
const TodayBoard = lazy(() => import("@/pages/dashboard/TodayBoard"));
const OnlineBooking = lazy(() => import("@/pages/dashboard/OnlineBooking"));
const Refunds = lazy(() => import("@/pages/dashboard/Refunds"));
const WebsiteHub = lazy(() => import("@/pages/dashboard/hubs").then((m) => ({ default: m.WebsiteHub })));
const BookingsHub = lazy(() => import("@/pages/dashboard/hubs").then((m) => ({ default: m.BookingsHub })));
const NumberFixes = lazy(() => import("@/pages/dashboard/NumberFixes"));
const DiscountSummary = lazy(() => import("@/pages/dashboard/DiscountSummary"));
const CashClose = lazy(() => import("@/pages/dashboard/CashClose"));

const ownerLinks = [
  { to: "/dashboard/owner", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/owner/bookings", label: "Bookings", icon: CalendarCheck },
  { to: "/dashboard/owner/website", label: "Website", icon: Globe },
  { to: "/dashboard/owner/fix-numbers", label: "Fix Numbers", icon: AlertTriangle },
  { to: "/dashboard/owner/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/dashboard/owner/payments", label: "Payments", icon: Receipt },
  { to: "/dashboard/owner/cash-close", label: "Close the Day", icon: Banknote },
  { to: "/dashboard/owner/discounts", label: "Discounts", icon: Percent },
  { to: "/dashboard/owner/data-pipeline", label: "Data Pipeline", icon: Database },
  { to: "/dashboard/owner/services", label: "Services", icon: Scissors },
  { to: "/dashboard/owner/artists", label: "Artists", icon: Palette },
  { to: "/dashboard/owner/artist-skills", label: "Artist Skills", icon: UserCog },
  { to: "/dashboard/owner/team", label: "Team", icon: Users },
  { to: "/dashboard/owner/management", label: "Management", icon: Network },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus },
];

/**
 * Each page below is its own chunk, fetched when its route opens. They used to
 * be imported eagerly, so every staff member downloaded the chart libraries
 * and the Excel writer before the first screen (the receptionist never opens
 * either).
 */
export default function OwnerDashboard() {
  return (
    <DashboardLayout sidebarLinks={ownerLinks} pageTitle="Owner Dashboard">
      <PageBoundary>
      <Routes>
        <Route index element={<DashboardOverview />} />
        <Route path="analytics" element={<DashboardAnalyticsView />} />
        <Route path="payments" element={<PaymentHistory />} />
        <Route path="data-pipeline" element={<DataPipeline />} />
        <Route path="services" element={<ServiceManagement />} />
        <Route path="artists" element={<ArtistManagement />} />
        <Route path="artist-skills" element={<ArtistSkills />} />
        <Route path="artist-view/:id" element={<ArtistDashboardView />} />
        <Route path="team" element={<TeamManagement />} />
        <Route path="management" element={<Management />} />
        <Route path="requests" element={<BookingRequests />} />
        <Route path="today" element={<TodayBoard />} />
        <Route path="online-booking" element={<OnlineBooking />} />
        <Route path="refunds" element={<Refunds />} />
        <Route path="website" element={<WebsiteHub />} />
        <Route path="bookings" element={<BookingsHub />} />
        <Route path="fix-numbers" element={<NumberFixes />} />
        <Route path="discounts" element={<DiscountSummary />} />
        <Route path="cash-close" element={<CashClose />} />
        <Route path="website-menu" element={<WebsiteMenu />} />
        <Route path="website-reels" element={<WebsiteReels />} />
        <Route path="website-offers" element={<WebsiteOffers />} />
      </Routes>
      </PageBoundary>
    </DashboardLayout>
  );
}
