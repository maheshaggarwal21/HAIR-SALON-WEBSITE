/**
 * @file NotificationLog.js
 * @description One row per customer/artist message we meant to send
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §2.2, §11, T2.13).
 *
 * `key` is unique — "<appointmentId>:<type>" — so the same message is never
 * sent twice, whether the webhook and the browser both confirm a payment or a
 * cron job runs twice (E5). A "failed" row is retried once by the cron (E21);
 * "pending" means a send was claimed and is in flight (or its instance died,
 * in which case the cron treats it like a failure after a few minutes).
 */

const mongoose = require("mongoose");

const notificationLogSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment", default: null },
    type: { type: String, required: true },
    channel: { type: String, enum: ["whatsapp", "telegram", "dev"], required: true },
    /** Recipient phone (10 digits) or Telegram chat; staff-only. */
    to: { type: String, default: null },
    status: { type: String, enum: ["pending", "sent", "failed", "skipped"], required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: null },
    providerId: { type: String, default: null },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

notificationLogSchema.index({ status: 1, updatedAt: 1 });
notificationLogSchema.index({ appointmentId: 1 });

module.exports = mongoose.model("NotificationLog", notificationLogSchema);
