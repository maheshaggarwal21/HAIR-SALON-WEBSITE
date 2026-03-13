/**
 * @file TopServices.tsx
 * @description Horizontal bar chart + text summary of top-booked services.
 *
 * Fetches data from GET /api/analytics/top-services.
 * Shows up to 10 services, colour-coded by rank.
 */

import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

interface ServiceData {
  service: string;
  count: number;
  revenue: number;
}

interface Props {
  api: string;
  qs: string;
}

const COLORS = ["#34d399", "#60a5fa", "#a78bfa", "#fbbf24", "#f87171", "#2dd4bf", "#fb923c", "#e879f9"];

function shortLabel(label: string, maxLen = 22): string {
  if (!label) return "";
  return label.length > maxLen ? `${label.slice(0, maxLen - 1)}…` : label;
}

export default function TopServices({ api, qs }: Props) {
  const [data, setData] = useState<ServiceData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${api}/api/analytics/top-services?${qs}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((err) => { console.error(err); setData([]); })
      .finally(() => setLoading(false));
  }, [api, qs]);

  if (loading) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl p-6 animate-pulse h-96 shadow-sm" />
    );
  }

  const top10 = data.slice(0, 10);

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-stone-900 mb-1">Top Services</h2>
      <p className="text-sm text-stone-500 mb-4">Most popular services by bookings</p>

      {top10.length === 0 ? (
        <p className="text-stone-400 text-center py-12">No data available</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={top10} layout="vertical" margin={{ left: 20, right: 20 }}>
              <XAxis type="number" stroke="#d6d3d1" tick={{ fill: "#78716c", fontSize: 12 }} />
              <YAxis
                dataKey="service"
                type="category"
                width={170}
                stroke="#d6d3d1"
                tick={{ fill: "#44403c", fontSize: 12 }}
                tickMargin={10}
                tickFormatter={(value) => shortLabel(String(value || ""))}
              />
              <Tooltip
                contentStyle={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, color: "#1c1917" }}
                formatter={(value: any, name?: string) =>
                  name === "count" ? [`${value} bookings`, "Bookings"] : [`₹${Number(value).toLocaleString("en-IN")}`, "Revenue"]
                }
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {top10.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          {/* Written summary */}
          <div className="mt-4 space-y-2">
            {top10.slice(0, 3).map((s, i) => (
              <p key={s.service} className="text-sm text-stone-500">
                <span className="text-stone-900 font-medium">#{i + 1}&nbsp;&nbsp;{s.service}</span>
                {" — "}{s.count} bookings, ₹{s.revenue.toLocaleString("en-IN")} revenue
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
