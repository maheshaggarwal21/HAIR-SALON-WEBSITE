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

import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import './index.css'
import { AuthProvider } from '@/context/AuthContext'
import ProtectedRoute from '@/components/ProtectedRoute'
import LandingPage from './pages/LandingPage'
import SignInPage from './pages/SignInPage'
import PaymentStatus from './pages/PaymentStatus'
import UnauthorizedPage from './pages/UnauthorizedPage'
import VisitEntryPage from './pages/VisitEntryPage'
import ManagerDashboard from './pages/ManagerDashboard'
import OwnerDashboard from './pages/OwnerDashboard'
import ArtistDashboardLayout from './pages/ArtistDashboardLayout'
import ReceptionistDashboard from './pages/ReceptionistDashboard'
import AboutPage from './pages/AboutPage'
import ContactPage from './pages/ContactPage'
import PrivacyPolicyPage from './pages/PrivacyPolicyPage'
import TermsOfServicePage from './pages/TermsOfServicePage'
import VisitAssignmentPage from './pages/VisitAssignmentPage'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AssignmentLockGuard>
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
        </AssignmentLockGuard>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
