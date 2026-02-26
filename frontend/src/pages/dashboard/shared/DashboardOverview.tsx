/**
 * @file DashboardOverview.tsx
 * @description Shared "Overview" sub-page used by both Manager and Owner dashboards.
 *
 * Shows: welcome header, today's KPI cards, month-to-date charts.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import dayjs from "dayjs";
import { useAuth } from "@/context/AuthContext";
import EmployeeLeaderboard from "@/components/analytics/EmployeeLeaderboard";
import TopServices from "@/components/analytics/TopServices";

const API = import.meta.env.VITE_BACKEND_URL || "";

interface SummaryData {
  totalRevenue: number;
  totalVisits: number;
}

export default function DashboardOverview() {
  const { user } = useAuth();

  const today = dayjs().format("YYYY-MM-DD");
  const monthStart = dayjs().startOf("month").format("YYYY-MM-DD");

  const [todayStats, setTodayStats] = useState<SummaryData | null>(null);
  const [monthStats, setMonthStats] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API}/api/analytics/summary?from=${today}&to=${today}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null)),
      fetch(`${API}/api/analytics/summary?from=${monthStart}&to=${today}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([tData, mData]) => {
        setTodayStats(tData);
        setMonthStats(mData);
        setFetchError(!tData && !mData);
      })
      .catch(() => { setFetchError(true); })
      .finally(() => setLoading(false));
  }, [today, monthStart]);

  const qs = `from=${monthStart}&to=${today}`;

  const cards = [
    { label: "Today's Revenue", value: todayStats ? `₹${todayStats.totalRevenue.toLocaleString("en-IN")}` : "—", empty: todayStats?.totalRevenue === 0 },
    { label: "Today's Visits", value: todayStats ? String(todayStats.totalVisits) : "—", empty: todayStats?.totalVisits === 0 },
    { label: "This Month's Revenue", value: monthStats ? `₹${monthStats.totalRevenue.toLocaleString("en-IN")}` : "—", empty: monthStats?.totalRevenue === 0 },
  ];

  return (
    <>
      {/* Welcome header */}
      <div className="mb-8">
        <motion.h2
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="text-3xl font-black text-stone-900 tracking-tight"
        >
          Welcome back, {user?.name?.split(" ")[0]} 👋
        </motion.h2>
        <p className="text-stone-500 mt-1 text-sm">
          {new Date().toLocaleDateString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </p>
      </div>

      {/* Stats cards */}
      {fetchError && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          Failed to load dashboard data. Check your connection and refresh.
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-8">
        {loading
          ? Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse bg-stone-100 rounded-2xl h-32" />
            ))
          : cards.map((c, index) => (
              <motion.div
                key={c.label}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: index * 0.08 }}
                className="bg-white rounded-2xl border border-stone-200/80 shadow-sm p-6"
              >
                <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-2">
                  {c.label}
                </p>
                <p className="text-3xl font-black text-stone-900">{c.value}</p>
                {c.empty && (
                  <p className="text-xs text-stone-400 mt-1">No visits yet</p>
                )}
              </motion.div>
            ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <EmployeeLeaderboard api={API} qs={qs} />
        <TopServices api={API} qs={qs} />
      </div>
    </>
  );
}
