/**
 * @file test/helpers/bootChild.js
 * @description Boots the REAL app (index.js) in a throwaway child process with
 * exactly the environment the parent gives it, makes the requests listed in
 * BOOT_REQUESTS, prints one JSON line with the results, and exits.
 *
 * Why a child process: some behaviour is decided once, when index.js is loaded
 * (e.g. whether a session secret exists in production). The test process has
 * already loaded index.js, so a second environment needs a second process.
 * The parent supplies MONGODB_URI for its in-memory replica set; the child
 * never sees Atlas.
 */
const http = require("http");

const requests = JSON.parse(process.env.BOOT_REQUESTS || "[]");

(async () => {
  const app = require("../../index.js");
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = [];
  for (const [method, path, body] of requests) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "x-forwarded-for": "10.1.1.1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    out.push({ method, path, status: res.status, body: json });
  }
  console.log("BOOT_RESULT " + JSON.stringify(out));
  server.close();
  http.globalAgent.destroy();
  process.exit(0);
})().catch((err) => {
  console.error("BOOT_FAILED", err);
  process.exit(1);
});
