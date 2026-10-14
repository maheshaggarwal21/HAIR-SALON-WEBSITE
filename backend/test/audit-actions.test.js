/**
 * @file test/audit-actions.test.js
 * @description Every audit action a route writes must be in AuditLog's enum.
 * audit.record() swallows errors on purpose (an audit hiccup must never block
 * the owner), so a missing name would otherwise be silently not recorded.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("every audit action used in routes is allowed by the AuditLog model", () => {
  const src = fs.readFileSync(path.join(__dirname, "../models/AuditLog.js"), "utf8");
  const allowed = new Set([...src.match(/const ACTIONS\s*=\s*\[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const dir = path.join(__dirname, "../routes");
  const used = new Set();
  for (const f of fs.readdirSync(dir)) {
    const code = fs.readFileSync(path.join(dir, f), "utf8");
    // audit.record({ action: "…" }) and statusChange({ auditAction: "…" })
    for (const m of code.matchAll(/(?:audit\.record\(\{\s*action|auditAction):\s*"([a-z_.]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 5, "found the audit calls");
  assert.deepEqual([...used].filter((a) => !allowed.has(a)), []);
});
