/**
 * @file duplicateCustomerReport.js
 * @description A printable sheet of customer records that look like the same
 * person entered twice because a phone number was mistyped at the counter.
 *
 * Why this exists: payments and visit history are tracked PER PHONE NUMBER. A
 * returning client whose number is typed one digit wrong shows up as a brand
 * new customer with one visit, and the established record loses that payment.
 * The owner reviews this sheet, ticks "Same" or "Different" on each pair, and
 * only then does anyone correct the records.
 *
 * READ-ONLY. It never writes to the database and never merges anything; the
 * sheet says so in its header. Records are grouped by phone number (last 10
 * digits), the same rule the Customer backfill (M1) uses.
 *
 * Pairs are two different numbers that are close to each other:
 *   Group A  identical name, phone differs by ONE digit
 *   Group B  identical name, phone differs by two or three digits, or two swapped
 *   Group C  name differs a little as well (spelling, nickname, surname dropped)
 *            but the phone is one or two digits out, or has two digits swapped
 * The record with more visits (then more money) is the "established" one, the
 * other is the suspected duplicate.
 *
 * A short last section lists numbers that cannot be a mobile number at all
 * (wrong length, or not starting 6-9) — those cannot be matched to anyone.
 *
 * A last section lists money that did not end as a normal paid visit:
 *   - payments Razorpay shows as REFUNDED (full or part), matched back to the
 *     visit that carried the payment id so the client can be named
 *   - payments Razorpay shows as FAILED
 *   - visits that were paid but whose artist assignment never finished (they
 *     are left out of revenue until completed)
 * Razorpay is the source of truth for refunds and failures; the refunded
 * payments carry no phone number there, so the visit supplies it.
 *
 * Usage:
 *   node scripts/duplicateCustomerReport.js                  # PDF in ~/Downloads
 *   node scripts/duplicateCustomerReport.js --out some.pdf
 *   node scripts/duplicateCustomerReport.js --html-only      # keep just the HTML
 */

require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const Visit = require("../models/Visit");
const PaymentEvent = require("../models/PaymentEvent");

const argv = process.argv.slice(2);
const HTML_ONLY = argv.includes("--html-only");
const outArg = argv.indexOf("--out");
const stamp = new Date().toISOString().slice(0, 10);
const OUT_PDF =
  outArg >= 0 ? path.resolve(argv[outArg + 1]) : path.join(os.homedir(), "Downloads", `The_Experts_duplicate_customer_review_${stamp}.pdf`);
const OUT_HTML = OUT_PDF.replace(/\.pdf$/i, ".html");

/** Same rule as a visit that counts everywhere else (routes/visits.js SETTLED_VISIT). */
const SETTLED = {
  paymentStatus: "success",
  $or: [{ assignmentStatus: { $exists: false } }, { assignmentStatus: "not_required" }, { assignmentStatus: "completed" }],
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inr = (n) => "INR " + Math.round(n).toLocaleString("en-IN");
const day = (d) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

// ── Matching ─────────────────────────────────────────────────────────────────

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** "identical" | "similar" | null */
function nameMatch(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return null;
  if (x === y || x.replace(/ /g, "") === y.replace(/ /g, "")) return "identical";
  if (levenshtein(x, y) <= 3) return "similar";
  const [tx, ty] = [x.split(" "), y.split(" ")];
  if (tx[0] === ty[0] || tx[0].startsWith(ty[0]) || ty[0].startsWith(tx[0])) return "similar"; // surname dropped / nickname
  return null;
}

/** What differs between two 10-digit numbers, or null if they are not close. */
function phoneDiff(a, b) {
  if (a.length !== 10 || b.length !== 10) return null;
  const at = [];
  for (let i = 0; i < 10; i++) if (a[i] !== b[i]) at.push(i);
  if (at.length === 1) return { kind: 1, text: `digit ${at[0] + 1}: ${a[at[0]]} -> ${b[at[0]]}` };
  if (at.length === 2 && at[1] === at[0] + 1 && a[at[0]] === b[at[1]] && a[at[1]] === b[at[0]]) {
    return { kind: "swap", text: `digits ${at[0] + 1}-${at[1] + 1} swapped (${a.slice(at[0], at[1] + 1)} -> ${b.slice(at[0], at[1] + 1)})` };
  }
  if (at.length <= 3) return { kind: at.length, text: at.map((i) => `digit ${i + 1}: ${a[i]} -> ${b[i]}`).join("; ") };
  return null;
}

// ── Refunded / incomplete payments ───────────────────────────────────────────

async function razorpayPayments() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  const auth = "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const from = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);
  const items = [];
  for (let skip = 0; ; skip += 100) {
    const res = await fetch(`https://api.razorpay.com/v1/payments?from=${from}&to=${to}&count=100&skip=${skip}`, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Razorpay ${res.status}`);
    const page = (await res.json()).items;
    items.push(...page);
    if (page.length < 100) break;
  }
  return items;
}

/** Refunded and failed Razorpay payments (named via their visit) + paid-but-unassigned visits. */
async function gatherIncomplete() {
  let payments = null;
  let razorpayError = null;
  try {
    payments = await razorpayPayments();
  } catch (err) {
    razorpayError = err.message;
  }
  const bad = (payments || []).filter((p) => p.amount_refunded > 0 || p.status === "failed" || p.status === "refunded");
  const ids = bad.map((p) => p.id);
  const [vs, evs] = await Promise.all([
    Visit.find({ $or: [{ razorpayPaymentId: { $in: ids } }, { "paymentSnapshot.razorpayPaymentId": { $in: ids } }] }, { name: 1, contact: 1, finalTotal: 1, date: 1, paymentStatus: 1, assignmentStatus: 1, razorpayPaymentId: 1, "paymentSnapshot.razorpayPaymentId": 1 }).lean(),
    PaymentEvent.find({ razorpayPaymentId: { $in: ids } }, { razorpayPaymentId: 1, contact: 1, customerName: 1, reconcileStatus: 1 }).lean(),
  ]);
  const visitOf = new Map(vs.map((v) => [v.razorpayPaymentId || v.paymentSnapshot?.razorpayPaymentId, v]));
  const eventOf = new Map(evs.map((e) => [e.razorpayPaymentId, e]));
  const rows = bad.map((p) => {
    const v = visitOf.get(p.id);
    const e = eventOf.get(p.id);
    const refunded = p.amount_refunded / 100;
    return {
      kind: p.status === "failed" ? "Failed" : refunded >= p.amount / 100 ? "Refunded in full" : "Refunded in part",
      name: v?.name || e?.customerName || p.notes?.name || "",
      phone: String(v?.contact || e?.contact || p.contact || p.notes?.phone || "").replace(/^\+?91(?=\d{10}$)/, ""),
      id: p.id,
      at: p.created_at * 1000,
      paid: p.amount / 100,
      refunded,
      visit: v ? `${inr(v.finalTotal)} visit on ${day(v.date)} — still counted as revenue` : "no visit on record",
      reason: p.status === "failed" ? p.error_description || "" : "",
    };
  });
  rows.sort((a, b) => b.at - a.at);

  const pending = await Visit.find({ paymentStatus: "success", assignmentStatus: "pending" }, { name: 1, contact: 1, finalTotal: 1, date: 1 }).sort({ date: -1 }).lean();
  return { rows, pending, razorpayError, razorpayChecked: payments !== null };
}

// ── Report ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set (backend/.env)");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const visits = await Visit.find(SETTLED, { name: 1, contact: 1, finalTotal: 1, date: 1 }).lean();
  const incomplete = await gatherIncomplete();
  await mongoose.disconnect();

  /** phone (last 10 digits) -> record */
  const byPhone = new Map();
  const invalid = new Map();
  for (const v of visits) {
    const digits = String(v.contact || "").replace(/\D/g, "");
    const phone = digits.slice(-10);
    const target = /^[6-9]\d{9}$/.test(phone) && digits.length <= 12 ? byPhone : invalid;
    const key = target === byPhone ? phone : String(v.contact || "").trim() || "(blank)";
    const r = target.get(key) || { phone: key, visits: 0, revenue: 0, last: 0, names: new Map() };
    r.visits++;
    r.revenue += v.finalTotal || 0;
    r.last = Math.max(r.last, +new Date(v.date));
    const n = String(v.name || "").trim();
    if (n) r.names.set(n, (r.names.get(n) || 0) + 1);
    target.set(key, r);
  }
  const records = [...byPhone.values()];
  for (const r of records) {
    r.nameList = [...r.names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    r.name = r.nameList[0] || "";
  }

  // Bucket by first 3 + last 3 digits is NOT safe (a digit may be wrong there),
  // so compare within buckets keyed on each 7-of-10 pattern instead. Simple and
  // fast enough: ~1.4k records -> ~1M comparisons.
  const pairs = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const d = phoneDiff(records[i].phone, records[j].phone);
      if (!d) continue;
      const nm = nameMatch(records[i].name, records[j].name) || records[i].nameList.some((n) => records[j].nameList.some((m) => nameMatch(n, m) === "identical")) && "identical";
      if (!nm) continue;
      const [est, sus] = [records[i], records[j]].sort((p, q) => q.visits - p.visits || q.revenue - p.revenue);
      const diff = phoneDiff(est.phone, sus.phone);
      let group;
      if (nm === "identical" && diff.kind === 1) group = "A";
      else if (nm === "identical") group = "B";
      else if (diff.kind === 1 || diff.kind === 2 || diff.kind === "swap") group = "C";
      else continue;
      pairs.push({ group, est, sus, diff });
    }
  }
  const order = (p) => -(p.est.revenue + p.sus.revenue);
  pairs.sort((a, b) => a.group.localeCompare(b.group) || order(a) - order(b));

  const suspects = new Set(pairs.map((p) => p.sus.phone));
  const susRecords = [...suspects].map((ph) => byPhone.get(ph));
  const stat = {
    pairs: pairs.length,
    identical: pairs.filter((p) => p.group !== "C").length,
    customers: records.length,
    ifAll: records.length - suspects.size,
    revenue: susRecords.reduce((s, r) => s + r.revenue, 0),
    visits: susRecords.reduce((s, r) => s + r.visits, 0),
  };

  const cell = (r) =>
    `<div class="ph">${esc(r.phone)}</div><div class="sub">${r.visits} visit${r.visits === 1 ? "" : "s"} · ${inr(r.revenue)}</div><div class="sub">last ${day(r.last)}</div>`;
  const nameCell = (e, s) => {
    const names = [...new Set([...e.nameList, ...s.nameList])];
    return `<b>${esc(names[0])}</b>${names.slice(1).map((n) => `<div class="sub">${esc(n)}</div>`).join("")}`;
  };
  const groupHtml = (g, title, note) => {
    const rows = pairs.filter((p) => p.group === g);
    if (!rows.length) return "";
    return `<h2>${title} <span class="n">(${rows.length})</span> <span class="note">${note}</span></h2>
<table><thead><tr><th>#</th><th>Name</th><th>Established record</th><th>Suspected duplicate</th><th>What differs</th><th>Same person?</th></tr></thead><tbody>
${rows.map((p, i) => `<tr><td>${i + 1}</td><td>${nameCell(p.est, p.sus)}</td><td>${cell(p.est)}</td><td>${cell(p.sus)}</td><td>${esc(p.diff.text)}</td><td class="tick">[&nbsp;&nbsp;&nbsp;] Same<br>[&nbsp;&nbsp;&nbsp;] Different</td></tr>`).join("\n")}
</tbody></table>`;
  };

  const invalidRows = [...invalid.values()].sort((a, b) => b.revenue - a.revenue);
  const invalidHtml = invalidRows.length
    ? `<h2>Numbers that cannot be a mobile number <span class="n">(${invalidRows.length})</span> <span class="note">Wrong length or not starting 6-9 — these cannot be matched to anyone until the correct number is found</span></h2>
<table><thead><tr><th>#</th><th>Name</th><th>Number as entered</th><th>Visits</th><th>Money</th><th>Last visit</th><th>Correct number</th></tr></thead><tbody>
${invalidRows.map((r, i) => { r.name = [...r.names.keys()][0] || ""; return `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="ph">${esc(r.phone)}</td><td>${r.visits}</td><td>${inr(r.revenue)}</td><td>${day(r.last)}</td><td>__________________</td></tr>`; }).join("\n")}
</tbody></table>`
    : "";

  const incHtml = (() => {
    const { rows, pending, razorpayError, razorpayChecked } = incomplete;
    if (!rows.length && !pending.length && razorpayChecked) return "";
    const money = (n) => (n ? inr(n) : "—");
    const rzp = rows.length
      ? `<table><thead><tr><th>#</th><th>Client</th><th>Outcome</th><th>Razorpay payment</th><th>Paid</th><th>Refunded</th><th>On our records</th><th>Notes</th></tr></thead><tbody>
${rows.map((x, i) => `<tr><td>${i + 1}</td><td><b>${esc(x.name || "(name not recorded)")}</b><div class="ph">${esc(x.phone || "no number")}</div></td><td>${x.kind}</td><td class="ph">${esc(x.id)}<div class="sub">${day(x.at)}</div></td><td>${inr(x.paid)}</td><td>${money(x.refunded)}</td><td>${esc(x.visit)}</td><td class="sub">${esc(x.reason)}&nbsp;</td></tr>`).join("\n")}
</tbody></table>`
      : `<p class="sub">${razorpayChecked ? "No refunded or failed payments found in Razorpay." : "Razorpay could not be checked" + (razorpayError ? " (" + esc(razorpayError) + ")" : " (keys not set)") + " — refunds are not listed."}</p>`;
    const pend = pending.length
      ? `<h3>Paid, but the artist assignment was never completed <span class="n">(${pending.length})</span></h3>
<p class="sub">The customer paid, but the visit was never finished on the assignment screen, so it is left out of revenue until someone completes it.</p>
<table><thead><tr><th>#</th><th>Client</th><th>Phone</th><th>Visit date</th><th>Amount</th><th>Resolved?</th></tr></thead><tbody>
${pending.map((v, i) => `<tr><td>${i + 1}</td><td><b>${esc(v.name)}</b></td><td class="ph">${esc(v.contact)}</td><td>${day(v.date)}</td><td>${inr(v.finalTotal)}</td><td class="tick">[&nbsp;&nbsp;&nbsp;] Done&nbsp;&nbsp;[&nbsp;&nbsp;&nbsp;] Not done</td></tr>`).join("\n")}
</tbody></table>`
      : "";
    return `<h2 style="page-break-before:always">Refunded and incomplete payments <span class="n">(${rows.length + pending.length})</span> <span class="note">Money that was returned through Razorpay or never became a finished visit</span></h2>
<p class="sub">Source: Razorpay (refunds and failures) and the visit record (client name and number). A refunded payment whose visit is still counted as revenue will overstate takings and needs correcting.</p>${rzp}${pend}`;
  })();

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>The Experts — Duplicate Review</title><style>
@page { size: A4 landscape; margin: 14mm 12mm 16mm; @bottom-center { content: "Page " counter(page) " of " counter(pages) "  ·  The Experts — Duplicate Review"; font: 8pt Helvetica, Arial, sans-serif; color: #888; } }
body { font: 9.5pt/1.35 Helvetica, Arial, sans-serif; color: #1c1917; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 2px; } .gen { color: #78716c; font-size: 9pt; margin-bottom: 10px; }
p { margin: 4px 0; } .stats { display: flex; gap: 10px; margin: 12px 0 8px; }
.stat { flex: 1; border: 1px solid #d6d3d1; border-radius: 6px; padding: 8px 10px; } .stat b { display: block; font-size: 15pt; } .stat span { font-size: 7.5pt; letter-spacing: .06em; color: #78716c; }
h2 { font-size: 12pt; margin: 18px 0 6px; } h2 .n { color: #78716c; font-weight: normal; } h2 .note { font-size: 9pt; color: #57534e; font-weight: normal; margin-left: 6px; }
table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 8pt; color: #57534e; border-bottom: 1.5px solid #a8a29e; padding: 4px 6px; }
td { vertical-align: top; padding: 6px; border-bottom: 1px solid #e7e5e4; } tr { page-break-inside: avoid; }
.ph { font-weight: 600; letter-spacing: .02em; } .sub { color: #78716c; font-size: 8.5pt; } .tick { white-space: nowrap; font-size: 9pt; }
.sign { margin-top: 28px; } h3 { font-size: 11pt; margin: 16px 0 4px; } h3 .n { color: #78716c; font-weight: normal; } </style></head><body>
<h1>The Experts</h1><div><b>Customer Records — Duplicate Review</b></div>
<div class="gen">Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · For verification — no records have been changed</div>
<p>Customer records are grouped by phone number, so the same person entered as "navdeep" and "Navdeep" is already counted once. The pairs below are different: the same or near-identical NAME with a phone number one or two digits apart. The usual pattern is an established customer alongside a one-visit record created when a number was mistyped at the counter.</p>
<p>Please mark each pair as the same person or two different people. Nothing has been merged and no totals have changed.</p>
<div class="stats">
<div class="stat"><b>${stat.pairs}</b><span>PAIRS TO REVIEW</span></div><div class="stat"><b>${stat.identical}</b><span>IDENTICAL NAME</span></div>
<div class="stat"><b>${stat.customers.toLocaleString("en-IN")}</b><span>CUSTOMERS ON RECORD</span></div><div class="stat"><b>${stat.ifAll.toLocaleString("en-IN")}</b><span>IF ALL CONFIRMED</span></div>
<div class="stat"><b>${inr(stat.revenue)}</b><span>REVENUE MISPLACED</span></div><div class="stat"><b>${stat.visits}</b><span>VISITS AFFECTED</span></div></div>
${groupHtml("A", "Group A — identical name, one digit different", "Very likely the same person")}
${groupHtml("B", "Group B — identical name, two digits different", "Likely the same person")}
${groupHtml("C", "Group C — name also differs", "Needs your judgement; some may genuinely be different people")}
${invalidHtml}
${incHtml}
<div class="sign"><p>Reviewed by Name: ______________________________ Date: ____________________</p>
<p>Return this sheet marked up and the confirmed pairs can be corrected. Nothing is changed until you confirm.</p></div>
</body></html>`;

  fs.writeFileSync(OUT_HTML, html);
  console.log(`pairs ${stat.pairs} (A ${pairs.filter((p) => p.group === "A").length}, B ${pairs.filter((p) => p.group === "B").length}, C ${pairs.filter((p) => p.group === "C").length}) · invalid numbers ${invalidRows.length} · refunded/failed ${incomplete.rows.length} · unassigned ${incomplete.pending.length} · customers ${stat.customers}`);
  if (HTML_ONLY) return console.log("HTML:", OUT_HTML);

  const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find(fs.existsSync);
  if (!chrome) return console.log("Chrome not found; open the HTML and print to PDF:", OUT_HTML);
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${OUT_PDF}`, `file://${OUT_HTML}`], { stdio: "ignore" });
  fs.unlinkSync(OUT_HTML);
  console.log("PDF:", OUT_PDF);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
