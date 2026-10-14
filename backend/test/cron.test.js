/**
 * @file test/cron.test.js
 * @description Scheduled jobs called by the outside timer (D19): the secret is
 * required, overlapping calls do the work once, and the request-SLA nudge
 * counts only opening hours and never repeats itself.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const { startDb, stopDb, clearDb } = require("./helpers/db");
const time = require("../utils/time");

let stub;
let sent = [];
let server;
let base;
let Appointment, SiteSettings, User, JobRun, runJob, requestsTick;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      sent.push(JSON.parse(raw || "{}"));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${stub.address().port}`;
  process.env.CRON_SECRET = "s3cret-for-tests";

  await startDb();
  Appointment = require("../models/Appointment");
  SiteSettings = require("../models/SiteSettings");
  User = require("../models/User");
  JobRun = require("../models/JobRun");
  ({ runJob } = require("../utils/jobLock"));
  ({ requestsTick } = require("../routes/cron"));

  const app = express();
  app.use("/api/cron", require("../routes/cron"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/cron`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  sent = [];
  await User.collection.insertOne({ name: "Owner", email: "o@example.com", role: "owner", isActive: true, telegramChatId: "111" });
});

const settingsLike = {
  openingHours: { mon: [{ open: "09:00", close: "21:00" }], tue: [], wed: [{ open: "09:00", close: "21:00" }] },
  holidays: [],
};

test("working minutes count only opening hours (IST), skipping the weekly off", () => {
  // Mon 26 Oct 2026, 20:00 IST → Wed 28 Oct 10:00 IST: 60 min Monday + 0 Tuesday + 60 Wednesday.
  const from = time.salonInstant("2026-10-26", "20:00");
  const to = time.salonInstant("2026-10-28", "10:00");
  assert.equal(time.workingMinutesBetween(settingsLike, from, to), 120);
  // Entirely overnight: nothing.
  assert.equal(
    time.workingMinutesBetween(settingsLike, time.salonInstant("2026-10-26", "21:30"), time.salonInstant("2026-10-26", "23:30")),
    0
  );
  assert.equal(time.workingMinutesBetween({ ...settingsLike, holidays: ["2026-10-28"] }, from, to), 60);
});

test("the timer must send the secret", async () => {
  assert.equal((await fetch(`${base}/requests-tick`)).status, 401);
  assert.equal((await fetch(`${base}/requests-tick`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const ok = await fetch(`${base}/requests-tick`, { headers: { Authorization: "Bearer s3cret-for-tests" } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).skipped, false);
});

test("overlapping runs of a job do the work once", async () => {
  let calls = 0;
  const slow = () => new Promise((r) => setTimeout(() => r(++calls), 100));
  const results = await Promise.all([runJob("x", slow), runJob("x", slow), runJob("x", slow)]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.skipped).length, 2);
  // Lock released afterwards: the next run goes ahead.
  assert.equal((await runJob("x", slow)).skipped, false);
  assert.equal((await JobRun.findOne({ name: "x" }).lean()).lockedUntil, null);
});

let n = 0;
async function request(createdAt) {
  return Appointment.create({
    ref: `EXP-C${String(++n).padStart(4, "2")}`,
    mode: "request",
    status: "requested",
    contact: "9876543210",
    name: "Asha",
    requestedWindow: { date: "2026-10-29", window: "evening" },
    pricing: { subtotal: 100, total: 100 },
    source: { channel: "web" },
    createdAt,
  });
}

test("requests waiting over 2 working hours are flagged to the owner once", async () => {
  await SiteSettings.getSingleton(); // defaults: 9–21, Tuesday off, 120 min SLA
  // A Wednesday, 15:00 IST.
  const now = time.salonInstant("2026-10-28", "15:00");
  const old = await request(time.salonInstant("2026-10-28", "12:30")); // 150 working min → overdue
  await request(time.salonInstant("2026-10-28", "14:00")); // 60 → not yet
  // Sent Monday 20:30; Tuesday closed → 30 + 360 min by Wed 15:00 → overdue.
  const overnight = await request(time.salonInstant("2026-10-26", "20:30"));

  const first = await requestsTick(now);
  assert.deepEqual([first.open, first.overdue, first.alerted], [3, 2, 2]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "111");
  assert.match(sent[0].text, new RegExp(old.ref));
  assert.match(sent[0].text, new RegExp(overnight.ref));

  // Next tick: nothing new to say.
  const second = await requestsTick(new Date(now.getTime() + 15 * 60_000));
  assert.equal(second.overdue, 0);
  assert.equal(sent.length, 1);
});

test("a confirmed request is never nudged", async () => {
  await SiteSettings.getSingleton();
  const a = await request(time.salonInstant("2026-10-28", "09:00"));
  await Appointment.updateOne({ _id: a._id }, { $set: { status: "confirmed" } });
  const out = await requestsTick(time.salonInstant("2026-10-28", "15:00"));
  assert.equal(out.overdue, 0);
  assert.equal(sent.length, 0);
});
