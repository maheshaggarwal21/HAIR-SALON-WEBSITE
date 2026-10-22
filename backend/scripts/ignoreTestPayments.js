/**
 * @file ignoreTestPayments.js
 * @description Take the two ₹1 QR-spike test payments out of the "payments collected
 * with no visit recorded" list, by marking them "ignored" (the status the app keeps
 * for test payments). NOTHING IS DELETED: the payment records stay, with a note.
 *
 * Run it YOURSELF, from backend/. It shows what it would change and changes nothing:
 *     node scripts/ignoreTestPayments.js
 * and only writes with --apply:
 *     node scripts/ignoreTestPayments.js --apply
 *
 * Safety: it only touches payments that are still "unmatched", captured, exactly ₹1, taken
 * on 22 Oct 2026 or later, and have no visit. Anything else is left alone. It prints every
 * id it finds so you can check them against the screen before using --apply.
 *
 * This hides the rows in the app. The ₹1 itself is still in Razorpay: refund it in
 * the Razorpay dashboard (Transactions → the payment → Refund) if you want it back.
 */

const path = require("path");
// The two test payments are found by what they are, not by a typed id: unmatched, captured,
// exactly ₹1, taken on 22 Oct 2026 or later, with no visit.
const SINCE = new Date("2026-10-22T00:00:00+05:30");

(async () => {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
  const mongoose = require("mongoose");
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI);
  const PaymentEvent = require("../models/PaymentEvent");
  const Visit = require("../models/Visit");

  const found = await PaymentEvent.find({ reconcileStatus: "unmatched", status: "captured", amount: 1, capturedAt: { $gte: SINCE } }).sort({ capturedAt: 1 }).lean();
  if (!found.length) console.log("No unmatched ₹1 payments found.");
  for (const e of found) {
    const id = e.razorpayPaymentId;
    const visit = await Visit.exists({ razorpayPaymentId: id });
    const when = new Date(e.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    console.log(`${id}: ₹${e.amount}, paid ${when} -> ${visit ? "HAS A VISIT, not touching" : apply ? "marking ignored" : "would mark ignored"}`);
    if (!visit && apply) {
      await PaymentEvent.updateOne(
        { razorpayPaymentId: id, reconcileStatus: "unmatched" },
        { $set: { reconcileStatus: "ignored", reconciledAt: new Date(), note: "₹1 test payment from the QR spike (22 Oct 2026), not a sale" } }
      );
    }
  }
  if (!apply) console.log("\nDry run. Run again with --apply to make the change.");
  await mongoose.disconnect();
})().catch((err) => { console.error("Failed:", err.message); process.exit(1); });
