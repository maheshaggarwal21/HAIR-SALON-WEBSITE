/**
 * @file audit.js
 * @description Fire-and-forget writer for the AuditLog collection.
 *
 * Auditing must never be able to fail a request it is describing, so every
 * write is wrapped and swallowed. A dropped audit line is a monitoring problem;
 * a 500 on login because the audit insert failed is an outage.
 */

const AuditLog = require("../models/AuditLog");

/**
 * @param {object} opts
 * @param {string} opts.action     one of AuditLog.ACTIONS
 * @param {object} [opts.req]      express request — supplies actor + ip + UA
 * @param {object} [opts.actor]    { id, name, role } when there is no session
 * @param {object} [opts.target]   { id, name }
 * @param {object} [opts.meta]
 */
async function record({ action, req, actor, target, meta }) {
  try {
    const sessionActor = req?.session?.userId
      ? {
          id:   req.session.userId,
          name: req.session.name,
          role: req.session.role,
        }
      : null;

    const who = actor ?? sessionActor ?? { id: null, name: "anonymous", role: null };

    await AuditLog.create({
      action,
      actorUserId:  who.id ?? null,
      actorName:    who.name ?? "anonymous",
      actorRole:    who.role ?? null,
      targetUserId: target?.id ?? null,
      targetName:   target?.name ?? null,
      meta:         meta ?? {},
      ip:           clientIp(req),
      userAgent:    req?.get?.("user-agent") ?? null,
    });
  } catch (err) {
    console.error("[audit] write failed:", err.message);
  }
}

/**
 * Best-effort client IP. Trusts X-Forwarded-For because the app runs behind
 * Vercel's proxy with `trust proxy` already enabled in index.js.
 */
function clientIp(req) {
  if (!req) return null;
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.ip ?? null;
}

/** Diff two permission arrays into { added, removed } for readable audit meta. */
function diffPermissions(before = [], after = []) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added:   after.filter((k) => !b.has(k)),
    removed: before.filter((k) => !a.has(k)),
  };
}

module.exports = { record, clientIp, diffPermissions };
