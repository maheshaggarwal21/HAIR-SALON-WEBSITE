/**
 * @file SlotLock.js
 * @description The double-booking guard (CONTROL_FLOW_AND_DATA_LOGIC.md §2.2, D4).
 *
 * One document = one 15-minute block of one artist's time (or one unit of a
 * shared station), owned by one appointment. The UNIQUE index on
 * {kind, artistId, resourceUnit, blockStart} is what makes double booking
 * impossible: two bookings racing for the same block both try to insert it
 * inside their transaction, and the database lets exactly one win. Never
 * replace this with an application-level "is it free?" check (CLAUDE.md).
 *
 * `artistId` holds the artist for kind "artist" and the Resource id for kind
 * "resource" (same field, so one unique index covers both).
 *
 * Holds (unpaid bookings, unanswered requests) carry `expiresAt`, and the TTL
 * index deletes them eventually. TTL runs about once a minute, so the create
 * transaction also deletes expired holds itself before inserting (E19). Firm
 * locks have no expiresAt and never expire.
 */

const mongoose = require("mongoose");

const BLOCK_MS = 15 * 60 * 1000;

const slotLockSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["artist", "resource"], required: true },
    artistId: { type: mongoose.Schema.Types.ObjectId, required: true },
    resourceUnit: { type: Number, default: 0 },
    blockStart: { type: Date, required: true },
    /** null for staff "block time" (training, lunch). */
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment", default: null },
    state: { type: String, enum: ["hold", "firm"], required: true },
    expiresAt: { type: Date, default: undefined },
    /** Why a block exists without an appointment ("Training"). */
    note: { type: String, default: null },
  },
  { versionKey: false }
);

slotLockSchema.index({ kind: 1, artistId: 1, resourceUnit: 1, blockStart: 1 }, { unique: true });
slotLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
slotLockSchema.index({ appointmentId: 1 });
slotLockSchema.index({ blockStart: 1, kind: 1 });

module.exports = mongoose.model("SlotLock", slotLockSchema);
module.exports.BLOCK_MS = BLOCK_MS;
