/**
 * @file ArtistDashboardView.tsx
 * @description Read-only view of an artist's dashboard for the owner.
 *
 * Fetches data from /api/owner/artist-dashboard/:artistId/* endpoints.
 * Rendered within the owner dashboard layout at /dashboard/owner/artist-view/:id.
 * Features a "Back to Artists" button, plus the same KPI cards, services breakdown,
 * and daily trend chart as the artist's own dashboard.
 */

import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  DollarSign,
  Users,
  Clock,
  TrendingUp,
  Star,
  Calendar,
  Briefcase,
  Scissors,
  BadgePercent,
} from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────
interface ArtistProfile {
  _id: string;
  name: string;
  phone: string;
  email: string | null;
  registrationId: string | null;
  commission: number;
  photo: string | null;
  isActive: boolean;
  createdAt: string;
}

interface DashboardSummary {
  totalRevenue: number;
  commissionPct: number;
  commissionEarned: number;
  totalVisits: number;
  uniqueCustomers: number;
  totalServices: number;
  hoursWorked: number;
  avgTicket: number;
  from: string;
  to: string;
}

interface ServiceBreakdown {
  service: string;
  count: number;
  revenue: number;
}

interface DailyTrend {
  date: string;
  revenue: number;
  commission: number;
  visits: number;
}

type DatePreset = "today" | "month" | "3months" | "year" | "custom";

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getPresetDates(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const today = formatDate(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "month":
      return {
        from: formatDate(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: today,
      };
    case "3months":
      return {
        from: formatDate(new Date(now.getFullYear(), now.getMonth() - 2, 1)),
        to: today,
      };
    case "year":
      return {
        from: formatDate(new Date(now.getFullYear(), 0, 1)),
        to: today,
      };
    default:
      return {
        from: formatDate(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: today,
      };
  }
}

function formatCurrency(n: number): string {
  return "₹" + n.toLocaleString("en-IN", {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function resolvePhotoUrl(photo: string | null): string | null {
  if (!photo) return null;
  if (photo.startsWith("http")) return photo;
  // Local upload — prefix with API base
  return `${API}${photo}`;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function ArtistDashboardView() {
  const { id: artistId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Date range
  const [preset, setPreset] = useState<DatePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // Data
  const [profile, setProfile] = useState<ArtistProfile | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [services, setServices] = useState<ServiceBreakdown[]>([]);
  const [trend, setTrend] = useState<DailyTrend[]>([]);

  // UI
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const getDateRange = useCallback(() => {
    if (preset === "custom" && customFrom && customTo) {
      return { from: customFrom, to: customTo };
    }
    return getPresetDates(preset);
  }, [preset, customFrom, customTo]);

  const fetchDashboardData = useCallback(async () => {
    if (!artistId) return;
    try {
      const { from, to } = getDateRange();
      const qs = `from=${from}&to=${to}`;
      const base = `${API}/api/owner/artist-dashboard/${artistId}`;

      const [profileRes, summaryRes, servicesRes, trendRes] = await Promise.all([
        fetch(`${base}/profile`, { credentials: "include" }),
        fetch(`${base}/summary?${qs}`, { credentials: "include" }),
        fetch(`${base}/services?${qs}`, { credentials: "include" }),
        fetch(`${base}/daily-trend?${qs}`, { credentials: "include" }),
      ]);

      if (!profileRes.ok || !summaryRes.ok || !servicesRes.ok || !trendRes.ok) {
        throw new Error("Failed to load artist dashboard data");
      }

      const [p, s, sv, t] = await Promise.all([
        profileRes.json(),
        summaryRes.json(),
        servicesRes.json(),
        trendRes.json(),
      ]);

      setProfile(p);
      setSummary(s);
      setServices(sv);
      setTrend(t);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [artistId, getDateRange]);

  // Initial fetch + refetch on date change
  useEffect(() => {
    setLoading(true);
    fetchDashboardData();
  }, [fetchDashboardData]);

  // Max value for trend chart bar scaling
  const maxTrendRevenue = Math.max(...trend.map((d) => d.revenue), 1);

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-10 h-10 rounded-full border-4 border-stone-200 border-t-amber-500 animate-spin" />
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      {/* ── Back button + title ── */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate("/dashboard/owner/artists")}
          className="flex items-center gap-1.5 text-sm text-stone-600 hover:text-stone-900 border border-stone-200 hover:border-stone-300 rounded-lg px-3 py-1.5 transition-all"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Artists
        </button>
        <h2 className="text-2xl font-bold text-stone-900">
          {profile?.name ?? "Artist"}'s Dashboard
        </h2>
      </div>

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Profile + Commission Hero ── */}
      {profile && (
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Profile card */}
          <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm p-6 flex items-center gap-5">
            {profile.photo ? (
              <img
                src={resolvePhotoUrl(profile.photo)!}
                alt={profile.name}
                className="w-16 h-16 rounded-full object-cover border-2 border-amber-200"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-linear-to-br from-amber-400 to-amber-600 flex items-center justify-center text-white text-2xl font-bold">
                {profile.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-stone-900 truncate">{profile.name}</h2>
              <p className="text-xs text-stone-500 mt-0.5">{profile.email || profile.phone}</p>
              {profile.registrationId && (
                <p className="text-xs text-stone-400 mt-0.5 flex items-center gap-1">
                  <Briefcase className="w-3 h-3" /> {profile.registrationId}
                </p>
              )}
              <span
                className={`inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  profile.isActive
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-stone-100 text-stone-500 border border-stone-200"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${profile.isActive ? "bg-green-500" : "bg-stone-400"}`} />
                {profile.isActive ? "Active" : "Inactive"}
              </span>
            </div>
          </div>

          {/* Commission Highlight */}
          <div
            className="lg:col-span-2 rounded-2xl p-6 relative overflow-hidden"
            style={{
              background: "linear-gradient(135deg, #b45309 0%, #d97706 50%, #f59e0b 100%)",
            }}
          >
            <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-white/10" />
            <div className="absolute -bottom-6 -left-6 w-24 h-24 rounded-full bg-white/5" />

            <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Star className="w-5 h-5 text-yellow-200" fill="currentColor" />
                  <span className="text-sm font-semibold text-yellow-100 uppercase tracking-wider">
                    Commission Earned
                  </span>
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl sm:text-5xl font-black text-white">
                    {summary ? formatCurrency(summary.commissionEarned) : "₹0"}
                  </span>
                  <span className="text-lg font-bold text-yellow-200/80">earned</span>
                </div>
              </div>

              <div className="flex flex-col items-center gap-1 bg-white/15 backdrop-blur-sm rounded-xl px-6 py-4">
                <BadgePercent className="w-6 h-6 text-yellow-200" />
                <span className="text-3xl font-black text-white">{profile.commission}%</span>
                <span className="text-xs text-yellow-100/80 font-medium uppercase tracking-wide">Rate</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Date Range Filter ── */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {(
          [
            { key: "today", label: "Today" },
            { key: "month", label: "This Month" },
            { key: "3months", label: "3 Months" },
            { key: "year", label: "This Year" },
            { key: "custom", label: "Custom" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setPreset(key)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-150 ${
              preset === key
                ? "bg-stone-900 text-white shadow-sm"
                : "bg-white border border-stone-200 text-stone-600 hover:border-stone-300 hover:bg-stone-50"
            }`}
          >
            {label}
          </button>
        ))}

        <AnimatePresence>
          {preset === "custom" && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              className="flex items-center gap-2 overflow-hidden"
            >
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 px-3 rounded-xl border border-stone-200 bg-white text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
              />
              <span className="text-stone-400 text-sm">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 px-3 rounded-xl border border-stone-200 bg-white text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── KPI Cards ── */}
      {summary && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
        >
          {[
            {
              icon: DollarSign,
              label: "Total Revenue",
              value: formatCurrency(summary.totalRevenue),
              color: "text-emerald-600",
              bg: "bg-emerald-50",
            },
            {
              icon: Users,
              label: "Customers Served",
              value: summary.uniqueCustomers.toString(),
              sub: `${summary.totalVisits} visits`,
              color: "text-blue-600",
              bg: "bg-blue-50",
            },
            {
              icon: Scissors,
              label: "Services Done",
              value: summary.totalServices.toString(),
              color: "text-purple-600",
              bg: "bg-purple-50",
            },
            {
              icon: Clock,
              label: "Hours Worked",
              value: `${summary.hoursWorked}h`,
              sub: `Avg ${formatCurrency(summary.avgTicket)}/visit`,
              color: "text-orange-600",
              bg: "bg-orange-50",
            },
          ].map((card) => (
            <div
              key={card.label}
              className="bg-white rounded-2xl border border-stone-200/80 shadow-sm p-5"
            >
              <div className={`w-9 h-9 rounded-xl ${card.bg} flex items-center justify-center mb-3`}>
                <card.icon className={`w-4.5 h-4.5 ${card.color}`} />
              </div>
              <p className="text-2xl font-black text-stone-900">{card.value}</p>
              <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mt-0.5">
                {card.label}
              </p>
              {"sub" in card && card.sub && <p className="text-xs text-stone-400 mt-0.5">{card.sub}</p>}
            </div>
          ))}
        </motion.div>
      )}

      {/* ── Two-column: Services Breakdown + Daily Trend ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Services breakdown */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white rounded-2xl border border-stone-200/80 shadow-sm p-6"
        >
          <h3 className="text-base font-bold text-stone-900 flex items-center gap-2 mb-4">
            <Scissors className="w-4 h-4 text-amber-500" />
            Top Services
          </h3>

          {services.length === 0 ? (
            <p className="text-sm text-stone-400 py-8 text-center">No service data in this period</p>
          ) : (
            <div className="space-y-3">
              {services.slice(0, 8).map((s, i) => {
                const maxCount = services[0]?.count || 1;
                const pct = Math.round((s.count / maxCount) * 100);
                return (
                  <div key={s.service}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-stone-700 truncate">
                        {i + 1}. {s.service}
                      </span>
                      <span className="text-sm font-semibold text-stone-900 ml-3 whitespace-nowrap">
                        {formatCurrency(s.revenue)}
                        <span className="text-stone-400 font-normal ml-1 text-xs">({s.count}×)</span>
                      </span>
                    </div>
                    <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.5, delay: i * 0.05 }}
                        className="h-full rounded-full bg-linear-to-r from-amber-400 to-amber-500"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>

        {/* Daily trend chart */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-white rounded-2xl border border-stone-200/80 shadow-sm p-6"
        >
          <h3 className="text-base font-bold text-stone-900 flex items-center gap-2 mb-4">
            <TrendingUp className="w-4 h-4 text-amber-500" />
            Daily Earnings
          </h3>

          {trend.length === 0 ? (
            <p className="text-sm text-stone-400 py-8 text-center">No data in this period</p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {trend.map((d) => {
                const revPct = Math.max((d.revenue / maxTrendRevenue) * 100, 2);
                const commPct = Math.max((d.commission / maxTrendRevenue) * 100, 1);
                const dateLabel = new Date(d.date + "T00:00").toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                });
                return (
                  <div key={d.date}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-stone-500 w-14 shrink-0">{dateLabel}</span>
                      <div className="flex-1 mx-2 flex flex-col gap-0.5">
                        <div className="h-3 bg-stone-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-stone-300"
                            style={{ width: `${revPct}%` }}
                          />
                        </div>
                        <div className="h-3 bg-stone-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-linear-to-r from-amber-400 to-amber-500"
                            style={{ width: `${commPct}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-right shrink-0 w-20">
                        <p className="text-xs font-semibold text-stone-700">{formatCurrency(d.revenue)}</p>
                        <p className="text-xs font-bold text-amber-600">{formatCurrency(d.commission)}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* Legend */}
              <div className="flex items-center gap-4 pt-2 border-t border-stone-100 mt-2">
                <span className="flex items-center gap-1.5 text-xs text-stone-500">
                  <span className="w-3 h-2 rounded bg-stone-300" /> Revenue
                </span>
                <span className="flex items-center gap-1.5 text-xs text-amber-600">
                  <span className="w-3 h-2 rounded bg-amber-400" /> Commission
                </span>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* ── Period Summary ── */}
      {summary && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-4 bg-white rounded-2xl border border-stone-200/80 shadow-sm p-6"
        >
          <h3 className="text-base font-bold text-stone-900 flex items-center gap-2 mb-4">
            <Calendar className="w-4 h-4 text-amber-500" />
            Period Summary
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <div>
              <p className="text-2xl font-black text-stone-900">{formatCurrency(summary.totalRevenue)}</p>
              <p className="text-xs text-stone-500 uppercase tracking-wider font-semibold mt-0.5">Revenue Generated</p>
            </div>
            <div>
              <p className="text-2xl font-black text-amber-600">{formatCurrency(summary.commissionEarned)}</p>
              <p className="text-xs text-stone-500 uppercase tracking-wider font-semibold mt-0.5">Commission</p>
            </div>
            <div>
              <p className="text-2xl font-black text-stone-900">{summary.totalVisits}</p>
              <p className="text-xs text-stone-500 uppercase tracking-wider font-semibold mt-0.5">Total Visits</p>
            </div>
            <div>
              <p className="text-2xl font-black text-stone-900">{formatCurrency(summary.avgTicket)}</p>
              <p className="text-xs text-stone-500 uppercase tracking-wider font-semibold mt-0.5">Avg Ticket</p>
            </div>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
