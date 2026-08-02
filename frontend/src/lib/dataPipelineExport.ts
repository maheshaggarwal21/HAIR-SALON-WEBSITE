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
}

export interface ExportPayload {
  summary: PipelineSummary;
  artistPerformance: ArtistPerf[];
  rows: PipelineRow[];
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

// ── Excel ────────────────────────────────────────────────────────────────────

/**
 * Workbook with three sheets: Summary (totals + active filters), Visits (the
 * filtered rows), and Artist Performance (per-artist revenue for the range).
 */
export function exportPipelineExcel(payload: ExportPayload): void {
  const { summary, rows, artistPerformance, range, filterSummary } = payload;
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
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 28 }, { wch: 34 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

  // ── Sheet 2: the filtered visit rows ──
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

  // ── Sheet 3: artist performance ──
  const artistRows =
    artistPerformance.length > 0
      ? artistPerformance.map((a) => ({
          Artist: a.artist,
          "Revenue (INR)": rupees(a.revenue),
          Visits: a.visits,
          Services: a.services,
          "Avg per visit (INR)": a.visits > 0 ? Math.round(a.revenue / a.visits) : 0,
        }))
      : [{ Note: "No artist activity in this range" }];
  const artistSheet = XLSX.utils.json_to_sheet(artistRows);
  artistSheet["!cols"] = [{ wch: 24 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(workbook, artistSheet, "Artist Performance");

  XLSX.writeFile(workbook, `data_pipeline_${fileStamp(range)}.xlsx`);
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/**
 * A formatted landscape report: title block, filter summary, totals grid,
 * artist table, then the visit table — every page numbered.
 */
export function exportPipelinePdf(payload: ExportPayload): void {
  const { summary, rows, artistPerformance, range, filterSummary } = payload;

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 36;
  let y = margin;

  // ── Header ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(28, 25, 23);
  doc.text(SALON_NAME, margin, y + 6);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(120, 113, 108);
  doc.text("Data Pipeline Report", margin, y + 22);

  doc.setFontSize(9);
  const generated = `Generated ${new Date().toLocaleString("en-IN")}`;
  doc.text(generated, pageWidth - margin - doc.getTextWidth(generated), y + 6);
  const rangeText = `${fmtDate(range.from)} — ${fmtDate(range.to)}`;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(180, 83, 9);
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

  // ── Summary totals grid ──
  const cards: [string, string][] = [
    ["Total Revenue", `INR ${summary.totalRevenue.toLocaleString("en-IN")}`],
    ["Visits", String(summary.totalVisits)],
    ["Unique Customers", String(summary.uniqueCustomers)],
    ["Avg Ticket", `INR ${summary.avgTicket.toLocaleString("en-IN")}`],
    ["Discounts", `INR ${summary.totalDiscount.toLocaleString("en-IN")}`],
  ];
  if (summary.attributedRevenue !== null) {
    cards.push([`Earned by ${summary.attributedTo}`, `INR ${summary.attributedRevenue.toLocaleString("en-IN")}`]);
  }
  const methodCards: [string, string][] = [
    ["Cash", `INR ${summary.cash.toLocaleString("en-IN")}`],
    ["Card", `INR ${summary.card.toLocaleString("en-IN")}`],
    ["Online", `INR ${summary.online.toLocaleString("en-IN")}`],
    ["Split visits", `${summary.splitVisits} (INR ${summary.splitRevenue.toLocaleString("en-IN")})`],
  ];

  const drawCards = (items: [string, string][], top: number): number => {
    const gap = 10;
    const cardW = (pageWidth - margin * 2 - gap * (items.length - 1)) / items.length;
    items.forEach(([label, value], i) => {
      const x = margin + i * (cardW + gap);
      doc.setFillColor(250, 248, 244);
      doc.setDrawColor(231, 229, 228);
      doc.roundedRect(x, top, cardW, 42, 4, 4, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(28, 25, 23);
      doc.text(value, x + 10, top + 20, { maxWidth: cardW - 20 });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(120, 113, 108);
      doc.text(label.toUpperCase(), x + 10, top + 33);
    });
    return top + 42 + 10;
  };

  y = drawCards(cards, y);
  y = drawCards(methodCards, y);
  y += 4;

  // ── Artist performance ──
  if (artistPerformance.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Artist", "Revenue (INR)", "Visits", "Services", "Avg / Visit (INR)"]],
      body: artistPerformance.map((a) => [
        a.artist,
        a.revenue.toLocaleString("en-IN"),
        String(a.visits),
        String(a.services),
        (a.visits > 0 ? Math.round(a.revenue / a.visits) : 0).toLocaleString("en-IN"),
      ]),
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 4, textColor: [41, 37, 36] },
      headStyles: { fillColor: [41, 37, 36], textColor: [255, 255, 255], fontSize: 8 },
      alternateRowStyles: { fillColor: [250, 248, 244] },
      // Narrow, left-anchored table — 5 short columns stretched across a full
      // landscape page leaves the numbers stranded from their labels.
      tableWidth: 430,
      columnStyles: {
        0: { cellWidth: 130 },
        1: { halign: "right", cellWidth: 90 },
        2: { halign: "right", cellWidth: 60 },
        3: { halign: "right", cellWidth: 60 },
        4: { halign: "right", cellWidth: 90 },
      },
      margin: { left: margin, right: margin },
      didDrawPage: () => {
        /* page numbers are stamped in a final pass below */
      },
    });
    // @ts-expect-error — lastAutoTable is attached at runtime by jspdf-autotable
    y = (doc.lastAutoTable?.finalY ?? y) + 18;
  }

  // ── Visit table ──
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
    theme: "grid",
    styles: {
      fontSize: 7.5,
      cellPadding: 3.5,
      textColor: [41, 37, 36],
      valign: "middle",
      overflow: "linebreak",
    },
    headStyles: { fillColor: [41, 37, 36], textColor: [255, 255, 255], fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 248, 244] },
    columnStyles: {
      0: { cellWidth: 56 },
      1: { cellWidth: 88 },
      2: { cellWidth: 92 },
      // Services is the only auto-width column — it absorbs the remainder.
      4: { halign: "right", cellWidth: 50 },
      5: { halign: "right", cellWidth: 68 },
      6: { halign: "right", cellWidth: 54, fontStyle: "bold" },
      // Wide enough for "Cash 1,050 + Online 100" on one line.
      7: { cellWidth: 132 },
    },
    margin: { left: margin, right: margin, bottom: 34 },
  });

  // ── Page numbers (final pass, so the total count is known) ──
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(146, 138, 133);
    const label = `Page ${i} of ${pageCount}`;
    doc.text(
      label,
      pageWidth - margin - doc.getTextWidth(label),
      doc.internal.pageSize.getHeight() - 18
    );
    doc.text(`${SALON_NAME} — Data Pipeline`, margin, doc.internal.pageSize.getHeight() - 18);
  }

  doc.save(`data_pipeline_${fileStamp(range)}.pdf`);
}
