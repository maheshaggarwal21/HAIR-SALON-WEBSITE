/**
 * @file main.tsx
 * @description Application entry point with role-based routing.
 *
 * Public routes:
 *   /                — Landing page
 *   /signin          — Sign-in page
 *   /payment-status  — Payment confirmation
 *   /unauthorized    — 403 page
 *   /about           — About Us
 *   /contact         — Contact Us
 *
 * Protected routes:
 *   /visit-entry           — Receptionist + Manager + Owner
 *   /dashboard/manager/*   — Manager + Owner
 *   /dashboard/owner/*     — Owner only
 */

import { StrictMode, useEffect, lazy, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import './index.css'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import ProtectedRoute from '@/components/ProtectedRoute'

/**
 * ── Route-level code splitting ───────────────────────────────────────────────
 *
 * Everything used to live in one 1.99 MB bundle, so a customer opening the
 * public landing page downloaded every dashboard, chart library and the Excel
 * writer before anything rendered. Each lazy() below becomes its own chunk that
 * is fetched only when that route is actually visited.
 *
 * Eagerly imported (deliberately): LandingPage and SignInPage are the first
 * thing every visitor and every staff member hits, so splitting them would only
 * add a round trip. They stay in the entry chunk.
 */
import LandingPage from './pages/LandingPage'
import SignInPage from './pages/SignInPage'

// Staff-only surfaces — never needed by a member of the public.
const OwnerDashboard        = lazy(() => import('./pages/OwnerDashboard'))
const ManagerDashboard      = lazy(() => import('./pages/ManagerDashboard'))
const ReceptionistDashboard = lazy(() => import('./pages/ReceptionistDashboard'))
const ArtistDashboardLayout = lazy(() => import('./pages/ArtistDashboardLayout'))
const VisitEntryPage        = lazy(() => import('./pages/VisitEntryPage'))
const VisitAssignmentPage   = lazy(() => import('./pages/VisitAssignmentPage'))
const ChangePasswordPage    = lazy(() => import('./pages/ChangePasswordPage'))

// Rarely-visited public pages.
const PaymentStatus       = lazy(() => import('./pages/PaymentStatus'))
const UnauthorizedPage    = lazy(() => import('./pages/UnauthorizedPage'))
const AboutPage           = lazy(() => import('./pages/AboutPage'))
const ContactPage         = lazy(() => import('./pages/ContactPage'))
const PrivacyPolicyPage   = lazy(() => import('./pages/PrivacyPolicyPage'))
const TermsOfServicePage  = lazy(() => import('./pages/TermsOfServicePage'))

/** Shown while a route chunk downloads. Matches ProtectedRoute's spinner. */
function RouteFallback() {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: '#faf8f4' }}
    >
      <div className="w-10 h-10 rounded-full border-4 border-stone-200 border-t-amber-500 animate-spin" />
    </div>
  )
}

function AssignmentLockGuard({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()

  // Mongo ObjectId shape check for local lock value safety.
  const objectIdPattern = /^[a-f\d]{24}$/i
  const pendingVisitId = localStorage.getItem('pendingAssignmentVisitId')
  const isValidPendingVisitId = !!pendingVisitId && objectIdPattern.test(pendingVisitId)
  const expectedPath = isValidPendingVisitId ? `/visit-assignment/${pendingVisitId}` : null
  const isSignInRoute = location.pathname === '/signin'

  useEffect(() => {
    // Hardening: clear malformed stale lock IDs so users are not forced into
    // impossible assignment URLs from corrupted local storage values.
    if (pendingVisitId && !isValidPendingVisitId) {
      localStorage.removeItem('pendingAssignmentVisitId')
    }
  }, [isValidPendingVisitId, pendingVisitId])

  useEffect(() => {
    // Hardening: allow sign-in route to avoid redirect loops when a stale lock
    // exists but the session has expired and auth middleware redirects to /signin.
    if (!isSignInRoute && expectedPath && location.pathname !== expectedPath) {
      navigate(expectedPath, { replace: true })
    }
  }, [expectedPath, isSignInRoute, location.pathname, navigate])

  return <>{children}</>
}

/**
 * Holds a user on /change-password until they replace a temporary password.
 *
 * The owner can issue a temp password from Management → People; without this
 * guard that shared, spoken-aloud credential would quietly become the account's
 * permanent password. Sits inside the router so it can read the location, and
 * outside the route table so it covers every protected page at once.
 */
function PasswordChangeGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const mustChange = !loading && Boolean(user?.mustChangePassword)
  const onChangePage = location.pathname === '/change-password'

  useEffect(() => {
    if (mustChange && !onChangePage) {
      navigate('/change-password', { replace: true })
    }
  }, [mustChange, onChangePage, navigate])

  return <>{children}</>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PasswordChangeGuard>
        <AssignmentLockGuard>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* ── Public ── */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/payment-status" element={<PaymentStatus />} />
            <Route path="/unauthorized" element={<UnauthorizedPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
            <Route path="/terms-of-service" element={<TermsOfServicePage />} />

            {/* ── Forced / voluntary password change — any signed-in role ── */}
            <Route
              path="/change-password"
              element={
                <ProtectedRoute allowedRoles={["receptionist", "manager", "owner", "artist"]}>
                  <ChangePasswordPage />
                </ProtectedRoute>
              }
            />

            {/* ── Visit Entry: receptionist + manager + owner ── */}
            <Route
              path="/visit-entry"
              element={
                <ProtectedRoute allowedRoles={["receptionist", "manager", "owner", "artist"]} requiredPermission="visit.create">
                  <VisitEntryPage />
                </ProtectedRoute>
              }
            />

            {/* ── Visit Assignment Lock Step ── */}
            <Route
              path="/visit-assignment/:visitId"
              element={
                <ProtectedRoute allowedRoles={["receptionist", "manager", "owner", "artist"]} requiredPermission="visit.create">
                  <VisitAssignmentPage />
                </ProtectedRoute>
              }
            />

            {/* ── Receptionist dashboard ── */}
            <Route
              path="/dashboard/receptionist/*"
              element={
                <ProtectedRoute allowedRoles={["receptionist", "manager", "owner"]}>
                  <ReceptionistDashboard />
                </ProtectedRoute>
              }
            />

            {/* ── Manager dashboard + sub-routes ── */}
            <Route
              path="/dashboard/manager/*"
              element={
                <ProtectedRoute allowedRoles={["manager", "owner"]}>
                  <ManagerDashboard />
                </ProtectedRoute>
              }
            />

            {/* ── Owner dashboard + sub-routes ── */}
            <Route
              path="/dashboard/owner/*"
              element={
                <ProtectedRoute allowedRoles={["owner"]}>
                  <OwnerDashboard />
                </ProtectedRoute>
              }
            />

            {/* ── Artist dashboard ── */}
            <Route
              path="/dashboard/artist/*"
              element={
                <ProtectedRoute allowedRoles={["artist"]}>
                  <ArtistDashboardLayout />
                </ProtectedRoute>
              }
            />

            {/* ── Catch-all ── */}
            <Route path="*" element={<Navigate to="/signin" replace />} />
          </Routes>
          </Suspense>
        </AssignmentLockGuard>
        </PasswordChangeGuard>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
