// backend/scripts/addArtistDashboardPermission.js
// Adds 'artist_dashboard.view' permission to all existing manager accounts
// that don't already have it.
//
// Run with: node scripts/addArtistDashboardPermission.js

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { PERMISSIONS } = require('../constants/permissions');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB. Looking for managers missing artist_dashboard.view...');

  const managers = await User.find({
    role: 'manager',
    permissions: { $not: { $elemMatch: { $eq: PERMISSIONS.ARTIST_DASHBOARD_VIEW } } },
  });

  console.log(`Found ${managers.length} manager(s) to update.`);

  for (const user of managers) {
    user.permissions = [...user.permissions, PERMISSIONS.ARTIST_DASHBOARD_VIEW];
    await user.save();
    console.log(`✅  ${user.email} → added artist_dashboard.view`);
  }

  console.log('Migration complete.');
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
