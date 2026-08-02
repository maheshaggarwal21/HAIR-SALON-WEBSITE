/**
 * @file DataPipeline.tsx
 * @description Cross-cutting reporting tab — filters, charts, table, exports.
 *
 * Separate from Payments and Analytics, which are unchanged. What this adds
 * over those two:
 *   - filters that combine (date + customer + artist + gender + method)
 *   - a payment-method filter that understands split payments, so "Cash"
 *     matches any visit with a cash line rather than only wholly-cash visits
 *   - per-artist revenue, apportioned per service so multi-artist visits
 *     credit each artist correctly
 *   - Excel and PDF exports that respect every active filter
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toLocalDateKey } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Legend,
  CartesianGrid,
} from "recharts";
import {
  Database,
  Filter,
  Download,
  FileText,
  ChevronLeft,
  ChevronRight,
  Search,
  RefreshCw,
  X,
  Users,
  Receipt,
} from "lucide-react";
import {
  exportPipelineExcel,
  exportPipelinePdf,
  type ExportPayload,
  type PipelineRow,
  type PipelineSummary,
  type ArtistPerf,
  type PaymentLine,
} from "@/lib/dataPipelineExport";

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────

type DatePreset = "today" | "yesterday" | "month" | "3months" | "6months" | "year" | "custom";
type MethodFilter = "all" | "cash" | "card" | "online" | "split";
type GenderFilter = "all" | "male" | "female" | "not_specified";
type TableMode = "visit" | "customer";

interface CustomerRow {
  id: string;
  name: string;
  contact: string;
  gender: PipelineRow["gender"];
  visits: number;
  totalSpent: number;
  totalDiscount: number;
  avgTicket: number;
  lastVisit: string;
  firstVisit: string;
  artistLabel: string;
  methodLabel: string;
}

interface GenderSplit {
  byVisit: { gender: string; count: number }[];
  byCustomer: { gender: string; count: number }[];
  fillRate: number;
}

interface PipelineResponse {
  summary: PipelineSummary;
  revenueSeries: { granularity: "day" | "week" | "month"; series: { period: string; revenue: number; visits: number }[] };
  methodMix: { method: string; amount: number }[];
  artistPerformance: ArtistPerf[];
  genderSplit: GenderSplit;
  rows: PipelineRow[] | CustomerRow[];
  groupBy: TableMode;
  pagination: { page: number; limit: number; total: number; pages: number };
  range: { from: string; to: string };
  truncated: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "month", label: "This Month" },
  { key: "3months", label: "3 Months" },
  { key: "6months", label: "6 Months" },
  { key: "year", label: "This Year" },
  { key: "custom", label: "Custom" },
];

const METHOD_COLORS: Record<string, string> = {
  cash: "#10b981",
  card: "#8b5cf6",
  online: "#3b82f6",
};

const METHOD_BADGE: Record<string, string> = {
  cash: "bg-emerald-50 text-emerald-700 border-emerald-200",
  card: "bg-violet-50 text-violet-700 border-violet-200",
  online: "bg-blue-50 text-blue-700 border-blue-200",
  Split: "bg-amber-50 text-amber-800 border-amber-300",
};

const GENDER_COLORS: Record<string, string> = {
  male: "#3b82f6",
  female: "#ec4899",
  not_specified: "#a8a29e",
};

const GENDER_LABEL: Record<string, string> = {
  male: "Male",
  female: "Female",
  not_specified: "Not specified",
};

const ARTIST_COLORS = ["#f59e0b", "#3b82f6", "#10b981", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1"];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Local-timezone date key — never `toISOString()`, which shifts to UTC. */
const ymd = toLocalDateKey;

function presetRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const today = ymd(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: ymd(y), to: ymd(y) };
    }
    case "month":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case "3months":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: today };
    case "6months":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 5, 1)), to: today };
    case "year":
      return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: today };
    default:
      return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
  }
}

function inr(n: number): string {
  return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
}

/**
 * Compact axis tick, e.g. ₹4.5k / ₹6k / ₹1.2L.
 *
 * Recharts picks ticks like 1500 and 4500; rounding those to whole thousands
 * renders "₹2k" and "₹5k", which both mislabels the gridline and can repeat a
 * label on adjacent ticks. Keep one decimal unless the value is a round unit.
 */
function axisMoney(value: number): string {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 100000) {
    const l = n / 100000;
    return `₹${l % 1 === 0 ? l.toFixed(0) : l.toFixed(1)}L`;
  }
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    return `₹${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `₹${Math.round(n)}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Axis label for a bucket key — "2026-07-14" → "14 Jul", "2026-07" → "Jul 26". */
function periodLabel(period: string, granularity: string): string {
  if (granularity === "month") {
    const [y, m] = period.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
  }
  const d = new Date(period);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function isCustomerRow(row: PipelineRow | CustomerRow): row is CustomerRow {
  return (row as CustomerRow).visits !== undefined;
}

// ── Small presentational pieces ──────────────────────────────────────────────

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-stone-200/80 shadow-sm ${className}`}>{children}</div>
  );
}

function ChartFrame({
  title,
  subtitle,
  children,
  empty,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  empty: boolean;
}) {
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-stone-900">{title}</h3>
      <p className="text-sm text-stone-500 mb-4">{subtitle}</p>
      {empty ? (
        <p className="text-stone-400 text-center py-16 text-sm">No data for the selected filters</p>
      ) : (
        children
      )}
    </Card>
  );
}

/** One payment line → plain badge. Several → "Split" badge with a breakdown. */
function PaymentCell({ lines, isSplit }: { lines: PaymentLine[]; isSplit: boolean }) {
  const breakdown = lines
    .map((l) => `${l.method[0].toUpperCase() + l.method.slice(1)} ${inr(l.amount)}`)
    .join(" + ");

  if (!isSplit) {
    const method = lines[0]?.method ?? "";
    return (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border capitalize ${
          METHOD_BADGE[method] || "bg-stone-50 text-stone-600 border-stone-200"
        }`}
      >
        {method || "—"}
      </span>
    );
  }

  return (
    <div className="group/split relative inline-block">
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border cursor-help ${METHOD_BADGE.Split}`}
        title={breakdown}
      >
        Split
        <span className="text-[10px] font-normal opacity-70">×{lines.length}</span>
      </span>
      <p className="text-[10px] text-stone-500 mt-1 whitespace-nowrap">{breakdown}</p>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function DataPipeline() {
  // Filters
  const [preset, setPreset] = useState<DatePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customerInput, setCustomerInput] = useState("");
  const [customer, setCustomer] = useState("");
  const [artist, setArtist] = useState("");
  const [gender, setGender] = useState<GenderFilter>("all");
  const [method, setMethod] = useState<MethodFilter>("all");
  const [tableMode, setTableMode] = useState<TableMode>("visit");

  const { from: pFrom, to: pTo } = presetRange(preset);
  const from = preset === "custom" ? customFrom : pFrom;
  const to = preset === "custom" ? customTo : pTo;

  // Data
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [artistOptions, setArtistOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState<"" | "excel" | "pdf">("");

  const LIMIT = 50;

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (customer) params.set("customer", customer);
    if (artist) params.set("artist", artist);
    if (gender !== "all") params.set("gender", gender);
    if (method !== "all") params.set("method", method);
    return params.toString();
  }, [from, to, customer, artist, gender, method]);

  /** Human-readable list of active filters — reused by both exporters. */
  const filterSummary = useMemo(() => {
    const out: string[] = [];
    const presetLabel = PRESETS.find((p) => p.key === preset)?.label ?? "";
    out.push(`Range: ${presetLabel}${from && to ? ` (${fmtDate(from)} – ${fmtDate(to)})` : ""}`);
    if (customer) out.push(`Customer: ${customer}`);
    if (artist) out.push(`Artist: ${artist}`);
    if (gender !== "all") out.push(`Gender: ${GENDER_LABEL[gender]}`);
    if (method !== "all") out.push(`Payment: ${method[0].toUpperCase() + method.slice(1)}`);
    return out;
  }, [preset, from, to, customer, artist, gender, method]);

  const fetchData = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `${API}/api/data-pipeline?${queryString}&page=${page}&limit=${LIMIT}&groupBy=${tableMode}`,
        { credentials: "include", cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setData(json);
    } catch {
      setError("Failed to load Data Pipeline. Check your connection and try again.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [queryString, page, tableMode, from, to]);

  useEffect(() => {
    setPage(1);
  }, [queryString, tableMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetch(`${API}/api/data-pipeline/options`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { artists: [] }))
      .then((d) => setArtistOptions(d.artists ?? []))
      .catch(() => setArtistOptions([]));
  }, []);

  /** Fetch the FULL filtered set (not just this page) and hand it to an exporter. */
  const runExport = async (kind: "excel" | "pdf") => {
    setExporting(kind);
    try {
      const res = await fetch(`${API}/api/data-pipeline/export?${queryString}`, {
        credentials: "include",
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Export failed");

      const payload: ExportPayload = {
        summary: json.summary,
        artistPerformance: json.artistPerformance,
        rows: json.rows,
        range: json.range,
        filterSummary,
      };
      if (kind === "excel") exportPipelineExcel(payload);
      else exportPipelinePdf(payload);
    } catch {
      setError("Export failed. Please try again.");
    } finally {
      setExporting("");
    }
  };

  const clearFilters = () => {
    setPreset("month");
    setCustomFrom("");
    setCustomTo("");
    setCustomer("");
    setCustomerInput("");
    setArtist("");
    setGender("all");
    setMethod("all");
  };

  const hasFilters = !!customer || !!artist || gender !== "all" || method !== "all" || preset !== "month";

  const summary = data?.summary;
  const rows = data?.rows ?? [];
  const pagination = data?.pagination;

  const revenueChartData = (data?.revenueSeries.series ?? []).map((p) => ({
    ...p,
    label: periodLabel(p.period, data?.revenueSeries.granularity ?? "day"),
  }));

  const methodChartData = (data?.methodMix ?? []).map((m) => ({
    ...m,
    label: m.method[0].toUpperCase() + m.method.slice(1),
  }));

  const genderChartData = (data?.genderSplit.byCustomer ?? [])
    .filter((g) => g.count > 0)
    .map((g) => ({ ...g, label: GENDER_LABEL[g.gender] ?? g.gender }));

  const artistChartData = (data?.artistPerformance ?? []).slice(0, 12);

  const summaryCards = summary
    ? [
        { label: "Total Revenue", value: inr(summary.totalRevenue), sub: `${summary.totalVisits} visits` },
        { label: "Total Visits", value: summary.totalVisits.toLocaleString("en-IN") },
        { label: "Unique Customers", value: summary.uniqueCustomers.toLocaleString("en-IN") },
        { label: "Avg Ticket", value: inr(summary.avgTicket) },
        summary.attributedRevenue !== null
          ? {
              label: `Earned by ${summary.attributedTo}`,
              value: inr(summary.attributedRevenue),
              sub: "their services only",
            }
          : { label: "Discounts Given", value: inr(summary.totalDiscount) },
      ]
    : [];

  const methodCards = summary
    ? [
        { label: "Cash", value: inr(summary.cash), tone: "text-emerald-600" },
        { label: "Card", value: inr(summary.card), tone: "text-violet-600" },
        { label: "Online", value: inr(summary.online), tone: "text-blue-600" },
        {
          label: "Split Payments",
          value: `${summary.splitVisits}`,
          sub: summary.splitVisits > 0 ? inr(summary.splitRevenue) : "none in range",
          tone: "text-amber-600",
        },
      ]
    : [];

  const inputCls =
    "h-10 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400";
  const labelCls = "block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1";

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
            <Database className="w-6 h-6 text-amber-500" /> Data Pipeline
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            Filter across date, customer, artist, gender and payment method — then export exactly what you see
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => runExport("excel")}
            disabled={!!exporting || loading}
            className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-4 py-2.5 hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Download className="w-4 h-4" /> {exporting === "excel" ? "Preparing…" : "Excel"}
          </button>
          <button
            onClick={() => runExport("pdf")}
            disabled={!!exporting || loading}
            className="flex items-center gap-2 bg-amber-600 text-white text-sm rounded-xl px-4 py-2.5 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <FileText className="w-4 h-4" /> {exporting === "pdf" ? "Preparing…" : "PDF"}
          </button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <Card className="p-5 mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-stone-400" />
          {PRESETS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPreset(key)}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
                preset === key ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
              }`}
            >
              {label}
            </button>
          ))}
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="ml-auto flex items-center gap-1 text-xs text-stone-500 hover:text-red-600 transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Clear all
            </button>
          )}
        </div>

        {preset === "custom" && (
          <div className="flex flex-wrap gap-3 mb-3">
            <div>
              <label className={labelCls}>From</label>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>To</label>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className={inputCls} />
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {/* Customer */}
          <div className="flex gap-2 items-end">
            <div>
              <label className={labelCls}>Customer Name</label>
              <input
                type="text"
                placeholder="Search customer…"
                value={customerInput}
                onChange={(e) => setCustomerInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setCustomer(customerInput.trim());
                }}
                className={`${inputCls} w-full sm:w-44`}
              />
            </div>
            <button
              onClick={() => setCustomer(customerInput.trim())}
              className="h-10 w-10 flex items-center justify-center rounded-xl border border-stone-200 hover:border-amber-400 hover:text-amber-600 transition-all text-stone-500"
              title="Apply customer filter"
            >
              <Search className="w-4 h-4" />
            </button>
            {customer && (
              <button
                onClick={() => {
                  setCustomer("");
                  setCustomerInput("");
                }}
                className="text-xs text-red-500 hover:text-red-700"
              >
                Clear
              </button>
            )}
          </div>

          {/* Artist — sourced from names present in visits, so legacy names appear */}
          <div>
            <label className={labelCls}>Artist</label>
            <select value={artist} onChange={(e) => setArtist(e.target.value)} className={inputCls}>
              <option value="">All Artists</option>
              {artistOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          {/* Gender */}
          <div>
            <label className={labelCls}>Gender</label>
            <select value={gender} onChange={(e) => setGender(e.target.value as GenderFilter)} className={inputCls}>
              <option value="all">All</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="not_specified">Not specified</option>
            </select>
          </div>

          {/* Payment method */}
          <div>
            <label className={labelCls}>Payment Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as MethodFilter)} className={inputCls}>
              <option value="all">All Methods</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="online">Online</option>
              <option value="split">Split</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={fetchData}
              className="h-10 w-10 flex items-center justify-center rounded-xl border border-stone-200 hover:border-amber-400 hover:text-amber-600 transition-all text-stone-500"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {method !== "all" && method !== "split" && (
          <p className="text-xs text-stone-500 mt-3">
            Showing every visit with a {method} component — including split payments that used {method}.
          </p>
        )}
        {summary?.attributedRevenue != null && (
          <p className="text-xs text-stone-500 mt-3">
            <span className="font-medium text-stone-700">Total Revenue</span> counts every visit {summary.attributedTo}{" "}
            took part in ({inr(summary.totalRevenue)}).{" "}
            <span className="font-medium text-stone-700">Earned by {summary.attributedTo}</span> counts only the
            services they personally performed ({inr(summary.attributedRevenue)}) — the difference is work done by
            other artists on shared visits.
          </p>
        )}
      </Card>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}
      {data?.truncated && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This range exceeds the 20,000-visit scan limit. Narrow the date range for exact totals.
        </div>
      )}

      {/* ── Summary cards ── */}
      {summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
            {summaryCards.map((c) => (
              <Card key={c.label} className="p-5">
                <p className="text-2xl font-black text-stone-900">{c.value}</p>
                <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mt-0.5">{c.label}</p>
                {c.sub && <p className="text-xs text-stone-400 mt-0.5">{c.sub}</p>}
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {methodCards.map((c) => (
              <Card key={c.label} className="p-5">
                <p className={`text-2xl font-black ${c.tone}`}>{c.value}</p>
                <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mt-0.5">{c.label}</p>
                {c.sub && <p className="text-xs text-stone-400 mt-0.5">{c.sub}</p>}
              </Card>
            ))}
          </div>
        </>
      )}

      {/* ── Charts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="lg:col-span-2">
          <ChartFrame
            title="Revenue Over Time"
            subtitle={`Bucketed by ${data?.revenueSeries.granularity ?? "day"} for the selected range`}
            empty={revenueChartData.length === 0}
          >
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={revenueChartData} margin={{ left: 4, right: 12, top: 8 }}>
                <defs>
                  <linearGradient id="dpRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f4" vertical={false} />
                <XAxis dataKey="label" stroke="#d6d3d1" tick={{ fill: "#78716c", fontSize: 11 }} minTickGap={16} />
                <YAxis
                  stroke="#d6d3d1"
                  tick={{ fill: "#78716c", fontSize: 11 }}
                  tickFormatter={(v) => axisMoney(Number(v))}
                  width={58}
                />
                <Tooltip
                  contentStyle={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8 }}
                  formatter={(value: unknown, name: unknown) =>
                    name === "revenue"
                      ? [inr(Number(value)), "Revenue"]
                      : [`${value} visits`, "Visits"]
                  }
                />
                <Area type="monotone" dataKey="revenue" stroke="#f59e0b" strokeWidth={2} fill="url(#dpRevenue)" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
        </div>

        <ChartFrame
          title="Payment Method Mix"
          subtitle="Rupees collected per method — split visits contribute to each method they used"
          empty={methodChartData.length === 0}
        >
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={methodChartData}
                dataKey="amount"
                nameKey="label"
                innerRadius={62}
                outerRadius={96}
                paddingAngle={2}
              >
                {methodChartData.map((m) => (
                  <Cell key={m.method} fill={METHOD_COLORS[m.method] ?? "#a8a29e"} />
                ))}
              </Pie>
              <Tooltip formatter={(value: unknown) => inr(Number(value))} contentStyle={{ borderRadius: 8 }} />
              <Legend verticalAlign="bottom" height={28} />
            </PieChart>
          </ResponsiveContainer>
          {summary && summary.splitVisits > 0 && (
            <p className="text-xs text-stone-500 text-center -mt-2">
              Includes {summary.splitVisits} split payment{summary.splitVisits !== 1 ? "s" : ""} worth{" "}
              {inr(summary.splitRevenue)}
            </p>
          )}
        </ChartFrame>

        <ChartFrame
          title="Gender Split"
          subtitle={`By unique customer — ${data?.genderSplit.fillRate ?? 0}% of visits have a recorded gender`}
          empty={genderChartData.length === 0}
        >
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={genderChartData}
                dataKey="count"
                nameKey="label"
                innerRadius={62}
                outerRadius={96}
                paddingAngle={2}
              >
                {genderChartData.map((g) => (
                  <Cell key={g.gender} fill={GENDER_COLORS[g.gender] ?? "#a8a29e"} />
                ))}
              </Pie>
              <Tooltip formatter={(value: unknown) => `${value} customers`} contentStyle={{ borderRadius: 8 }} />
              <Legend verticalAlign="bottom" height={28} />
            </PieChart>
          </ResponsiveContainer>
          <p className="text-xs text-stone-400 text-center -mt-2">Based on available data</p>
        </ChartFrame>

        <div className="lg:col-span-2">
          <ChartFrame
            title="Artist Performance"
            subtitle="Revenue credited per service, so multi-artist visits are split correctly between artists"
            empty={artistChartData.length === 0}
          >
            <ResponsiveContainer width="100%" height={Math.max(260, artistChartData.length * 34)}>
              <BarChart data={artistChartData} layout="vertical" margin={{ left: 12, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f4" horizontal={false} />
                <XAxis
                  type="number"
                  stroke="#d6d3d1"
                  tick={{ fill: "#78716c", fontSize: 11 }}
                  tickFormatter={(v) => axisMoney(Number(v))}
                />
                <YAxis
                  dataKey="artist"
                  type="category"
                  width={140}
                  stroke="#d6d3d1"
                  tick={{ fill: "#44403c", fontSize: 12 }}
                />
                <Tooltip
                  cursor={{ fill: "#fafaf9" }}
                  contentStyle={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8 }}
                  formatter={(value: unknown, name: unknown) =>
                    name === "revenue" ? [inr(Number(value)), "Revenue"] : [`${value}`, "Visits"]
                  }
                />
                <Bar dataKey="revenue" radius={[0, 4, 4, 0]} barSize={18}>
                  {artistChartData.map((_, i) => (
                    <Cell key={i} fill={ARTIST_COLORS[i % ARTIST_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
              {artistChartData.slice(0, 3).map((a, i) => (
                <p key={a.artist} className="text-sm text-stone-500">
                  <span className="text-stone-900 font-medium">
                    #{i + 1} {a.artist}
                  </span>
                  {" — "}
                  {inr(a.revenue)}, {a.visits} visits
                </p>
              ))}
            </div>
          </ChartFrame>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <h3 className="text-lg font-semibold text-stone-900">
          {tableMode === "visit" ? "Visits" : "Customers"}
          {pagination && <span className="text-sm font-normal text-stone-500 ml-2">{pagination.total} rows</span>}
        </h3>
        <div className="flex items-center gap-1 bg-stone-100 rounded-xl p-1">
          <button
            onClick={() => setTableMode("visit")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              tableMode === "visit" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
            }`}
          >
            <Receipt className="w-3.5 h-3.5" /> Per visit
          </button>
          <button
            onClick={() => setTableMode("customer")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              tableMode === "customer" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
            }`}
          >
            <Users className="w-3.5 h-3.5" /> Unique customers
          </button>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: tableMode === "visit" ? "1180px" : "900px" }}>
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              {tableMode === "visit" ? (
                <>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Date</th>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Client</th>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Artist</th>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Services</th>
                  <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Subtotal</th>
                  <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Discount</th>
                  <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Total</th>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Payment</th>
                </>
              ) : (
                <>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Customer</th>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Gender</th>
                  <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Visits</th>
                  <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Total Spent</th>
                  <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Avg Ticket</th>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Artists Seen</th>
                  <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Last Visit</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-stone-100">
                  {Array.from({ length: tableMode === "visit" ? 8 : 7 }).map((__, j) => (
                    <td key={j} className="px-4 py-3.5">
                      <div className="h-4 bg-stone-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-16 text-center text-stone-400 text-sm">
                  No {tableMode === "visit" ? "visits" : "customers"} matched the active filters.
                </td>
              </tr>
            ) : (
              rows.map((row) =>
                isCustomerRow(row) ? (
                  <tr key={row.id} className="border-b border-stone-100 hover:bg-stone-50/50 transition-colors">
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-stone-800">{row.name}</p>
                      <p className="text-[11px] text-stone-400">{row.contact}</p>
                    </td>
                    <td className="px-4 py-3.5 text-stone-600">{GENDER_LABEL[row.gender] ?? row.gender}</td>
                    <td className="px-4 py-3.5 text-right text-stone-700 font-medium">{row.visits}</td>
                    <td className="px-4 py-3.5 text-right font-bold text-amber-600">{inr(row.totalSpent)}</td>
                    <td className="px-4 py-3.5 text-right text-stone-600">{inr(row.avgTicket)}</td>
                    <td className="px-4 py-3.5 text-stone-600 text-xs">{row.artistLabel}</td>
                    <td className="px-4 py-3.5 text-stone-600 whitespace-nowrap">{fmtDate(row.lastVisit)}</td>
                  </tr>
                ) : (
                  <tr key={row.id} className="border-b border-stone-100 hover:bg-stone-50/50 transition-colors">
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-stone-800 whitespace-nowrap">{fmtDate(row.date)}</p>
                      {row.startTime && (
                        <p className="text-[11px] text-stone-400 mt-0.5 whitespace-nowrap">
                          {row.startTime}–{row.endTime}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-stone-800 truncate max-w-[130px]" title={row.name}>
                        {row.name}
                      </p>
                      <p className="text-[11px] text-stone-400">{row.contact}</p>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1 max-w-[170px]">
                        {row.artists.length > 0 ? (
                          row.artists.map((a) => (
                            <span
                              key={a}
                              className="inline-block px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-medium whitespace-nowrap"
                            >
                              {a}
                            </span>
                          ))
                        ) : (
                          <span className="text-stone-500">{row.artistLabel}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {row.services.map((s, i) => (
                          <span
                            key={i}
                            className="inline-block px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 text-[11px] font-medium whitespace-nowrap"
                          >
                            {s.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right text-stone-600 whitespace-nowrap">{inr(row.subtotal)}</td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap">
                      {row.discountAmount > 0 ? (
                        <span className="text-red-500">
                          −{inr(row.discountAmount)}
                          <span className="text-[10px] text-stone-400 ml-1">({row.discountPercent}%)</span>
                        </span>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap font-bold text-amber-600">
                      {inr(row.finalTotal)}
                    </td>
                    <td className="px-4 py-3.5">
                      <PaymentCell lines={row.paymentLines} isSplit={row.isSplit} />
                    </td>
                  </tr>
                )
              )
            )}
          </tbody>
        </table>
      </Card>

      {/* ── Pagination ── */}
      {pagination && pagination.pages > 1 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mt-4 px-2">
          <p className="text-sm text-stone-500">
            Showing {(pagination.page - 1) * pagination.limit + 1}–
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
          </p>
          <div className="flex items-center gap-2">
            <button
              disabled={pagination.page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 text-sm text-stone-600 hover:border-stone-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <span className="text-sm text-stone-600 font-medium">
              {pagination.page} / {pagination.pages}
            </span>
            <button
              disabled={pagination.page >= pagination.pages}
              onClick={() => setPage((p) => p + 1)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 text-sm text-stone-600 hover:border-stone-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
