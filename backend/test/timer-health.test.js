/**
 * @file test/timer-health.test.js
 * @description Audit item 7: a watchdog for the outside 15-minute timer.
 *
 * The bookings-tick job (cron-job.org, every 15 minutes) releases unpaid holds
 * and sends reminders. If the timer dies, nothing on the server notices. The
 * job already records JobRun.lastRunAt; this reads it:
 *   - /api/health shows { ok, minutesAgo } so an uptime monitor can watch it;
 *   - the daily morning job tells the owner on Telegram, once a day, when the
 *     timer is older than 45 minutes or has never run.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { startDb, stopDb, clearDb } = require("./helpers/db");

let JobRun, User, NotificationLog, telegram, timerHealth, morning, server, base;
let sent = [];
let telegramOk = true;

const MIN = 60_000;
const NOW = new Date("2026-10-26T03:00:00Z"); // 08:30 IST, an ordinary morning

before(async () => {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "x", PUBLIC_TOKEN_SECRET: "t", META_WA_TOKEN: "", META_WA_PHONE_NUMBER_ID: "" });
  await startDb();
  JobRun = require("../models/JobRun");
  User = require("../models/User");
  NotificationLog = require("../models/NotificationLog");
  telegram = require("../utils/telegram");
  telegram.isConfigured = () => true;
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return telegramOk ? { ok: true } : { ok: false, description: "chat not found" };
  };
  timerHealth = require("../utils/timerHealth");
  morning = require("../utils/morning");
  const app = require("../index.js");
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  sent = [];
  telegramOk = true;
  await User.collection.insertOne({ name: "Owner", email: "o@example.com", role: "owner", isActive: true, permissions: [], telegramChatId: "555" });
});

const tickRanAgo = (minutes, extra = {}) =>
  JobRun.create({ name: "bookings-tick", lastRunAt: new Date(NOW.getTime() - minutes * MIN), ...extra });

test("the threshold is a named constant of 45 minutes", () => {
  assert.equal(timerHealth.BOOKINGS_TICK_STALE_MS, 45 * MIN);
});

test("fresh: ran 7 minutes ago", async () => {
  await tickRanAgo(7);
  assert.deepEqual(await timerHealth.checkBookingsTickHealth(NOW), { ok: true, minutesAgo: 7 });
});

test("exactly 45 minutes is still fine; 46 is stale", async () => {
  await tickRanAgo(45);
  assert.equal((await timerHealth.checkBookingsTickHealth(NOW)).ok, true);
  await JobRun.updateOne({ name: "bookings-tick" }, { $set: { lastRunAt: new Date(NOW.getTime() - 46 * MIN) } });
  assert.deepEqual(await timerHealth.checkBookingsTickHealth(NOW), { ok: false, minutesAgo: 46 });
});

test("stale: ran 3 hours ago", async () => {
  await tickRanAgo(180);
  assert.deepEqual(await timerHealth.checkBookingsTickHealth(NOW), { ok: false, minutesAgo: 180 });
});

test("never ran: no JobRun document, or one that was only ever locked", async () => {
  assert.deepEqual(await timerHealth.checkBookingsTickHealth(NOW), { ok: false, minutesAgo: null });
  await JobRun.create({ name: "bookings-tick", lockedUntil: new Date(NOW.getTime() + MIN), lastRunAt: null });
  assert.deepEqual(await timerHealth.checkBookingsTickHealth(NOW), { ok: false, minutesAgo: null });
});

test("a clock a little ahead of the database never shows a negative age", async () => {
  await JobRun.create({ name: "bookings-tick", lastRunAt: new Date(NOW.getTime() + 2 * MIN) });
  assert.deepEqual(await timerHealth.checkBookingsTickHealth(NOW), { ok: true, minutesAgo: 0 });
});

test("morning job: stale timer → one Telegram alert to the owner, naming how long", async () => {
  await tickRanAgo(180);
  const out = await morning.morningRun(NOW);
  assert.equal(out.timerAlerts, 1);
  const alerts = sent.filter((m) => /timer/i.test(m.text));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].chatId, "555");
  assert.match(alerts[0].text, /3 h|180 min|3 hours/);
});

test("morning job: never ran → alert says it has never run", async () => {
  await morning.morningRun(NOW);
  const alerts = sent.filter((m) => /timer/i.test(m.text));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /never/i);
});

test("morning job: on a day the salon is closed, a dead timer is still reported", async () => {
  const time = require("../utils/time");
  let d = time.addDays(time.salonDate(), 1);
  while (time.weekdayKey(d) !== "tue") d = time.addDays(d, 1);
  const out = await morning.morningRun(time.salonInstant(d, "08:15"));
  assert.equal(out.closed, true);
  assert.equal(out.timerAlerts, 1);
});

test("morning job: fresh timer → no alert", async () => {
  await tickRanAgo(5);
  const out = await morning.morningRun(NOW);
  assert.equal(out.timerAlerts, 0);
  assert.equal(sent.filter((m) => /timer/i.test(m.text)).length, 0);
});

test("alert goes out ONCE a day, even if the morning job is called twice", async () => {
  await tickRanAgo(180);
  await morning.morningRun(NOW);
  await morning.morningRun(NOW);
  await morning.morningRun(new Date(NOW.getTime() + 10 * MIN)); // same IST day
  assert.equal(sent.filter((m) => /timer/i.test(m.text)).length, 1);
  assert.equal(await NotificationLog.countDocuments({ type: "owner_timer_alert" }), 1);
});

test("next day, a still-stale timer alerts again", async () => {
  await tickRanAgo(180);
  await morning.morningRun(NOW);
  await morning.morningRun(new Date(NOW.getTime() + 24 * 60 * MIN));
  assert.equal(sent.filter((m) => /timer/i.test(m.text)).length, 2);
});

test("a Telegram failure is retried by the next call, not marked as done", async () => {
  await tickRanAgo(180);
  telegramOk = false;
  assert.equal((await morning.morningRun(NOW)).timerAlerts, 0);
  assert.equal((await NotificationLog.findOne({ type: "owner_timer_alert" })).status, "failed");
  telegramOk = true;
  assert.equal((await morning.morningRun(NOW)).timerAlerts, 1);
  assert.equal((await morning.morningRun(NOW)).timerAlerts, 0, "and then it stays done");
});

test("the watchdog failing never stops the morning job", async () => {
  const original = JobRun.findOne;
  JobRun.findOne = () => { throw new Error("db hiccup"); };
  const log = console.error;
  console.error = () => {};
  try {
    const out = await morning.morningRun(NOW);
    assert.equal(out.timerAlerts, 0);
    assert.ok(out.date, "the rest of the morning run still ran");
  } finally {
    JobRun.findOne = original;
    console.error = log;
  }
});

test("/api/health: stable parseable shape, no secrets, no error text", async () => {
  await JobRun.create({ name: "bookings-tick", lastRunAt: new Date(Date.now() - 7 * MIN), lastError: "SECRET-boom-detail", lastResult: { x: "SECRET-result" } });
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body.timers.bookingsTick).sort(), ["minutesAgo", "ok"]);
  assert.equal(body.timers.bookingsTick.ok, true);
  assert.equal(body.timers.bookingsTick.minutesAgo, 7);
  assert.ok(!JSON.stringify(body).includes("SECRET"));

  await JobRun.deleteMany({});
  const never = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(never.timers.bookingsTick, { ok: false, minutesAgo: null });
});
