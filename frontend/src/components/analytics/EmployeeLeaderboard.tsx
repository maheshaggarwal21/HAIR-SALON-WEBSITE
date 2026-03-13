/**
 * @file EmployeeLeaderboard.tsx
 * @description Ranked table of artists with selectable ranking metric.
 *
 * Fetches data from GET /api/analytics/employees.
 * Highlights the top performer and provides key insights.
 */

import { useEffect, useMemo, useState } from "react";
import { Trophy, Medal } from "lucide-react";

interface Employee {
  rank: number;
  name: string;
  customersServed: number;
  uniqueCustomers: number;
  revenue: number;
  hoursWorked: number;
  // Phase 3: productivity fields
  revenuePerHour: number;          // ₹ per effective hour
  totalExtraMins: number;          // net extra time (+ = late, - = early)
  schedulableVisits: number;       // visits with full duration data
  productivityScore: number;       // revenue ÷ effectiveHours (ranking key)
}

interface Props {
  api: string;
  qs: string;
}

type RankMetric = "productivity" | "revenue" | "customers" | "revenuePerHour";

const METRIC_OPTIONS: Array<{ value: RankMetric; label: string }> = [
  { value: "productivity", label: "Productivity Score" },
  { value: "revenue", label: "Revenue" },
  { value: "customers", label: "Customers Served" },
  { value: "revenuePerHour", label: "Revenue per Hour" },
];

const RANK_STYLES: Record<number, string> = {
  1: "text-amber-500",
  2: "text-stone-400",
  3: "text-orange-500",
};

export default function EmployeeLeaderboard({ api, qs }: Props) {
  const [data, setData] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [rankMetric, setRankMetric] = useState<RankMetric>("productivity");

  useEffect(() => {
    setLoading(true);
    fetch(`${api}/api/analytics/employees?${qs}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((err) => { console.error(err); setData([]); })
      .finally(() => setLoading(false));
  }, [api, qs]);

  const rankedData = useMemo(() => {
    const list = [...data];

    list.sort((a, b) => {
      if (rankMetric === "revenue") return b.revenue - a.revenue;
      if (rankMetric === "customers") return b.customersServed - a.customersServed;
      if (rankMetric === "revenuePerHour") return b.revenuePerHour - a.revenuePerHour;
      return b.productivityScore - a.productivityScore;
    });

    return list.map((e, i) => ({ ...e, rank: i + 1 }));
  }, [data, rankMetric]);

  if (loading) {
    return <div className="bg-white border border-stone-200 rounded-xl p-6 animate-pulse h-64 shadow-sm" />;
  }

  if (rankedData.length === 0) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Employee Leaderboard</h2>
        <p className="text-stone-400 text-center py-12">No data available</p>
      </div>
    );
  }

  const topEmployee = rankedData[0];
  const selectedMetricLabel = METRIC_OPTIONS.find((m) => m.value === rankMetric)?.label || "Productivity Score";

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">Employee Leaderboard</h2>
          <p className="text-sm text-stone-500">Ranked by {selectedMetricLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={rankMetric}
            onChange={(e) => setRankMetric(e.target.value as RankMetric)}
            className="bg-white border border-stone-200 rounded-lg px-3 py-1.5 text-sm text-stone-800 outline-none focus:border-stone-400"
          >
            {METRIC_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
            <Trophy className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-medium text-amber-600">Top Performer: {topEmployee.name}</span>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200">
              <th className="text-left py-3 px-2 text-stone-500 font-medium">Rank</th>
              <th className="text-left py-3 px-2 text-stone-500 font-medium">Artist</th>
              <th className="text-right py-3 px-2 text-stone-500 font-medium">Customers</th>
              <th className="text-right py-3 px-2 text-stone-500 font-medium">Revenue</th>
              <th className="text-right py-3 px-2 text-stone-500 font-medium">Hours</th>
              <th className="text-right py-3 px-2 text-stone-500 font-medium">₹/Hour</th>
              <th className="text-right py-3 px-2 text-stone-500 font-medium">Extra Time</th>
            </tr>
          </thead>
          <tbody>
            {rankedData.map((e) => (
              <tr key={e.name} className="border-b border-stone-100 hover:bg-stone-50 transition-colors">
                <td className="py-3 px-2">
                  <span className={`font-bold ${RANK_STYLES[e.rank] || "text-stone-500"}`}>
                    {e.rank <= 3 ? (
                      <span className="flex items-center gap-1">
                        <Medal className="w-4 h-4" /> {e.rank}
                      </span>
                    ) : (
                      `#${e.rank}`
                    )}
                  </span>
                </td>
                <td className="py-3 px-2 font-medium text-stone-900">{e.name}</td>
                <td className="py-3 px-2 text-right text-stone-600">{e.customersServed}</td>
                <td className="py-3 px-2 text-right font-medium text-emerald-600">
                  ₹{e.revenue.toLocaleString("en-IN")}
                </td>
                <td className="py-3 px-2 text-right text-stone-600">{e.hoursWorked}h</td>
                <td className="py-3 px-2 text-right text-stone-600">
                  {e.revenuePerHour > 0 ? `₹${e.revenuePerHour.toLocaleString("en-IN")}` : "—"}
                </td>
                <td className="py-3 px-2 text-right">
                  {e.schedulableVisits === 0 ? (
                    <span className="text-stone-400 text-xs">no data</span>
                  ) : e.totalExtraMins > 0 ? (
                    <span className="text-red-500 font-medium text-xs">+{e.totalExtraMins}m</span>
                  ) : e.totalExtraMins < 0 ? (
                    <span className="text-emerald-600 font-medium text-xs">{e.totalExtraMins}m</span>
                  ) : (
                    <span className="text-emerald-500 text-xs">On Time</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Written insights */}
      <div className="mt-4 p-4 bg-stone-50 border border-stone-100 rounded-lg space-y-1.5">
        <p className="text-sm font-medium text-stone-700">Key Insights:</p>
        <p className="text-sm text-stone-600">
          <span className="text-stone-900 font-medium">{topEmployee.name}</span> leads with{" "}
          ₹{topEmployee.revenue.toLocaleString("en-IN")} revenue across {topEmployee.customersServed} customers
          {topEmployee.revenuePerHour > 0 && (
            <> at <span className="text-emerald-600 font-medium">₹{topEmployee.revenuePerHour.toLocaleString("en-IN")}/hr</span> effectiveness</>
          )}.
        </p>
        {rankedData.length > 1 && (
          <p className="text-sm text-stone-600">
            {rankMetric === "productivity" && (
              <>Productivity gap (#1 vs last): ₹{(rankedData[0].productivityScore - rankedData[rankedData.length - 1].productivityScore).toLocaleString("en-IN")}/hr effective</>
            )}
            {rankMetric === "revenue" && (
              <>Revenue gap (#1 vs last): ₹{(rankedData[0].revenue - rankedData[rankedData.length - 1].revenue).toLocaleString("en-IN")}</>
            )}
            {rankMetric === "customers" && (
              <>Customer gap (#1 vs last): {(rankedData[0].customersServed - rankedData[rankedData.length - 1].customersServed).toLocaleString("en-IN")} visits</>
            )}
            {rankMetric === "revenuePerHour" && (
              <>₹/Hour gap (#1 vs last): ₹{(rankedData[0].revenuePerHour - rankedData[rankedData.length - 1].revenuePerHour).toLocaleString("en-IN")}/hr</>
            )}
          </p>
        )}
        {(() => {
          const withData = rankedData.filter((e) => e.schedulableVisits > 0);
          if (withData.length === 0) return null;
          const mostEfficient = [...withData].sort((a, b) => a.totalExtraMins - b.totalExtraMins)[0];
          return mostEfficient.totalExtraMins < 0 ? (
            <p className="text-sm text-stone-600">
              Most time-efficient: <span className="text-stone-900 font-medium">{mostEfficient.name}</span>{" "}
              (<span className="text-emerald-600">{mostEfficient.totalExtraMins}m</span> under expected)
            </p>
          ) : mostEfficient.totalExtraMins > 0 ? (
            <p className="text-sm text-stone-600">
              Watch: <span className="text-stone-900 font-medium">{mostEfficient.name}</span>{" "}
              accumulating <span className="text-red-500">+{mostEfficient.totalExtraMins}m</span> overtime
            </p>
          ) : null;
        })()}
      </div>
    </div>
  );
}
