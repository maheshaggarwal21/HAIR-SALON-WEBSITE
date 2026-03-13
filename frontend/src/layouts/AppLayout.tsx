/**
 * @file AppLayout.tsx
 * @description Shared layout shell for public and visit-entry pages.
 *
 * Auth-aware navbar with mobile hamburger menu:
 *   Guest:     logo left · [Home · About Us · Contact] centered · Sign In right
 *   Logged in: logo left · [Home · About Us · Contact · Dashboard] centered · avatar+role dropdown right
 */

import { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Scissors, Menu, X, ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useAuth } from "@/context/AuthContext";

interface AppLayoutProps {
  children: React.ReactNode;
  subtitle?: string;
}

/** Return the dashboard path for the given role. */
function dashboardPath(role: string) {
  if (role === "owner") return "/dashboard/owner";
  if (role === "manager") return "/dashboard/manager";
  if (role === "receptionist") return "/dashboard/receptionist";
  if (role === "artist") return "/dashboard/artist";
  return "/";
}

/** Capitalise first letter */
function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function AppLayout({ children }: AppLayoutProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  /* Close profile dropdown on outside click */
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSignOut = async () => {
    setMobileOpen(false);
    setProfileOpen(false);
    await logout();
    navigate("/signin");
  };

  /* Build nav links dynamically */
  const navLinks: { to: string; label: string }[] = [
    { to: "/", label: "Home" },
    { to: "/about", label: "About Us" },
    { to: "/contact", label: "Contact" },
  ];
  if (user && ["manager", "owner", "receptionist", "artist"].includes(user.role)) {
    navLinks.push({ to: dashboardPath(user.role), label: "Dashboard" });
  }

  const isActive = (to: string) =>
    pathname === to || (to.startsWith("/dashboard") && pathname.startsWith("/dashboard"));

  return (
    <div className="min-h-screen w-full" style={{ backgroundColor: "#faf8f4" }}>
      {/* ── Sticky navbar ── */}
      <header
        className="fixed top-0 left-0 right-0 z-50 w-full"
        style={{
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-8 h-16 flex items-center">

          {/* ── Left: logo (fixed width so center stays truly centered) ── */}
          <Link to="/" className="shrink-0 flex items-center gap-3 group w-40 lg:w-48">
            <div className="h-10 w-10 rounded-xl bg-amber-50 shadow-sm ring-1 ring-black/8 group-hover:ring-amber-300/60 transition-all duration-200 flex items-center justify-center">
              <Scissors className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-lg font-extrabold text-stone-800 tracking-tight hidden sm:block">
              The Experts
            </span>
          </Link>

          {/* ── Center: nav links (desktop) — bigger, bolder, truly centered ── */}
          <nav className="hidden md:flex flex-1 justify-center items-center gap-2">
            {navLinks.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`
                  px-5 py-2 rounded-lg text-[15px] font-semibold tracking-wide
                  transition-colors duration-150
                  ${isActive(to)
                    ? "text-stone-900 bg-stone-100/80"
                    : "text-stone-500 hover:text-stone-900 hover:bg-stone-100/50"
                  }
                `}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* ── Right: role + avatar dropdown (desktop) — fixed width to balance logo ── */}
          <div className="hidden md:flex shrink-0 items-center justify-end w-40 lg:w-48">
            {user ? (
              <div ref={profileRef} className="relative">
                {/* Clickable trigger: avatar + name + role badge + chevron */}
                <button
                  onClick={() => setProfileOpen((v) => !v)}
                  className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl hover:bg-stone-100/70 transition-colors duration-150"
                >
                  <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 text-sm font-bold flex items-center justify-center uppercase ring-2 ring-amber-200/50">
                    {user.name?.charAt(0) ?? "?"}
                  </div>
                  <div className="hidden lg:flex flex-col items-start leading-tight">
                    <span className="text-sm font-semibold text-stone-800 truncate max-w-25">
                      {user.name}
                    </span>
                    <span className="text-[11px] font-medium text-amber-600 uppercase tracking-wider">
                      {capitalise(user.role)}
                    </span>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-stone-400 transition-transform duration-200 ${profileOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {/* Dropdown */}
                <AnimatePresence>
                  {profileOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -6, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 top-full mt-2 w-52 rounded-xl bg-white border border-stone-200/80 shadow-lg shadow-stone-200/40 py-2 z-50"
                    >
                      {/* User info */}
                      <div className="px-4 py-2 border-b border-stone-100">
                        <p className="text-sm font-semibold text-stone-800 truncate">{user.name}</p>
                        <p className="text-xs text-stone-400 truncate">{user.email}</p>
                        <span className="mt-1 inline-block text-[10px] font-bold uppercase tracking-widest text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                          {capitalise(user.role)}
                        </span>
                      </div>
                      {/* Sign Out */}
                      <button
                        onClick={handleSignOut}
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-red-600 hover:bg-red-50/60 transition-colors duration-150"
                      >
                        <LogOut className="w-4 h-4" />
                        Sign Out
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <Link
                to="/signin"
                className="px-5 py-2 rounded-lg bg-stone-900 text-white text-sm font-semibold tracking-wide hover:bg-stone-800 transition-colors duration-150"
              >
                Sign In
              </Link>
            )}
          </div>

          {/* ── Hamburger button (mobile only) ── */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="md:hidden ml-auto flex items-center justify-center w-10 h-10 rounded-lg text-stone-600 hover:bg-stone-100 transition-colors"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* ── Mobile slide-down menu ── */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="md:hidden overflow-hidden border-t border-stone-100"
              style={{ background: "rgba(255,255,255,0.97)" }}
            >
              <nav className="flex flex-col px-6 py-4 gap-1">
                {navLinks.map(({ to, label }) => (
                  <Link
                    key={to}
                    to={to}
                    onClick={() => setMobileOpen(false)}
                    className={`px-4 py-2.5 rounded-lg text-base font-semibold transition-colors ${
                      isActive(to)
                        ? "text-stone-900 bg-stone-100"
                        : "text-stone-600 hover:bg-stone-50"
                    }`}
                  >
                    {label}
                  </Link>
                ))}

                {user ? (
                  <div className="mt-3 pt-3 border-t border-stone-100">
                    <div className="flex items-center gap-3 px-4 mb-3">
                      <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 text-sm font-bold flex items-center justify-center uppercase">
                        {user.name?.charAt(0) ?? "?"}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-stone-800">{user.name}</p>
                        <p className="text-xs text-amber-600 font-medium">{capitalise(user.role)}</p>
                      </div>
                    </div>
                    <button
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                ) : (
                  <Link
                    to="/signin"
                    onClick={() => setMobileOpen(false)}
                    className="mt-2 mx-4 text-center px-4 py-2.5 rounded-lg bg-stone-900 text-white text-sm font-semibold"
                  >
                    Sign In
                  </Link>
                )}
              </nav>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Spacer so content doesn't hide behind fixed navbar */}
      <div className="h-16" />

      <main className="w-full">{children}</main>
    </div>
  );
}

