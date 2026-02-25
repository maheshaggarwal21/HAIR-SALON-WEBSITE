/**
 * @file seedArtistUser.js
 * @description One-time seed script to create a dummy artist with
 *              a linked User account for testing the artist dashboard.
 *
 * Run:  node scripts/seedArtistUser.js
 *
 * Credentials:
  *   Email:    artist@theexperts.in
  *   Password: Artist@123
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const connectDB = require("../db");
const User = require("../models/User");
const Artist = require("../models/Artist");

async function seed() {
  await connectDB();

  const email = "artist@theexperts.in";
  const password = "Artist@123";
  const name = "Demo Artist";
  const phone = "9876543210";
  const commission = 30; // 30% commission

  // Check if user already exists
  let user = await User.findOne({ email });
  if (!user) {
    const passwordHash = await bcrypt.hash(password, 12);
    user = await User.create({
      name,
      email,
      passwordHash,
      role: "artist",
    });
    console.log("✅ User account created:", email);
  } else {
    console.log("ℹ️  User account already exists:", email);
    // Ensure role is artist and active
    if (user.role !== "artist" || !user.isActive) {
      user.role = "artist";
      user.isActive = true;
      await user.save();
      console.log("   → Updated role to artist and activated");
    }
  }

  // Check if artist record exists for this phone
  let artist = await Artist.findOne({ phone });
  if (!artist) {
    artist = await Artist.create({
      name,
      phone,
      email,
      registrationId: "REG-001",
      commission,
      photo: null,
      userId: user._id,
    });
    console.log("✅ Artist record created:", name, `(${commission}% commission)`);
  } else {
    // Link to user if not already linked
    if (!artist.userId) {
      artist.userId = user._id;
      artist.email = email;
      artist.commission = commission;
      artist.registrationId = "REG-001";
      await artist.save();
      console.log("ℹ️  Artist record linked to user account");
    } else {
      console.log("ℹ️  Artist record already exists and is linked");
    }
  }

  console.log("\n🎯 Dummy Artist Credentials:");
  console.log("   Email:    artist@theexperts.in");
  console.log("   Password: Artist@123");
  console.log(`   Commission: ${commission}%\n`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
