/**
 * @file backfillLostPayments.js
 * @description Recover payments Razorpay captured that never became a Visit.
 *
 * Reconciling Razorpay against the database found 14 captured payments with no
 * corresponding visit — money collected from customers that never reached the
 * salon's books. They were lost because the visit was only ever created by the
 * customer's browser after paying, with no server-side record and no webhook.
 *
 * What this script CAN recover from Razorpay: amount, payer name, phone,
 * payment method, and the exact time of capture.
 *
 * What it CANNOT recover: which services were performed, and by which artist.
 * Razorpay never sees those. Rather than invent them, each recovered visit
 * carries a clearly-labelled placeholder service and no artist, and is stamped
 * `filledBy: "Payment reconciliation"` so it is obvious in every report that
 * this row was reconstructed and needs completing from the salon's own records.
 *
 * Gender is required by the Visit schema. Every affected customer has visited
 * before, so it is read from their most recent prior visit rather than guessed.
 *
 * Usage:
 *   node scripts/backfillLostPayments.js            # dry run, writes nothing
 *   node scripts/backfillLostPayments.js --commit   # actually insert
 *   node scripts/backfillLostPayments.js --undo     # remove what it inserted
 */

require("dotenv").config({ path: __dirname + "//../.env" });
const mongoose = require("mongoose");
const Visit = require("../models/Visit");
const PaymentEvent = require("../models/PaymentEvent");

const COMMIT = process.argv.includes("--commit");
const UNDO = process.argv.includes("--undo");

/** Stamp that identifies a reconstructed row, and makes undo safe. */
const RECON_MARK = "Payment reconciliation";
const PLACEHOLDER_SERVICE = "Unrecorded services (payment recovered from Razorpay)";

/** Ignore the developer's own test transactions. */
const MIN_REAL_AMOUNT = 10;

const auth =
  "Basic " +
  Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");

const ist = (d) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const rs = (n) => "Rs" + Number(n).toLocaleString("en-IN");

async function fetchCapturedPayments() {
  const from = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);
  let items = [];
  let skip = 0;
  for (;;) {
    const res = await fetch(
      `https://api.razorpay.com/v1/payments?from=${from}&to=${to}&count=100&skip=${skip}`,
      { headers: { Authorization: auth } }
    );
    if (!res.ok) throw new Error(`Razorpay ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    items = items.concat(json.items || []);
    if (!json.items || json.items.length < 100) break;
    skip += 100;
    if (skip > 5000) break;
  }
  return items.filter((p) => p.status === "captured");
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  if (UNDO) {
    const doomed = await Visit.find({ filledBy: RECON_MARK }).select("_id razorpayPaymentId finalTotal name").lean();
    console.log(`Recovered visits currently in the database: ${doomed.length}`);
    doomed.forEach((v) => console.log(`   ${v.razorpayPaymentId}  ${rs(v.finalTotal)}  ${v.name}`));
    if (!COMMIT) {
      console.log("\nDry run. Re-run with --undo --commit to delete these.");
    } else {
      const ids = doomed.map((v) => v._id);
      const res = await Visit.deleteMany({ _id: { $in: ids } });
      await PaymentEvent.updateMany(
        { reconciledVisitId: { $in: ids } },
        { $set: { reconcileStatus: "unmatched", reconciledVisitId: null, reconciledAt: null } }
      );
      console.log(`\nDeleted ${res.deletedCount} recovered visits and reset their payment events.`);
    }
    await mongoose.disconnect();
    return;
  }

  const captured = await fetchCapturedPayments();
  const known = new Set((await Visit.distinct("razorpayPaymentId")).filter(Boolean));
  const orphans = captured.filter((p) => !known.has(p.id)).sort((a, b) => a.created_at - b.created_at);

  const real = orphans.filter((p) => p.amount / 100 >= MIN_REAL_AMOUNT);
  const tests = orphans.filter((p) => p.amount / 100 < MIN_REAL_AMOUNT);

  console.log(`captured at Razorpay : ${captured.length}`);
  console.log(`missing from the DB  : ${orphans.length}`);
  console.log(`  -> real payments   : ${real.length}  (${rs(real.reduce((s, p) => s + p.amount / 100, 0))})`);
  console.log(`  -> test payments   : ${tests.length}  (skipped: under ${rs(MIN_REAL_AMOUNT)})`);
  tests.forEach((p) => console.log(`       skipping ${p.id} ${rs(p.amount / 100)} ${p.notes?.customer_name || ""}`));

  console.log(`\n=== ${COMMIT ? "INSERTING" : "DRY RUN — nothing will be written"} ===\n`);

  const planned = [];
  for (const p of real) {
    const contact = String(p.contact || "").replace(/^\+91/, "").trim();
    const nameFromRzp = (p.notes?.customer_name || "").trim();

    // Gender is required by the schema. Read it from this customer's most
    // recent earlier visit instead of guessing.
    const prior = await Visit.findOne({ contact })
      .sort({ date: -1 })
      .select("gender name")
      .lean();

    const amount = Math.round(p.amount / 100);
    const when = new Date(p.created_at * 1000);

    planned.push({
      payment: p,
      doc: {
        schemaVersion: 1,
        name: nameFromRzp || prior?.name || "Unknown (recovered payment)",
        contact,
        gender: prior?.gender || "prefer_not",
        date: when,
        startTime: null,
        endTime: null,
        artist: null,
        services: [{ name: PLACEHOLDER_SERVICE, price: amount, serviceId: null, duration: null }],
        visitDurationMins: null,
        filledBy: RECON_MARK,
        subtotal: amount,
        discountPercent: 0,
        discountAmount: 0,
        finalTotal: amount,
        paymentMethod: "online",
        cashAmount: 0,
        cardAmount: 0,
        onlineAmount: amount,
        paymentStatus: "success",
        razorpayPaymentId: p.id,
        assignmentStatus: "not_required",
        lockUntilAssigned: false,
        paymentConfirmedAt: when,
      },
      genderSource: prior ? "previous visit" : "NO PRIOR VISIT — defaulted",
    });
  }

  planned.forEach((x, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${ist(x.doc.date).padEnd(24)} ${x.doc.name.padEnd(20)} ${x.doc.contact.padEnd(12)} ` +
        `${rs(x.doc.finalTotal).padStart(8)}  gender=${x.doc.gender} (${x.genderSource})`
    );
    console.log(`    ${x.doc.razorpayPaymentId}   artist: (unknown)   services: placeholder`);
  });

  const total = planned.reduce((s, x) => s + x.doc.finalTotal, 0);
  console.log(`\ntotal to restore: ${rs(total)} across ${planned.length} visits`);

  if (!COMMIT) {
    console.log("\nNothing written. Re-run with --commit to insert.");
    await mongoose.disconnect();
    return;
  }

  let inserted = 0;
  for (const x of planned) {
    // Guard against a double-run: the payment id is the natural key.
    const exists = await Visit.findOne({ razorpayPaymentId: x.doc.razorpayPaymentId }).select("_id").lean();
    if (exists) {
      console.log(`  skip (already present): ${x.doc.razorpayPaymentId}`);
      continue;
    }
    const visit = await Visit.create(x.doc);
    inserted += 1;

    await PaymentEvent.findOneAndUpdate(
      { razorpayPaymentId: x.payment.id },
      {
        $set: {
          razorpayOrderId: x.payment.order_id || null,
          amount: x.doc.finalTotal,
          method: x.payment.method || null,
          contact: x.doc.contact,
          customerName: x.doc.name,
          status: "captured",
          capturedAt: x.doc.date,
          source: "backfill",
          reconcileStatus: "matched",
          reconciledVisitId: visit._id,
          reconciledAt: new Date(),
          note: "Recovered by backfillLostPayments.js — services and artist unknown",
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    console.log(`  inserted ${x.doc.razorpayPaymentId}  ${rs(x.doc.finalTotal)}  ${x.doc.name}  -> visit ${visit._id}`);
  }

  console.log(`\nDone. ${inserted} visit(s) restored, ${rs(total)}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
