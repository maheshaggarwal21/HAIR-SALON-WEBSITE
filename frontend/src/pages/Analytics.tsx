/**
 * @file Analytics.tsx
 * @description Dashboard page that assembles all analytics widgets.
 *
 * Date range state is lifted here so every child component shares the
 * same `from` and `to` query parameters when fetching data.
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
import AppLayout from "@/layouts/AppLayout";

/** Backend API base URL (injected at build time via Vite env vars). */
const API = import.meta.env.VITE_BACKEND_URL || "";

export default function Analytics() {
  const [from, setFrom] = useState(dayjs().startOf("month").format("YYYY-MM-DD"));
  const [to, setTo] = useState(dayjs().format("YYYY-MM-DD"));

  const handleDateChange = useCallback((newFrom: string, newTo: string) => {
    setFrom(newFrom);
    setTo(newTo);
  }, []);

  const qs = `from=${from}&to=${to}`;

  return (
    <AppLayout subtitle="Business Analytics">
      <div className="mx-auto max-w-6xl w-full px-6 pt-12 pb-16">
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-stone-900">Salon Analytics</h2>
            <p className="text-sm text-stone-500 mt-0.5">Business performance at a glance</p>
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
      </div>
    </AppLayout>
  );
}
