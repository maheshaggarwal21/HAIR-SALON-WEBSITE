/**
 * @file RepeatCustomers.tsx
 * @description Donut chart + stats showing new vs returning customers.
 *
 * Fetches data from GET /api/analytics/repeat-customers.
 */

import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

interface RepeatData {
  totalCustomers: number;
  repeatCustomers: number;
  newCustomers: number;
  repeatRate: number;
}

interface Props {
  api: string;
  qs: string;
}

const COLORS = ["#a78bfa", "#34d399"];

export default function RepeatCustomers({ api, qs }: Props) {
  const [data, setData] = useState<RepeatData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setFetchError(false);
    fetch(`${api}/api/analytics/repeat-customers?${qs}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch(() => { setData(null); setFetchError(true); })
      .finally(() => setLoading(false));
  }, [api, qs]);

  if (loading) {
    return <div className="bg-white border border-stone-200 rounded-xl p-6 animate-pulse h-96 shadow-sm" />;
  }

  if (fetchError) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Repeat Customers</h2>
        <p className="text-red-500 text-center py-12">Failed to load data. Please try again.</p>
      </div>
    );
  }

  if (!data || data.totalCustomers === 0) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Repeat Customers</h2>
        <p className="text-stone-400 text-center py-12">No data available</p>
      </div>
    );
  }

  const chartData = [
    { name: "Returning", value: data.repeatCustomers },
    { name: "New", value: data.newCustomers },
  ];

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-stone-900 mb-1">Repeat Customers</h2>
      <p className="text-sm text-stone-500 mb-4">New vs returning customers</p>

      <div className="flex items-center gap-6">
        <ResponsiveContainer width="50%" height={220}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={80}
              paddingAngle={4}
              dataKey="value"
              stroke="none"
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, color: "#1c1917" }}
              formatter={(value) => [`${value} customers`, ""]}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="flex-1 space-y-4">
          {/* Big number */}
          <div>
            <p className="text-4xl font-bold text-purple-600">{data.repeatRate}%</p>
            <p className="text-sm text-stone-500">of customers came back</p>
          </div>

          {/* Legend */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-purple-500" />
              <span className="text-sm text-stone-600">Returning: {data.repeatCustomers}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-emerald-500" />
              <span className="text-sm text-stone-600">New: {data.newCustomers}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Written insight */}
      <div className="mt-4 p-3 bg-stone-50 border border-stone-100 rounded-lg">
        <p className="text-sm text-stone-600">
          Out of <span className="text-stone-900 font-medium">{data.totalCustomers}</span> total customers,{" "}
          <span className="text-purple-600 font-medium">{data.repeatCustomers}</span> visited more than once.
          {data.repeatRate >= 50
            ? " Great retention — more than half your customers are returning!"
            : " There's room to improve customer retention."}
        </p>
      </div>
    </div>
  );
}
