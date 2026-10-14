/**
 * @file TimeOff.js
 * @description An artist's leave or blocked time (CF §2.2). The availability
 * engine subtracts it from the artist's working intervals. Adding time off over
 * existing bookings is allowed but warned about (E8, T2.18).
 */

const mongoose = require("mongoose");

const timeOffSchema = new mongoose.Schema(
  {
    artistId: { type: mongoose.Schema.Types.ObjectId, ref: "Artist", required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 200, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

timeOffSchema.pre("validate", function () {
  if (this.endAt <= this.startAt) this.invalidate("endAt", "Time off must end after it starts");
});
timeOffSchema.index({ artistId: 1, startAt: 1, endAt: 1 });

module.exports = mongoose.model("TimeOff", timeOffSchema);
