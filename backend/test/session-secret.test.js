/**
 * @file test/session-secret.test.js
 * @description Audit item 6: no hard-coded public fallback for SESSION_SECRET in production.
 *
 * In production (NODE_ENV === "production", same test bookingToken.js uses) a
 * missing secret must not take the whole API down: the server boots, staff and
 * session routes answer 503, and the public booking API and the Razorpay
 * webhook keep working. /api/health says whether the secret exists, never what it is.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { startDb, stopDb } = require("./helpers/db");
const { sessionSecret, DEV_SESSION_SECRET } = require("../utils/sessionSecret");

before(async () => { await startDb(); });
after(async () => { await stopDb(); });

test("sessionSecret: uses the configured secret everywhere", () => {
  assert.equal(sessionSecret({ SESSION_SECRET: "abc123", NODE_ENV: "production" }), "abc123");
  assert.equal(sessionSecret({ SESSION_SECRET: "abc123" }), "abc123");
});

test("sessionSecret: production without a secret has NO fallback", () => {
  assert.equal(sessionSecret({ NODE_ENV: "production" }), null);
  assert.equal(sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "" }), null);
  assert.equal(sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "   " }), null);
});

test("sessionSecret: development and test fall back to a dev-only value", () => {
  assert.equal(sessionSecret({}), DEV_SESSION_SECRET);
  assert.equal(sessionSecret({ NODE_ENV: "development" }), DEV_SESSION_SECRET);
  assert.equal(sessionSecret({ NODE_ENV: "test", SESSION_SECRET: "" }), DEV_SESSION_SECRET);
});

test("the test environment has a SESSION_SECRET set (so tests never rely on the dev fallback)", () => {
  assert.ok(process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length > 0);
});

/** Boot index.js in a child with this environment and make these requests. */
function bootWith(env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "helpers", "bootChild.js")], {
      env: {
        ...process.env,
        TURNSTILE_SECRET_KEY: "test-secret",
        PUBLIC_TOKEN_SECRET: "test-public-token-secret",
        RAZORPAY_WEBHOOK_SECRET: "test-webhook-secret",
        ...env,
        BOOT_REQUESTS: JSON.stringify(requests),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error("child timed out\n" + err)); }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("BOOT_RESULT "));
      if (!line) return reject(new Error(`child exited ${code} with no result\n${out}\n${err}`));
      resolve({ results: JSON.parse(line.slice("BOOT_RESULT ".length)), stdout: out, stderr: err });
    });
  });
}

const REQUESTS = [
  ["GET", "/api/health"],
  ["GET", "/api/bookings"],                 // staff route: needs a session
  ["POST", "/api/auth/login", { username: "x", password: "y" }], // login needs a session
  ["GET", "/api/public/site"],              // public website API
  ["POST", "/api/razorpay/webhook", {}],    // Razorpay webhook (bad signature on purpose)
];
const byPath = (res, method, p) => res.find((r) => r.method === method && r.path === p);

test("production WITHOUT a secret: boots, staff/session routes answer 503, public API and webhook still answer", async () => {
  const { results, stderr } = await bootWith({ NODE_ENV: "production", SESSION_SECRET: "" }, REQUESTS);

  assert.equal(byPath(results, "GET", "/api/bookings").status, 503);
  assert.equal(byPath(results, "POST", "/api/auth/login").status, 503);
  assert.equal(byPath(results, "GET", "/api/bookings").body.error, "SESSION_SECRET_MISSING");

  assert.equal(byPath(results, "GET", "/api/public/site").status, 200, "public booking site keeps working");
  const hook = byPath(results, "POST", "/api/razorpay/webhook");
  assert.notEqual(hook.status, 503, "Razorpay webhook is reachable");
  assert.ok([400, 401, 403].includes(hook.status), `webhook rejects the unsigned call itself, got ${hook.status}`);

  const health = byPath(results, "GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.sessionSecret, "missing");

  assert.match(stderr, /SESSION_SECRET is not set/, "a loud log line");
});

test("production WITH a secret: staff routes are reachable (401 without login, not 503) and health says ok", async () => {
  const { results, stdout, stderr } = await bootWith({ NODE_ENV: "production", SESSION_SECRET: "a-real-production-secret-value" }, REQUESTS);
  assert.equal(byPath(results, "GET", "/api/bookings").status, 401);
  assert.equal(byPath(results, "GET", "/api/public/site").status, 200);
  const health = byPath(results, "GET", "/api/health");
  assert.equal(health.body.sessionSecret, "ok");
  assert.ok(!JSON.stringify(results).includes("a-real-production-secret-value"), "the value is never printed in a response");
  assert.ok(!(stdout + stderr).includes("a-real-production-secret-value"), "nor in the logs");
  assert.doesNotMatch(stderr, /SESSION_SECRET is not set/);
});

test("development WITHOUT a secret: falls back, staff routes work as before", async () => {
  const { results } = await bootWith({ NODE_ENV: "development", SESSION_SECRET: "" }, REQUESTS);
  assert.equal(byPath(results, "GET", "/api/bookings").status, 401);
  assert.equal(byPath(results, "GET", "/api/health").body.sessionSecret, "ok");
});
