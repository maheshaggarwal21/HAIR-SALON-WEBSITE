/**
 * @file Reel.js
 * @description A short video for the website's reels wall (CF §2.2, T1.20).
 *
 * Phase 1b: the owner uploads reels in the staff app (Vercel Blob) or pastes a
 * link. The Instagram sync (Business account confirmed, Q7) will fill the same
 * collection later via `igMediaId`; the website doesn't care where a reel
 * came from. Hidden reels stay in the database but never reach the site.
 */

const mongoose = require("mongoose");

const reelSchema = new mongoose.Schema(
  {
    igMediaId: { type: String, default: undefined },
    mediaType: { type: String, enum: ["video", "image"], default: "video" },
    mediaUrl: { type: String, required: true },
    thumbnailUrl: { type: String, default: null },
    /** Link to the post on Instagram, if there is one. */
    permalink: { type: String, default: null },
    caption: { type: String, trim: true, maxlength: 300, default: null },
    postedAt: { type: Date, default: () => new Date() },
    visible: { type: Boolean, default: true },
    /** "Book this look": the service this reel shows. */
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", default: null },
    sortOrder: { type: Number, default: 0 },
    urlRefreshedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

reelSchema.index({ igMediaId: 1 }, { unique: true, sparse: true });
reelSchema.index({ visible: 1, sortOrder: 1, postedAt: -1 });

module.exports = mongoose.model("Reel", reelSchema);
