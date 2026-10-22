/**
 * @file exportLeads.js
 * @description A contacts sheet for WhatsApp marketing (AiSensy): every customer
 * who paid for a visit since 1 March 2026, one row per phone number.
 *
 * Run it YOURSELF on the salon computer, from backend/:
 *     node scripts/exportLeads.js                # since 1 March 2026
 *     node scripts/exportLeads.js 2026-06-01     # since another date
 * It writes a folder on the Desktop with a spreadsheet and CSV files. The
 * customer data goes straight from the database to your own disk. Do not email
 * the files, do not commit them, delete them when the import is done.
 *
 * READ-ONLY: it never changes the database.
 *
 * ── Consent (CLAUDE.md "Privacy and consent") ────────────────────────────────
 * WhatsApp MARKETING needs the person's agreement. The Customer collection holds
 * it (`marketing.whatsappOptIn`); today nobody has it recorded, so every row says
 * "Not recorded" and the "opted in only" file is empty. Messages about a booking
 * (confirmation, reminder) do not need it; promotions and broadcasts do.
 *
 * Rows that are NOT put in the import file but listed under "Needs review":
 * numbers that are not a real 10-digit mobile, obvious fakes (1234567890,
 * 9999999999), and the salon's own staff and artists.
 *
 * `buildLeads` is pure (no database) so it can be tested with made-up visits.
 */

const FAKE = new Set(["1234567890", "0123456789", "9876543210", "0000000000"]);
const PLACEHOLDER_NAMES = /^(na|n\/a|nil|none|unknown|customer|client|guest|test|-+|\.+|\d+)$/i;
const DAY = 86400000;

const last10 = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
const isMobile = (p) => /^[6-9]\d{9}$/.test(p);
const looksFake = (p) => FAKE.has(p) || /^(\d)\1{9}$/.test(p);

function titleCase(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}
const ymd = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);

/**
 * @param {object[]} visits  paid visits, oldest first: {name, contact, gender, date, finalTotal, services:[{name}], artist}
 * @param {Set<string>} staff  last-10 numbers of staff and artists
 * @param {Map<string,{at:Date,source:string}>} consent  numbers that agreed to WhatsApp marketing
 * @param {Date} now
 */
function buildLeads(visits, staff = new Set(), consent = new Map(), now = new Date()) {
  const byPhone = new Map();
  for (const v of visits) {
    const phone = last10(v.contact);
    const e =
      byPhone.get(phone) ??
      { phone, raw: String(v.contact ?? ""), visits: 0, spent: 0, first: v.date, last: v.date, names: new Map(), svc: new Map(), name: "", gender: null, lastServices: "" };
    e.visits++;
    e.spent += v.finalTotal || 0;
    e.last = v.date;
    e.gender = v.gender || e.gender;
    const nm = String(v.name ?? "").trim();
    if (nm && !PLACEHOLDER_NAMES.test(nm)) { e.name = nm; e.names.set(nm.toLowerCase(), 1); }
    const list = (v.services || []).map((s) => s.name).filter(Boolean);
    if (list.length) e.lastServices = list.join(", ");
    for (const s of list) e.svc.set(s, (e.svc.get(s) || 0) + 1);
    byPhone.set(phone, e);
  }

  const leads = [];
  const review = [];
  for (const e of byPhone.values()) {
    if (!isMobile(e.phone)) { review.push({ ...e, why: "Not a real 10-digit mobile number" }); continue; }
    if (looksFake(e.phone)) { review.push({ ...e, why: "Looks like a made-up number" }); continue; }
    if (staff.has(e.phone)) { review.push({ ...e, why: "Staff or artist number" }); continue; }

    const days = Math.max(0, Math.floor((now - new Date(e.last)) / DAY));
    const spent = Math.round(e.spent);
    const who = e.gender === "female" ? "Women" : e.gender === "male" ? "Men" : "";
    const segment = days > 120 ? "Lapsed (120+ days)" : days > 60 ? "Slipping (60-120 days)" : e.visits >= 3 ? "Regular" : e.visits === 1 && days <= 30 ? "New" : "Active";
    const tags = [who && who.toLowerCase(), e.visits >= 3 && "regular", e.visits >= 6 && "vip", days > 60 && "lapsed-60", days > 120 && "lapsed-120", e.visits === 1 && "one-visit"].filter(Boolean).join(" | ");
    const c = consent.get(e.phone);
    const name = titleCase(e.name);
    leads.push({
      Name: name || "Customer",
      "First name": name ? name.split(" ")[0] : "Customer",
      Phone: "91" + e.phone,
      Gender: who,
      "Visits since start": e.visits,
      "First visit": ymd(e.first),
      "Last visit": ymd(e.last),
      "Days since last visit": days,
      "Total spent (Rs)": spent,
      "Last services": e.lastServices,
      "Favourite service": [...e.svc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
      Segment: segment,
      Tags: tags,
      "WhatsApp marketing consent": c ? `Yes (${ymd(c.at)}${c.source ? ", " + c.source : ""})` : "Not recorded",
      "Name note": e.names.size > 1 ? "Different names used on this number (family sharing?)" : !name ? "No name recorded" : "",
    });
  }
  leads.sort((a, b) => b["Total spent (Rs)"] - a["Total spent (Rs)"]);
  return { leads, review };
}

/**
 * AiSensy's own sample file: first row = headers (any names), "Phone Number" and
 * "Tags" (tag1 | tag2). Every tag and every attribute must already exist in
 * AiSensy (Manage tab) or the import cannot use it, so the plain file has only
 * Name, Phone Number and Tags; the other file adds the attributes.
 */
const ATTRIBUTES = ["First name", "Gender", "Segment", "Last visit", "Days since last visit", "Visits since start", "Total spent (Rs)", "Favourite service", "Last services"];
function aisensyRows(leads, withAttributes) {
  return leads.map((l) => ({
    Name: l.Name,
    "Phone Number": l.Phone,
    Tags: l.Tags,
    ...(withAttributes ? Object.fromEntries(ATTRIBUTES.map((a) => [a, l[a]])) : {}),
  }));
}
const allTags = (leads) => [...new Set(leads.flatMap((l) => (l.Tags ? l.Tags.split(" | ") : [])))].sort();

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) => "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";

async function main() {
  const path = require("path");
  const fs = require("fs");
  const os = require("os");
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
  const mongoose = require("mongoose");
  const XLSX = require("xlsx");
  const since = process.argv[2] || "2026-03-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("Give the start date as YYYY-MM-DD, e.g. 2026-03-01");

  await mongoose.connect(process.env.MONGODB_URI);
  const Visit = require("../models/Visit");
  const Artist = require("../models/Artist");
  const User = require("../models/User");
  const Customer = require("../models/Customer");

  const from = new Date(`${since}T00:00:00+05:30`);
  const visits = await Visit.find({ date: { $gte: from }, paymentStatus: "success" }, { name: 1, contact: 1, gender: 1, date: 1, finalTotal: 1, "services.name": 1 }).sort({ date: 1 }).lean();
  const staff = new Set([...(await Artist.find({}, { phone: 1 }).lean()).map((a) => last10(a.phone)), ...(await User.find({}, { phone: 1 }).lean()).map((u) => last10(u.phone))].filter(Boolean));
  const consent = new Map((await Customer.find({ "marketing.whatsappOptIn": true }, { phone: 1, marketing: 1 }).lean()).map((c) => [last10(c.phone), { at: c.marketing.at || new Date(), source: c.marketing.source }]));
  await mongoose.disconnect();

  const { leads, review } = buildLeads(visits, staff, consent);
  const cols = Object.keys(leads[0] || { Name: "", Phone: "" });
  const optedIn = leads.filter((l) => l["WhatsApp marketing consent"].startsWith("Yes"));

  const dir = path.join(os.homedir(), "Desktop", `Leads-Export-${new Date().toISOString().slice(0, 10)}`);
  fs.mkdirSync(dir, { recursive: true });
  const plainCols = ["Name", "Phone Number", "Tags"];
  const attrCols = [...plainCols, ...ATTRIBUTES];
  fs.writeFileSync(path.join(dir, "1-AiSensy-import-simple.csv"), toCsv(aisensyRows(leads, false), plainCols));
  fs.writeFileSync(path.join(dir, "2-AiSensy-import-with-attributes.csv"), toCsv(aisensyRows(leads, true), attrCols));
  fs.writeFileSync(path.join(dir, "3-AiSensy-import-OPTED-IN-only.csv"), toCsv(aisensyRows(optedIn, true), attrCols));
  const tagList = allTags(leads);

  const seg = {};
  for (const l of leads) seg[l.Segment] = (seg[l.Segment] || 0) + 1;
  const readme = [
    ["WhatsApp marketing contacts"],
    [`Paid visits since ${since}, one row per phone number. Made on ${new Date().toISOString().slice(0, 10)}.`],
    [""],
    ["READ THIS BEFORE YOU BROADCAST"],
    ["WhatsApp (Meta) only lets a business send promotions and broadcasts to people who AGREED to receive them. A person giving their number at the counter is not that agreement."],
    ["Sending marketing to people who did not agree gets customers to press 'Block' and 'Report', which lowers the number's quality and can get it restricted or banned. It can also break privacy rules."],
    [`Right now ${optedIn.length} of ${leads.length} people have a recorded agreement. The file "3-AiSensy-import-OPTED-IN-only.csv" is the only one that is safe to broadcast to.`],
    ["Messages about a booking (confirmation, reminder) do not need this agreement."],
    ["How to get agreement: the website booking form has an unticked 'send me offers' box; ask at the counter and note it; or put a QR code that opens WhatsApp with 'Yes, send me offers'."],
    [""],
    ["HOW TO IMPORT INTO AISENSY"],
    ["1. In AiSensy, open the Manage tab and CREATE the tags listed on the 'Tags to create' sheet. A tag that does not exist yet cannot be imported."],
    ["2. File 1-AiSensy-import-simple.csv has only Name, Phone Number and Tags. Start with this one."],
    ["3. If you also want the extra details (segment, last visit, favourite service...), create each one as an ATTRIBUTE in AiSensy first (same Manage tab), then import 2-AiSensy-import-with-attributes.csv."],
    ["4. AiSensy > Contacts > Import > choose the CSV. The first row is the header row. Tags are separated with a vertical bar ( | ), exactly as AiSensy's sample file asks."],
    ["5. Phone numbers are written as 91XXXXXXXXXX. If you open a CSV in Excel and save it again, check the phone column did not turn into a number like 9.18E+11. Better: do not re-save, import the file as it is."],
    [""],
    ["WHAT IS IN THE SHEETS"],
    ["Contacts: every valid mobile number, biggest spenders first."],
    ["Tags to create: the tag names used in the files, to create in AiSensy before importing."],
    ["Needs review: numbers left out (wrong length, made-up, or staff) so you can fix them in Fix Numbers."],
    [""],
    ["COUNTS"],
    [`Valid contacts: ${leads.length}`],
    [`Left out for review: ${review.length}`],
    ...Object.entries(seg).map(([k, v]) => [`${k}: ${v}`]),
    [""],
    ["This file has customers' phone numbers. Keep it private, do not email or share it, and delete it after the import."],
  ];
  const wb = XLSX.utils.book_new();
  const ws0 = XLSX.utils.aoa_to_sheet(readme);
  ws0["!cols"] = [{ wch: 130 }];
  XLSX.utils.book_append_sheet(wb, ws0, "Read me");
  const ws1 = XLSX.utils.json_to_sheet(leads, { header: cols });
  ws1["!cols"] = cols.map((c) => ({ wch: Math.max(12, Math.min(40, c.length + 4)) }));
  ws1["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws1, "Contacts");
  const ws2 = XLSX.utils.json_to_sheet(review.map((r) => ({ "What is wrong": r.why, "Number as typed": r.raw, Name: r.name, Visits: r.visits, "Total spent (Rs)": Math.round(r.spent), "Last visit": ymd(r.last) })));
  ws2["!cols"] = [{ wch: 36 }, { wch: 18 }, { wch: 24 }, { wch: 8 }, { wch: 16 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Needs review");
  const wsT = XLSX.utils.json_to_sheet(tagList.map((t) => ({ "Tag to create in AiSensy": t, "How many contacts": leads.filter((l) => l.Tags.split(" | ").includes(t)).length })));
  wsT["!cols"] = [{ wch: 28 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsT, "Tags to create");
  XLSX.writeFile(wb, path.join(dir, "Leads.xlsx"));

  // Counts only: nothing personal is printed here.
  console.log(`Done. ${visits.length} paid visits -> ${leads.length} contacts, ${review.length} left out for review, ${optedIn.length} with recorded WhatsApp marketing consent.`);
  console.log(`Folder: ${dir}`);
}

module.exports = { buildLeads, toCsv, aisensyRows, allTags };
if (require.main === module) main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
