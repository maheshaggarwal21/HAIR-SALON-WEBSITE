/**
 * @file DashboardLayout.tsx
 * @description Full-page layout with collapsible sidebar + scrollable main area.
 *
 * Used by ManagerDashboard and OwnerDashboard — NOT by public pages.
 * Sidebar links and page title are passed as props so both roles share
 * the same layout shell with different navigation.
 *
 * On mobile (< lg), sidebar is hidden behind a hamburger toggle with
 * an overlay backdrop.
 */

import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { LogOut, Scissors, Menu, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

// ── Types ────────────────────────────────────────────────────────────────────
export interface SidebarLink {
  to: string;
  label: string;
  icon: React.ElementType;
  requiredPermission?: string; // PBAC — if present, link is hidden when user lacks permission
}

interface DashboardLayoutProps {
  children: React.ReactNode;
  sidebarLinks: SidebarLink[];
  pageTitle: string;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function DashboardLayout({
  children,
  sidebarLinks,
  pageTitle,
}: DashboardLayoutProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Filter sidebar links based on PBAC permissions.
  // Links without requiredPermission are always visible.
  // Owner sees all links regardless of permission.
  const visibleLinks = sidebarLinks.filter((link) => {
    if (!link.requiredPermission) return true;
    if (user?.role === "owner") return true;
    return user?.permissions.includes(link.requiredPermission) ?? false;
  });

  const handleSignOut = async () => {
    setSidebarOpen(false);
    await logout();
    navigate("/signin");
  };

  /** Shared sidebar content rendered in both desktop and mobile contexts. */
  const sidebarContent = (
    <>
      {/* Branding */}
      <div className="h-16 flex items-center gap-3 px-5 border-b border-stone-800 shrink-0">
        <div className="h-9 w-9 rounded-lg bg-amber-600 flex items-center justify-center">
          <Scissors className="w-4.5 h-4.5 text-white" />
        </div>
        <span className="text-white font-bold text-base tracking-tight">
          The Experts
        </span>
      </div>

      {/* Navigation */}
      <div className="flex-1 py-4 overflow-y-auto">
        <nav className="px-3 space-y-1">
          {visibleLinks.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to.split("/").length <= 3}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                isActive
                  ? "flex items-center gap-3 px-4 py-2.5 rounded-xl text-white bg-amber-600 font-medium text-sm"
                  : "flex items-center gap-3 px-4 py-2.5 rounded-xl text-stone-400 hover:text-white hover:bg-stone-800 font-medium text-sm transition-all duration-150"
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      {/* Sign-out */}
      <div className="shrink-0 p-3 border-t border-stone-800">
        <button
          onClick={handleSignOut}
          className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-stone-400 hover:text-red-400 hover:bg-stone-800 font-medium text-sm transition-all duration-150 w-full"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign Out
        </button>
      </div>
    </>
  );

  return (
    <div style={{ backgroundColor: "#faf8f4" }} className="flex min-h-screen">
      {/* ── Desktop sidebar (lg+) ── */}
      <motion.aside
        initial={{ x: -20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="hidden lg:flex w-64 fixed left-0 top-0 h-full bg-stone-900 flex-col z-40"
      >
        {sidebarContent}
      </motion.aside>

      {/* ── Mobile sidebar overlay ── */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-40 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
            {/* Sidebar drawer */}
            <motion.aside
              initial={{ x: -264 }}
              animate={{ x: 0 }}
              exit={{ x: -264 }}
              transition={{ type: "tween", duration: 0.25 }}
              className="fixed left-0 top-0 h-full w-64 bg-stone-900 flex flex-col z-50 lg:hidden"
            >
              {/* Close button */}
              <button
                onClick={() => setSidebarOpen(false)}
                className="absolute top-4 right-3 w-8 h-8 flex items-center justify-center text-stone-400 hover:text-white rounded-lg hover:bg-stone-800 transition-colors"
                aria-label="Close sidebar"
              >
                <X className="w-4 h-4" />
              </button>
              {sidebarContent}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col lg:ml-64">
        {/* Top bar */}
        <header
          className="h-16 sticky top-0 z-30 flex items-center justify-between px-4 sm:px-8"
          style={{
            background: "rgba(255,255,255,0.90)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            borderBottom: "1px solid rgba(0,0,0,0.07)",
          }}
        >
          <div className="flex items-center gap-3">
            {/* Mobile hamburger */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden flex items-center justify-center w-9 h-9 rounded-lg text-stone-600 hover:bg-stone-100 transition-colors"
              aria-label="Open sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-lg sm:text-xl font-bold text-stone-900">{pageTitle}</h1>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-amber-100 text-amber-700 text-xs font-bold flex items-center justify-center uppercase">
              {user?.name?.charAt(0) ?? "?"}
            </div>
            <span className="text-sm font-medium text-stone-700 hidden sm:block">
              {user?.name}
            </span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 sm:p-8">{children}</main>
      </div>
    </div>
  );
}
