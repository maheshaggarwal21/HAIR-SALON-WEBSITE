/**
 * @file Resource.js
 * @description A shared station — facial bed, pedicure station, makeup chair —
 * with a capacity (CF §2.2). Services that need one list it in
 * Service.resourceIds; the engine then also needs a free unit of the station.
 * Not used until the owner creates stations (Q5 default: not tracked).
 */

const mongoose = require("mongoose");

const resourceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    capacity: { type: Number, required: true, min: 1, max: 20, default: 1 },
    serviceIds: { type: [mongoose.Schema.Types.ObjectId], ref: "Service", default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Resource", resourceSchema);
