/**
 * @file services.js
 * @description CRUD routes for salon services.
 *
 * Mounted at /api/services in index.js.
 *
 * Access control:
 *   GET  /            — any authenticated user (for form dropdowns & read-only views)
 *   GET  /all         — owner only (includes inactive)
 *   GET  /categories  — any authenticated user (distinct category names)
 *   POST /            — owner only
 *   PATCH /:id        — owner only
 *   DELETE /:id       — owner only (soft-delete)
 *
 * Website fields kept in step here (owner rules, 13 Oct 2026):
 *   - publicPrice is half the list price (Service.defaultPublicPrice). When the
 *     list price changes, publicPrice follows — unless the owner has already
 *     set a different public price, which is an exception and is left alone.
 *   - durationMinutes starts at one hour for a new service (durationConfirmed
 *     false). Once the owner types a time, it is confirmed and artist
 *     time-performance starts using it. Online booking uses either.
 *
 * Every create / edit / deactivate / delete is audited (CLAUDE.md: owner
 * changes to services and prices go through utils/audit.js).
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const Service = require("../models/Service");
const { authorizePermission } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require('../constants/permissions');
const validateId = require("../middleware/validateId");
const audit = require("../utils/audit");
// Website menu refreshes within seconds of an edit (T1.24).
const { revalidateSite } = require("../utils/revalidate");

/** Fields whose before → after values are worth keeping in the audit line. */
const AUDITED_FIELDS = ["name", "price", "publicPrice", "category", "isActive", "durationMinutes", "durationConfirmed"];

function changedFields(before, after) {
  const diff = {};
  for (const f of AUDITED_FIELDS) {
    if (before[f] !== after[f]) diff[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return diff;
}

const router = express.Router();

/** Escape regex metacharacters so user input is treated as a literal string. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Ensure DB on every request (Vercel cold-start) ─────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[services] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ─── GET / — List all active services ───────────────────────────────────────

router.get("/", async (_req, res) => {
  try {
    const services = await Service.find({ isActive: true }).sort({ category: 1, name: 1 });
    return res.json(services);
  } catch (err) {
    console.error("[services] List error:", err);
    return res.status(500).json({ error: "Failed to fetch services" });
  }
});

// ─── GET /all — List ALL services (including inactive) — owner only ─────────

router.get("/all", authorizePermission(PERMISSIONS.SERVICES_VIEW), async (_req, res) => {
  try {
    const services = await Service.find({}).sort({ createdAt: -1 });
    return res.json(services);
  } catch (err) {
    console.error("[services] List all error:", err);
    return res.status(500).json({ error: "Failed to fetch services" });
  }
});

// ─── GET /categories — Distinct active categories ───────────────────────────

router.get("/categories", authorizePermission(PERMISSIONS.SERVICES_VIEW), async (_req, res) => {
  try {
    const categories = await Service.distinct("category", {
      isActive: true,
      category: { $ne: "" },
    });
    return res.json(categories.sort());
  } catch (err) {
    console.error("[services] Categories error:", err);
    return res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// ─── POST / — Create a new service — owner only ────────────────────────────

router.post(
  "/",
  authorizePermission(PERMISSIONS.SERVICES_CRUD),
  [
    body("name").trim().notEmpty().withMessage("Service name is required"),
    body("price")
      .notEmpty()
      .withMessage("Price is required")
      .isFloat({ min: 0 })
      .withMessage("Price must be a non-negative number"),
    body("category").optional().trim(),
    // durationMinutes is optional — must be a positive integer when provided
    body("durationMinutes")
      .optional({ nullable: true })
      .isInt({ min: 1 })
      .withMessage("Duration must be a whole number of minutes (at least 1)"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      // Check duplicate name
      const existing = await Service.findOne({
        name: { $regex: new RegExp(`^${escapeRegex(req.body.name.trim())}$`, "i") },
      });
      if (existing) {
        return res
          .status(409)
          .json({ error: "A service with this name already exists" });
      }

      const price = Number(req.body.price);
      const typedDuration = req.body.durationMinutes != null;
      const service = await Service.create({
        name: req.body.name.trim(),
        price,
        publicPrice: Service.defaultPublicPrice(price),
        category: req.body.category?.trim() || "",
        // Not given → the one-hour placeholder, unconfirmed, for the owner to fix later.
        durationMinutes: typedDuration ? Number(req.body.durationMinutes) : Service.DEFAULT_DURATION_MINUTES,
        durationConfirmed: typedDuration,
      });

      await audit.record({
        action: "service.created",
        req,
        target: { name: service.name },
        meta: {
          serviceId: String(service._id),
          price: service.price,
          publicPrice: service.publicPrice,
          durationMinutes: service.durationMinutes,
          durationConfirmed: service.durationConfirmed,
        },
      });
      await revalidateSite(["services", "packages"]);
      return res.status(201).json(service);
    } catch (err) {
      console.error("[services] Create error:", err);
      return res.status(500).json({ error: "Failed to create service" });
    }
  }
);

// ─── PATCH /:id — Update a service — owner only ────────────────────────────

router.patch(
  "/:id",
  validateId,
  authorizePermission(PERMISSIONS.SERVICES_CRUD),
  [
    body("name")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Name cannot be empty"),
    body("price")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Price must be a non-negative number"),
    body("category").optional().trim(),
    body("isActive").optional().isBoolean().withMessage("isActive must be boolean"),
    body("durationMinutes")
      .optional({ nullable: true })
      .custom((v) => v === null || (Number.isInteger(Number(v)) && Number(v) >= 1))
      .withMessage("Duration must be a whole number ≥ 1, or null to clear it"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { id } = req.params;

      const service = await Service.findById(id);
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }

      // Build update object
      const updateObj = {};
      if (req.body.name !== undefined) {
        const trimmed = req.body.name.trim();
        // Check duplicate name (excluding self)
        const dup = await Service.findOne({
          name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
          _id: { $ne: id },
        });
        if (dup) {
          return res
            .status(409)
            .json({ error: "Another service already has this name" });
        }
        updateObj.name = trimmed;
      }
      if (req.body.price !== undefined) {
        updateObj.price = Number(req.body.price);
        // publicPrice tracks the half-price rule unless the owner overrode it.
        const followsRule =
          service.publicPrice == null || service.publicPrice === Service.defaultPublicPrice(service.price);
        if (followsRule) updateObj.publicPrice = Service.defaultPublicPrice(updateObj.price);
      }
      if (req.body.category !== undefined) updateObj.category = req.body.category.trim();
      if (req.body.isActive !== undefined) updateObj.isActive = req.body.isActive;
      // A typed time is the owner's real time → confirmed. null clears it.
      if (req.body.durationMinutes !== undefined) {
        const cleared = req.body.durationMinutes === null;
        updateObj.durationMinutes = cleared ? null : Number(req.body.durationMinutes);
        updateObj.durationConfirmed = !cleared;
      }

      const updated = await Service.findByIdAndUpdate(id, updateObj, { new: true, runValidators: true });
      const changes = changedFields(service.toObject(), updated.toObject());
      if (Object.keys(changes).length) {
        await audit.record({
          action: "service.updated",
          req,
          target: { name: updated.name },
          meta: { serviceId: String(updated._id), changes },
        });
      }
      await revalidateSite(["services", "packages"]);
      return res.json(updated);
    } catch (err) {
      console.error("[services] Update error:", err);
      return res.status(500).json({ error: "Failed to update service" });
    }
  }
);

// ─── DELETE /:id — Soft-delete a service — owner only ───────────────────────

router.delete("/:id", validateId, authorizePermission(PERMISSIONS.SERVICES_CRUD), async (req, res) => {
  try {
    const { id } = req.params;

    const service = await Service.findById(id);
    if (!service) {
      return res.status(404).json({ error: "Service not found" });
    }

    await Service.findByIdAndUpdate(id, { isActive: false });
    await audit.record({
      action: "service.deactivated",
      req,
      target: { name: service.name },
      meta: { serviceId: String(service._id) },
    });
    await revalidateSite(["services", "packages"]);
    return res.json({ ok: true, message: "Service deactivated successfully" });
  } catch (err) {
    console.error("[services] Delete error:", err);
    return res.status(500).json({ error: "Failed to deactivate service" });
  }
});

// ─── DELETE /:id/permanent — Hard-delete a service from DB ──────────────────

router.delete("/:id/permanent", validateId, authorizePermission(PERMISSIONS.SERVICES_CRUD), async (req, res) => {
  try {
    const { id } = req.params;

    const service = await Service.findById(id);
    if (!service) {
      return res.status(404).json({ error: "Service not found" });
    }

    await Service.findByIdAndDelete(id);
    await audit.record({
      action: "service.deleted",
      req,
      target: { name: service.name },
      meta: { serviceId: String(service._id), price: service.price, category: service.category },
    });
    await revalidateSite(["services", "packages"]);
    return res.json({ ok: true, message: "Service permanently deleted" });
  } catch (err) {
    console.error("[services] Permanent delete error:", err);
    return res.status(500).json({ error: "Failed to delete service" });
  }
});

module.exports = router;
