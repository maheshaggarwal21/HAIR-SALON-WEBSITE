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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
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
import ArtistDashboard from './pages/ArtistDashboard'
import ReceptionistDashboard from './pages/ReceptionistDashboard'
import AboutPage from './pages/AboutPage'
import ContactPage from './pages/ContactPage'
import PrivacyPolicyPage from './pages/PrivacyPolicyPage'
import TermsOfServicePage from './pages/TermsOfServicePage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
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
              <ProtectedRoute allowedRoles={["receptionist", "manager", "owner"]}>
                <VisitEntryPage />
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
            path="/dashboard/artist"
            element={
              <ProtectedRoute allowedRoles={["artist"]}>
                <ArtistDashboard />
              </ProtectedRoute>
            }
          />

          {/* ── Catch-all ── */}
          <Route path="*" element={<Navigate to="/signin" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
