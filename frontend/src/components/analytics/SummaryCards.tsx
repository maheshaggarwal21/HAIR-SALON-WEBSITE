/**
 * @file SummaryCards.tsx
 * @description Four KPI cards: Total Revenue, Total Visits,
 *              Unique Customers, and Average Ticket Size.
 *
 * Fetches data from GET /api/analytics/summary.
 */

import { useEffect, useState } from "react";
import { IndianRupee, Users, Calendar, TrendingUp } from "lucide-react";

interface SummaryData {
  totalRevenue: number;
  totalVisits: number;
  uniqueCustomers: number;
  avgTicket: number;
}

interface Props {
  api: string;
  qs: string;
}

export default function SummaryCards({ api, qs }: Props) {
  const [data, setData] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setFetchError(false);
    fetch(`${api}/api/analytics/summary?${qs}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch(() => { setData(null); setFetchError(true); })
      .finally(() => setLoading(false));
  }, [api, qs]);

  const cards = data
    ? [
        { label: "Total Revenue", value: `₹${data.totalRevenue.toLocaleString("en-IN")}`, icon: IndianRupee, color: "text-emerald-400" },
        { label: "Total Visits", value: data.totalVisits, icon: Calendar, color: "text-blue-400" },
        { label: "Unique Customers", value: data.uniqueCustomers, icon: Users, color: "text-purple-400" },
        { label: "Avg. Ticket Size", value: `₹${data.avgTicket.toLocaleString("en-IN")}`, icon: TrendingUp, color: "text-amber-400" },
      ]
    : [];

  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white border border-stone-200 rounded-xl p-5 animate-pulse h-28" />
        ))}
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-600">
        Failed to load summary. Please check your connection and try again.
      </div>
    );
  }

  if (!data || data.totalVisits === 0) {
    const emptyCards = [
      { label: "Total Revenue", icon: IndianRupee, color: "text-emerald-500" },
      { label: "Total Visits", icon: Calendar, color: "text-blue-500" },
      { label: "Unique Customers", icon: Users, color: "text-purple-500" },
      { label: "Avg. Ticket Size", icon: TrendingUp, color: "text-amber-500" },
    ];
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {emptyCards.map((c) => (
          <div key={c.label} className="bg-white border border-stone-200 rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <c.icon className={`w-5 h-5 ${c.color} opacity-40`} />
              <span className="text-sm text-stone-400">{c.label}</span>
            </div>
            <p className="text-2xl font-bold text-stone-300">—</p>
            <p className="text-xs text-stone-400 mt-1">No data</p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <div key={c.label} className="bg-white border border-stone-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center gap-2 mb-3">
            <c.icon className={`w-5 h-5 ${c.color}`} />
            <span className="text-sm text-stone-500">{c.label}</span>
          </div>
          <p className="text-2xl font-bold text-stone-900">{c.value}</p>
        </div>
      ))}
    </div>
  );
}
