/**
 * @file index.js
 * @description Express server for the Hair Salon application.
 *
 * Responsibilities:
 *   - Razorpay payment integration (Orders API + Payment Links)
 *   - Visit entry form dropdown data (fetched from MongoDB)
 *   - Health-check endpoint with MongoDB diagnostics
 *   - Analytics routes (delegated to ./routes/analytics)
 *
 * Deployed on Vercel as a serverless function via `module.exports = app`.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Razorpay = require("razorpay");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// ── Database ─────────────────────────────────────────────────────────────────
const connectDB = require("./db");
const Service = require("./models/Service");

// ── Owner-account seed ───────────────────────────────────────────────────────
// The owner account is seeded by `scripts/seedOwner.js` (run `npm run
// seed:owner` at deploy time), NOT lazily on the first request. Keeping it out
// of the request path means a cold serverless container no longer pays a
// bcrypt hash + DB round trip on its very first (login) request. See that file
// for the full rationale.

// ── New: session & auth packages ─────────────────────────────────────────────
const session = require("express-session");
const cookieParser = require("cookie-parser");
const MongoStore = require("connect-mongo").default;
const { authenticate, authorize, authorizePermission } = require("./middleware/authMiddleware");
const { PERMISSIONS } = require("./constants/permissions");
const whatsapp = require("./utils/whatsapp");
const { sessionSecret } = require("./utils/sessionSecret");
const { timersHealth } = require("./utils/timerHealth");

// Say loudly, once per cold start, which WhatsApp settings are missing (names only, never values).
if (process.env.NODE_ENV === "production") {
  const w = whatsapp.configStatus();
  const state = `provider=${w.provider} dryRun=${w.dryRun} testPhone=${w.testPhone}`;
  if (w.missing.length) console.error(`[whatsapp] SETTINGS MISSING — messages will be held back: ${w.missing.join(", ")} (${state})`);
  else console.log(`[whatsapp] ready (${state})`);
}

// ── Configuration ────────────────────────────────────────────────────────────
/** Allowed CORS origins — custom domains + local dev ports */
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  "https://www.thexpertshair.com",
  "https://thexpertshair.com",
  // Staff app's target home once the customer site takes the apex (T1.9, T1.23).
  "https://app.thexpertshair.com",
  "https://api.thexpertshair.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
];

/**
 * Accept any local dev origin on localhost/127.0.0.1 regardless of Vite port.
 */
function isLocalDevOrigin(origin) {
  if (!origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

/**
 * Check whether an origin is a Vercel preview/production URL.
 * Accepts any *.vercel.app origin — real security is handled by session auth.
 */
function isVercelOrigin(origin) {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();

// Required for secure cookies behind Vercel's reverse proxy
app.set("trust proxy", 1);

// CORS — allow configured frontend, Vercel previews + common Vite dev ports
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, same-origin)
    if (!origin || ALLOWED_ORIGINS.includes(origin) || isVercelOrigin(origin) || isLocalDevOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/**
 * POST /api/razorpay/webhook
 *
 * Razorpay calls this server-to-server the moment a payment is captured, so a
 * payment is recorded even if the customer's browser never completes the
 * follow-up calls that create the Visit. Reconciliation found 14 payments
 * (₹3,185.70) lost exactly that way before this existed.
 *
 * Mounted HERE, above express.json(), because the signature is computed over
 * the raw request body — parsing it first would change the bytes and every
 * signature check would fail. It also sits above the session and rate-limit
 * middleware: Razorpay has no cookie, and throttling a payment notification is
 * how money goes missing in the first place.
 */
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[webhook] RAZORPAY_WEBHOOK_SECRET is not set — rejecting");
      return res.status(503).json({ error: "Webhook not configured" });
    }

    const signature = req.get("x-razorpay-signature") || "";
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""));

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn("[webhook] signature mismatch — ignoring");
      return res.status(400).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Malformed payload" });
    }

    // The database write MUST finish before responding.
    //
    // This function runs on Vercel, where the instance is frozen as soon as the
    // response is sent — any work started after res.send() may simply never
    // execute. An earlier version acknowledged first and persisted afterwards;
    // it passed locally on a long-lived node process and silently dropped every
    // write in production, which is the exact failure this endpoint exists to
    // prevent. Razorpay allows several seconds, the write is a single indexed
    // upsert, and a 5xx makes Razorpay retry — which is the behaviour we want if
    // the database is briefly unavailable.
    try {
      const type = event?.event;
      const payment = event?.payload?.payment?.entity;
      // Nothing to record, but acknowledge so Razorpay stops retrying.
      if (!payment?.id) return res.status(200).json({ received: true, ignored: "no payment entity" });
      if (!["payment.captured", "payment.authorized", "payment.failed"].includes(type)) {
        return res.status(200).json({ received: true, ignored: type });
      }

      await connectDB();
      const PaymentEvent = require("./models/PaymentEvent");
      const Visit = require("./models/Visit");

      // Already recorded by the browser flow? Then this is simply confirmation.
      const visit = await Visit.findOne({ razorpayPaymentId: payment.id })
        .select("_id")
        .lean();

      await PaymentEvent.findOneAndUpdate(
        { razorpayPaymentId: payment.id },
        {
          $set: {
            razorpayOrderId: payment.order_id || null,
            amount: Math.round((payment.amount || 0) / 100),
            currency: payment.currency || "INR",
            method: payment.method || null,
            contact: String(payment.contact || "").replace(/^\+91/, "") || null,
            customerName: payment.notes?.customer_name || null,
            email: payment.email || null,
            status: payment.status || "captured",
            capturedAt: payment.created_at ? new Date(payment.created_at * 1000) : new Date(),
            source: "webhook",
            raw: payment,
            ...(visit
              ? { reconcileStatus: "matched", reconciledVisitId: visit._id, reconciledAt: new Date() }
              : {}),
          },
          // Only default to "unmatched" on insert, so a later webhook retry
          // cannot undo a reconciliation that already happened.
          $setOnInsert: visit ? {} : { reconcileStatus: "unmatched" },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Online booking (deposit or full payment, D18): the order was created by
      // utils/booking.js with notes.kind = "booking". Confirm the booking here,
      // server-to-server — this is the source of truth; the browser's
      // verify-payment call is only a convenience (CF §5.3). Idempotent (E5).
      if (payment.notes?.kind === "booking" && payment.order_id) {
        if (payment.status !== "captured") return res.status(200).json({ received: true, booking: "not captured" });
        const { confirmPayment } = require("./utils/booking");
        const out = await confirmPayment({
          orderId: payment.order_id,
          paymentId: payment.id,
          amount: Math.round((payment.amount || 0) / 100),
        });
        if (out.appt?._id) {
          await PaymentEvent.updateOne(
            { razorpayPaymentId: payment.id },
            { $set: { purpose: "booking", appointmentId: out.appt._id, reconcileStatus: "matched_appointment", reconciledAt: new Date() } }
          );
        }
        return res.status(200).json({ received: true, booking: out.outcome });
      }

      // Counter UPI QR (D60): a payment made against a QR Code has no order, and the
      // QR's notes (kind, sessionId) were copied onto it by Razorpay. Marks the counter
      // session paid and fills in the visit's payment reference. Idempotent. Not
      // gated by COUNTER_DISPLAY_ENABLED: money that arrived must always be recorded.
      if (!payment.order_id && payment.notes?.kind === "counter_qr") {
        const { applyCapturedPayment } = require("./utils/counter");
        const out = await applyCapturedPayment(payment);
        return res.status(200).json({ received: true, counter: out.outcome });
      }

      if (!visit && payment.status === "captured") {
        console.warn(
          `[webhook] UNRECONCILED PAYMENT ${payment.id} ₹${Math.round((payment.amount || 0) / 100)} ` +
            `from ${payment.contact || "unknown"} — captured with no matching visit`
        );
      }

      return res.status(200).json({ received: true, reconciled: !!visit });
    } catch (err) {
      // Persisting failed. Return 5xx so Razorpay retries rather than treating
      // the payment as recorded — a retry is exactly the safety net we want.
      console.error("[webhook] processing error:", err.message);
      return res.status(500).json({ error: "Failed to record payment event" });
    }
  }
);

app.use(express.json());

// Security headers
app.use(helmet());

/**
 * Customer website API — mounted HERE, before the global limiter and the
 * session, on purpose (CONTROL_FLOW_AND_DATA_LOGIC.md §14):
 *   - no session middleware runs, so a public visitor never gets a session
 *     cookie and staff sessions are never reachable from public routes;
 *   - the global limiter assumes one shared salon IP; public routes carry
 *     their own Mongo-backed per-visitor limits (middleware/mongoRateLimit.js).
 */
app.use("/api/public", require("./routes/public"));

/**
 * Scheduled jobs, called by the outside timer (cron-job.org, D19) with
 * `Authorization: Bearer $CRON_SECRET`. Same early mount as /api/public: no
 * session for a machine caller, and a timer must never be rate-limited.
 */
app.use("/api/cron", require("./routes/cron"));

/**
 * Global rate limiter — 200 requests per 15 min per IP.
 *
 * Every device in the salon shares one public IP, so a busy afternoon can burn
 * through this budget. Payment-completion endpoints are therefore exempt: if
 * `/verify-order-payment` or the visit-create call is throttled AFTER Razorpay
 * has taken the money, the payment is captured with nothing to show for it.
 * That is precisely the failure that lost 14 payments. Browsing endpoints stay
 * limited; the ones that close out a transaction never are.
 */
const PAYMENT_CRITICAL = [
  "/api/verify-order-payment",
  "/api/create-order",
  "/api/order-status",    // polled every few seconds while checkout is open
  "/api/visits",          // covers /visits, /visits/v2 and confirm-assignment
  "/api/razorpay/webhook",
  // The owner-approval gate polls /login-status every ~2.5s for up to 90s, so a
  // handful of staff signing in at opening time would otherwise exhaust the
  // global budget and lock the salon out. It carries its own tighter limiter
  // (pollLimiter in routes/auth.js) instead.
  "/api/auth/login-status",
  // Telegram delivers Approve/Deny callbacks from its own IP range and retries
  // on non-2xx; throttling it would strand logins in `pending`.
  "/api/telegram/webhook",
];

/**
 * Counter-payment POLLING (D60). The tablet asks for its screen every 2.5-20 s and the
 * staff screen checks a pending QR every ~2.5 s; from one shared IP that would eat the
 * budget in minutes. Only these exact GETs are exempt — pairing (/api/display/pair),
 * creating and cancelling a payment are not. Each is limited per device or per session
 * instead (middleware/deviceAuth.js, routes/counter.js).
 */
const POLLING_ONLY = [
  /^\/api\/display\/state$/,
  /^\/api\/counter\/status$/,
  /^\/api\/counter\/sessions\/[a-f\d]{24}$/i,
];

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      PAYMENT_CRITICAL.some((p) => req.path.startsWith(p)) ||
      (req.method === "GET" && POLLING_ONLY.some((re) => re.test(req.path))),
  })
);

/**
 * The counter tablet (D60). After the global limiter (so /pair stays limited) and
 * before the session, so a tablet never gets a cookie or a staff session.
 */
app.use("/api/display", require("./routes/counterDisplay"));

/**
 * Cookie parsing — required by the login gate.
 *
 * express-session reads the session cookie itself but never populates
 * req.cookies, and the approval flow needs two cookies of its own:
 * `salon_device` (device trust) and `salon_pending` (binds a /login-status poll
 * to the browser that supplied the password). Must run before the session
 * middleware so both are available everywhere downstream.
 */
app.use(cookieParser());

// ── Session middleware (stored in MongoDB) ────────────────────────────────────
/**
 * Audit item 6: no public fallback secret in production (utils/sessionSecret.js).
 * Everything mounted ABOVE this point — the Razorpay webhook, /api/public,
 * /api/cron, the counter display — never needed a session and keeps working.
 * Everything below needs one, so without a secret it answers 503 (fail closed).
 * /api/health and "/" stay up so the problem can be seen: health says "missing".
 */
const SESSION_SECRET = sessionSecret();
if (!SESSION_SECRET) {
  console.error("[session] SESSION_SECRET is not set in production — staff login and every staff route will answer 503 until it is added. Public booking, the Razorpay webhook and cron are unaffected.");
  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/api/health") return next();
    console.error(`[session] SESSION_SECRET is not set — refusing ${req.method} ${req.path}`);
    return res.status(503).json({ error: "SESSION_SECRET_MISSING", message: "Staff sign-in is switched off until the server is configured. Tell the owner." });
  });
}
if (SESSION_SECRET) app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  /**
   * Extend the cookie on every response, so maxAge behaves as an INACTIVITY
   * timeout rather than a hard deadline counted from sign-in.
   *
   * Without this (the express-session default is `rolling: false`) the cookie
   * expiry is stamped once at login and never moves, no matter how much the
   * user is doing. Staff signing in when the salon opens at ~08:45–09:30 were
   * therefore thrown out at ~16:45–17:30 mid-shift, exactly the window they
   * reported. It is also the likely trigger for the payments lost on 31 July:
   * an expired session returns 401 to the post-payment save, which used to fail
   * silently after Razorpay had already taken the money.
   *
   * Note the store's `touchAfter` does NOT do this — it only throttles how often
   * the session document is rewritten in Mongo. Only `rolling` moves the cookie.
   */
  rolling: true,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    // Rewrite the stored session at most hourly. Combined with `rolling`, the
    // record is refreshed well within the 8h window during any active shift.
    touchAfter: 3600,
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    // 8 hours of INACTIVITY, refreshed on every request by `rolling` above.
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// ── Razorpay client (lazy — only created when credentials are provided) ─────
const razorpay = process.env.RAZORPAY_KEY_ID
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

/**
 * Generate an HMAC-SHA256 hex signature for Razorpay verification.
 * @param {string} payload - Concatenated payload string
 * @returns {string} Hex digest
 */
function hmacSha256(payload) {
  return crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(payload)
    .digest("hex");
}

// ─── Payment Routes ──────────────────────────────────────────────────────────

/**
 * POST /api/create-order
 * @body {{ name, phone, serviceIds, discountPercent, paymentMode, cashAmount }}
 * @returns {{ order_id, amount, currency, key_id, name, phone }}
 *
 * Creates a Razorpay Order for the embedded Checkout SDK on the frontend.
 * Amount is computed SERVER-SIDE from serviceIds to prevent client-side tampering.
 */
app.post("/api/create-order", authenticate, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payment service not configured" });

  const {
    name,
    phone,
    serviceIds,
    discountPercent = 0,
    paymentMode = "online",
    cashAmount = 0,
    appointmentId = null,
  } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: "name and phone are required" });
  }

  /**
   * A booking at checkout (CF §8, T2.16): charge only what is still due — the
   * booking's own prices, minus the deposit already paid online. Computed by
   * utils/checkout.js, the same code the visit is written with.
   */
  if (appointmentId) {
    try {
      await connectDB();
      const { appointmentBill, CheckoutError } = require("./utils/checkout");
      let bill;
      try {
        bill = await appointmentBill({ appointmentId, serviceIds });
      } catch (err) {
        if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      let chargeOnline = bill.remainder;
      if (paymentMode === "partial") {
        const cash = Math.round(Number(cashAmount) || 0);
        if (cash <= 0 || cash >= bill.remainder) {
          return res.status(400).json({ error: "Cash amount must be between ₹1 and the amount due minus ₹1" });
        }
        chargeOnline = bill.remainder - cash;
      }
      if (chargeOnline < 1) return res.status(400).json({ error: "Nothing is due online for this booking" });
      const order = await razorpay.orders.create({
        amount: Math.round(chargeOnline * 100),
        currency: "INR",
        receipt: `appt_${bill.appt.ref}_${Date.now()}`.slice(0, 40),
        notes: { customer_name: String(name).trim(), customer_phone: String(phone).trim(), appointment_ref: bill.appt.ref, kind: "visit" },
      });
      return res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID, name: String(name).trim(), phone: String(phone).trim() });
    } catch (err) {
      console.error("[create-order] appointment order error:", err);
      return res.status(500).json({ error: "Failed to create order" });
    }
  }
  if (!serviceIds || !Array.isArray(serviceIds) || serviceIds.length === 0) {
    return res.status(400).json({ error: "serviceIds are required to compute the authoritative order amount" });
  }

  try {
    await connectDB();

    // ── Compute amount server-side (prevents client-side tampering) ─────────
    const requestedIds = serviceIds.map((id) => String(id));
    const uniqueIds = [...new Set(requestedIds)];

    const serviceDocs = await Service.find({ _id: { $in: uniqueIds }, isActive: true }).lean();
    if (serviceDocs.length === 0) {
      return res.status(400).json({ error: "No valid active services found" });
    }

    const serviceById = new Map(serviceDocs.map((s) => [String(s._id), s]));
    const missingService = requestedIds.find((id) => !serviceById.has(id));
    if (missingService) {
      return res.status(400).json({ error: "One or more selected services are invalid or inactive" });
    }

    const subtotal = requestedIds.reduce((sum, id) => {
      const service = serviceById.get(id);
      return sum + (service?.price || 0);
    }, 0);
    const pct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
    const discountAmt = Math.round(subtotal * (pct / 100));
    const finalTotal = Math.max(0, subtotal - discountAmt);

    let chargeOnline = finalTotal;
    if (paymentMode === "partial") {
      const cash = Math.round(Number(cashAmount) || 0);
      if (cash <= 0 || cash >= finalTotal) {
        return res.status(400).json({ error: "Cash amount must be between ₹1 and total minus ₹1 for partial payment" });
      }
      chargeOnline = finalTotal - cash;
    }

    const amountInPaise = Math.round(chargeOnline * 100);
    if (amountInPaise < 100) {
      return res.status(400).json({ error: "Online amount must be at least ₹1" });
    }

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: {
        customer_name: String(name).trim(),
        customer_phone: String(phone).trim(),
      },
    });

    return res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      name: String(name).trim(),
      phone: String(phone).trim(),
    });
  } catch (err) {
    console.error("[payment] Order creation error:", err);
    return res.status(500).json({ error: "Failed to create order", details: err.message });
  }
});

/**
 * POST /api/verify-order-payment
 * @body {{ razorpay_order_id, razorpay_payment_id, razorpay_signature, name, phone, amount }}
 * @returns {{ success, payment_id, order_id, amount, name, phone }}
 *
 * Verifies the HMAC-SHA256 signature returned by Razorpay embedded checkout.
 */
app.post("/api/verify-order-payment", authenticate, async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    name,
    phone,
    amount,
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: "Missing payment parameters" });
  }

  const expected = hmacSha256(razorpay_order_id + "|" + razorpay_payment_id);
  if (expected !== razorpay_signature) {
    return res.status(400).json({ success: false, error: "Invalid payment signature" });
  }

  return res.json({
    success: true,
    payment_id: razorpay_payment_id,
    order_id: razorpay_order_id,
    amount: amount != null ? Number(amount) / 100 : 0,
    name: name || "",
    phone: phone || "",
  });
});

/**
 * GET /api/order-status/:orderId
 * @returns {{ paid: boolean, payment_id: string|null, amount: number|null,
 *             status: string|null, attempts: number }}
 *
 * Asks Razorpay's server whether this order has actually been paid.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The Checkout SDK is not a reliable witness to its own success. On 7 Aug a
 * customer scanned the UPI QR and paid ₹150; Razorpay captured it
 * (pay_TMqcyVB4DQpw2a, order paid on the first attempt) while the checkout
 * window showed "Payment could not be completed — Too many requests" and went
 * back to offering a QR. Checkout polls Razorpay directly from the salon's
 * browser, and every device in the salon shares one public IP, so that polling
 * is what gets rate-limited — the payment itself is untouched. When checkout
 * gives up, its `handler` never fires, so nothing creates the visit.
 *
 * This endpoint is the independent second opinion. It is called from OUR server
 * with OUR API key, so it is unaffected by whatever throttling the salon's
 * browser has run into, and it reads the order — the thing that actually knows
 * whether money arrived — instead of trusting the widget's own report.
 */
app.get("/api/order-status/:orderId", authenticate, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payment service not configured" });

  const { orderId } = req.params;
  if (!/^order_[A-Za-z0-9]+$/.test(orderId)) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  try {
    const { items = [] } = await razorpay.orders.fetchPayments(orderId);
    const captured = items.find((p) => p.status === "captured");

    return res.json({
      paid: !!captured,
      payment_id: captured?.id || null,
      amount: captured?.amount ?? null,
      status: captured?.status || null,
      attempts: items.length,
    });
  } catch (err) {
    // A failed poll is not a failed payment. Report it and let the caller keep
    // polling — treating a transient Razorpay error as "unpaid" is how a
    // captured payment ends up with no visit against it.
    console.error("[payment] Order status check failed:", orderId, err.message);
    return res.status(502).json({ error: "Could not reach Razorpay", details: err.message });
  }
});

/**
 * GET /api/payments/unreconciled
 * @query days — how far back to look (default 30, max 365)
 * @returns {{ count: number, totalAmount: number, healed: number, payments: [...] }}
 *
 * Every payment Razorpay captured that still has no visit against it — the
 * salon's "money we cannot account for" list.
 *
 * It re-checks before reporting, and that is the point. The webhook fires about
 * a second after capture, which is before the browser has finished creating the
 * visit, so a payment event is ALWAYS born "unmatched" and nothing used to
 * revisit it. That left 30 unmatched events of which 29 were perfectly fine —
 * an alarm nobody could act on, hiding the single ₹150 that really was lost.
 * Re-checking here clears the stale ones (and writes the correction back, so the
 * list gets cheaper to compute over time) and leaves only real gaps.
 */
app.get(
  "/api/payments/unreconciled",
  authenticate,
  authorizePermission(PERMISSIONS.PAYMENTS_VIEW),
  async (req, res) => {
    try {
      await connectDB();
      const PaymentEvent = require("./models/PaymentEvent");
      const Visit = require("./models/Visit");

      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const candidates = await PaymentEvent.find({
        reconcileStatus: "unmatched",
        status: "captured",
        capturedAt: { $gte: since },
      })
        .sort({ capturedAt: -1 })
        .lean();

      // One query for all of them rather than one per payment.
      const ids = candidates.map((e) => e.razorpayPaymentId);
      const visits = await Visit.find({ razorpayPaymentId: { $in: ids } })
        .select("_id razorpayPaymentId")
        .lean();
      const visitByPaymentId = new Map(visits.map((v) => [v.razorpayPaymentId, v._id]));

      const stale = candidates.filter((e) => visitByPaymentId.has(e.razorpayPaymentId));
      const genuine = candidates.filter((e) => !visitByPaymentId.has(e.razorpayPaymentId));

      // Write the correction back so this work is not repeated on every load.
      await Promise.all(
        stale.map((e) =>
          PaymentEvent.updateOne(
            { razorpayPaymentId: e.razorpayPaymentId },
            {
              $set: {
                reconcileStatus: "matched",
                reconciledVisitId: visitByPaymentId.get(e.razorpayPaymentId),
                reconciledAt: new Date(),
              },
            }
          )
        )
      );

      return res.json({
        count: genuine.length,
        totalAmount: genuine.reduce((sum, e) => sum + (e.amount || 0), 0),
        healed: stale.length,
        payments: genuine.map((e) => ({
          razorpayPaymentId: e.razorpayPaymentId,
          razorpayOrderId: e.razorpayOrderId,
          amount: e.amount,
          method: e.method,
          contact: e.contact,
          customerName: e.customerName,
          capturedAt: e.capturedAt,
        })),
      });
    } catch (err) {
      console.error("[payment] Unreconciled lookup failed:", err);
      return res.status(500).json({ error: "Failed to load unreconciled payments" });
    }
  }
);

/**
 * GET /api/verify-payment
 * @query razorpay_payment_id, razorpay_payment_link_id,
 *        razorpay_payment_link_reference_id, razorpay_payment_link_status,
 *        razorpay_signature
 * @returns {{ success, payment_id, amount, currency, name, phone, status }}
 *
 * Verifies the Razorpay Payment Link callback signature, then fetches
 * full payment details (amount, customer info) for the confirmation page.
 */
app.get("/api/verify-payment", authenticate, async (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_payment_link_id,
    razorpay_payment_link_reference_id,
    razorpay_payment_link_status,
    razorpay_signature,
  } = req.query;

  if (!razorpay_payment_id || !razorpay_payment_link_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: "Missing payment parameters" });
  }
  if (!razorpay) return res.status(503).json({ success: false, error: "Payment service not configured" });

  // Reconstruct the payload and verify HMAC signature
  const payload = [
    razorpay_payment_link_id,
    razorpay_payment_link_reference_id,
    razorpay_payment_link_status,
    razorpay_payment_id,
  ].join("|");

  if (hmacSha256(payload) !== razorpay_signature) {
    return res.status(400).json({ success: false, error: "Invalid payment signature" });
  }

  // Fetch full payment details from Razorpay API
  try {
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    return res.json({
      success: true,
      payment_id: razorpay_payment_id,
      amount: payment.amount / 100,
      currency: payment.currency,
      name: payment.notes?.customer_name || "",
      phone: payment.notes?.customer_phone || "",
      status: payment.status,
    });
  } catch (err) {
    console.error("[payment] Fetch error:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch payment details" });
  }
});

// ─── Auth & Admin Routes ─────────────────────────────────────────────────────
// All route-level access is enforced by authorizePermission(PERMISSION) inside
// each router — the mount-level authorize() role gate has been removed so that
// any authenticated user whose permissions array contains the required key can
// reach the handler, regardless of role.
app.use("/api/auth", require("./routes/auth"));

// Public by design — Telegram has no session cookie. The webhook authenticates
// itself with the X-Telegram-Bot-Api-Secret-Token header instead.
app.use("/api/telegram", require("./routes/telegram"));

/**
 * Dev-only Telegram long-polling.
 *
 * Telegram cannot deliver a webhook to localhost, so without this the Approve /
 * Deny buttons do nothing on a development machine. Opt in with
 * TELEGRAM_MODE=polling; it is hard-gated to non-production because it calls
 * deleteWebhook (which would unhook the live bot) and holds a permanently open
 * request (which serverless cannot support).
 */
if (process.env.TELEGRAM_MODE === "polling" && process.env.NODE_ENV !== "production") {
  const telegram = require("./utils/telegram");
  const { processUpdate } = require("./routes/telegram");
  telegram.startPolling((update) => processUpdate(update));
}

app.use("/api/management", authenticate, require("./routes/management"));
app.use("/api/admin", authenticate, require("./routes/admin"));
app.use("/api/artists", authenticate, require("./routes/artists"));
app.use("/api/services", authenticate, require("./routes/services"));
app.use("/api/bookings", authenticate, require("./routes/bookings"));
app.use("/api/schedules", authenticate, require("./routes/schedules"));
app.use("/api/data-fixes", authenticate, require("./routes/dataFixes"));
app.use("/api/counter", authenticate, require("./routes/counter"));
app.use("/api/website", authenticate, require("./routes/website"));
app.use("/api/artist-skills", authenticate, require("./routes/artistSkills"));
app.use("/api/visits", authenticate, require("./routes/visits"));
app.use("/api/data-pipeline", authenticate, require("./routes/dataPipeline"));

// ─── Static Data ─────────────────────────────────────────────────────────────

const Artist = require("./models/Artist");

/**
 * GET /api/form-data
 * Returns dropdown options for the visit entry form.
 * All data is fetched from the database (Artist + Service collections).
 */
app.get("/api/form-data", authenticate, async (_req, res) => {
  try {
    await connectDB();

    // Fetch active artists from DB
    const dbArtists = await Artist.find({ isActive: true }).sort({ name: 1 });
    const artists = dbArtists.map((a) => ({ id: a._id.toString(), name: a.name }));

    // Fetch active services from DB
    const dbServices = await Service.find({ isActive: true }).sort({ category: 1, name: 1 });
    const services = dbServices.map((s) => ({
      id: s._id.toString(),
      name: s.name,
      price: s.price,
    }));

    // Derive unique categories from active services
    const categorySet = [...new Set(dbServices.map((s) => s.category).filter(Boolean))];
    const serviceTypes = categorySet.sort().map((c, i) => ({ id: `cat-${i}`, name: c }));

    res.json({
      artists,
      serviceTypes,
      services,
    });
  } catch (err) {
    console.error("[form-data] Error:", err);
    res.status(500).json({ error: "Failed to load form data" });
  }
});

// ─── Utility Routes ──────────────────────────────────────────────────────────

/** Root route — confirms the API is running. */
app.get("/", (_req, res) =>
  res.json({ service: "Hair Salon Backend API", status: "running" })
);

/**
 * GET /api/health
 * Returns server status + MongoDB connection state.
 * readyState codes: 0 = disconnected, 1 = connected,
 *                   2 = connecting, 3 = disconnecting
 */
app.get("/api/health", async (_req, res) => {
  try {
    await connectDB();
    res.json({
      status: "ok",
      mongoState: mongoose.connection.readyState, // 0=disconnected,1=connected,2=connecting,3=disconnecting
      mongoUri: process.env.MONGODB_URI ? "set" : "NOT SET",
      // Reports only whether the value exists, never the value itself — so a
      // misconfigured webhook can be diagnosed without dashboard access.
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ? "set" : "NOT SET",
      // "ok" or "missing" — never the value (audit item 6).
      sessionSecret: SESSION_SECRET ? "ok" : "missing",
      // Names of missing WhatsApp settings only, so "why was nobody messaged?" can be answered without the dashboard.
      whatsapp: whatsapp.configStatus(),
      // Is the outside 15-minute timer alive? { ok, minutesAgo } — age only, no secrets or error text (audit item 7).
      timers: await timersHealth(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      mongoState: mongoose.connection.readyState,
      mongoUri: process.env.MONGODB_URI ? "set" : "NOT SET",
      // Reports only whether the value exists, never the value itself — so a
      // misconfigured webhook can be diagnosed without dashboard access.
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ? "set" : "NOT SET",
      error: err.message,
    });
  }
});

// ─── Analytics Routes (mounted sub-router) ──────────────────────────────────
// No role gate — authorizePermission(PERMISSIONS.ANALYTICS_VIEW) on each route
// is the sole enforcement. Any authenticated user with that permission can access.
app.use("/api/analytics", authenticate, require("./routes/analytics"));

// ─── Artist Dashboard Routes ─────────────────────────────────────────────────
// authorize("artist") is intentionally kept here: this endpoint serves an
// artist's OWN personal data scoped to their session identity. There is no
// grantable permission for "read your own stats" — it is inherent to the role.
app.use("/api/artist-dashboard", authenticate, authorize("artist"), require("./routes/artistDashboard"));

// ─── Owner-view of any artist's dashboard ────────────────────────────────────
// authorizePermission(PERMISSIONS.ARTIST_DASHBOARD_VIEW) enforced per-route inside.
app.use("/api/owner/artist-dashboard", authenticate, require("./routes/ownerArtistDashboard"));

// ─── Server / Vercel Export ──────────────────────────────────────────────────
// When run locally (`node index.js`), start an HTTP server.
// On Vercel, the exported Express app is wrapped automatically.
if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log("Backend running at http://localhost:" + PORT);
  });
}

module.exports = app;
