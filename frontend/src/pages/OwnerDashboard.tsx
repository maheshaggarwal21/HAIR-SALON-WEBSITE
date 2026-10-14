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
 */

import { Routes, Route } from "react-router-dom";
import {
  LayoutDashboard,
  BarChart3,
  Scissors,
  Users,
  Palette,
  CalendarPlus,
  Receipt,
  Database,
  Network,
  Inbox,
  Globe,
  Store,
  Clapperboard,
  Megaphone,
} from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import Management from "@/pages/dashboard/Management";
import DashboardOverview from "@/pages/dashboard/shared/DashboardOverview";
import DashboardAnalyticsView from "@/pages/dashboard/shared/DashboardAnalyticsView";
import ServiceManagement from "@/pages/dashboard/ServiceManagement";
import TeamManagement from "@/pages/dashboard/TeamManagement";
import ArtistManagement from "@/pages/dashboard/ArtistManagement";
import ArtistDashboardView from "@/pages/dashboard/ArtistDashboardView";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";
import DataPipeline from "@/pages/dashboard/DataPipeline";
import BookingRequests from "@/pages/dashboard/BookingRequests";
import WebsiteSettings from "@/pages/dashboard/WebsiteSettings";
import WebsiteMenu from "@/pages/dashboard/WebsiteMenu";
import WebsiteReels from "@/pages/dashboard/WebsiteReels";
import WebsiteOffers from "@/pages/dashboard/WebsiteOffers";

const ownerLinks = [
  { to: "/dashboard/owner", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/owner/requests", label: "Website Requests", icon: Inbox },
  { to: "/dashboard/owner/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/dashboard/owner/payments", label: "Payments", icon: Receipt },
  { to: "/dashboard/owner/data-pipeline", label: "Data Pipeline", icon: Database },
  { to: "/dashboard/owner/services", label: "Services", icon: Scissors },
  { to: "/dashboard/owner/artists", label: "Artists", icon: Palette },
  { to: "/dashboard/owner/team", label: "Team", icon: Users },
  { to: "/dashboard/owner/management", label: "Management", icon: Network },
  { to: "/dashboard/owner/website", label: "Website Settings", icon: Globe },
  { to: "/dashboard/owner/website-menu", label: "Website Menu", icon: Store },
  { to: "/dashboard/owner/website-reels", label: "Website Reels", icon: Clapperboard },
  { to: "/dashboard/owner/website-offers", label: "Website Offers", icon: Megaphone },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus },
];

export default function OwnerDashboard() {
  return (
    <DashboardLayout sidebarLinks={ownerLinks} pageTitle="Owner Dashboard">
      <Routes>
        <Route index element={<DashboardOverview />} />
        <Route path="analytics" element={<DashboardAnalyticsView />} />
        <Route path="payments" element={<PaymentHistory />} />
        <Route path="data-pipeline" element={<DataPipeline />} />
        <Route path="services" element={<ServiceManagement />} />
        <Route path="artists" element={<ArtistManagement />} />
        <Route path="artist-view/:id" element={<ArtistDashboardView />} />
        <Route path="team" element={<TeamManagement />} />
        <Route path="management" element={<Management />} />
        <Route path="requests" element={<BookingRequests />} />
        <Route path="website" element={<WebsiteSettings />} />
        <Route path="website-menu" element={<WebsiteMenu />} />
        <Route path="website-reels" element={<WebsiteReels />} />
        <Route path="website-offers" element={<WebsiteOffers />} />
      </Routes>
    </DashboardLayout>
  );
}
