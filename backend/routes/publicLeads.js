/**
 * @file publicLeads.js
 * @description POST /api/public/leads: a lead from an offer page (no bundle chosen) or from the landing page's
 * "Interested?" section. Name, phone and an optional question. Mounted inside /api/public.
 *
 * No payment, no OTP, nothing held, no booking and no customer record: it only lands in the staff app under
 * Bookings -> Leads and tells the owner on Telegram. Same spam controls as the offer request (routes/publicWaRequest.js):
 *   - a honeypot box people never see: a bot that fills it gets a convincing "ok" and nothing is stored;
 *   - 10 requests per address per hour and 3 NEW leads per phone per day (database-backed, shared by every instance);
 *   - phone numbers normalised so one person is one number, and the same words from the same number within a day are
 *     the first lead again, not a second one;
 *   - only known fields: marketing consent, a status or anything else cannot be sent in.
 */
const express = require("express");
const { body, validationResult } = require("express-validator");
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const { mongoRateLimit, hit } = require("../middleware/mongoRateLimit");
const { alertNewLead } = require("../utils/bookingAlerts");
const wa = require("../utils/waRequest");
const { cleanUtm } = require("../utils/utm");

const router = express.Router();
const HOUR = 60 * 60 * 1000;
const FIELDS = new Set(["name", "phone", "query", "source", "offerSlug", "campaign", "utm", "website"]);
const ipLimit = mongoRateLimit({ name: "lead-ip", windowMs: HOUR, max: 10 });

function onlyKnownFields(req, res, next) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return res.status(400).json({ error: "VALIDATION", message: "Send the details as JSON." });
  const unknown = Object.keys(b).filter((k) => !FIELDS.has(k));
  if (unknown.length) return res.status(400).json({ error: "VALIDATION", message: "Unexpected fields.", fields: unknown });
  return next();
}

const validators = [
  body("name").isString().trim().isLength({ min: 2, max: 60 }).withMessage("Enter your name.").matches(/^[\p{L}\p{M} .'-]+$/u).withMessage("Enter your name using letters only."),
  body("phone")
    .customSanitizer((v) => Customer.normalisePhone(v))
    .custom((v) => v !== null)
    .withMessage("Enter a 10-digit mobile number."),
  body("query").optional({ nullable: true }).isString().trim().isLength({ max: 500 }).withMessage("Keep your question under 500 characters."),
  body("source").optional({ nullable: true }).isIn(["offer_page", "landing"]).withMessage("Unknown source."),
  body("offerSlug").optional({ nullable: true }).isString().matches(/^[a-z0-9-]{1,60}$/).withMessage("Unknown offer."),
  body("campaign").optional({ nullable: true }).isString().isLength({ max: 60 }),
  body("utm").optional({ nullable: true }).isObject(),
  body("utm.*").optional({ nullable: true }).isString().isLength({ max: 255 }),
  body("website").optional({ nullable: true }).isString().isLength({ max: 300 }),
];

const same = (a, b) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

router.post("/leads", onlyKnownFields, ipLimit, validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: "VALIDATION", message: errors.array()[0].msg, fields: errors.array().map((e) => e.path) });
  }
  const b = req.body;

  // Honeypot: people cannot see this box. A bot that fills it is told "sent" and nothing is stored.
  if (typeof b.website === "string" && b.website.trim() !== "") return res.status(201).json({ ok: true, duplicate: false });

  try {
    const query = typeof b.query === "string" && b.query.trim() ? b.query.trim() : null;

    // The same person sending the same words again within a day is the first lead again.
    const recent = await Lead.find({ phone: b.phone, createdAt: { $gte: new Date(Date.now() - 24 * HOUR) } }).lean();
    if (recent.some((l) => same(l.query, query))) return res.status(200).json({ ok: true, duplicate: true });

    // Limits that count only real new leads.
    const phoneHit = await hit({ name: "lead-phone", id: b.phone, windowMs: 24 * HOUR, max: 3 });
    if (!phoneHit.allowed) return res.status(429).json({ error: "LIMIT_REACHED", message: "We already have your details. We'll be in touch." });

    const campaign = wa.cleanCampaign(b.campaign) || null;
    const lead = await Lead.create({
      name: b.name,
      phone: b.phone,
      query,
      source: { channel: b.source || "landing", offerSlug: b.offerSlug || null, campaign, utm: cleanUtm(b.utm) || null },
    });

    // Before responding: on Vercel, work after the response may never run. Never throws.
    await alertNewLead(lead);
    return res.status(201).json({ ok: true, duplicate: false });
  } catch (err) {
    console.error("[public] lead error:", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Something went wrong. Try again, or message us on WhatsApp." });
  }
});

module.exports = router;
