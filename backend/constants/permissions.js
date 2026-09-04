// backend/constants/permissions.js
// Canonical registry of all PBAC permission keys in the system.
// Import PERMISSIONS anywhere you need a permission key string.
// Import ROLE_DEFAULTS to seed new accounts with the right starting permissions.

const PERMISSIONS = Object.freeze({
  ANALYTICS_VIEW:        'analytics.view',
  PAYMENTS_VIEW:         'payments.view',
  // Narrows PAYMENTS_VIEW rather than granting anything on its own — see the
  // note above PERMISSION_LABELS. Useless without payments.view.
  PAYMENTS_TODAY_ONLY:   'payments.today_only',
  DATAPIPELINE_VIEW:     'datapipeline.view',
  SERVICES_VIEW:         'services.view',
  SERVICES_CRUD:         'services.crud',
  ARTISTS_VIEW:          'artists.view',
  ARTISTS_CRUD:          'artists.crud',
  ARTIST_DASHBOARD_VIEW: 'artist_dashboard.view',
  TEAM_VIEW:             'team.view',
  TEAM_MANAGE:           'team.manage',
  VISIT_CREATE:          'visit.create',
});

// Default permission sets assigned when a new account is created.
// The owner bypasses PBAC entirely — its array is intentionally empty and unused.
// Artists start with an empty array (no permissions by default); the owner can
// grant any permission via the Artist directory editor, and PBAC enforces it
// identically to any other role.
const ROLE_DEFAULTS = {
  manager:      [
    'analytics.view',
    'payments.view',
    'services.view',
    'artists.view',
    'artists.crud',
    'artist_dashboard.view',
    'visit.create',
  ],
  receptionist: [
    'payments.view',
    'visit.create',
  ],
  artist:       [], // starts empty — owner grants permissions individually via Artist directory
  owner:        [], // bypasses PBAC — this array is intentionally unused
};

// Human-readable labels used by the frontend permission editor UI.
// Keep this in sync with the PERMISSIONS object above.
//
// Almost every key here GRANTS access. `payments.today_only` is the exception:
// it RESTRICTS payments.view down to the current day. It is written as an
// opt-in restriction rather than making payments.view mean "today" and adding a
// payments.view_history key, because the latter would silently strip history
// from every account that already holds payments.view today.
const PERMISSION_LABELS = {
  'analytics.view':        'View Analytics Dashboard',
  'payments.view':         'View Payment History',
  'payments.today_only':   "↳ Restrict to today's payments only (hides older records)",
  'datapipeline.view':     'View Data Pipeline (includes per-artist revenue)',
  'services.view':         'View Services List',
  'services.crud':         'Manage Services (Create / Edit / Delete)',
  'artists.view':          'View Artist Directory',
  'artists.crud':          'Manage Artists (Create / Edit / Deactivate)',
  'artist_dashboard.view': 'View Artist Personal Dashboards',
  'team.view':             'View Team Management',
  'team.manage':           'Manage Team Accounts (Create / Edit / Deactivate)',
  'visit.create':          'Create Visit Entries',
};

// UI groupings for the permission editor checklist — purely cosmetic.
const PERMISSION_GROUPS = [
  {
    label: 'Visit Operations',
    keys:  ['visit.create'],
  },
  {
    label: 'Financials',
    // today_only sits directly under payments.view so the indented label reads
    // as a modifier of the line above it.
    keys:  ['payments.view', 'payments.today_only', 'datapipeline.view'],
  },
  {
    label: 'Analytics',
    keys:  ['analytics.view'],
  },
  {
    label: 'Artists',
    keys:  ['artists.view', 'artists.crud', 'artist_dashboard.view'],
  },
  {
    label: 'Services',
    keys:  ['services.view', 'services.crud'],
  },
  {
    label: 'Administration',
    keys:  ['team.view', 'team.manage'],
  },
];

module.exports = { PERMISSIONS, ROLE_DEFAULTS, PERMISSION_LABELS, PERMISSION_GROUPS };
