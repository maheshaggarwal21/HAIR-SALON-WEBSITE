/**
 * @file authMiddleware.js
 * @description Session-based authentication and PBAC (permission-based) authorisation middleware.
 *
 * Design principle: roles are ONLY used to set the initial permission array when
 * an account is created (see ROLE_DEFAULTS in constants/permissions.js). After that,
 * access to every route is controlled exclusively by authorizePermission(PERMISSION_KEY).
 *
 * The only exception is authorize("artist") on /api/artist-dashboard, which guards
 * identity-scoped personal data (an artist reading their own stats) — there is no
 * grantable permission key that maps to "access your own data".
 *
 * Usage:
 *   authenticate             — verify session exists
 *   authorizePermission(key) — check user.permissions includes the key (owner always passes)
 *   authorize(...roles)      — RESERVED for identity-scope guards only (artist dashboard)
 */

const User = require('../models/User');
const connectDB = require('../db');
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

  /**
   * Defence in depth: this middleware is mounted app-wide and runs BEFORE any
   * router's own connect-on-request middleware. A router that forgets to add
   * one leaves this read hitting an unconnected mongoose on a cold serverless
   * container, where it buffers, times out and throws — which staff see as
   * "Internal server error during permission check". routes/visits.js did
   * exactly that. connectDB is an idempotent singleton, so calling it here is
   * effectively free once warm and removes a whole class of ordering bug.
   */
  await connectDB();

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
