/**
 * @file admin.js
 * @description Owner-only user management routes.
 *
 * Mounted at /api/admin in index.js, protected by:
 *   authenticate → authorize("owner")
 *
 * CRUD for staff accounts (receptionist / manager).
 * The owner role can ONLY be created via the seed script.
 *
 * The PATCH route also supports `isActive` for reactivation.
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const User = require("../models/User");
const validateId = require("../middleware/validateId");
const { invalidateUserSessions } = require("../utils/sessionUtils");
const { PERMISSIONS, ROLE_DEFAULTS, PERMISSION_LABELS, PERMISSION_GROUPS } = require('../constants/permissions');
const { authorizePermission, evictPermissionCache } = require('../middleware/authMiddleware');

const router = express.Router();

// ── Ensure DB on every request (Vercel cold-start) ─────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[admin] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ─── GET /permissions — Return permission registry for UI ──────────────────

router.get("/permissions", (req, res) => {
  res.json({
    permissions: Object.values(PERMISSIONS),
    labels:      PERMISSION_LABELS,
    groups:      PERMISSION_GROUPS,
  });
});

// ─── GET /users ─────────────────────────────────────────────────────────────

router.get("/users", authorizePermission(PERMISSIONS.TEAM_VIEW), async (_req, res) => {
  try {
    const users = await User.find({}, "-passwordHash").sort({ createdAt: -1 });
    return res.json(users);
  } catch (err) {
    console.error("[admin] List users error:", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ─── POST /users ────────────────────────────────────────────────────────────

router.post(
  "/users",
  authorizePermission(PERMISSIONS.TEAM_MANAGE),
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("A valid email is required"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("role")
      .isIn(["receptionist", "manager"])
      .withMessage("Role must be receptionist or manager"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      // Check duplicate email
      const existing = await User.findOne({
        email: req.body.email.toLowerCase(),
      });
      if (existing) {
        return res
          .status(409)
          .json({ error: "A user with this email already exists" });
      }

      const passwordHash = await bcrypt.hash(req.body.password, 12);

      const user = await User.create({
        name: req.body.name.trim(),
        email: req.body.email.toLowerCase().trim(),
        passwordHash,
        role: req.body.role,
        createdBy: req.session.userId,
        permissions: ROLE_DEFAULTS[req.body.role] ?? [],
      });

      // Return without passwordHash
      const userObj = user.toObject();
      delete userObj.passwordHash;

      return res.status(201).json(userObj);
    } catch (err) {
      console.error("[admin] Create user error:", err);
      return res.status(500).json({ error: "Failed to create user" });
    }
  }
);

// ─── PATCH /users/:id ───────────────────────────────────────────────────────

router.patch(
  "/users/:id",
  validateId,
  [
    body("name").optional().trim().notEmpty().withMessage("Name cannot be empty"),
    body("email")
      .optional()
      .isEmail()
      .withMessage("A valid email is required"),
    body("role")
      .optional()
      .isIn(["receptionist", "manager"])
      .withMessage("Role must be receptionist or manager"),
    body("password")
      .optional()
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("isActive").optional().isBoolean().withMessage("isActive must be boolean"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { id } = req.params;

      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Prevent owner from changing their own role
      if (id === req.session.userId && req.body.role) {
        return res
          .status(400)
          .json({ error: "Cannot change your own role" });
      }

      // Validate permissions if provided
      const { permissions } = req.body;
      if (permissions !== undefined) {
        const validKeys = Object.values(PERMISSIONS);
        const invalid = permissions.filter(k => !validKeys.includes(k));
        if (invalid.length > 0) {
          return res.status(400).json({ error: 'Invalid permission key(s)', invalid, valid: validKeys });
        }
      }

      // Build update object from provided fields only
      const updateObj = {};
      if (req.body.name !== undefined) updateObj.name = req.body.name.trim();
      if (req.body.email !== undefined) {
        const newEmail = req.body.email.toLowerCase().trim();
        // Check duplicate email (excluding self)
        const dup = await User.findOne({ email: newEmail, _id: { $ne: id } });
        if (dup) {
          return res.status(409).json({ error: "A user with this email already exists" });
        }
        updateObj.email = newEmail;
      }
      if (req.body.role !== undefined) updateObj.role = req.body.role;
      if (req.body.password) {
        updateObj.passwordHash = await bcrypt.hash(req.body.password, 12);
      }
      if (req.body.isActive !== undefined) updateObj.isActive = req.body.isActive;
      if (permissions !== undefined) updateObj.permissions = permissions;

      const updated = await User.findByIdAndUpdate(id, updateObj, {
        new: true,
        runValidators: true,
      }).select("-passwordHash");

      // Evict the permission cache so the next request fetches fresh data
      evictPermissionCache(id);

      // Invalidate all active sessions for this user after any account change
      await invalidateUserSessions(req.sessionStore, id);

      return res.json(updated);
    } catch (err) {
      console.error("[admin] Update user error:", err);
      return res.status(500).json({ error: "Failed to update user" });
    }
  }
);

// ─── DELETE /users/:id ──────────────────────────────────────────────────────

router.delete("/users/:id", validateId, authorizePermission(PERMISSIONS.TEAM_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Prevent self-deletion
    if (id === req.session.userId) {
      return res
        .status(400)
        .json({ error: "Cannot deactivate your own account" });
    }

    // Soft-delete only
    await User.findByIdAndUpdate(id, { isActive: false });

    // Log out all active sessions for this user
    await invalidateUserSessions(req.sessionStore, id);

    return res.json({ ok: true, message: "User deactivated successfully" });
  } catch (err) {
    console.error("[admin] Delete user error:", err);
    return res.status(500).json({ error: "Failed to deactivate user" });
  }
});

// ─── DELETE /users/:id/permanent — Hard-delete a user from DB ───────────────

router.delete("/users/:id/permanent", validateId, authorizePermission(PERMISSIONS.TEAM_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Prevent self-deletion
    if (id === req.session.userId) {
      return res
        .status(400)
        .json({ error: "Cannot delete your own account" });
    }

    // Prevent deleting the owner account
    if (user.role === "owner") {
      return res
        .status(400)
        .json({ error: "Cannot delete the owner account" });
    }

    // Kill any active sessions for this user before deletion
    await invalidateUserSessions(req.sessionStore, id);

    await User.findByIdAndDelete(id);

    return res.json({ ok: true, message: "User permanently deleted" });
  } catch (err) {
    console.error("[admin] Permanent delete user error:", err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

module.exports = router;
