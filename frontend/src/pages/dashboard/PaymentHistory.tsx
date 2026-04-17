/**
 * @file PaymentHistory.tsx
 * @description Payment / visit history panel.
 *
 * Access: receptionist, manager, owner (all three roles).
 *
 * Features:
 *   - Date range filter (today / this month / 3 months / year / custom)
 *   - Artist name filter (free text)
 *   - Payment method filter (all / cash / card / online / partial)
 *   - Schema filter (all / legacy / v2)
 *   - Summary cards: Revenue, Cash, Card, Online, Discounts, Visit count
 *   - Paginated visits table
 *   - Client-side CSV export for the current filtered + loaded page
 */

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import * as XLSX from "xlsx";
import {
  Receipt,
  Filter,
  Download,
  ChevronLeft,
  ChevronRight,
  IndianRupee,
  Search,
  RefreshCw,
} from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ServiceSnapshot {
  name: string;
  price: number;
  artistName?: string | null;
}

interface VisitRecord {
  _id: string;
  name: string;
  contact: string;
  artist: string;
  services: ServiceSnapshot[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  finalTotal: number;
  paymentMethod: "online" | "cash" | "card" | "partial";
  cashAmount: number;
  cardAmount: number;
  onlineAmount: number;
  razorpayPaymentId: string | null;
  paymentStatus: "pending" | "success" | "failed";
  filledBy: string;
  date: string;
  startTime: string;
  endTime: string;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface Summary {
  totalRevenue: number;
  totalCash: number;
  totalCard: number;
  totalOnline: number;
  totalDiscount: number;
  count: number;
}

type DatePreset = "today" | "month" | "3months" | "year" | "custom";
type MethodFilter = "all" | "cash" | "card" | "online" | "partial";
type SchemaFilter = "all" | "legacy" | "v2";

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function fmtCurrency(n: number): string {
  return "₹" + n.toLocaleString("en-IN");
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

const METHOD_COLORS: Record<string, string> = {
  cash: "bg-green-50 text-green-700 border-green-200",
  card: "bg-violet-50 text-violet-700 border-violet-200",
  online: "bg-blue-50 text-blue-700 border-blue-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
};

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-50 text-green-700 border-green-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function PaymentHistory() {
  // Date preset + custom
  const [preset, setPreset] = useState<DatePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const { from: pFrom, to: pTo } = getPresetDates(preset);
  const from = preset === "custom" ? customFrom : pFrom;
  const to = preset === "custom" ? customTo : pTo;

  // Filters
  const [customerFilter, setCustomerFilter] = useState("");
  const [customerInput, setCustomerInput] = useState("");
  const [artistFilter, setArtistFilter] = useState("");
  const [artistInput, setArtistInput] = useState(""); // interim input
  const [methodFilter, setMethodFilter] = useState<MethodFilter>("all");
  const [schemaFilter, setSchemaFilter] = useState<SchemaFilter>("all");

  // Pagination
  const [page, setPage] = useState(1);
  const LIMIT = 50;

  // Data
  const [visits, setVisits] = useState<VisitRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");

  const fetchHistory = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setFetchError("");

    const params = new URLSearchParams({ from, to, page: String(page), limit: String(LIMIT) });
    // Always send schema filter so backend and UI stay in sync for mixed legacy/V2 views.
    params.set("schema", schemaFilter);
    if (customerFilter) params.set("customer", customerFilter);
    if (artistFilter) params.set("artist", artistFilter);
    if (methodFilter !== "all") params.set("method", methodFilter);

    try {
      const res = await fetch(`${API}/api/visits/history?${params}`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch");
      setVisits(data.visits);
      setPagination(data.pagination);
      setSummary(data.summary);
    } catch (err: unknown) {
      setFetchError("Failed to load payment history. Please check your connection and try again.");
      setVisits([]);
    } finally {
      setLoading(false);
    }
  }, [from, to, page, schemaFilter, customerFilter, artistFilter, methodFilter]);

  // Reset to page 1 when any filter changes
  useEffect(() => {
    setPage(1);
  }, [from, to, schemaFilter, customerFilter, artistFilter, methodFilter]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // ── Excel Export ─────────────────────────────────────────────────────────
  const handleExport = () => {
    if (!visits.length) return;

    const rows = visits.map((v) => ({
      Date: fmtDate(v.date),
      Client: v.name,
      Contact: v.contact,
      Artist: (() => {
        const names = [...new Set(v.services.map((s) => s.artistName).filter(Boolean))];
        return names.length > 0 ? names.join(", ") : v.artist;
      })(),
      Services: v.services.map((s) => `${s.name} (₹${s.price})`).join(" | "),
      "Subtotal (₹)": v.subtotal,
      "Discount %": v.discountPercent,
      "Discount (₹)": v.discountAmount,
      "Total (₹)": v.finalTotal,
      Method: v.paymentMethod,
      "Cash (₹)": v.cashAmount,
      "Card (₹)": v.cardAmount,
      "Online (₹)": v.onlineAmount,
      "Razorpay ID": v.razorpayPaymentId || "",
      Status: v.paymentStatus,
      "Filled By": v.filledBy,
      "Created At": fmtDateTime(v.createdAt),
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);

    // Auto-fit column widths
    const colWidths = Object.keys(rows[0]).map((key) => ({
      wch: Math.max(
        key.length,
        ...rows.map((r) => String((r as Record<string, unknown>)[key] ?? "").length)
      ) + 2,
    }));
    worksheet["!cols"] = colWidths;

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Payment History");
    XLSX.writeFile(workbook, `payments_${from}_to_${to}.xlsx`);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const presets: { key: DatePreset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "month", label: "This Month" },
    { key: "3months", label: "3 Months" },
    { key: "year", label: "This Year" },
    { key: "custom", label: "Custom" },
  ];

  const summaryCards = summary
    ? [
        { label: "Total Revenue", value: fmtCurrency(summary.totalRevenue), sub: `${summary.count} visits` },
        { label: "Cash Collected", value: fmtCurrency(summary.totalCash) },
        { label: "Card Collected", value: fmtCurrency(summary.totalCard) },
        { label: "Online Collected", value: fmtCurrency(summary.totalOnline) },
        { label: "Discounts Given", value: fmtCurrency(summary.totalDiscount) },
      ]
    : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
            <Receipt className="w-6 h-6 text-amber-500" /> Payment History
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            Browse and export all visit payment records
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={!visits.length}
          className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-5 py-2.5 hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all w-full sm:w-auto justify-center"
        >
          <Download className="w-4 h-4" /> Export Excel
        </button>
      </div>

      {/* ── Date Preset Tabs ── */}
      <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm p-5 mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-stone-400" />
          {presets.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPreset(key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                preset === key
                  ? "bg-stone-900 text-white"
                  : "bg-stone-100 text-stone-600 hover:bg-stone-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {preset === "custom" && (
          <div className="flex flex-wrap gap-3 mt-2">
            <div>
              <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">From</label>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-10 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">To</label>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-10 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
              />
            </div>
          </div>
        )}

        {/* Additional filters */}
        <div className="flex flex-wrap gap-3 mt-3">
          {/* Customer name search */}
          <div className="flex gap-2 items-end">
            <div>
              <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Customer Name</label>
              <input
                type="text"
                placeholder="Search customer…"
                value={customerInput}
                onChange={(e) => setCustomerInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") setCustomerFilter(customerInput.trim()); }}
                className="h-10 w-full sm:w-44 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
              />
            </div>
            <button
              onClick={() => setCustomerFilter(customerInput.trim())}
              className="h-10 w-10 flex items-center justify-center rounded-xl border border-stone-200 hover:border-amber-400 hover:text-amber-600 transition-all text-stone-500"
            >
              <Search className="w-4 h-4" />
            </button>
            {customerFilter && (
              <button
                onClick={() => { setCustomerFilter(""); setCustomerInput(""); }}
                className="text-xs text-red-500 hover:text-red-700 ml-1"
              >
                Clear
              </button>
            )}
          </div>

          {/* Artist search */}
          <div className="flex gap-2 items-end">
            <div>
              <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Artist</label>
              <input
                type="text"
                placeholder="Search artist…"
                value={artistInput}
                onChange={(e) => setArtistInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") setArtistFilter(artistInput.trim()); }}
                className="h-10 w-full sm:w-44 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
              />
            </div>
            <button
              onClick={() => setArtistFilter(artistInput.trim())}
              className="h-10 w-10 flex items-center justify-center rounded-xl border border-stone-200 hover:border-amber-400 hover:text-amber-600 transition-all text-stone-500"
            >
              <Search className="w-4 h-4" />
            </button>
            {artistFilter && (
              <button
                onClick={() => { setArtistFilter(""); setArtistInput(""); }}
                className="text-xs text-red-500 hover:text-red-700 ml-1"
              >
                Clear
              </button>
            )}
          </div>

          {/* Payment method */}
          <div>
            <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Method</label>
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value as MethodFilter)}
              className="h-10 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
            >
              <option value="all">All Methods</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="online">Online</option>
              <option value="partial">Partial</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Schema</label>
            <select
              value={schemaFilter}
              onChange={(e) => setSchemaFilter(e.target.value as SchemaFilter)}
              className="h-10 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
            >
              <option value="all">All Records</option>
              <option value="legacy">Legacy</option>
              <option value="v2">V2</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={fetchHistory}
              className="h-10 w-10 flex items-center justify-center rounded-xl border border-stone-200 hover:border-amber-400 hover:text-amber-600 transition-all text-stone-500"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {fetchError && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {fetchError}
        </div>
      )}

      {/* ── Summary Cards ── */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
          {summaryCards.map((c) => (
            <div
              key={c.label}
              className="bg-white rounded-xl border border-stone-200/80 p-5 shadow-sm"
            >
              <p className="text-2xl font-black text-stone-900">{c.value}</p>
              <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mt-0.5">
                {c.label}
              </p>
              {c.sub && <p className="text-xs text-stone-400 mt-0.5">{c.sub}</p>}
            </div>
          ))}
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-225">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Date</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Client</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Artist</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Services</th>
              <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Subtotal</th>
              <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Discount</th>
              <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Total</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Method</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-stone-100">
                    {Array.from({ length: 9 }).map((__, j) => (
                      <td key={j} className="px-4 py-3.5">
                        <div className="h-4 bg-stone-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : visits.length === 0
              ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-16 text-center text-stone-400 text-sm">
                      No visits found for the selected filters.
                    </td>
                  </tr>
                )
              : visits.map((v) => (
                  <tr
                    key={v._id}
                    className="group border-b border-stone-100 hover:bg-stone-50/50 transition-colors"
                  >
                    {/* Date */}
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-stone-800 whitespace-nowrap">
                        {fmtDate(v.date)}
                      </p>
                      <p className="text-[11px] text-stone-400 mt-0.5 whitespace-nowrap">
                        {v.startTime}–{v.endTime}
                      </p>
                    </td>

                    {/* Client */}
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-stone-800">{v.name}</p>
                      <p className="text-[11px] text-stone-400">{v.contact}</p>
                    </td>

                    {/* Artist */}
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {(() => {
                          const artistNames = [...new Set(
                            v.services
                              .map((s) => s.artistName)
                              .filter((n): n is string => !!n)
                          )];
                          if (artistNames.length > 0) {
                            return artistNames.map((name) => (
                              <span
                                key={name}
                                className="inline-block px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-medium whitespace-nowrap"
                              >
                                {name}
                              </span>
                            ));
                          }
                          return <span className="text-stone-700">{v.artist || "—"}</span>;
                        })()}
                      </div>
                    </td>

                    {/* Services */}
                    <td className="px-4 py-3.5 max-w-45">
                      <div className="flex flex-wrap gap-1">
                        {v.services.map((s, i) => (
                          <span
                            key={i}
                            className="inline-block px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 text-[11px] font-medium whitespace-nowrap"
                          >
                            {s.name}
                          </span>
                        ))}
                      </div>
                    </td>

                    {/* Subtotal */}
                    <td className="px-4 py-3.5 text-right text-stone-600 whitespace-nowrap">
                      {fmtCurrency(v.subtotal)}
                    </td>

                    {/* Discount */}
                    <td className="px-4 py-3.5 text-right whitespace-nowrap">
                      {v.discountAmount > 0 ? (
                        <span className="text-red-500">
                          −{fmtCurrency(v.discountAmount)}
                          <span className="text-[10px] text-stone-400 ml-1">({v.discountPercent}%)</span>
                        </span>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>

                    {/* Total */}
                    <td className="px-4 py-3.5 text-right whitespace-nowrap">
                      <span className="font-bold text-amber-600 flex items-center justify-end gap-0.5">
                        <IndianRupee className="w-3 h-3" />
                        {v.finalTotal.toLocaleString("en-IN")}
                      </span>
                      {v.paymentMethod === "partial" && (
                        <p className="text-[10px] text-stone-400 mt-0.5 text-right">
                          Cash {fmtCurrency(v.cashAmount)} + Online {fmtCurrency(v.onlineAmount)}
                        </p>
                      )}
                    </td>

                    {/* Method */}
                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border capitalize ${
                          METHOD_COLORS[v.paymentMethod] || ""
                        }`}
                      >
                        {v.paymentMethod}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border capitalize ${
                          STATUS_COLORS[v.paymentStatus] || ""
                        }`}
                      >
                        {v.paymentStatus}
                      </span>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {pagination && pagination.pages > 1 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mt-4 px-2">
          <p className="text-sm text-stone-500">
            Showing {(pagination.page - 1) * pagination.limit + 1}–
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} visits
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

      {/* Small note */}
      {pagination && pagination.pages <= 1 && pagination.total > 0 && (
        <p className="text-xs text-stone-400 mt-3 text-right">
          {pagination.total} visit{pagination.total !== 1 ? "s" : ""} total
        </p>
      )}
    </motion.div>
  );
}
