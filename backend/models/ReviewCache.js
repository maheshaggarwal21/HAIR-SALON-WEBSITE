/**
 * @file ReviewCache.js
 * @description The salon's Google rating and recent reviews, refreshed once a
 * day from the Places API (New) (CF §13, T1.21). One document, key "google".
 *
 * Shown exactly as Google returns them, with attribution: no editing, no
 * filtering by star rating (§13). If the refresh fails, the last good copy
 * stays and the website keeps showing it.
 */

const mongoose = require("mongoose");

const reviewCacheSchema = new mongoose.Schema(
  {
    key: { type: String, default: "google", unique: true },
    rating: { type: Number, default: null },
    count: { type: Number, default: null },
    mapsUri: { type: String, default: null },
    reviews: {
      type: [
        new mongoose.Schema(
          {
            author: String,
            authorUri: String,
            rating: Number,
            text: String,
            relativeTime: String,
            publishTime: Date,
            profilePhoto: String,
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    fetchedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ReviewCache", reviewCacheSchema);
