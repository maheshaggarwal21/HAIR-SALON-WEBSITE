/**
 * @file DashboardAnalyticsView.tsx
 * @description Full analytics view shared by Manager and Owner dashboards.
 *
 * Reuses all existing analytics components — rendered inside
 * DashboardLayout (no AppLayout wrapper).
 */

import { useState, useCallback } from "react";
import dayjs from "dayjs";
import DateFilter from "@/components/analytics/DateFilter";
import SummaryCards from "@/components/analytics/SummaryCards";
import TopServices from "@/components/analytics/TopServices";
import EmployeeLeaderboard from "@/components/analytics/EmployeeLeaderboard";
import RepeatCustomers from "@/components/analytics/RepeatCustomers";
import EmployeeDeepDive from "@/components/analytics/EmployeeDeepDive";
import ExportButton from "@/components/analytics/ExportButton";

const API = import.meta.env.VITE_BACKEND_URL || "";

export default function DashboardAnalyticsView() {
  const [from, setFrom] = useState(dayjs().startOf("month").format("YYYY-MM-DD"));
  const [to, setTo] = useState(dayjs().format("YYYY-MM-DD"));

  const handleDateChange = useCallback((newFrom: string, newTo: string) => {
    setFrom(newFrom);
    setTo(newTo);
  }, []);

  const qs = `from=${from}&to=${to}`;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-stone-900">Salon Analytics</h2>
          <p className="text-sm text-stone-500 mt-0.5">
            Business performance at a glance
          </p>
        </div>
        <ExportButton api={API} qs={qs} />
      </div>

      {/* Date Filter */}
      <DateFilter from={from} to={to} onChange={handleDateChange} />

      {/* Summary Cards */}
      <SummaryCards api={API} qs={qs} />

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TopServices api={API} qs={qs} />
        <RepeatCustomers api={API} qs={qs} />
      </div>

      {/* Employee Leaderboard */}
      <EmployeeLeaderboard api={API} qs={qs} />

      {/* Employee Deep Dive */}
      <EmployeeDeepDive api={API} qs={qs} />
    </div>
  );
}
