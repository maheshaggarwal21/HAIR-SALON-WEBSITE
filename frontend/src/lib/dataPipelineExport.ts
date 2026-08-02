/**
 * @file dataPipelineExport.ts
 * @description Excel and PDF exporters for the Data Pipeline tab.
 *
 * Both take the SAME payload — the full filtered row set fetched from
 * /api/data-pipeline/export — so an export always matches what is on screen,
 * including rows on pages the user never scrolled to.
 *
 * Excel and PDF are deliberately separate code paths: the workbook is a
 * machine-readable dump across two sheets, while the PDF is a formatted report
 * with a header block, summary totals and a page-numbered table.
 */

import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

// ── Shared types ─────────────────────────────────────────────────────────────

export interface PaymentLine {
  method: "cash" | "card" | "online";
  amount: number;
}

export interface PipelineRow {
  id: string;
  date: string;
  name: string;
  contact: string;
  gender: "male" | "female" | "not_specified";
  artists: string[];
  artistLabel: string;
  serviceLabel: string;
  startTime: string | null;
  endTime: string | null;
  services: { name: string; price: number }[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  finalTotal: number;
  paymentLines: PaymentLine[];
  isSplit: boolean;
  methodLabel: string;
  filledBy: string;
}

export interface PipelineSummary {
  totalRevenue: number;
  totalVisits: number;
  uniqueCustomers: number;
  avgTicket: number;
  totalDiscount: number;
  cash: number;
  card: number;
  online: number;
  splitVisits: number;
  splitRevenue: number;
  /** Set only when an artist filter is active — that artist's earned share. */
  attributedRevenue: number | null;
  attributedTo: string | null;
}

export interface ArtistPerf {
  artist: string;
  revenue: number;
  visits: number;
  services: number;
  uniqueCustomers?: number;
  avgPerVisit?: number;
  /** Null when the artist has no Artist record, so no rate is configured. */
  commissionPct?: number | null;
  /** Attributed revenue × commissionPct. Null when the rate is unknown. */
  commissionEarned?: number | null;
  /** "Beard Trim ×12, Haircut ×4, +3 more" */
  topServices?: string;
}

export interface CustomerSummaryRow {
  id: string;
  name: string;
  contact: string;
  gender: "male" | "female" | "not_specified";
  visits: number;
  totalSpent: number;
  totalDiscount: number;
  avgTicket: number;
  firstVisit: string;
  lastVisit: string;
  serviceCount: number;
  topServices: string;
  artistLabel: string;
  methodLabel: string;
}

export interface ServiceSummaryRow {
  service: string;
  count: number;
  revenue: number;
  listRevenue: number;
  avgPrice: number;
  uniqueCustomers: number;
  artistCount: number;
}

export interface ExportPayload {
  summary: PipelineSummary;
  artistPerformance: ArtistPerf[];
  customerSummary: CustomerSummaryRow[];
  serviceSummary: ServiceSummaryRow[];
  rows: PipelineRow[];
  totals?: {
    customers: number;
    artists: number;
    services: number;
    visits: number;
    commissionOwed: number;
  };
  range: { from: string; to: string };
  /** Human-readable description of every active filter. */
  filterSummary: string[];
}

const SALON_NAME = "The Experts";

const GENDER_LABEL: Record<string, string> = {
  male: "Male",
  female: "Female",
  not_specified: "Not specified",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Plain rupee formatting — no symbol, so Excel treats the cell as a number. */
function rupees(n: number): number {
  return Math.round(Number(n) || 0);
}

/**
 * "Cash ₹200 + Online ₹200" — the per-line breakdown for a split.
 *
 * The rupee sign is optional because jsPDF's built-in Helvetica is WinAnsi
 * encoded and has no U+20B9 glyph — it renders as broken spacing. Excel has no
 * such limit, so the workbook keeps the symbol and the PDF uses a bare number.
 */
function lineBreakdown(lines: PaymentLine[], symbol = "₹"): string {
  return lines
    .map((l) => `${l.method[0].toUpperCase() + l.method.slice(1)} ${symbol}${l.amount.toLocaleString("en-IN")}`)
    .join(" + ");
}

function fileStamp(range: { from: string; to: string }): string {
  return `${range.from}_to_${range.to}`;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Quote a value per RFC 4180 — commas, quotes and newlines all need it. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * One CSV holding every section, because a CSV cannot carry sheets the way the
 * workbook does. Sections are separated by a blank line and a title row, which
 * Excel, Numbers and Sheets all open cleanly, and which `pandas.read_csv` can be
 * pointed at with `skiprows`.
 *
 * Depth follows the same toggle as the PDF: summary omits the per-visit rows.
 */
export function exportPipelineCsv(payload: ExportPayload, options: { mode: "summary" | "full" } = { mode: "full" }): void {
  const { summary, rows, artistPerformance, customerSummary, serviceSummary, totals, range, filterSummary } = payload;
  const lines: string[] = [];

  lines.push(csvRow([`${SALON_NAME} — Data Pipeline Report`]));
  lines.push(csvRow(["Range", `${fmtDate(range.from)} to ${fmtDate(range.to)}`]));
  lines.push(csvRow(["Generated", new Date().toLocaleString("en-IN")]));
  lines.push(csvRow(["Report depth", options.mode === "summary" ? "Summary (no per-visit rows)" : "Full detail"]));
  filterSummary.forEach((f, i) => lines.push(csvRow([i === 0 ? "Filters" : "", f])));

  lines.push("");
  lines.push(csvRow(["TOTALS"]));
  lines.push(csvRow(["Metric", "Value"]));
  lines.push(csvRow(["Total revenue", rupees(summary.totalRevenue)]));
  lines.push(csvRow(["Total visits", summary.totalVisits]));
  lines.push(csvRow(["Unique customers", summary.uniqueCustomers]));
  lines.push(csvRow(["Average ticket", rupees(summary.avgTicket)]));
  lines.push(csvRow(["Discounts given", rupees(summary.totalDiscount)]));
  lines.push(csvRow(["Cash collected", rupees(summary.cash)]));
  lines.push(csvRow(["Card collected", rupees(summary.card)]));
  lines.push(csvRow(["Online collected", rupees(summary.online)]));
  lines.push(csvRow(["Split payment visits", summary.splitVisits]));
  lines.push(csvRow(["Split payment revenue", rupees(summary.splitRevenue)]));
  lines.push(csvRow(["Commission owed to artists", rupees(totals?.commissionOwed ?? 0)]));
  if (summary.attributedRevenue != null) {
    lines.push(csvRow([`Revenue attributed to ${summary.attributedTo}`, rupees(summary.attributedRevenue)]));
  }

  lines.push("");
  lines.push(csvRow(["ARTISTS"]));
  lines.push(
    csvRow(["Artist", "Revenue (INR)", "Commission %", "Commission Owed (INR)", "Visits", "Services", "Customers", "Avg per Visit (INR)", "Contributed To"])
  );
  artistPerformance.forEach((a) =>
    lines.push(
      csvRow([
        a.artist,
        rupees(a.revenue),
        a.commissionPct ?? "",
        a.commissionEarned ?? "",
        a.visits,
        a.services,
        a.uniqueCustomers ?? "",
        a.avgPerVisit ?? "",
        a.topServices ?? "",
      ])
    )
  );

  lines.push("");
  lines.push(csvRow(["CUSTOMERS"]));
  lines.push(
    csvRow(["Customer", "Contact", "Gender", "Visits", "Total Paid (INR)", "Avg Ticket (INR)", "Discount (INR)", "Services Taken", "Service Breakdown", "Artists", "Methods", "First Visit", "Last Visit"])
  );
  (customerSummary ?? []).forEach((c) =>
    lines.push(
      csvRow([
        c.name,
        c.contact,
        GENDER_LABEL[c.gender] ?? c.gender,
        c.visits,
        rupees(c.totalSpent),
        rupees(c.avgTicket),
        rupees(c.totalDiscount),
        c.serviceCount,
        c.topServices,
        c.artistLabel,
        c.methodLabel,
        fmtDate(c.firstVisit),
        fmtDate(c.lastVisit),
      ])
    )
  );

  lines.push("");
  lines.push(csvRow(["SERVICES"]));
  lines.push(csvRow(["Service", "Times Sold", "Revenue (INR)", "At List Price (INR)", "Avg Price (INR)", "Customers", "Artists"]));
  (serviceSummary ?? []).forEach((s) =>
    lines.push(csvRow([s.service, s.count, rupees(s.revenue), rupees(s.listRevenue), rupees(s.avgPrice), s.uniqueCustomers, s.artistCount]))
  );

  if (options.mode === "full") {
    lines.push("");
    lines.push(csvRow(["VISITS"]));
    lines.push(
      csvRow(["Date", "Client", "Contact", "Gender", "Artist", "Services", "Subtotal (INR)", "Discount %", "Discount (INR)", "Total (INR)", "Method", "Breakdown", "Cash (INR)", "Card (INR)", "Online (INR)", "Filled By"])
    );
    rows.forEach((r) =>
      lines.push(
        csvRow([
          fmtDate(r.date),
          r.name,
          r.contact,
          GENDER_LABEL[r.gender] ?? r.gender,
          r.artistLabel,
          r.serviceLabel,
          rupees(r.subtotal),
          r.discountPercent,
          rupees(r.discountAmount),
          rupees(r.finalTotal),
          r.isSplit ? "Split" : r.methodLabel,
          lineBreakdown(r.paymentLines),
          rupees(r.paymentLines.find((l) => l.method === "cash")?.amount ?? 0),
          rupees(r.paymentLines.find((l) => l.method === "card")?.amount ?? 0),
          rupees(r.paymentLines.find((l) => l.method === "online")?.amount ?? 0),
          r.filledBy,
        ])
      )
    );
  }

  // A BOM makes Excel read the file as UTF-8; without it the ₹ signs in the
  // payment breakdown column arrive as mojibake.
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${options.mode === "summary" ? "salon_summary" : "data_pipeline"}_${fileStamp(range)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── Excel ────────────────────────────────────────────────────────────────────

/**
 * Workbook with a sheet per view: Summary, Artists, Customers, Services, and —
 * in full mode only — every individual visit. Summary mode drops that last
 * sheet, matching what the PDF and CSV toggles do.
 */
export function exportPipelineExcel(
  payload: ExportPayload,
  options: { mode: "summary" | "full" } = { mode: "full" }
): void {
  const { summary, rows, artistPerformance, customerSummary, serviceSummary, totals, range, filterSummary } = payload;
  const workbook = XLSX.utils.book_new();

  // ── Sheet 1: summary ──
  const summaryRows: (string | number)[][] = [
    [`${SALON_NAME} — Data Pipeline Report`],
    [`Range`, `${fmtDate(range.from)} to ${fmtDate(range.to)}`],
    [`Generated`, new Date().toLocaleString("en-IN")],
    [],
    ["Active filters"],
    ...filterSummary.map((f) => ["", f]),
    [],
    ["Metric", "Value"],
    ["Total revenue", rupees(summary.totalRevenue)],
    ["Total visits", summary.totalVisits],
    ["Unique customers", summary.uniqueCustomers],
    ["Average ticket", rupees(summary.avgTicket)],
    ["Discounts given", rupees(summary.totalDiscount)],
    ...(summary.attributedRevenue !== null
      ? [
          [],
          [`Revenue attributed to ${summary.attributedTo}`, rupees(summary.attributedRevenue)],
          [
            "Note",
            "Total revenue counts every visit this artist took part in. Attributed revenue counts only the services they personally performed.",
          ],
        ]
      : []),
    [],
    ["Collected by method", "Amount"],
    ["Cash", rupees(summary.cash)],
    ["Card", rupees(summary.card)],
    ["Online", rupees(summary.online)],
    [],
    ["Split payments (visits)", summary.splitVisits],
    ["Split payments (revenue)", rupees(summary.splitRevenue)],
    [],
    ["Commission owed to artists", rupees(totals?.commissionOwed ?? 0)],
    [],
    ["Report depth", options.mode === "summary" ? "Summary (no per-visit rows)" : "Full detail"],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 28 }, { wch: 34 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

  // ── Sheet 2: the filtered visit rows (full mode only) ──
  if (options.mode === "full") {
    const visitRows = rows.map((r) => ({
      Date: fmtDate(r.date),
      Client: r.name,
      Contact: r.contact,
      Gender: GENDER_LABEL[r.gender] ?? r.gender,
      Artist: r.artistLabel,
      Services: r.serviceLabel,
      "Subtotal (INR)": rupees(r.subtotal),
      "Discount %": r.discountPercent,
      "Discount (INR)": rupees(r.discountAmount),
      "Total (INR)": rupees(r.finalTotal),
      Method: r.isSplit ? "Split" : r.methodLabel,
      Breakdown: lineBreakdown(r.paymentLines),
      "Cash (INR)": rupees(r.paymentLines.find((l) => l.method === "cash")?.amount ?? 0),
      "Card (INR)": rupees(r.paymentLines.find((l) => l.method === "card")?.amount ?? 0),
      "Online (INR)": rupees(r.paymentLines.find((l) => l.method === "online")?.amount ?? 0),
      "Filled By": r.filledBy,
    }));

    const visitSheet = XLSX.utils.json_to_sheet(
      visitRows.length > 0 ? visitRows : [{ Note: "No visits matched the active filters" }]
    );
    if (visitRows.length > 0) {
      visitSheet["!cols"] = Object.keys(visitRows[0]).map((key) => ({
        wch:
          Math.min(
            46,
            Math.max(
              key.length,
              ...visitRows.map((r) => String((r as Record<string, unknown>)[key] ?? "").length)
            )
          ) + 2,
      }));
    }
    XLSX.utils.book_append_sheet(workbook, visitSheet, "Visits");
  }

  // ── Sheet 3: artist performance, including commission owed ──
  const artistRows =
    artistPerformance.length > 0
      ? artistPerformance.map((a) => ({
          Artist: a.artist,
          "Revenue (INR)": rupees(a.revenue),
          "Commission %": a.commissionPct ?? "",
          "Commission Owed (INR)": a.commissionEarned ?? "",
          Visits: a.visits,
          Services: a.services,
          Customers: a.uniqueCustomers ?? "",
          "Avg per visit (INR)": a.avgPerVisit ?? (a.visits > 0 ? Math.round(a.revenue / a.visits) : 0),
          "Contributed To": a.topServices ?? "",
        }))
      : [{ Note: "No artist activity in this range" }];
  const artistSheet = XLSX.utils.json_to_sheet(artistRows);
  artistSheet["!cols"] = [{ wch: 22 }, { wch: 15 }, { wch: 13 }, { wch: 21 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 18 }, { wch: 52 }];
  XLSX.utils.book_append_sheet(workbook, artistSheet, "Artists");

  // ── Sheet 4: per-customer totals ──
  const customerRows =
    customerSummary && customerSummary.length > 0
      ? customerSummary.map((c) => ({
          Customer: c.name,
          Contact: c.contact,
          Gender: GENDER_LABEL[c.gender] ?? c.gender,
          Visits: c.visits,
          "Total Paid (INR)": rupees(c.totalSpent),
          "Avg Ticket (INR)": rupees(c.avgTicket),
          "Discount (INR)": rupees(c.totalDiscount),
          "Services Taken": c.serviceCount,
          "Service Breakdown": c.topServices,
          Artists: c.artistLabel,
          Methods: c.methodLabel,
          "First Visit": fmtDate(c.firstVisit),
          "Last Visit": fmtDate(c.lastVisit),
        }))
      : [{ Note: "No customers matched the active filters" }];
  const customerSheet = XLSX.utils.json_to_sheet(customerRows);
  customerSheet["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 17 }, { wch: 17 }, { wch: 15 }, { wch: 15 }, { wch: 46 }, { wch: 30 }, { wch: 18 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(workbook, customerSheet, "Customers");

  // ── Sheet 5: per-service totals ──
  const serviceRows =
    serviceSummary && serviceSummary.length > 0
      ? serviceSummary.map((s2) => ({
          Service: s2.service,
          "Times Sold": s2.count,
          "Revenue (INR)": rupees(s2.revenue),
          "At List Price (INR)": rupees(s2.listRevenue),
          "Avg Price (INR)": rupees(s2.avgPrice),
          Customers: s2.uniqueCustomers,
          Artists: s2.artistCount,
        }))
      : [{ Note: "No services matched the active filters" }];
  const serviceSheet = XLSX.utils.json_to_sheet(serviceRows);
  serviceSheet["!cols"] = [{ wch: 40 }, { wch: 12 }, { wch: 15 }, { wch: 20 }, { wch: 16 }, { wch: 11 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(workbook, serviceSheet, "Services");

  XLSX.writeFile(
    workbook,
    `${options.mode === "summary" ? "salon_summary" : "data_pipeline"}_${fileStamp(range)}.xlsx`
  );
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/** A chart rasterised from the page, ready to embed. */
export interface ChartImage {
  title: string;
  dataUrl: string;
  width: number;
  height: number;
  /**
   * Values spelled out under the plot. Recharts draws its legend as HTML, not
   * SVG, so it is lost when the plot is serialised — without this the donut
   * slices would be unlabelled colours.
   */
  caption?: string;
}

export interface PdfOptions {
  /**
   * "summary" — a compressed report: totals, charts, and ranked rollups of
   *   customers, artists and services. No per-visit rows, so a full year fits
   *   in a handful of pages instead of 155.
   * "full" — the summary, followed by every individual visit.
   */
  mode: "summary" | "full";
  /**
   * Colour treatment. Mono keeps the report cheap to print on a black-and-white
   * office printer; colour tints the header bands and money columns so revenue,
   * commission and discounts are legible at a glance.
   */
  colored?: boolean;
  charts?: ChartImage[];
  /** How many rows to keep in each ranked table for summary mode. */
  topN?: number;
}

const PAGE_MARGIN = 36;

type RGB = [number, number, number];

/** The two colour treatments the report can be rendered in. */
interface Palette {
  head: RGB;
  headText: RGB;
  altRow: RGB;
  accent: RGB;
  money: RGB;
  positive: RGB;
  negative: RGB;
  muted: RGB;
  cardFill: RGB;
  cardBorder: RGB;
}

const MONO: Palette = {
  head: [41, 37, 36],
  headText: [255, 255, 255],
  altRow: [250, 248, 244],
  accent: [180, 83, 9],
  money: [41, 37, 36],
  positive: [41, 37, 36],
  negative: [41, 37, 36],
  muted: [120, 113, 108],
  cardFill: [250, 248, 244],
  cardBorder: [231, 229, 228],
};

const COLOUR: Palette = {
  head: [180, 83, 9],       // amber-700, matching the app's brand band
  headText: [255, 255, 255],
  altRow: [254, 247, 237],  // warm tint
  accent: [180, 83, 9],
  money: [180, 83, 9],      // revenue
  positive: [5, 150, 105],  // commission owed
  negative: [220, 38, 38],  // discounts
  muted: [120, 113, 108],
  cardFill: [255, 251, 245],
  cardBorder: [253, 230, 195],
};

/** Shared table styling so every table in the report reads as one document. */
function tableTheme(pal: Palette, extra: Record<string, unknown> = {}) {
  return {
    theme: "grid" as const,
    styles: { fontSize: 7.5, cellPadding: 3.5, textColor: [41, 37, 36] as RGB, overflow: "linebreak" as const },
    headStyles: { fillColor: pal.head, textColor: pal.headText, fontSize: 8 },
    alternateRowStyles: { fillColor: pal.altRow },
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, bottom: 34 },
    ...extra,
  };
}

/**
 * Tint whole columns of a table body. Used for the money columns so revenue,
 * commission and discount read differently without needing a legend.
 */
function tintColumns(map: Record<number, RGB>, bold: number[] = []) {
  return (data: { section: string; column: { index: number }; cell: { styles: Record<string, unknown> } }) => {
    if (data.section !== "body") return;
    const colour = map[data.column.index];
    if (colour) data.cell.styles.textColor = colour;
    if (bold.includes(data.column.index)) data.cell.styles.fontStyle = "bold";
  };
}

/** Y position just below the last table autoTable drew. */
function afterTable(doc: jsPDF, fallback: number): number {
  // @ts-expect-error — lastAutoTable is attached at runtime by jspdf-autotable
  return (doc.lastAutoTable?.finalY ?? fallback) + 18;
}

function drawSectionTitle(doc: jsPDF, text: string, y: number, sub?: string): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(28, 25, 23);
  doc.text(text, PAGE_MARGIN, y);
  // Measure the title while its own font is still active — measuring after
  // switching to the smaller subtitle font under-reports the width and the two
  // strings overlap.
  const titleWidth = doc.getTextWidth(text);
  if (sub) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120, 113, 108);
    doc.text(sub, PAGE_MARGIN + titleWidth + 10, y);
  }
  return y + 12;
}

/**
 * A formatted report. Summary mode is the compressed view: header, filters,
 * totals, charts, then ranked customer / artist / service tables. Full mode
 * appends the per-visit table on top of that.
 */
export function exportPipelinePdf(payload: ExportPayload, options: PdfOptions = { mode: "full" }): void {
  const { summary, rows, artistPerformance, customerSummary, serviceSummary, range, filterSummary, totals } = payload;
  const mode = options.mode ?? "full";
  const topN = options.topN ?? 25;
  const charts = options.charts ?? [];
  const pal = options.colored ? COLOUR : MONO;

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = PAGE_MARGIN;
  let y = margin;

  // ── Header ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(28, 25, 23);
  doc.text(SALON_NAME, margin, y + 6);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(120, 113, 108);
  doc.text(mode === "summary" ? "Salon Summary Report" : "Data Pipeline Report", margin, y + 22);

  doc.setFontSize(9);
  const generated = `Generated ${new Date().toLocaleString("en-IN")}`;
  doc.text(generated, pageWidth - margin - doc.getTextWidth(generated), y + 6);
  const rangeText = `${fmtDate(range.from)} — ${fmtDate(range.to)}`;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...pal.accent);
  doc.text(rangeText, pageWidth - margin - doc.getTextWidth(rangeText), y + 22);

  y += 34;
  doc.setDrawColor(231, 229, 228);
  doc.line(margin, y, pageWidth - margin, y);
  y += 16;

  // ── Active filters ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(120, 113, 108);
  doc.text("FILTERS", margin, y);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(68, 64, 60);
  const filterText = filterSummary.length > 0 ? filterSummary.join("   •   ") : "None";
  const wrapped = doc.splitTextToSize(filterText, pageWidth - margin * 2 - 60);
  doc.text(wrapped, margin + 56, y);
  y += Math.max(14, wrapped.length * 11) + 8;

  // ── Totals ──
  const cards: [string, string][] = [
    ["Total Revenue", `INR ${summary.totalRevenue.toLocaleString("en-IN")}`],
    ["Visits", String(summary.totalVisits)],
    ["Unique Customers", String(summary.uniqueCustomers)],
    ["Avg Ticket", `INR ${summary.avgTicket.toLocaleString("en-IN")}`],
    ["Discounts", `INR ${summary.totalDiscount.toLocaleString("en-IN")}`],
  ];
  if (summary.attributedRevenue !== null && summary.attributedRevenue !== undefined) {
    cards.push([`Earned by ${summary.attributedTo}`, `INR ${summary.attributedRevenue.toLocaleString("en-IN")}`]);
  }
  const methodCards: [string, string][] = [
    ["Cash", `INR ${summary.cash.toLocaleString("en-IN")}`],
    ["Card", `INR ${summary.card.toLocaleString("en-IN")}`],
    ["Online", `INR ${summary.online.toLocaleString("en-IN")}`],
    ["Split visits", `${summary.splitVisits} (INR ${summary.splitRevenue.toLocaleString("en-IN")})`],
    ["Commission Owed", `INR ${(totals?.commissionOwed ?? 0).toLocaleString("en-IN")}`],
  ];

  const drawCards = (items: [string, string][], top: number): number => {
    const gap = 10;
    const cardW = (pageWidth - margin * 2 - gap * (items.length - 1)) / items.length;
    items.forEach(([label, value], i) => {
      const x = margin + i * (cardW + gap);
      doc.setFillColor(...pal.cardFill);
      doc.setDrawColor(...pal.cardBorder);
      doc.roundedRect(x, top, cardW, 42, 4, 4, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...(options.colored ? pal.accent : ([28, 25, 23] as RGB)));
      doc.text(value, x + 10, top + 20, { maxWidth: cardW - 20 });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(120, 113, 108);
      doc.text(label.toUpperCase(), x + 10, top + 33, { maxWidth: cardW - 20 });
    });
    return top + 42 + 10;
  };

  y = drawCards(cards, y);
  y = drawCards(methodCards, y);
  y += 6;

  // ── Charts ──
  if (charts.length > 0) {
    y = drawSectionTitle(doc, "Overview", y, "charts as shown on screen");
    const gap = 16;
    const perRow = 2;
    const slotW = (pageWidth - margin * 2 - gap * (perRow - 1)) / perRow;
    // A fixed slot height keeps a wide line chart and a square donut on the
    // same baseline; each image is fitted inside and centred rather than
    // stretched, so nothing is distorted and no dead space is left behind.
    // Sized so both rows of a four-chart overview land on the first page
    // together with the totals, rather than one row spilling over by a few points.
    const slotH = 112;

    for (let i = 0; i < charts.length; i += perRow) {
      const slice = charts.slice(i, i + perRow);
      const rowH = slotH + 13 + (slice.some((c) => c.caption) ? 11 : 0);

      if (y + rowH > pageHeight - 44) {
        doc.addPage();
        y = margin;
      }

      slice.forEach((chart, j) => {
        const slotX = margin + j * (slotW + gap);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(68, 64, 60);
        doc.text(chart.title, slotX, y + 8);

        // Contain: scale down to fit the slot, never up past natural size.
        const scale = Math.min(slotW / chart.width, slotH / chart.height);
        const drawW = chart.width * scale;
        const drawH = chart.height * scale;
        const drawX = slotX + (slotW - drawW) / 2;

        try {
          doc.addImage(chart.dataUrl, "PNG", drawX, y + 13, drawW, drawH, undefined, "FAST");
        } catch {
          doc.setFont("helvetica", "normal");
          doc.setTextColor(168, 162, 158);
          doc.text("(chart unavailable)", slotX, y + 28);
        }

        if (chart.caption) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(120, 113, 108);
          const capLines = doc.splitTextToSize(chart.caption, slotW);
          doc.text(capLines.slice(0, 2), slotX, y + 13 + slotH + 9);
        }
      });
      y += rowH + 8;
    }
    y += 4;
  }

  // ── Artists, with commission owed ──
  if (artistPerformance.length > 0) {
    if (y > pageHeight - 150) { doc.addPage(); y = margin; }
    y = drawSectionTitle(doc, "Artists", y, "revenue credited per service; commission at each artist's rate");
    autoTable(doc, {
      startY: y,
      head: [["Artist", "Revenue (INR)", "Rate", "Commission (INR)", "Visits", "Services", "Customers", "Avg/Visit", "Contributed To"]],
      body: artistPerformance.map((a) => [
        a.artist,
        a.revenue.toLocaleString("en-IN"),
        a.commissionPct == null ? "n/a" : `${a.commissionPct}%`,
        a.commissionEarned == null ? "—" : a.commissionEarned.toLocaleString("en-IN"),
        String(a.visits),
        String(a.services),
        String(a.uniqueCustomers ?? "—"),
        (a.avgPerVisit ?? 0).toLocaleString("en-IN"),
        a.topServices ?? "",
      ]),
      // Foot cells carry their own alignment — autoTable does not apply
      // columnStyles.halign to the footer row.
      foot: [[
        { content: "TOTAL", styles: { halign: "left" as const } },
        {
          content: artistPerformance.reduce((s, a) => s + a.revenue, 0).toLocaleString("en-IN"),
          styles: { halign: "right" as const },
        },
        "",
        {
          content: (totals?.commissionOwed ?? 0).toLocaleString("en-IN"),
          styles: { halign: "right" as const },
        },
        "", "", "", "", "",
      ]],
      footStyles: {
        fillColor: options.colored ? ([253, 237, 213] as RGB) : ([245, 243, 240] as RGB),
        textColor: [28, 25, 23] as RGB,
        fontStyle: "bold",
        fontSize: 8,
      },
      ...tableTheme(pal, {
        columnStyles: {
          0: { cellWidth: 96 },
          1: { halign: "right", cellWidth: 76 },
          2: { halign: "right", cellWidth: 36 },
          3: { halign: "right", cellWidth: 84, fontStyle: "bold" },
          4: { halign: "right", cellWidth: 42 },
          5: { halign: "right", cellWidth: 48 },
          6: { halign: "right", cellWidth: 56 },
          7: { halign: "right", cellWidth: 52 },
          8: { cellWidth: 280 },
        },
        // revenue amber, commission green
        didParseCell: options.colored ? tintColumns({ 1: pal.money, 3: pal.positive }, [1, 3]) : undefined,
      }),
    });
    y = afterTable(doc, y);
  }

  // ── Customers ──
  if (customerSummary && customerSummary.length > 0) {
    const list = mode === "summary" ? customerSummary.slice(0, topN) : customerSummary;
    if (y > pageHeight - 150) { doc.addPage(); y = margin; }
    y = drawSectionTitle(
      doc,
      "Customers",
      y,
      mode === "summary" && customerSummary.length > topN
        ? `top ${topN} by spend of ${customerSummary.length}`
        : `${customerSummary.length} total`
    );
    autoTable(doc, {
      startY: y,
      head: [["Customer", "Contact", "Gender", "Visits", "Total Paid (INR)", "Avg Ticket", "Discount", "Services Taken", "Last Visit"]],
      body: list.map((c) => [
        c.name,
        c.contact,
        GENDER_LABEL[c.gender] ?? c.gender,
        String(c.visits),
        c.totalSpent.toLocaleString("en-IN"),
        c.avgTicket.toLocaleString("en-IN"),
        c.totalDiscount.toLocaleString("en-IN"),
        c.topServices,
        fmtDate(c.lastVisit),
      ]),
      ...tableTheme(pal, {
        columnStyles: {
          0: { cellWidth: 92 },
          1: { cellWidth: 64 },
          2: { cellWidth: 50 },
          3: { halign: "right", cellWidth: 38 },
          4: { halign: "right", cellWidth: 78, fontStyle: "bold" },
          5: { halign: "right", cellWidth: 56 },
          6: { halign: "right", cellWidth: 52 },
          7: { cellWidth: 216 },
          8: { cellWidth: 62 },
        },
        // total paid amber, discount red
        didParseCell: options.colored ? tintColumns({ 4: pal.money, 6: pal.negative }, [4]) : undefined,
      }),
    });
    y = afterTable(doc, y);
  }

  // ── Services ──
  if (serviceSummary && serviceSummary.length > 0) {
    const list = mode === "summary" ? serviceSummary.slice(0, topN) : serviceSummary;
    if (y > pageHeight - 150) { doc.addPage(); y = margin; }
    y = drawSectionTitle(
      doc,
      "Services",
      y,
      mode === "summary" && serviceSummary.length > topN
        ? `top ${topN} by revenue of ${serviceSummary.length}`
        : `${serviceSummary.length} total`
    );
    autoTable(doc, {
      startY: y,
      head: [["Service", "Times Sold", "Revenue (INR)", "At List Price", "Avg Price", "Customers", "Artists"]],
      body: list.map((s) => [
        s.service,
        String(s.count),
        s.revenue.toLocaleString("en-IN"),
        s.listRevenue.toLocaleString("en-IN"),
        s.avgPrice.toLocaleString("en-IN"),
        String(s.uniqueCustomers),
        String(s.artistCount),
      ]),
      ...tableTheme(pal, {
        columnStyles: {
          0: { cellWidth: 180 },
          1: { halign: "right", cellWidth: 62 },
          2: { halign: "right", cellWidth: 84, fontStyle: "bold" },
          3: { halign: "right", cellWidth: 72 },
          4: { halign: "right", cellWidth: 62 },
          5: { halign: "right", cellWidth: 62 },
          6: { halign: "right", cellWidth: 50 },
        },
        didParseCell: options.colored ? tintColumns({ 2: pal.money }, [2]) : undefined,
      }),
    });
    y = afterTable(doc, y);
  }

  // ── Per-visit detail (full mode only) ──
  if (mode === "full") {
    doc.addPage();
    y = margin;
    y = drawSectionTitle(doc, "Visits", y, `${rows.length} rows`);
    autoTable(doc, {
      startY: y,
      head: [["Date", "Client", "Artist", "Services", "Subtotal", "Discount", "Total", "Payment"]],
      body:
        rows.length > 0
          ? rows.map((r) => [
              fmtDate(r.date),
              `${r.name}\n${r.contact}`,
              r.artistLabel,
              r.serviceLabel,
              r.subtotal.toLocaleString("en-IN"),
              r.discountAmount > 0 ? `-${r.discountAmount.toLocaleString("en-IN")} (${r.discountPercent}%)` : "—",
              r.finalTotal.toLocaleString("en-IN"),
              r.isSplit ? `Split\n${lineBreakdown(r.paymentLines, "")}` : r.methodLabel,
            ])
          : [["—", "No visits matched the active filters", "", "", "", "", "", ""]],
      ...tableTheme(pal, {
        styles: { fontSize: 7.5, cellPadding: 3.5, textColor: [41, 37, 36], valign: "middle", overflow: "linebreak" },
        columnStyles: {
          0: { cellWidth: 56 },
          1: { cellWidth: 88 },
          2: { cellWidth: 92 },
          4: { halign: "right", cellWidth: 50 },
          5: { halign: "right", cellWidth: 68 },
          6: { halign: "right", cellWidth: 54, fontStyle: "bold" },
          7: { cellWidth: 132 },
        },
        didParseCell: options.colored ? tintColumns({ 5: pal.negative, 6: pal.money }) : undefined,
      }),
    });
  }

  // ── Page numbers (final pass, so the total count is known) ──
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(146, 138, 133);
    const label = `Page ${i} of ${pageCount}`;
    doc.text(label, pageWidth - margin - doc.getTextWidth(label), pageHeight - 18);
    doc.text(`${SALON_NAME} — ${mode === "summary" ? "Salon Summary" : "Data Pipeline"}`, margin, pageHeight - 18);
  }

  doc.save(
    `${mode === "summary" ? "salon_summary" : "data_pipeline"}${options.colored ? "_colour" : ""}_${fileStamp(range)}.pdf`
  );
}
