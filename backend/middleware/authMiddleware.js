/**
 * @file authMiddleware.js
 * @description Session-based authentication and role-based authorisation middleware.
 *
 * Usage in route mounting:
 *   const { authenticate, authorize } = require("./middleware/authMiddleware");
 *
 *   app.use("/api/admin", authenticate, authorize("owner"), adminRouter);
 *   app.use("/api/analytics", authenticate, authorize("manager", "owner"), analyticsRouter);
 */

const User = require('../models/User');
const { PERMISSIONS } = require('../constants/permissions');

// ─── In-process permission cache ─────────────────────────────────────────────
// Stores { permissions: string[], expiresAt: number } keyed by userId string.
// TTL is 60 seconds — a good balance between freshness and DB load.
// Always call evictPermissionCache(userId) after any permission or role change.
const permCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function evictPermissionCache(userId) {
  permCache.delete(String(userId));
}

async function getUserPermissions(userId) {
  const key    = String(userId);
  const cached = permCache.get(key);

  // Return cached value if it hasn't expired yet
  if (cached && cached.expiresAt > Date.now()) {
    return cached.permissions;
  }

  // Lightweight DB fetch — only the permissions field, not the whole document
  const user = await User.findById(userId, { permissions: 1 }).lean();
  const perms = user?.permissions ?? [];

  permCache.set(key, { permissions: perms, expiresAt: Date.now() + CACHE_TTL_MS });
  return perms;
}

/**
 * Verify that the request has an active session with a userId.
 * Returns 401 if the user is not signed in.
 */
function authenticate(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res
      .status(401)
      .json({ error: "Not authenticated. Please sign in." });
  }
  next();
}

/**
 * Factory that returns a middleware restricting access to the given roles.
 * Must be used AFTER `authenticate` so `req.session.role` is guaranteed.
 *
 * @param  {...string} roles - Allowed roles, e.g. "manager", "owner"
 * @returns {Function} Express middleware
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session.role)) {
      return res
        .status(403)
        .json({ error: "Access denied. Insufficient permissions." });
    }
    next();
  };
}

// authorizePermission — PBAC middleware factory.
// Use AFTER authenticate() and authorize() in the middleware chain.
// The owner role always bypasses this check (short-circuits before DB lookup).
//
// Usage example:
//   router.get('/analytics', authenticate, authorize('manager', 'owner'),
//              authorizePermission(PERMISSIONS.ANALYTICS_VIEW), handler);
//
function authorizePermission(requiredKey) {
  return async function(req, res, next) {
    // Owner is always exempt from permission checks
    if (req.session.role === 'owner') return next();

    try {
      const permissions = await getUserPermissions(req.session.userId);

      if (!permissions.includes(requiredKey)) {
        return res.status(403).json({
          error:    'Permission denied',
          required: requiredKey,
          message:  'You do not have permission to access this feature. Contact the owner to request access.',
        });
      }

      next();
    } catch (err) {
      console.error('authorizePermission error:', err);
      res.status(500).json({ error: 'Internal server error during permission check' });
    }
  };
}

module.exports = {
  authenticate,
  authorize,
  authorizePermission,      // NEW
  evictPermissionCache,     // NEW
  getUserPermissions,       // NEW (exported for testing)
};
