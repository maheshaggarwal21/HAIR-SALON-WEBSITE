/**
 * @file artists.js
 * @description CRUD routes for salon artists.
 *
 * Mounted at /api/artists in index.js.
 *
 * Access control:
 *   GET  /           — any authenticated user (for the visit form dropdown)
 *   POST /           — manager + owner (also creates a linked User account if email provided)
 *   PATCH /:id       — manager + owner
 *   DELETE /:id      — manager + owner (soft-delete)
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const Artist = require("../models/Artist");
const User = require("../models/User");
const { authorizePermission, evictPermissionCache } = require("../middleware/authMiddleware");
const { PERMISSIONS } = require('../constants/permissions');
const validateId = require("../middleware/validateId");
const { invalidateUserSessions } = require("../utils/sessionUtils");

const router = express.Router();

// ── Ensure DB on every request (Vercel cold-start) ─────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[artists] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ─── GET / — List all active artists ────────────────────────────────────────

router.get("/", async (_req, res) => {
  try {
    const artists = await Artist.find({ isActive: true }).sort({ name: 1 });
    return res.json(artists);
  } catch (err) {
    console.error("[artists] List error:", err);
    return res.status(500).json({ error: "Failed to fetch artists" });
  }
});

// ─── GET /all — List ALL artists (including inactive) ──────────────────────

router.get("/all", authorizePermission(PERMISSIONS.ARTISTS_VIEW), async (_req, res) => {
  try {
    // Populate the linked User's permissions + isActive so the frontend can render the permission editor and login status
    const artists = await Artist.find({}).populate("userId", "permissions isActive").sort({ createdAt: -1 });
    return res.json(artists);
  } catch (err) {
    console.error("[artists] List all error:", err);
    return res.status(500).json({ error: "Failed to fetch artists" });
  }
});

// ─── POST / — Create a new artist (+ optional linked User account) ──────────

router.post(
  "/",
  authorizePermission(PERMISSIONS.ARTISTS_CRUD),
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^[6-9]\d{9}$/)
      .withMessage("Enter a valid 10-digit Indian mobile number"),
    body("email").optional({ values: "falsy" }).isEmail().withMessage("Enter a valid email"),
    body("password")
      .optional({ values: "falsy" })
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("registrationId").optional({ values: "falsy" }).trim(),
    body("commission")
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage("Commission must be 0–100"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      // Check duplicate phone
      const existing = await Artist.findOne({ phone: req.body.phone.trim() });
      if (existing) {
        return res
          .status(409)
          .json({ error: "An artist with this phone number already exists" });
      }

      // Normalize email once for all checks below
      const emailLower = req.body.email ? req.body.email.toLowerCase().trim() : null;

      // If an email is provided, enforce uniqueness across BOTH collections
      // regardless of whether a login is being created (password may be added later).
      if (emailLower) {
        const [dupArtist, dupUser] = await Promise.all([
          Artist.findOne({ email: emailLower }),
          User.findOne({ email: emailLower }),
        ]);
        if (dupArtist) {
          return res.status(409).json({ error: "An artist with this email already exists" });
        }
        if (dupUser) {
          return res.status(409).json({ error: "This email is already used by a team member account" });
        }
      }

      let userId = null;

      // If email + password provided, create a linked User account (role: "artist")
      if (emailLower && req.body.password) {
        const passwordHash = await bcrypt.hash(req.body.password, 12);
        const user = await User.create({
          name: req.body.name.trim(),
          email: emailLower,
          passwordHash,
          role: "artist",
          createdBy: req.session.userId,
        });
        userId = user._id;
      }

      const artist = await Artist.create({
        name: req.body.name.trim(),
        phone: req.body.phone.trim(),
        email: emailLower,
        registrationId: req.body.registrationId?.trim() || null,
        commission: Number(req.body.commission) || 0,
        userId,
      });

      return res.status(201).json(artist);
    } catch (err) {
      console.error("[artists] Create error:", err);
      return res.status(500).json({ error: "Failed to create artist" });
    }
  }
);

// ─── PATCH /:id — Update an artist ─────────────────────────────────────────

router.patch(
  "/:id",
  validateId,
  authorizePermission(PERMISSIONS.ARTISTS_CRUD),
  [
    body("name")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Name cannot be empty"),
    body("phone")
      .optional()
      .trim()
      .matches(/^[6-9]\d{9}$/)
      .withMessage("Enter a valid 10-digit Indian mobile number"),
    body("isActive").optional().isBoolean().withMessage("isActive must be boolean"),
    body("email").optional({ values: "falsy" }).isEmail().withMessage("Enter a valid email"),
    body("registrationId").optional({ values: "falsy" }).trim(),
    body("commission")
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage("Commission must be 0–100"),
    body("password")
      .optional({ values: "falsy" })
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("permissions").optional().isArray().withMessage("permissions must be an array"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { id } = req.params;

      const artist = await Artist.findById(id);
      if (!artist) {
        return res.status(404).json({ error: "Artist not found" });
      }

      // Build update object
      const updateObj = {};
      if (req.body.name !== undefined) updateObj.name = req.body.name.trim();
      if (req.body.phone !== undefined) {
        // Check duplicate phone (excluding self)
        const dup = await Artist.findOne({
          phone: req.body.phone.trim(),
          _id: { $ne: id },
        });
        if (dup) {
          return res
            .status(409)
            .json({ error: "Another artist already has this phone number" });
        }
        updateObj.phone = req.body.phone.trim();
      }
      if (req.body.isActive !== undefined) {
        updateObj.isActive = req.body.isActive;
        // Also sync the linked User account's isActive so login works after reactivation
        if (artist.userId) {
          await User.findByIdAndUpdate(artist.userId, { isActive: req.body.isActive });
          // If deactivating, invalidate sessions immediately
          if (!req.body.isActive) {
            await invalidateUserSessions(req.sessionStore, artist.userId.toString());
          }
        }
      }
      const incomingEmail =
        req.body.email !== undefined
          ? req.body.email
            ? req.body.email.toLowerCase().trim()
            : null
          : undefined;

      // If email is being set to a new non-null value, enforce uniqueness across
      // both Artist and User collections before applying any updates.
      if (incomingEmail) {
        const [dupArtist, dupUser] = await Promise.all([
          // Exclude this artist from the Artist check
          Artist.findOne({ email: incomingEmail, _id: { $ne: id } }),
          // Exclude the artist's own linked login (they share email by design);
          // when artist.userId is null, $ne: null matches all users → full check.
          User.findOne({ email: incomingEmail, _id: { $ne: artist.userId ?? null } }),
        ]);
        if (dupArtist) {
          return res.status(409).json({ error: "Another artist already has this email" });
        }
        if (dupUser) {
          return res.status(409).json({ error: "This email is already used by a team member account" });
        }
      }

      if (incomingEmail !== undefined) updateObj.email = incomingEmail;
      if (req.body.registrationId !== undefined) updateObj.registrationId = req.body.registrationId?.trim() || null;
      if (req.body.commission !== undefined) updateObj.commission = Number(req.body.commission);
      const newPassword = req.body.password;
      let shouldInvalidateSessions = false;

      // Require an email when setting a password for a user without a linked account
      if (newPassword && !artist.userId && !incomingEmail) {
        return res.status(400).json({ error: "Email is required to set a login" });
      }

      // Sync linked User account (or create one) for email/password/name changes
      if (artist.userId) {
        const userUpdate = {};
        if (updateObj.name) userUpdate.name = updateObj.name;

        if (incomingEmail !== undefined && incomingEmail) {
          const dup = await User.findOne({ email: incomingEmail, _id: { $ne: artist.userId } });
          if (dup) {
            return res.status(409).json({ error: "A user with this email already exists" });
          }
          userUpdate.email = incomingEmail;
        }

        if (newPassword) {
          userUpdate.passwordHash = await bcrypt.hash(newPassword, 12);
        }

        if (Object.keys(userUpdate).length) {
          await User.findByIdAndUpdate(artist.userId, userUpdate);
          shouldInvalidateSessions = true;
        }
      } else if (incomingEmail && newPassword) {
        // Create a linked user if none exists and credentials were supplied
        const dup = await User.findOne({ email: incomingEmail });
        if (dup) {
          return res.status(409).json({ error: "A user with this email already exists" });
        }
        const passwordHash = await bcrypt.hash(newPassword, 12);
        const createdUser = await User.create({
          name: updateObj.name || artist.name,
          email: incomingEmail,
          passwordHash,
          role: "artist",
          createdBy: req.session.userId,
        });
        updateObj.userId = createdUser._id;
      }

      const updated = await Artist.findByIdAndUpdate(id, updateObj, { new: true });

      // If linked user credentials changed, log out all active sessions for that user
      if (shouldInvalidateSessions && (artist.userId || updateObj.userId)) {
        await invalidateUserSessions(req.sessionStore, (artist.userId || updateObj.userId).toString());
      }

      // Update permissions on the linked User account if provided
      const linkedUserId = updateObj.userId ?? artist.userId;
      if (req.body.permissions !== undefined && linkedUserId) {
        const validKeys = Object.values(PERMISSIONS);
        const validPerms = req.body.permissions.filter(k => validKeys.includes(k));
        await User.findByIdAndUpdate(linkedUserId, { permissions: validPerms });
        evictPermissionCache(linkedUserId.toString());
      }

      // Re-fetch with populated userId so response matches GET /all shape
      const populated = await Artist.findById(updated._id).populate("userId", "permissions isActive");
      return res.json(populated);
    } catch (err) {
      console.error("[artists] Update error:", err);
      return res.status(500).json({ error: "Failed to update artist" });
    }
  }
);

// ─── DELETE /:id — Soft-delete an artist ────────────────────────────────────

router.delete("/:id", validateId, authorizePermission(PERMISSIONS.ARTISTS_CRUD), async (req, res) => {
  try {
    const { id } = req.params;

    const artist = await Artist.findById(id);
    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    await Artist.findByIdAndUpdate(id, { isActive: false });

    // Also deactivate the linked User account if any
    if (artist.userId) {
      await User.findByIdAndUpdate(artist.userId, { isActive: false });
      await invalidateUserSessions(req.sessionStore, artist.userId.toString());
    }

    return res.json({ ok: true, message: "Artist deactivated successfully" });
  } catch (err) {
    console.error("[artists] Delete error:", err);
    return res.status(500).json({ error: "Failed to deactivate artist" });
  }
});

// ─── DELETE /:id/permanent — Hard-delete an artist from DB ──────────────────

router.delete("/:id/permanent", validateId, authorizePermission(PERMISSIONS.ARTISTS_CRUD), async (req, res) => {
  try {
    const { id } = req.params;

    const artist = await Artist.findById(id);
    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    // Also delete the linked User account if any
    if (artist.userId) {
      await invalidateUserSessions(req.sessionStore, artist.userId.toString());
      await User.findByIdAndDelete(artist.userId);
    }

    await Artist.findByIdAndDelete(id);
    return res.json({ ok: true, message: "Artist permanently deleted" });
  } catch (err) {
    console.error("[artists] Permanent delete error:", err);
    return res.status(500).json({ error: "Failed to delete artist" });
  }
});

module.exports = router;
