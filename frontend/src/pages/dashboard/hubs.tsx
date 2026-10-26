/**
 * @file hubs.tsx
 * @description The two grouped sidebar entries: Website and Bookings.
 *
 * Eighteen sidebar links no longer fit a laptop screen, so the first ones
 * (Overview, Today, Requests…) scrolled out of sight. Related screens now live
 * behind one entry each, like Management.
 */

import { lazy } from "react";
import { CalendarClock, CalendarDays, Clapperboard, Globe, Inbox, Megaphone, RotateCcw, Store, CalendarCheck, UserPlus } from "lucide-react";
import HubPage from "@/components/HubPage";

const WebsiteSettings = lazy(() => import("@/pages/dashboard/WebsiteSettings"));
const WebsiteMenu = lazy(() => import("@/pages/dashboard/WebsiteMenu"));
const WebsiteReels = lazy(() => import("@/pages/dashboard/WebsiteReels"));
const WebsiteOffers = lazy(() => import("@/pages/dashboard/WebsiteOffers"));
const TodayBoard = lazy(() => import("@/pages/dashboard/TodayBoard"));
const BookingRequests = lazy(() => import("@/pages/dashboard/BookingRequests"));
const OnlineBooking = lazy(() => import("@/pages/dashboard/OnlineBooking"));
const Refunds = lazy(() => import("@/pages/dashboard/Refunds"));
const Leads = lazy(() => import("@/pages/dashboard/Leads"));

export function WebsiteHub() {
  return (
    <HubPage
      title="Website"
      icon={Globe}
      intro="Everything the customer site shows: contact details, the menu, videos and offers."
      tabs={[
        { id: "settings", label: "Settings", blurb: "Phone, address, opening hours, closed days, artists on the site.", icon: Globe, permission: "website.manage", Component: WebsiteSettings },
        { id: "menu", label: "Menu", blurb: "Which services appear on the website, with their public names and photos.", icon: Store, permission: "website.manage", Component: WebsiteMenu },
        { id: "reels", label: "Reels", blurb: "The hero slides and reels shown on the home page.", icon: Clapperboard, permission: "website.manage", Component: WebsiteReels },
        { id: "offers", label: "Offers", blurb: "Offer bars and pop-ups with their start and end dates.", icon: Megaphone, permission: "website.manage", Component: WebsiteOffers },
      ]}
    />
  );
}

export function BookingsHub() {
  return (
    <HubPage
      title="Bookings"
      icon={CalendarCheck}
      intro="Today's chairs, requests and leads from the website, who can be booked online, and refunds owed."
      tabs={[
        { id: "today", label: "Today", blurb: "Timeline per artist: walk-ins, check-in, move, no-show.", icon: CalendarDays, permission: "bookings.view", Component: TodayBoard },
        { id: "requests", label: "Website requests", blurb: "People who asked for a slot on the website.", icon: Inbox, permission: "bookings.view", Component: BookingRequests },
        { id: "leads", label: "Leads", blurb: "People who left their name and number without choosing a package: call them back.", icon: UserPlus, permission: "bookings.view", Component: Leads },
        { id: "online", label: "Online booking", blurb: "Which artists the website may book, their hours and leave.", icon: CalendarClock, permission: "bookings.view", Component: OnlineBooking },
        { id: "refunds", label: "Refunds", blurb: "Money owed back to online customers.", icon: RotateCcw, permission: "bookings.refund", Component: Refunds },
      ]}
    />
  );
}
