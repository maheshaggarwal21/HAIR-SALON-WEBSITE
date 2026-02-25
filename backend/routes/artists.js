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
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { body, validationResult } = require("express-validator");
const connectDB = require("../db");
const Artist = require("../models/Artist");
const User = require("../models/User");
const { authorize } = require("../middleware/authMiddleware");
const validateId = require("../middleware/validateId");

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

// ─── GET /all — List ALL artists (including inactive) — manager + owner ─────

router.get("/all", authorize("manager", "owner"), async (_req, res) => {
  try {
    const artists = await Artist.find({}).sort({ createdAt: -1 });
    return res.json(artists);
  } catch (err) {
    console.error("[artists] List all error:", err);
    return res.status(500).json({ error: "Failed to fetch artists" });
  }
});

// ─── POST / — Create a new artist (+ optional linked User account) ──────────

router.post(
  "/",
  authorize("manager", "owner"),
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
    body("photo").optional({ values: "falsy" }).trim(),
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

      let userId = null;

      // If email + password provided, create a linked User account (role: "artist")
      if (req.body.email && req.body.password) {
        const emailLower = req.body.email.toLowerCase().trim();

        // Check if a user with this email already exists
        const existingUser = await User.findOne({ email: emailLower });
        if (existingUser) {
          return res
            .status(409)
            .json({ error: "A user with this email already exists" });
        }

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
        email: req.body.email ? req.body.email.toLowerCase().trim() : null,
        registrationId: req.body.registrationId?.trim() || null,
        commission: Number(req.body.commission) || 0,
        photo: req.body.photo?.trim() || null,
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
  authorize("manager", "owner"),
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
    body("photo").optional({ values: "falsy" }).trim(),
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
      if (req.body.isActive !== undefined) updateObj.isActive = req.body.isActive;
      if (req.body.email !== undefined) updateObj.email = req.body.email ? req.body.email.toLowerCase().trim() : null;
      if (req.body.registrationId !== undefined) updateObj.registrationId = req.body.registrationId?.trim() || null;
      if (req.body.commission !== undefined) updateObj.commission = Number(req.body.commission);
      if (req.body.photo !== undefined) updateObj.photo = req.body.photo?.trim() || null;

      const updated = await Artist.findByIdAndUpdate(id, updateObj, { new: true });

      // If the artist has a linked User account, sync the name
      if (updated.userId && updateObj.name) {
        await User.findByIdAndUpdate(updated.userId, { name: updateObj.name });
      }

      return res.json(updated);
    } catch (err) {
      console.error("[artists] Update error:", err);
      return res.status(500).json({ error: "Failed to update artist" });
    }
  }
);

// ─── DELETE /:id — Soft-delete an artist ────────────────────────────────────

router.delete("/:id", validateId, authorize("manager", "owner"), async (req, res) => {
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
    }

    return res.json({ ok: true, message: "Artist deactivated successfully" });
  } catch (err) {
    console.error("[artists] Delete error:", err);
    return res.status(500).json({ error: "Failed to deactivate artist" });
  }
});

// ─── DELETE /:id/permanent — Hard-delete an artist from DB ──────────────────

router.delete("/:id/permanent", validateId, authorize("owner"), async (req, res) => {
  try {
    const { id } = req.params;

    const artist = await Artist.findById(id);
    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    // Also delete the linked User account if any
    if (artist.userId) {
      await User.findByIdAndDelete(artist.userId);
    }

    await Artist.findByIdAndDelete(id);
    return res.json({ ok: true, message: "Artist permanently deleted" });
  } catch (err) {
    console.error("[artists] Permanent delete error:", err);
    return res.status(500).json({ error: "Failed to delete artist" });
  }
});

// ─── Photo upload via multer ─────────────────────────────────────────────────
// Vercel's serverless filesystem is read-only except /tmp.
// Use /tmp/uploads so multer can write files without crashing on cold start.

const uploadsDir = process.env.VERCEL
  ? path.join("/tmp", "uploads")
  : path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const uniqueName = `artist-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    cb(null, extOk && mimeOk);
  },
});

/**
 * POST /:id/photo  — Upload a photo from the user's system.
 * Saves the file to /uploads/ and stores the URL in artist.photo.
 * Returns the updated artist record.
 */
router.post(
  "/:id/photo",
  validateId,
  authorize("manager", "owner"),
  upload.single("photo"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const artist = await Artist.findById(id);
      if (!artist) {
        return res.status(404).json({ error: "Artist not found" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No valid image file provided. Allowed: jpg, png, webp, gif (max 5 MB)" });
      }

      // Delete old uploaded photo if it's a local file
      if (artist.photo && artist.photo.startsWith("/uploads/")) {
        const filename = path.basename(artist.photo);
        const oldPath = path.join(uploadsDir, filename);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      // Store relative URL: /uploads/filename.ext
      const photoUrl = `/uploads/${req.file.filename}`;
      artist.photo = photoUrl;
      await artist.save();

      return res.json(artist);
    } catch (err) {
      console.error("[artists] Photo upload error:", err);
      return res.status(500).json({ error: "Failed to upload photo" });
    }
  }
);

module.exports = router;
