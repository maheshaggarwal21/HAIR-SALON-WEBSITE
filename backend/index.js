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
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// ── Database ─────────────────────────────────────────────────────────────────
const connectDB = require("./db");
const User = require("./models/User");

// ── Auto-seed owner account from env vars ────────────────────────────────────
/**
 * Ensures exactly one owner account exists in the database.
 * - If no owner exists → creates one from OWNER_EMAIL / OWNER_PASSWORD env vars
 * - If an owner exists → updates email, name, and password to match env vars
 * Runs lazily on the first request (not at module load) to avoid unhandled
 * rejection crashes in Vercel's serverless environment.
 */
let ownerSeeded = false;
async function ensureOwner() {
  if (ownerSeeded) return;
  ownerSeeded = true; // Mark immediately to prevent concurrent runs

  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  const name = "Salon Owner";

  if (!email || !password) {
    console.warn("[ensureOwner] OWNER_EMAIL / OWNER_PASSWORD not set — skipping owner auto-seed");
    return;
  }

  try {
    await connectDB();
    const existing = await User.findOne({ role: "owner" });

    if (existing) {
      // Sync credentials with env vars
      let changed = false;
      if (existing.email !== email) { existing.email = email; changed = true; }
      if (existing.name !== name) { existing.name = name; changed = true; }

      // Only re-hash if the password actually changed
      const passwordMatch = await bcrypt.compare(password, existing.passwordHash);
      if (!passwordMatch) {
        existing.passwordHash = await bcrypt.hash(password, 12);
        changed = true;
      }

      if (!existing.isActive) { existing.isActive = true; changed = true; }
      if (changed) {
        await existing.save();
        console.log("[ensureOwner] Owner account updated:", email);
      }
    } else {
      const passwordHash = await bcrypt.hash(password, 12);
      await User.create({ name, email, passwordHash, role: "owner" });
      console.log("[ensureOwner] Owner account created:", email);
    }
  } catch (err) {
    ownerSeeded = false; // Allow retry on next request
    console.error("[ensureOwner] Failed:", err.message);
  }
}

// ── New: session & auth packages ─────────────────────────────────────────────
const session = require("express-session");
const MongoStore = require("connect-mongo").default;
const { authenticate, authorize } = require("./middleware/authMiddleware");

// ── Configuration ────────────────────────────────────────────────────────────
/** Frontend URL used for Razorpay payment-link callbacks (redirect after pay). */
const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:5173"
).replace(/\/+$/, "");

/** Allowed CORS origins — includes common Vite dev ports */
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
];

/**
 * Check whether an origin is a Vercel preview/production URL.
 * Accepts any *.vercel.app origin — real security is handled by JWT auth.
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
    if (!origin || ALLOWED_ORIGINS.includes(origin) || isVercelOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// Lazy owner-seed + DB warm-up on the first request
app.use(async (_req, _res, next) => {
  try { await ensureOwner(); } catch { /* logged inside ensureOwner */ }
  next();
});

// Security headers
app.use(helmet());

// Global rate limiter — 200 requests per 15 min per IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Session middleware (stored in MongoDB) ────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    touchAfter: 24 * 3600, // only update session once per day unless data changes
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ── Razorpay client (lazy — only created when credentials are provided) ─────
const razorpay = process.env.RAZORPAY_KEY_ID
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate required payment fields and convert amount to paise.
 * @param {object} body  - Express req.body
 * @param {object} res   - Express response (used to send 400 on failure)
 * @returns {{ name: string, phone: string, amountInPaise: number } | null}
 *          Parsed values, or null if validation failed (response already sent).
 */
function validatePaymentInput(body, res) {
  const { name, phone, amount } = body;

  if (!name || !phone || !amount) {
    res.status(400).json({ error: "name, phone and amount are required" });
    return null;
  }

  const amountInPaise = Math.round(Number(amount) * 100);
  if (isNaN(amountInPaise) || amountInPaise < 100) {
    res.status(400).json({ error: "Amount must be at least ₹1" });
    return null;
  }

  return { name: name.trim(), phone: phone.trim(), amountInPaise };
}

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
 * @body {{ name: string, phone: string, amount: number }} — amount in rupees
 * @returns {{ order_id, amount, currency, key_id, name, phone }}
 *
 * Creates a Razorpay Order for the embedded Checkout SDK on the frontend.
 * Amount is locked server-side so the customer cannot alter it.
 */
app.post("/api/create-order", authenticate, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payment service not configured" });

  const parsed = validatePaymentInput(req.body, res);
  if (!parsed) return; // 400 already sent

  try {
    const order = await razorpay.orders.create({
      amount: parsed.amountInPaise,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: {
        customer_name: parsed.name,
        customer_phone: parsed.phone,
        amount_inr: String(req.body.amount),
      },
    });

    return res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      name: parsed.name,
      phone: parsed.phone,
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
    amount: Number(amount) / 100,
    name: name || "",
    phone: phone || "",
  });
});

/**
 * POST /api/create-payment-link
 * @body {{ name: string, phone: string, amount: number }} — amount in rupees
 * @returns {{ payment_link_url: string }}
 *
 * Creates a Razorpay Payment Link (legacy flow). Razorpay redirects the
 * customer back to the frontend /payment-status page with query params.
 */
app.post("/api/create-payment-link", authenticate, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payment service not configured" });

  const parsed = validatePaymentInput(req.body, res);
  if (!parsed) return;

  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: parsed.amountInPaise,
      currency: "INR",
      accept_partial: false,
      description: "Hair Salon Appointment Payment",
      customer: { name: parsed.name, contact: "+91" + parsed.phone },
      notify: { sms: true, email: false },
      reminder_enable: false,
      notes: {
        customer_name: parsed.name,
        customer_phone: parsed.phone,
        amount_inr: String(req.body.amount),
      },
      callback_url: `${FRONTEND_URL}/payment-status`,
      callback_method: "get",
    });

    return res.json({ payment_link_url: paymentLink.short_url });
  } catch (err) {
    console.error("[payment] Payment link error:", err);
    return res.status(500).json({ error: "Failed to create payment link", details: err.message });
  }
});

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

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", authenticate, authorize("owner"), require("./routes/admin"));
app.use("/api/artists", authenticate, require("./routes/artists"));
app.use("/api/services", authenticate, require("./routes/services"));
app.use("/api/visits", authenticate, require("./routes/visits"));

// ─── Static Data ─────────────────────────────────────────────────────────────

const Artist = require("./models/Artist");
const Service = require("./models/Service");

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
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      mongoState: mongoose.connection.readyState,
      mongoUri: process.env.MONGODB_URI ? "set" : "NOT SET",
      error: err.message,
    });
  }
});

// ─── Analytics Routes (mounted sub-router) ──────────────────────────────────
app.use("/api/analytics", authenticate, authorize("manager", "owner"), require("./routes/analytics"));

// ─── Artist Dashboard Routes (artist-only) ──────────────────────────────────
app.use("/api/artist-dashboard", authenticate, authorize("artist"), require("./routes/artistDashboard"));

// ─── Owner-view of any artist's dashboard ────────────────────────────────────
app.use("/api/owner/artist-dashboard", authenticate, authorize("owner"), require("./routes/ownerArtistDashboard"));

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
