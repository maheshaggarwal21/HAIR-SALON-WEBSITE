/**
 * @file JobRun.js
 * @description One document per scheduled job: an overlap lock plus the last
 * result (CONTROL_FLOW_AND_DATA_LOGIC.md §16).
 *
 * The timer (cron-job.org, D19) can fire twice, retry after a timeout, or fire
 * while a slow run is still going. `utils/jobLock.js` takes this lock with one
 * conditional update, so at most one run of a job does its work at a time on
 * any number of serverless instances.
 */

const mongoose = require("mongoose");

const jobRunSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    lockedUntil: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastResult: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("JobRun", jobRunSchema);
