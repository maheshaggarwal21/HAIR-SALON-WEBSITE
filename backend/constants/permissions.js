// backend/constants/permissions.js
// Canonical registry of all PBAC permission keys in the system.
// Import PERMISSIONS anywhere you need a permission key string.
// Import ROLE_DEFAULTS to seed new accounts with the right starting permissions.

const PERMISSIONS = Object.freeze({
  ANALYTICS_VIEW:        'analytics.view',
  PAYMENTS_VIEW:         'payments.view',
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
// The artist role has a fixed separate flow and is not part of PBAC.
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
  artist:       [], // fixed flow — PBAC does not apply
  owner:        [], // bypasses PBAC — this array is intentionally unused
};

// Human-readable labels used by the frontend permission editor UI.
// Keep this in sync with the PERMISSIONS object above.
const PERMISSION_LABELS = {
  'analytics.view':        'View Analytics Dashboard',
  'payments.view':         'View Payment History',
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
    keys:  ['payments.view'],
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
