// backend/scripts/migratePermissions.js
// One-time migration: backfill permissions[] on all existing User documents.
// Run with: node scripts/migratePermissions.js

require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../models/User');
const { ROLE_DEFAULTS } = require('../constants/permissions');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB. Starting permissions migration...');

  // Only touch users whose permissions array is currently empty or missing
  const users = await User.find({
    $or: [
      { permissions: { $exists: false } },
      { permissions: { $size: 0 } },
    ],
  });
  console.log(`Found ${users.length} users to migrate.`);

  for (const user of users) {
    const defaults = ROLE_DEFAULTS[user.role] ?? [];
    user.permissions = defaults;
    await user.save();
    console.log(`✅  ${user.email} (${user.role}) → [${defaults.join(', ')}]`);
  }

  console.log('Migration complete.');
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
