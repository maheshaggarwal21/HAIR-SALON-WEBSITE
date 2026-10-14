/**
 * @file jobLock.js
 * @description Run a scheduled job at most once at a time (CF §16).
 *
 * Lock = one atomic update: take the JobRun document only if its lock has
 * expired. A second caller either fails the filter (lock held) or, on the very
 * first run, loses the insert race on the unique `name` index — both mean
 * "someone else is running it", and the caller returns { skipped: true }.
 *
 * The lock has a time limit (default 10 min, §16) so a run killed mid-way by a
 * serverless timeout doesn't block the job forever. Jobs must still be
 * idempotent: the lock prevents overlap, not a re-run after a crash.
 */

const JobRun = require("../models/JobRun");

/**
 * @param {string}   name
 * @param {Function} fn         async () => result (must be idempotent)
 * @param {object}   [opts]
 * @param {number}   [opts.lockMs=600000]
 * @returns {Promise<{skipped: true} | {skipped: false, result: any}>}
 */
async function runJob(name, fn, { lockMs = 10 * 60 * 1000 } = {}) {
  const now = new Date();
  try {
    await JobRun.findOneAndUpdate(
      { name, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $set: { lockedUntil: new Date(now.getTime() + lockMs) } },
      { upsert: true }
    );
  } catch (err) {
    if (err?.code === 11000) return { skipped: true };
    throw err;
  }

  try {
    const result = await fn();
    await JobRun.updateOne(
      { name },
      { $set: { lockedUntil: null, lastRunAt: new Date(), lastResult: result ?? null, lastError: null } }
    );
    return { skipped: false, result };
  } catch (err) {
    await JobRun.updateOne(
      { name },
      { $set: { lockedUntil: null, lastRunAt: new Date(), lastError: String(err?.message || err) } }
    ).catch(() => {});
    throw err;
  }
}

module.exports = { runJob };
