import path from "node:path";
import type { NextConfig } from "next";

/**
 * Where the salon API lives (CONTROL_FLOW_AND_DATA_LOGIC.md §1.1, §22).
 * Production: https://api.thexpertshair.com. Local: the backend dev server.
 */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // This app is one folder of a three-app repo (Vercel Root Directory =
    // customer/). Pin the root so Turbopack never adopts a lockfile above it.
    root: path.join(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  /**
   * The booking sheet calls /api/public/* on THIS origin and Next forwards it
   * to the API. Same-origin from the browser's point of view, so no CORS
   * preflight on every slot lookup and nothing for Instagram's in-app browser
   * to block. Only the public surface is forwarded — staff routes stay
   * unreachable from the customer domain (CLAUDE.md, "Do not").
   */
  async rewrites() {
    return [{ source: "/api/public/:path*", destination: `${API_BASE}/api/public/:path*` }];
  },
  /**
   * The salon's own photos and videos (public/images, public/media) change
   * rarely, but Vercel serves them with max-age=0, so every visit re-checks
   * every file and the hero video starts late. A week in the browser plus a
   * month of serve-stale-while-refreshing makes repeat visits instant. A file
   * replaced under the SAME name can take up to a week to show for people who
   * visited before; a new name shows at once (D58).
   */
  async headers() {
    const cache = [{ key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=2592000" }];
    return [
      { source: "/images/:path*", headers: cache },
      { source: "/media/:path*", headers: cache },
    ];
  },
  /**
   * Domain switch (T1.23). Once this site serves thexpertshair.com, the staff
   * app moves to app.thexpertshair.com; old bookmarks and Razorpay callbacks to
   * staff URLs are forwarded there. Off until STAFF_APP_URL is set, so nothing
   * changes before the switch. Temporary (307) for the first weeks, so a
   * rollback (CP2: point the apex back at the staff app) isn't fighting cached
   * permanent redirects in browsers.
   */
  async redirects() {
    const staff = (process.env.STAFF_APP_URL || "").replace(/\/+$/, "");
    const legacyPublic = [
      { source: "/privacy-policy", destination: "/privacy", permanent: true },
      { source: "/terms-of-service", destination: "/terms", permanent: true },
      { source: "/about", destination: "/", permanent: true },
      { source: "/contact", destination: "/#visit", permanent: true },
    ];
    if (!staff) return legacyPublic;
    const staffPaths = [
      "/signin",
      "/change-password",
      "/unauthorized",
      "/payment-status",
      "/visit-entry",
      "/visit-assignment/:path*",
      "/dashboard",
      "/dashboard/:path*",
    ];
    return [...legacyPublic, ...staffPaths.map((source) => ({ source, destination: `${staff}${source}`, permanent: false }))];
  },
};

export default nextConfig;
