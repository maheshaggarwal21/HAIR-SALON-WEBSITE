/**
 * @file qr-spike.js
 * @description THROWAWAY spike (not deployed, not imported by anything): what does
 * Razorpay's UPI QR API really send back and in what order?
 *
 * Creates ONE single-use, fixed-amount ₹1 UPI QR (closes by itself after 10 min),
 * prints the full response, fetches the QR image, then polls the QR and its
 * payments every 3 seconds for 10 minutes and prints the raw JSON each time.
 * Scan the QR with a UPI app during that window and pay the ₹1; watch what shows
 * up, and (with the webhook logging in index.js) what the webhook receives.
 *
 *   RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... node scripts/qr-spike.js | tee qr-spike.out
 * or, with no variables set, it reads backend/.env like the other scripts.
 *
 * The key id decides the mode: rzp_test_… = test mode, rzp_live_… = a REAL ₹1.
 * The first line printed says which. The output contains the payer's UPI id and
 * phone number once someone pays: keep qr-spike.out private and delete it.
 *
 * Delete this file when the spike is finished.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const API = "https://api.razorpay.com/v1";
const POLL_MS = 3000;
const TOTAL_MS = 10 * 60 * 1000;
const CLOSE_AFTER_S = 600;

if (!KEY_ID || !KEY_SECRET) {
  console.error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (or put them in backend/.env).");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

/** Calls Razorpay and returns the status and the raw parsed (or raw text) body; never throws. */
async function rzp(method, urlPath, body) {
  try {
    const res = await fetch(API + urlPath, {
      method,
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the text */ }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: `fetch failed: ${err.message}` };
  }
}

(async () => {
  console.log(`[${stamp()}] mode: ${KEY_ID.startsWith("rzp_live_") ? "LIVE (a real ₹1)" : KEY_ID.startsWith("rzp_test_") ? "test" : "unknown key type"}`);

  const marker = `qr-spike-${Date.now()}`;
  const create = await rzp("POST", "/payments/qr_codes", {
    type: "upi_qr",
    name: "qr-spike",
    usage: "single_use",
    fixed_amount: true,
    payment_amount: 100, // paise = ₹1
    description: "qr-spike test, safe to ignore",
    close_by: Math.floor(Date.now() / 1000) + CLOSE_AFTER_S,
    notes: { spike: "qr-spike", marker },
  });
  console.log(`\n=== CREATE  HTTP ${create.status} ===`);
  console.log(JSON.stringify(create.json ?? create.text, null, 2));
  const qr = create.json;
  if (!qr?.id) {
    console.error("No QR id came back, stopping.");
    process.exit(1);
  }
  console.log(`\nmarker: ${marker}\nqr id: ${qr.id}\nimage_url: ${qr.image_url}`);

  // The image itself.
  if (qr.image_url) {
    try {
      const img = await fetch(qr.image_url);
      const bytes = (await img.arrayBuffer()).byteLength;
      console.log(`\n=== IMAGE  HTTP ${img.status}  content-type: ${img.headers.get("content-type")}  size: ${bytes} bytes  content-length header: ${img.headers.get("content-length")} ===`);
    } catch (err) {
      console.log(`\n=== IMAGE fetch failed: ${err.message} ===`);
    }
  }

  console.log(`\nPay ₹1 by scanning image_url now. Polling every ${POLL_MS / 1000}s for ${TOTAL_MS / 60000} minutes (Ctrl-C to stop).`);
  const started = Date.now();
  let tick = 0;
  while (Date.now() - started < TOTAL_MS) {
    tick++;
    const [one, pays] = await Promise.all([rzp("GET", `/payments/qr_codes/${qr.id}`), rzp("GET", `/payments/qr_codes/${qr.id}/payments`)]);
    console.log(`\n--- poll ${tick}  ${stamp()}  (+${Math.round((Date.now() - started) / 1000)}s) ---`);
    console.log(`QR       HTTP ${one.status}: ${JSON.stringify(one.json ?? one.text)}`);
    console.log(`PAYMENTS HTTP ${pays.status}: ${JSON.stringify(pays.json ?? pays.text)}`);
    await sleep(POLL_MS);
  }
  console.log(`\n[${stamp()}] done. The QR closes by itself at close_by. Delete this script and qr-spike.out.`);
})();
