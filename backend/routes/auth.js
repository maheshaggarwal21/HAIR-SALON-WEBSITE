/**
 * @file auth.js
 * @description Authentication routes — login, logout, session check.
 *
 * Mounted at /api/auth in index.js (public — no auth middleware).
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");
const connectDB = require("../db");
const User = require("../models/User");

const router = express.Router();

// Strict rate limit for login — 10 attempts per 15 min per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});

// ── Ensure DB on every request (Vercel cold-start) ─────────────────────────
router.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[auth] DB middleware error:", err.message);
    res.status(503).json({ error: "Database unavailable", details: err.message });
  }
});

// ─── POST /login ────────────────────────────────────────────────────────────

router.post(
  "/login",
  loginLimiter,
  [
    body("email").isEmail().withMessage("A valid email is required"),
    body("password")
      .isString()
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    // Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const user = await User.findOne({
        email: req.body.email.toLowerCase(),
        isActive: true,
      });

      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const valid = await user.verifyPassword(req.body.password);
      if (!valid) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Persist session
      req.session.userId = user._id.toString();
      req.session.role = user.role;
      req.session.name = user.name;
      req.session.email = user.email;

      // Explicitly save session before responding (serverless may terminate early)
      req.session.save((err) => {
        if (err) {
          console.error("[auth] Session save error:", err);
          return res.status(500).json({ error: "Failed to create session" });
        }
        return res.json({
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          permissions: user.permissions ?? [],
        });
      });
    } catch (err) {
      console.error("[auth] Login error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ─── POST /logout ───────────────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("[auth] Session destroy error:", err);
      return res.status(500).json({ error: "Failed to sign out" });
    }
    res.clearCookie("connect.sid", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return res.json({ ok: true });
  });
});

// ─── GET /me ────────────────────────────────────────────────────────────────

router.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Fetch permissions from DB so they are always fresh
  const user = await User.findById(req.session.userId, { permissions: 1 }).lean();

  return res.json({
    id: req.session.userId,
    name: req.session.name,
    email: req.session.email,
    role: req.session.role,
    permissions: user?.permissions ?? [],
  });
});

module.exports = router;
