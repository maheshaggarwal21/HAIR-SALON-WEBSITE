/**
 * @file PaymentHistory.tsx
 * @description Payment / visit history panel.
 *
 * Access: receptionist, manager, owner (all three roles).
 *
 * Features:
 *   - Date range filter (today / yesterday / this month / 3 months / year / custom)
 *   - Client lookup by name or phone → that client's full history, all dates
 *   - Artist name filter (free text)
 *   - Payment method filter (all / cash / card / online / partial)
 *   - Schema filter (all / legacy / v2)
 *   - Summary cards: Revenue, Cash, Card, Online, Discounts, Visit count
 *     (never for the front-desk view — the server doesn't send them)
 *   - Paginated visits table
 *   - Client-side CSV export for the current filtered + loaded page
 */

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { useSearchParams } from "react-router-dom";
import { parseHistoryParams } from "@/lib/paymentLinks";
import { toLocalDateKey } from "@/lib/utils";
import UnreconciledPayments from "@/pages/dashboard/shared/UnreconciledPayments";
import { useRestriction } from "@/hooks/usePermission";
import { searchCustomers } from "@/services/api";
import type { CustomerSuggestion } from "@/types/visit";
import {
  Receipt,
  Filter,
  Download,
  ChevronLeft,
  ChevronRight,
  IndianRupee,
  Search,
  RefreshCw,
  ArrowLeft,
  UserRound,
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

type DatePreset = "today" | "yesterday" | "month" | "3months" | "year" | "custom";
type MethodFilter = "all" | "cash" | "card" | "online" | "partial";
type SchemaFilter = "all" | "legacy" | "v2";

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Local-timezone date key for the range presets.
 *
 * Previously `d.toISOString().slice(0, 10)`, which converts to UTC and so
 * rolled local midnight back a day in IST — "This Month" queried from the 31st
 * of the previous month, inflating every total by one extra day of visits.
 */
const formatDate = toLocalDateKey;

function getPresetDates(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const today = formatDate(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
      return { from: y, to: y };
    }
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

/** Visit.date is the calendar day at UTC midnight — read it back in UTC. */
function fmtVisitDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
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
  /**
   * `payments.today_only` is the front-desk view (CF D39): today and yesterday,
   * one client's full history through the lookup (rows only, no totals).
   *
   * The server enforces all of it regardless of what we send (see /history in
   * routes/visits.js) — this only keeps the UI honest, so a restricted user
   * sees a page that makes sense rather than date buttons that silently do
   * nothing.
   *
   * useRestriction, NOT usePermission: the latter reports true for the owner on
   * every key, which would restrict the owner. See the note on useRestriction.
   */
  const deskView = useRestriction("payments.today_only");

  // Date preset + custom
  const [preset, setPreset] = useState<DatePreset>(deskView ? "today" : "month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const effectivePreset: DatePreset =
    deskView && preset !== "today" && preset !== "yesterday" ? "today" : preset;
  const { from: pFrom, to: pTo } = getPresetDates(effectivePreset);
  const from = effectivePreset === "custom" ? customFrom : pFrom;
  const to = effectivePreset === "custom" ? customTo : pTo;

  /**
   * Client lookup. Typing shows matching previous clients (name or phone);
   * picking one switches the page to THAT client's history across all dates.
   * Enter without picking keeps the old behaviour: filter the date range by
   * name.
   */
  const [client, setClient] = useState<CustomerSuggestion | null>(null);
  const [clientMatches, setClientMatches] = useState<CustomerSuggestion[]>([]);
  const [clientMatchesOpen, setClientMatchesOpen] = useState(false);

  // Filters
  const [customerFilter, setCustomerFilter] = useState("");
  const [customerInput, setCustomerInput] = useState("");
  const [artistFilter, setArtistFilter] = useState("");
  const [artistInput, setArtistInput] = useState(""); // interim input
  const [methodFilter, setMethodFilter] = useState<MethodFilter>("all");
  const [schemaFilter, setSchemaFilter] = useState<SchemaFilter>("all");

  /**
   * Deep link (from Fix numbers & errors → Payment log errors): ?contact=, ?from=, ?to= only PRESELECT the
   * client lookup and the date range. Read on first load and whenever the URL changes; never written back when
   * the user changes a filter. Invalid values are ignored (see lib/paymentLinks.ts); the server still enforces
   * payments.view and the front-desk date clamp, so the URL is never trusted for access. With no params
   * nothing here changes anything.
   */
  const [searchParams] = useSearchParams();
  const urlKey = searchParams.toString();
  const [appliedUrlKey, setAppliedUrlKey] = useState<string | null>(null);
  if (appliedUrlKey !== urlKey) {
    setAppliedUrlKey(urlKey);
    const { contact: linkedContact, range: linkedRange } = parseHistoryParams(searchParams);
    if (linkedRange) {
      setPreset("custom");
      setCustomFrom(linkedRange.from);
      setCustomTo(linkedRange.to);
    }
    if (linkedContact) {
      setClient({ name: "", contact: linkedContact, gender: "other" });
      setCustomerInput("");
      setCustomerFilter("");
      setClientMatches([]);
      setClientMatchesOpen(false);
    }
  }

  // Pagination
  const [page, setPage] = useState(1);
  const LIMIT = 50;

  // Data
  const [visits, setVisits] = useState<VisitRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");

  useEffect(() => {
    const q = customerInput.trim();
    const query = /^[0-9]{3,10}$/.test(q)
      ? { phone: q }
      : q.replace(/\s/g, "").length >= 2 && !/\d/.test(q)
        ? { name: q }
        : null;
    if (!query || client) {
      setClientMatches([]);
      return;
    }
    let stale = false;
    const timeout = window.setTimeout(async () => {
      try {
        const found = await searchCustomers(query);
        if (!stale) setClientMatches(found);
      } catch {
        if (!stale) setClientMatches([]);
      }
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timeout);
    };
  }, [customerInput, client]);

  // A client opened from a link only has a number; fill in the name from the lookup when it is found.
  useEffect(() => {
    if (!client || client.name) return;
    let stale = false;
    searchCustomers({ phone: client.contact })
      .then((found) => {
        const match = found.find((c) => c.contact === client.contact);
        if (match && !stale) setClient(match);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [client]);

  const pickClient = (c: CustomerSuggestion) => {
    setClient(c);
    setCustomerInput(c.name);
    setCustomerFilter("");
    setClientMatches([]);
    setClientMatchesOpen(false);
  };

  const clearClient = () => {
    setClient(null);
    setCustomerInput("");
    setCustomerFilter("");
  };

  const fetchHistory = useCallback(async () => {
    if (!client && (!from || !to)) return;
    setLoading(true);
    setFetchError("");

    // A client's history ignores dates on the server; don't send them.
    const params = new URLSearchParams(
      client
        ? { contact: client.contact, page: String(page), limit: String(LIMIT) }
        : { from, to, page: String(page), limit: String(LIMIT) }
    );
    // Always send schema filter so backend and UI stay in sync for mixed legacy/V2 views.
    params.set("schema", schemaFilter);
    if (customerFilter && !client) params.set("customer", customerFilter);
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
    } catch {
      setFetchError("Failed to load payment history. Please check your connection and try again.");
      setVisits([]);
    } finally {
      setLoading(false);
    }
  }, [client, from, to, page, schemaFilter, customerFilter, artistFilter, methodFilter]);

  // Reset to page 1 when any filter changes
  useEffect(() => {
    setPage(1);
  }, [client, from, to, schemaFilter, customerFilter, artistFilter, methodFilter]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // ── Excel Export ─────────────────────────────────────────────────────────
  const handleExport = async () => {
    if (!visits.length) return;

    // xlsx is ~400 KB and is only needed the moment someone clicks Export.
    // Loading it here keeps it out of the main bundle entirely.
    const XLSX = await import("xlsx");

    const rows = visits.map((v) => ({
      Date: fmtVisitDay(v.date),
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
    XLSX.writeFile(
      workbook,
      client ? `payments_${client.contact}.xlsx` : `payments_${from}_to_${to}.xlsx`
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const presets: { key: DatePreset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "month", label: "This Month" },
    { key: "3months", label: "3 Months" },
    { key: "year", label: "This Year" },
    { key: "custom", label: "Custom" },
  ];

  const visiblePresets = deskView
    ? presets.filter((p) => p.key === "today" || p.key === "yesterday")
    : presets;

  // `summary` is null only for a single client's history; the day view has totals.
  const summaryCards = summary
    ? [
        {
          label: client ? "Total Spent" : "Total Revenue",
          value: fmtCurrency(summary.totalRevenue),
          sub: `${summary.count} visits`,
        },
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
            {deskView
              ? "Today's and yesterday's payments. Search a client to see everything they've paid since their first visit."
              : "Browse and export all visit payment records"}
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

      {/*
        Money Razorpay took that never became a visit. Renders nothing when
        everything reconciles, so it only appears when there is something to do.
        It sits above the filters deliberately — a gap here is not something to
        find by scrolling.
      */}
      <UnreconciledPayments />

      {/* ── Date Preset Tabs ── */}
      <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm p-5 mb-4">
        {client ? (
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <UserRound className="w-5 h-5 text-amber-600 shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold text-stone-900 truncate">
                  {client.name || "Client"} · {client.contact}
                </p>
                <p className="text-xs text-stone-500">
                  All visits
                  {client.firstVisitDate ? ` since ${fmtVisitDay(client.firstVisitDate)}` : ""}
                  {client.visitCount
                    ? ` · ${client.visitCount} visit${client.visitCount === 1 ? "" : "s"}`
                    : ""}
                </p>
              </div>
            </div>
            <button
              onClick={clearClient}
              className="flex items-center gap-1.5 text-sm font-medium text-stone-600 hover:text-stone-900"
            >
              <ArrowLeft className="w-4 h-4" /> Back to all payments
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Filter className="w-4 h-4 text-stone-400" />
            {visiblePresets.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPreset(key)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  effectivePreset === key
                    ? "bg-stone-900 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {!client && !deskView && preset === "custom" && (
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
          {/* Client lookup: name or phone */}
          <div className="flex gap-2 items-end">
            <div className="relative">
              <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Client</label>
              <input
                type="text"
                placeholder="Name or phone…"
                value={customerInput}
                onChange={(e) => {
                  setCustomerInput(e.target.value);
                  setClientMatchesOpen(true);
                  if (client) setClient(null);
                }}
                onFocus={() => setClientMatchesOpen(true)}
                onBlur={() => setClientMatchesOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setCustomerFilter(customerInput.trim());
                    setClientMatchesOpen(false);
                  }
                  if (e.key === "Escape") setClientMatchesOpen(false);
                }}
                autoComplete="off"
                className="h-10 w-full sm:w-56 px-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
              />
              {clientMatchesOpen && clientMatches.length > 0 && (
                <div className="absolute left-0 top-full z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-stone-200 bg-white shadow-lg overflow-hidden">
                  <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                    See a client's full history
                  </p>
                  {clientMatches.map((c) => (
                    <button
                      key={`${c.contact}-${c.name}`}
                      type="button"
                      // mousedown, not click: the input's blur closes this list first.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickClient(c);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-stone-50 transition-colors border-t border-stone-100"
                    >
                      <p className="text-sm font-medium text-stone-800">{c.name} · {c.contact}</p>
                      <p className="text-xs text-stone-500">
                        {c.visitCount ? `${c.visitCount} visit${c.visitCount === 1 ? "" : "s"}` : ""}
                        {c.lastVisitDate ? ` · last ${fmtVisitDay(c.lastVisitDate)}` : ""}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setCustomerFilter(customerInput.trim())}
              title="Filter these dates by name"
              className="h-10 w-10 flex items-center justify-center rounded-xl border border-stone-200 hover:border-amber-400 hover:text-amber-600 transition-all text-stone-500"
            >
              <Search className="w-4 h-4" />
            </button>
            {(customerFilter || client) && (
              <button
                onClick={clearClient}
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
        <table className="w-full text-sm" style={{ minWidth: "1100px" }}>
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ width: "110px" }}>Date</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ width: "130px" }}>Client</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ minWidth: "140px" }}>Artist</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ minWidth: "180px" }}>Services</th>
              <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ width: "90px" }}>Subtotal</th>
              <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ width: "100px" }}>Discount</th>
              <th className="text-right px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ width: "100px" }}>Total</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ width: "80px" }}>Method</th>
              <th className="text-left px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500" style={{ width: "80px" }}>Status</th>
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
                      {client
                        ? "No paid visits found for this client."
                        : "No visits found for the selected filters."}
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
                        {fmtVisitDay(v.date)}
                      </p>
                      <p className="text-[11px] text-stone-400 mt-0.5 whitespace-nowrap">
                        {v.startTime}–{v.endTime}
                      </p>
                    </td>

                    {/* Client */}
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-stone-800 truncate max-w-[120px]" title={v.name}>{v.name}</p>
                      <p className="text-[11px] text-stone-400">{v.contact}</p>
                    </td>

                    {/* Artist */}
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1 max-w-[160px]">
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
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
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
