/**
 * @file ReceptionistDashboard.tsx
 * @description Receptionist's dashboard with sidebar nav.
 *
 * Routes:
 *   /dashboard/receptionist          → Payment History (default)
 *   /dashboard/receptionist/payments → Payment History
 *
 * Receptionists can view payment records and navigate to New Visit Entry.
 */

import { Routes, Route, Navigate } from "react-router-dom";
import { Receipt, CalendarPlus } from "lucide-react";
import DashboardLayout from "@/layouts/DashboardLayout";
import PaymentHistory from "@/pages/dashboard/PaymentHistory";

const receptionistLinks = [
  { to: "/dashboard/receptionist/payments", label: "Payment History", icon: Receipt },
  { to: "/visit-entry", label: "New Visit Entry", icon: CalendarPlus },
];

export default function ReceptionistDashboard() {
  return (
    <DashboardLayout sidebarLinks={receptionistLinks} pageTitle="Receptionist Dashboard">
      <Routes>
        <Route index element={<Navigate to="payments" replace />} />
        <Route path="payments" element={<PaymentHistory />} />
      </Routes>
    </DashboardLayout>
  );
}
