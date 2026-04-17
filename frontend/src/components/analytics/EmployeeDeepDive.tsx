/**
 * @file EmployeeDeepDive.tsx
 * @description Detailed performance breakdown for a selected employee.
 *
 * Fetches the employee list from GET /api/analytics/employees,
 * then loads per-artist stats from GET /api/analytics/employee/:name.
 * Includes stat cards, a top-services bar chart, and a written summary.
 */

import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { User, TrendingUp, Clock, Users, Award, Zap, Timer } from "lucide-react";

interface EmployeeDetail {
  name: string;
  customersServed: number;
  uniqueCustomers: number;
  revenue: number;
  hoursWorked: number;
  avgRevenuePerVisit: number;
  topServices: { service: string; count: number; revenue: number }[];
  rank: number;
  totalArtists: number;
  // Phase 3: time performance fields
  revenuePerHour: number;       // ₹ per effective hour
  totalExtraMins: number;       // net over/under time (+ = late, - = early)
  schedulableVisits: number;    // visits with duration data
}

interface EmployeeName {
  name: string;
}

interface Props {
  api: string;
  qs: string;
}

export default function EmployeeDeepDive({ api, qs }: Props) {
  const [employees, setEmployees] = useState<EmployeeName[]>([]);
  const [selected, setSelected] = useState("");
  const [data, setData] = useState<EmployeeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");

  // Fetch employee list
  useEffect(() => {
    setFetchError("");
    fetch(`${api}/api/analytics/employees?${qs}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((list: EmployeeName[]) => {
        setEmployees(Array.isArray(list) ? list : []);
        if (Array.isArray(list) && list.length > 0) {
          setSelected(list[0].name);
        } else {
          setSelected("");
          setData(null);
        }
      })
      .catch(() => { setEmployees([]); setSelected(""); setData(null); setFetchError("Failed to load employee list. Please try again."); });
  }, [api, qs]);

  // Fetch selected employee detail
  useEffect(() => {
    if (!selected) {
      setData(null);
      return;
    }
    setLoading(true);
    setFetchError("");
    fetch(`${api}/api/analytics/employee/${encodeURIComponent(selected)}?${qs}`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch(() => { setData(null); setFetchError("Failed to load employee details. Please try again."); })
      .finally(() => setLoading(false));
  }, [api, qs, selected]);

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">Employee Deep Dive</h2>
          <p className="text-sm text-stone-500">Detailed performance breakdown</p>
        </div>
        {employees.length > 0 && (
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="bg-white border border-stone-200 rounded-lg px-4 py-2 text-sm text-stone-800 outline-none focus:border-stone-400"
          >
            {employees.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {fetchError ? (
        <p className="text-red-500 text-center py-12">{fetchError}</p>
      ) : employees.length === 0 && !loading ? (
        <p className="text-stone-400 text-center py-12">No employee data available for this period</p>
      ) : loading ? (
        <div className="animate-pulse space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-stone-100 rounded-lg h-24" />
            ))}
          </div>
          <div className="h-48 bg-stone-100 rounded-lg" />
        </div>
      ) : data && data.customersServed > 0 ? (
        <>
          {/* Stat cards: core 5 always shown + 2 Phase-3 cards when data exists */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <StatCard icon={Award} label="Rank" value={`#${data.rank} of ${data.totalArtists}`} color="text-amber-500" />
            <StatCard icon={TrendingUp} label="Revenue" value={`₹${data.revenue.toLocaleString("en-IN")}`} color="text-emerald-600" />
            <StatCard icon={Users} label="Customers" value={String(data.customersServed)} color="text-blue-500" />
            <StatCard icon={Clock} label="Hours Worked" value={`${data.hoursWorked}h`} color="text-purple-500" />
          </div>
          <div className={`grid gap-4 mb-6 ${
            data.schedulableVisits > 0 ? "grid-cols-2 md:grid-cols-3" : "grid-cols-2 md:grid-cols-2"
          }`}>
            <StatCard icon={User} label="Avg ₹/Visit" value={`₹${data.avgRevenuePerVisit.toLocaleString("en-IN")}`} color="text-pink-500" />
            {/* ₹/Hour: only meaningful when we have at least some visits with duration data */}
            <StatCard
              icon={Zap}
              label="₹/Hour (Effective)"
              value={data.schedulableVisits > 0 && data.revenuePerHour > 0
                ? `₹${data.revenuePerHour.toLocaleString("en-IN")}`
                : "—"}
              color="text-indigo-500"
            />
            {/* Extra Time: net overrun/underrun beyond ±10 min tolerance */}
            {data.schedulableVisits > 0 && (
              <div className="bg-white border border-stone-200 rounded-lg p-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <Timer className={`w-4 h-4 ${
                    data.totalExtraMins > 0 ? "text-red-500"
                    : data.totalExtraMins < 0 ? "text-emerald-500"
                    : "text-stone-400"
                  }`} />
                  <span className="text-xs text-stone-500">Extra Time</span>
                </div>
                {data.totalExtraMins === 0 ? (
                  <p className="text-lg font-bold text-emerald-500">On Time</p>
                ) : (
                  <p className={`text-lg font-bold ${
                    data.totalExtraMins > 0 ? "text-red-500" : "text-emerald-600"
                  }`}>
                    {data.totalExtraMins > 0 ? "+" : ""}{data.totalExtraMins}m
                  </p>
                )}
                <p className="text-xs text-stone-400 mt-0.5">
                  across {data.schedulableVisits} timed visit{data.schedulableVisits !== 1 ? "s" : ""}
                </p>
              </div>
            )}
          </div>

          {/* Top services bar chart */}
          {data.topServices.length > 0 && (
            <div className="mb-4">
              <p className="text-sm font-medium text-stone-600 mb-3">Top Services by {data.name}</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.topServices}>
                  <XAxis dataKey="service" stroke="#d6d3d1" tick={{ fill: "#78716c", fontSize: 11 }} />
                  <YAxis stroke="#d6d3d1" tick={{ fill: "#78716c", fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, color: "#1c1917" }}
                    formatter={(value) => [`${value}`, "Bookings"]}
                  />
                  <Bar dataKey="count" fill="#60a5fa" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Written summary for the owner */}
          <div className="p-4 bg-stone-50 border border-stone-100 rounded-lg space-y-2">
            <p className="text-sm font-medium text-stone-700">Performance Summary:</p>
            <p className="text-sm text-stone-600">
              <span className="text-stone-900 font-medium">{data.name}</span> is ranked{" "}
              <span className="text-amber-600 font-medium">#{data.rank}</span> out of {data.totalArtists} artists.
            </p>
            <p className="text-sm text-stone-600">
              Generated <span className="text-emerald-600 font-medium">₹{data.revenue.toLocaleString("en-IN")}</span> from{" "}
              {data.customersServed} customers in {data.hoursWorked} hours of work.
            </p>
            <p className="text-sm text-stone-600">
              Average earning per customer visit: <span className="text-stone-900 font-medium">₹{data.avgRevenuePerVisit.toLocaleString("en-IN")}</span>
            </p>
            {data.schedulableVisits > 0 && data.revenuePerHour > 0 && (
              <p className="text-sm text-stone-600">
                Effective productivity: <span className="text-indigo-500 font-medium">₹{data.revenuePerHour.toLocaleString("en-IN")}/hr</span>{" "}
                (adjusted for {data.totalExtraMins > 0 ? "overtime" : data.totalExtraMins < 0 ? "time saved" : "on-time performance"})
              </p>
            )}
            {data.schedulableVisits > 0 && data.totalExtraMins !== 0 && (
              <p className="text-sm text-stone-600">
                Net extra time:{" "}
                {data.totalExtraMins > 0
                  ? <span className="text-red-500 font-medium">+{data.totalExtraMins} min over schedule</span>
                  : <span className="text-emerald-600 font-medium">{data.totalExtraMins} min under schedule</span>}
              </p>
            )}
            {data.rank === 1 && (
              <p className="text-sm text-amber-600 font-medium mt-1">
                ⭐ Top performer — recommended for incentive!
              </p>
            )}
            {data.rank === data.totalArtists && data.totalArtists > 1 && (
              <p className="text-sm text-red-500 mt-1">
                Needs improvement — lowest ranked this period.
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="text-stone-400 text-center py-8">Select an employee to view details</p>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string; color: string }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-4">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-xs text-stone-500">{label}</span>
      </div>
      <p className="text-lg font-bold text-stone-900">{value}</p>
    </div>
  );
}
