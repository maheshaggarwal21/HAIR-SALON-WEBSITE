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
  Palette,
  Scissors,
} from "lucide-react";
import {
  exportPipelineExcel,
  exportPipelinePdf,
  type ExportPayload,
  type PipelineRow,
  type PipelineSummary,
  type ArtistPerf,
  type PaymentLine,
  type ChartImage,
} from "@/lib/dataPipelineExport";

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────

type DatePreset = "today" | "yesterday" | "month" | "3months" | "6months" | "year" | "custom";
type MethodFilter = "all" | "cash" | "card" | "online" | "split";
type GenderFilter = "all" | "male" | "female" | "not_specified";
type TableMode = "visit" | "customer" | "artist" | "service";

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
  serviceCount: number;
  topServices: string;
}

interface ServiceRow {
  service: string;
  count: number;
  revenue: number;
  listRevenue: number;
  avgPrice: number;
  uniqueCustomers: number;
  artistCount: number;
}

type AnyRow = PipelineRow | CustomerRow | ArtistPerf | ServiceRow;

/** One table column: how to label it, align it, and render a cell from a row. */
interface Column {
  key: string;
  label: string;
  align?: "left" | "right";
  width?: string;
  render: (row: AnyRow) => React.ReactNode;
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
  customerSummary: CustomerRow[];
  serviceSummary: ServiceRow[];
  totals: {
    customers: number;
    artists: number;
    services: number;
    visits: number;
    commissionOwed: number;
  };
  rows: AnyRow[];
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

const MODE_META: Record<
  TableMode,
  { label: string; title: string; noun: string; blurb: string; icon: React.ElementType; minWidth: string }
> = {
  visit: {
    label: "Per visit",
    title: "Visits",
    noun: "visits",
    blurb: "Every visit in the filtered range, one row each",
    icon: Receipt,
    minWidth: "1180px",
  },
  customer: {
    label: "Customers",
    title: "Customers",
    noun: "customers",
    blurb: "One row per client — total spent and services taken across the range",
    icon: Users,
    minWidth: "1080px",
  },
  artist: {
    label: "Artists",
    title: "Artists",
    noun: "artists",
    blurb: "Revenue credited per service, plus commission owed at each artist's rate",
    icon: Palette,
    minWidth: "1120px",
  },
  service: {
    label: "Services",
    title: "Services",
    noun: "services",
    blurb: "How often each service sold and what it brought in",
    icon: Scissors,
    minWidth: "900px",
  },
};

/** Small helper so long comma lists (services, artists) stay readable in a cell. */
function Muted({ text, max = 60 }: { text: string; max?: number }) {
  if (!text || text === "—") return <span className="text-stone-400">—</span>;
  return (
    <span className="text-stone-600 text-xs" title={text}>
      {text.length > max ? `${text.slice(0, max - 1)}…` : text}
    </span>
  );
}

// ── Small presentational pieces ──────────────────────────────────────────────

function Card({
  children,
  className = "",
  ...rest
}: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`bg-white rounded-2xl border border-stone-200/80 shadow-sm ${className}`} {...rest}>
      {children}
    </div>
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
    // data-chart lets the PDF exporter find and label this plot.
    <Card className="p-6" data-chart={empty ? undefined : title}>
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


/**
 * Rasterise a Recharts SVG so it can be embedded in the PDF.
 *
 * Recharts draws to inline SVG; jsPDF needs bitmap data. The clone is given an
 * explicit size and a font rule, because a detached SVG loses the page's
 * inherited CSS and would otherwise fall back to a serif default.
 */
async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<ChartImage | null> {
  try {
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return null;

    // A full-width chart on a wide monitor is ~1200px; 2x that is more pixels
    // than a landscape A4 column can use, and bloats the PDF. Cap the effective
    // scale so the embedded image stays near print resolution.
    const effectiveScale = Math.min(scale, Math.max(1, 1600 / box.width));

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(box.width));
    clone.setAttribute("height", String(box.height));

    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent =
      "text{font-family:Helvetica,Arial,sans-serif;} .recharts-cartesian-axis-tick text{font-size:11px;}";
    clone.insertBefore(style, clone.firstChild);

    const svgText = new XMLSerializer().serializeToString(clone);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;

    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg load failed"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width * effectiveScale);
    canvas.height = Math.round(box.height * effectiveScale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    return {
      title: "",
      dataUrl: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return null;
  }
}

/**
 * Grab every chart on the page, in display order, for the PDF.
 *
 * A chart card can contain several SVGs — Recharts draws each legend swatch as
 * its own 14px `<svg>`, and those come first in document order for the donuts.
 * Picking the largest by area reliably selects the plot itself.
 */
async function captureCharts(): Promise<ChartImage[]> {
  const holders = [...document.querySelectorAll<HTMLElement>("[data-chart]")];
  const out: ChartImage[] = [];

  for (const holder of holders) {
    const svgs = [...holder.querySelectorAll("svg")];
    if (svgs.length === 0) continue;

    const plot = svgs.reduce((biggest, candidate) => {
      const a = candidate.getBoundingClientRect();
      const b = biggest.getBoundingClientRect();
      return a.width * a.height > b.width * b.height ? candidate : biggest;
    });

    const box = plot.getBoundingClientRect();
    if (box.width < 80 || box.height < 80) continue; // still a swatch, not a plot

    const shot = await svgToPng(plot as SVGSVGElement);
    if (shot) out.push({ ...shot, title: holder.dataset.chart ?? "" });
  }
  return out;
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
  // "Summary report" collapses the PDF to totals + charts + rollups, dropping
  // the per-visit table that made a full-year export 155 pages.
  const [summaryPdf, setSummaryPdf] = useState(true);

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
        customerSummary: json.customerSummary ?? [],
        serviceSummary: json.serviceSummary ?? [],
        totals: json.totals,
        rows: json.rows,
        range: json.range,
        filterSummary,
      };
      if (kind === "excel") {
        exportPipelineExcel(payload);
      } else {
        // Charts are rasterised from the live DOM, so the PDF shows exactly
        // the plots on screen for the current filters.
        // Captions restore the information Recharts keeps in its HTML legend,
        // which is lost when only the SVG plot is rasterised.
        const captions: Record<string, string> = {
          "Payment Method Mix": (json.methodMix ?? [])
            .map((m: { method: string; amount: number }) =>
              `${m.method[0].toUpperCase() + m.method.slice(1)} ${inr(m.amount)}`)
            .join("  ·  "),
          "Gender Split": (json.genderSplit?.byCustomer ?? [])
            .filter((g: { count: number }) => g.count > 0)
            .map((g: { gender: string; count: number }) =>
              `${GENDER_LABEL[g.gender] ?? g.gender} ${g.count}`)
            .join("  ·  "),
          "Artist Performance": (json.artistPerformance ?? [])
            .slice(0, 3)
            .map((a: ArtistPerf, i: number) => `#${i + 1} ${a.artist} ${inr(a.revenue)}`)
            .join("  ·  "),
          "Revenue Over Time": `${json.revenueSeries?.granularity ?? "day"} buckets  ·  peak ${inr(
            Math.max(0, ...(json.revenueSeries?.series ?? []).map((x: { revenue: number }) => x.revenue))
          )}`,
        };
        const charts = summaryPdf
          ? (await captureCharts()).map((c) => ({ ...c, caption: captions[c.title] }))
          : [];
        exportPipelinePdf(payload, { mode: summaryPdf ? "summary" : "full", charts });
      }
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

  // ── Table columns per mode ────────────────────────────────────────────────
  // Declaring columns as data keeps four very different table shapes readable,
  // and lets the header, skeleton and body all derive from one definition.
  const columns: Column[] = useMemo(() => {
    if (tableMode === "customer") {
      return [
        { key: "name", label: "Customer", render: (r) => {
          const c = r as CustomerRow;
          return (<><p className="font-medium text-stone-800">{c.name}</p>
            <p className="text-[11px] text-stone-400">{c.contact}</p></>);
        }},
        { key: "gender", label: "Gender", render: (r) => (
          <span className="text-stone-600">{GENDER_LABEL[(r as CustomerRow).gender] ?? "—"}</span>) },
        { key: "visits", label: "Visits", align: "right", render: (r) => (
          <span className="text-stone-700 font-medium">{(r as CustomerRow).visits}</span>) },
        { key: "spent", label: "Total Paid", align: "right", render: (r) => (
          <span className="font-bold text-amber-600">{inr((r as CustomerRow).totalSpent)}</span>) },
        { key: "avg", label: "Avg Ticket", align: "right", render: (r) => (
          <span className="text-stone-600">{inr((r as CustomerRow).avgTicket)}</span>) },
        { key: "disc", label: "Discount", align: "right", render: (r) => (
          <span className="text-red-500">−{inr((r as CustomerRow).totalDiscount)}</span>) },
        { key: "svc", label: "Services Taken", render: (r) => (
          <Muted text={(r as CustomerRow).topServices} max={54} />) },
        { key: "artists", label: "Artists Seen", render: (r) => (
          <Muted text={(r as CustomerRow).artistLabel} max={34} />) },
        { key: "last", label: "Last Visit", align: "right", render: (r) => (
          <span className="text-stone-600">{fmtDate((r as CustomerRow).lastVisit)}</span>) },
      ];
    }

    if (tableMode === "artist") {
      return [
        { key: "artist", label: "Artist", render: (r) => (
          <span className="font-medium text-stone-800">{(r as ArtistPerf).artist}</span>) },
        { key: "revenue", label: "Revenue", align: "right", render: (r) => (
          <span className="font-bold text-amber-600">{inr((r as ArtistPerf).revenue)}</span>) },
        { key: "rate", label: "Rate", align: "right", render: (r) => {
          const a = r as ArtistPerf;
          return a.commissionPct == null
            ? <span className="text-stone-400" title="No artist record — commission rate unknown">n/a</span>
            : <span className="text-stone-600">{a.commissionPct}%</span>;
        }},
        { key: "commission", label: "Commission Owed", align: "right", render: (r) => {
          const a = r as ArtistPerf;
          return a.commissionEarned == null
            ? <span className="text-stone-400">—</span>
            : <span className="font-semibold text-emerald-600">{inr(a.commissionEarned)}</span>;
        }},
        { key: "visits", label: "Visits", align: "right", render: (r) => (
          <span className="text-stone-700">{(r as ArtistPerf).visits}</span>) },
        { key: "services", label: "Services", align: "right", render: (r) => (
          <span className="text-stone-700">{(r as ArtistPerf).services}</span>) },
        { key: "customers", label: "Customers", align: "right", render: (r) => (
          <span className="text-stone-700">{(r as ArtistPerf).uniqueCustomers ?? "—"}</span>) },
        { key: "avg", label: "Avg / Visit", align: "right", render: (r) => (
          <span className="text-stone-600">{inr((r as ArtistPerf).avgPerVisit ?? 0)}</span>) },
        { key: "top", label: "Contributed To", render: (r) => (
          <Muted text={(r as ArtistPerf).topServices ?? ""} max={56} />) },
      ];
    }

    if (tableMode === "service") {
      return [
        { key: "service", label: "Service", render: (r) => (
          <span className="font-medium text-stone-800">{(r as ServiceRow).service}</span>) },
        { key: "count", label: "Times Sold", align: "right", render: (r) => (
          <span className="text-stone-700 font-medium">{(r as ServiceRow).count}</span>) },
        { key: "revenue", label: "Revenue", align: "right", render: (r) => (
          <span className="font-bold text-amber-600">{inr((r as ServiceRow).revenue)}</span>) },
        { key: "list", label: "At List Price", align: "right", render: (r) => (
          <span className="text-stone-500">{inr((r as ServiceRow).listRevenue)}</span>) },
        { key: "avg", label: "Avg Price", align: "right", render: (r) => (
          <span className="text-stone-600">{inr((r as ServiceRow).avgPrice)}</span>) },
        { key: "cust", label: "Customers", align: "right", render: (r) => (
          <span className="text-stone-700">{(r as ServiceRow).uniqueCustomers}</span>) },
        { key: "artists", label: "Artists", align: "right", render: (r) => (
          <span className="text-stone-700">{(r as ServiceRow).artistCount}</span>) },
      ];
    }

    // Default: per-visit rows.
    return [
      { key: "date", label: "Date", width: "110px", render: (r) => {
        const v = r as PipelineRow;
        return (<><p className="font-medium text-stone-800 whitespace-nowrap">{fmtDate(v.date)}</p>
          {v.startTime && <p className="text-[11px] text-stone-400 mt-0.5 whitespace-nowrap">{v.startTime}–{v.endTime}</p>}</>);
      }},
      { key: "client", label: "Client", render: (r) => {
        const v = r as PipelineRow;
        return (<><p className="font-medium text-stone-800 truncate max-w-[130px]" title={v.name}>{v.name}</p>
          <p className="text-[11px] text-stone-400">{v.contact}</p></>);
      }},
      { key: "artist", label: "Artist", render: (r) => {
        const v = r as PipelineRow;
        return (
          <div className="flex flex-wrap gap-1 max-w-[170px]">
            {v.artists.length > 0 ? v.artists.map((a) => (
              <span key={a} className="inline-block px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-medium whitespace-nowrap">{a}</span>
            )) : <span className="text-stone-500">{v.artistLabel}</span>}
          </div>);
      }},
      { key: "services", label: "Services", render: (r) => (
        <div className="flex flex-wrap gap-1 max-w-[220px]">
          {(r as PipelineRow).services.map((s, i) => (
            <span key={i} className="inline-block px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 text-[11px] font-medium whitespace-nowrap">{s.name}</span>
          ))}
        </div>) },
      { key: "subtotal", label: "Subtotal", align: "right", render: (r) => (
        <span className="text-stone-600">{inr((r as PipelineRow).subtotal)}</span>) },
      { key: "discount", label: "Discount", align: "right", render: (r) => {
        const v = r as PipelineRow;
        return v.discountAmount > 0
          ? (<span className="text-red-500">−{inr(v.discountAmount)}<span className="text-[10px] text-stone-400 ml-1">({v.discountPercent}%)</span></span>)
          : <span className="text-stone-400">—</span>;
      }},
      { key: "total", label: "Total", align: "right", render: (r) => (
        <span className="font-bold text-amber-600">{inr((r as PipelineRow).finalTotal)}</span>) },
      { key: "payment", label: "Payment", render: (r) => {
        const v = r as PipelineRow;
        return <PaymentCell lines={v.paymentLines} isSplit={v.isSplit} />;
      }},
    ];
  }, [tableMode]);

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
        {
          label: "Commission Owed",
          value: inr(data?.totals?.commissionOwed ?? 0),
          sub: `${data?.totals?.artists ?? 0} artists`,
          tone: "text-stone-900",
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
        <div className="flex flex-col items-stretch sm:items-end gap-2">
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

          {/* Report depth — a full year of visit rows is ~155 pages, so the
              condensed report is the default. */}
          <label className="flex items-center gap-2 cursor-pointer select-none self-end">
            <span className={`text-xs ${summaryPdf ? "text-stone-400" : "text-stone-600 font-medium"}`}>
              Full detail
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={summaryPdf}
              onClick={() => setSummaryPdf((v) => !v)}
              className={`relative h-5 w-9 rounded-full transition-colors ${
                summaryPdf ? "bg-amber-500" : "bg-stone-300"
              }`}
              title={
                summaryPdf
                  ? "PDF shows totals, charts and ranked customer / artist / service tables"
                  : "PDF also appends every individual visit — long for wide date ranges"
              }
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                  summaryPdf ? "left-[1.125rem]" : "left-0.5"
                }`}
              />
            </button>
            <span className={`text-xs ${summaryPdf ? "text-stone-800 font-medium" : "text-stone-400"}`}>
              Summary report
            </span>
          </label>
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

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
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
        <div>
          <h3 className="text-lg font-semibold text-stone-900">
            {MODE_META[tableMode].title}
            {pagination && (
              <span className="text-sm font-normal text-stone-500 ml-2">{pagination.total} rows</span>
            )}
          </h3>
          <p className="text-xs text-stone-500 mt-0.5">{MODE_META[tableMode].blurb}</p>
        </div>
        <div className="flex items-center gap-1 bg-stone-100 rounded-xl p-1">
          {(Object.keys(MODE_META) as TableMode[]).map((mode) => {
            const Icon = MODE_META[mode].icon;
            return (
              <button
                key={mode}
                onClick={() => setTableMode(mode)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  tableMode === mode ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
                }`}
              >
                <Icon className="w-3.5 h-3.5" /> {MODE_META[mode].label}
              </button>
            );
          })}
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: MODE_META[tableMode].minWidth }}>
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-4 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500 ${
                    c.align === "right" ? "text-right" : "text-left"
                  }`}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-stone-100">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3.5">
                      <div className="h-4 bg-stone-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-6 py-16 text-center text-stone-400 text-sm">
                  No {MODE_META[tableMode].noun} matched the active filters.
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={(row as { id?: string }).id ?? i}
                  className="border-b border-stone-100 hover:bg-stone-50/50 transition-colors"
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-3.5 ${c.align === "right" ? "text-right whitespace-nowrap" : ""}`}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
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
