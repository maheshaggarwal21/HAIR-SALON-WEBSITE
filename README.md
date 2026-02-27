# The Experts Hair Salon — Full-Stack Management System

> **A production-grade, full-stack hair salon management platform** built for real daily operations.  
> Live site: [www.thexpertshair.com](https://www.thexpertshair.com) · API: [api.thexpertshair.com](https://api.thexpertshair.com)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Folder Structure](#3-folder-structure)
4. [Environment Variables](#4-environment-variables)
5. [Database Models](#5-database-models)
6. [Backend — API Endpoints](#6-backend--api-endpoints)
7. [Frontend — Pages & Screens](#7-frontend--pages--screens)
8. [Access Control — PBAC](#8-access-control--pbac)
9. [Feature Walkthrough](#9-feature-walkthrough)
10. [Security Architecture](#10-security-architecture)
11. [Analytics System](#11-analytics-system)
12. [Payment Integration](#12-payment-integration)
13. [Running Locally](#13-running-locally)
14. [Deployment](#14-deployment)
15. [File Reference](#15-file-reference)

---

## 1. Project Overview

This is a **complete salon management system** built for "The Experts Hair Salon." It replaces paper records and manual processes with a digital platform that handles:

- **Client visit recording** — Every client visit is logged with services, artist, timings, and payment
- **Multi-mode payment** — Razorpay (online/UPI), Cash, or Split (partial cash + partial online)
- **Role-based dashboards** — Four different user types, each seeing only what they're permitted to
- **Artist performance analytics** — Revenue, commission, time efficiency, leaderboards
- **Service & team management** — Owner controls everything; managers handle operations
- **Payment history** — Full transaction ledger with filtering and Excel export

Think of this as a mini-ERP system tailored specifically for a hair salon.

---

## 2. Tech Stack

### Backend

| Technology | Version | Why it's used |
|---|---|---|
| **Node.js + Express** | Express 4.x | HTTP server and REST API framework. Express is minimal and flexible — perfect for building clean route handlers. |
| **MongoDB + Mongoose** | Mongoose 9.x | Document database. Each visit, user, artist, and service is a document. Mongoose adds schema validation and query helpers on top of the raw MongoDB driver. |
| **express-session + connect-mongo** | Session 1.x | Session-based authentication. The server creates a session after login and stores it in MongoDB so it survives server restarts and scales across serverless invocations. |
| **bcryptjs** | 3.x | Password hashing. Passwords are NEVER stored as plain text — bcrypt hashes them with a salt factor of 12 (computationally slow by design, making brute-force attacks impractical). |
| **Razorpay Node SDK** | 2.x | Payment gateway. Used to create payment orders and verify HMAC signatures after payment. |
| **express-validator** | 7.x | Input validation middleware. Every POST/PATCH request runs through validators before reaching the database. |
| **helmet** | 8.x | Sets secure HTTP headers (Content-Security-Policy, X-Frame-Options, etc.) automatically. |
| **express-rate-limit** | 8.x | Prevents brute-force and DDoS attacks by capping requests to 200 per 15 minutes per IP. |
| **xlsx (SheetJS)** | 0.18.x | Server-side Excel file generation for the analytics export endpoint. |
| **cors** | 2.x | Cross-Origin Resource Sharing — controls which frontend origins are allowed to call the API. |
| **dotenv** | 17.x | Loads `.env` file into `process.env` for local development. |

### Frontend

| Technology | Version | Why it's used |
|---|---|---|
| **React** | 19.x | Component-based UI library. Every screen is built as a tree of reusable React components. |
| **TypeScript** | 5.9.x | Adds static types to JavaScript. Catches bugs at compile time rather than at runtime in production. |
| **Vite** | 7.x | Build tool and dev server. Significantly faster than Webpack — hot module replacement is near-instant. |
| **React Router DOM** | 7.x | Client-side routing. Handles navigation between pages without a full page reload. |
| **Tailwind CSS** | 4.x | Utility-first CSS framework. Styles are applied directly in JSX using class names — no separate CSS files needed. |
| **Framer Motion** | 12.x | Production-ready animations. Used for page transitions, modal entry/exit, and micro-interactions. |
| **Recharts** | 3.x | Composable chart library built on D3. Used for bar charts in the Employee Deep Dive analytics panel. |
| **Radix UI** | Various | Accessible, unstyled component primitives (Select, Popover, Label). Used as the base for custom-styled UI components. |
| **xlsx (SheetJS)** | 0.18.x | Client-side Excel export in the Payment History page — no server round-trip needed. |
| **dayjs** | 1.11.x | Lightweight date utility used in the Dashboard Overview for date formatting. |
| **lucide-react** | 0.575.x | Icon library — all icons in the UI come from here. |
| **cmdk** | 1.x | Command-palette-style search used in the multi-select service picker. |

---

## 3. Folder Structure

```
HAIR-SALON-WEBSITE/
│
├── backend/                          # Express REST API
│   ├── index.js                      # App entry point — middleware, routes, Razorpay
│   ├── db.js                         # MongoDB connection singleton
│   ├── package.json                  # Backend dependencies
│   ├── vercel.json                   # Vercel serverless deployment config
│   │
│   ├── constants/
│   │   └── permissions.js            # PBAC permission keys, role defaults, labels, UI groups
│   │
│   ├── middleware/
│   │   ├── authMiddleware.js         # authenticate() + authorize() + authorizePermission()
│   │   └── validateId.js             # MongoDB ObjectId format validator
│   │
│   ├── models/
│   │   ├── Visit.js                  # Client visit record schema
│   │   ├── Artist.js                 # Salon artist schema
│   │   ├── Service.js                # Salon service schema
│   │   └── User.js                   # Staff user account schema (includes permissions[])
│   │
│   ├── routes/
│   │   ├── auth.js                   # POST /login, POST /logout, GET /me
│   │   ├── admin.js                  # Team management (PBAC: team.view / team.manage)
│   │   ├── artists.js                # Artist CRUD (PBAC: artists.view / artists.crud)
│   │   ├── services.js               # Service CRUD (PBAC: services.view / services.crud)
│   │   ├── visits.js                 # Visit creation + payment history (PBAC gated)
│   │   ├── analytics.js              # All analytics endpoints (PBAC: analytics.view)
│   │   ├── artistDashboard.js        # Artist's own dashboard data
│   │   └── ownerArtistDashboard.js   # Owner's view of any artist's dashboard
│   │
│   └── scripts/                      # One-time database seed / migration scripts
│       ├── seedArtists.js
│       ├── seedArtistUser.js
│       ├── seedOwner.js
│       ├── seedServices.js
│       └── migratePermissions.js     # Backfills permissions[] for existing users
│
└── frontend/                         # React + TypeScript SPA
    ├── index.html                    # HTML shell
    ├── vite.config.ts                # Vite build configuration
    ├── tsconfig.json                 # TypeScript config
    ├── vercel.json                   # Vercel SPA routing + API proxy config
    ├── package.json                  # Frontend dependencies
    │
    └── src/
        ├── main.tsx                  # App root — React Router route tree
        ├── index.css                 # Global styles + Tailwind imports
        │
        ├── context/
        │   └── AuthContext.tsx       # Global auth state (user, loading, logout)
        │
        ├── hooks/
        │   ├── useVisitForm.ts       # All visit form logic — state, validation, submit
        │   └── usePermission.ts      # PBAC hook — checks user.permissions[] (owner always true)
        │
        ├── layouts/
        │   ├── AppLayout.tsx         # Public navbar + page shell
        │   ├── AuthLayout.tsx        # Centered card layout for sign-in
        │   └── DashboardLayout.tsx   # Sidebar navigation shell for dashboards
        │
        ├── services/
        │   ├── api.ts                # API helper functions (createOrder, createVisit, etc.)
        │   └── razorpay.ts           # Razorpay SDK script loader
        │
        ├── types/
        │   └── visit.ts              # TypeScript types for visit form data
        │
        ├── lib/
        │   └── utils.ts              # cn() helper (clsx + tailwind-merge)
        │
        ├── components/
        │   ├── ProtectedRoute.tsx    # Role-gated route wrapper
        │   │
        │   ├── ui/                   # Reusable low-level UI components
        │   │   ├── input.tsx         # Styled <input> wrapping Radix
        │   │   ├── label.tsx         # Styled <label>
        │   │   ├── select.tsx        # Styled <Select> wrapping Radix
        │   │   ├── combobox.tsx      # Searchable dropdown
        │   │   ├── multi-select.tsx  # Multi-value searchable picker (services)
        │   │   ├── time-picker.tsx   # MaskedTimeInput + TimePicker (drum-roll)
        │   │   ├── SignInForm.tsx     # Login form with role-based redirect
        │   │   ├── background-beams.tsx  # Animated background (landing page)
        │   │   └── sparkles.tsx      # Particle effect (submit button)
        │   │
        │   └── analytics/            # Analytics sub-components
        │       ├── SummaryCards.tsx       # 4 KPI cards (revenue, visits, etc.)
        │       ├── TopServices.tsx        # Top services by revenue bar chart
        │       ├── EmployeeLeaderboard.tsx # Ranked artist table
        │       ├── EmployeeDeepDive.tsx   # Per-artist performance breakdown
        │       ├── RepeatCustomers.tsx    # Donut chart — new vs returning
        │       ├── DateFilter.tsx         # Date preset + custom range picker
        │       └── ExportButton.tsx       # Excel download from analytics
        │
        └── pages/
            ├── LandingPage.tsx           # Public homepage
            ├── AboutPage.tsx             # About the salon
            ├── ContactPage.tsx           # Contact details
            ├── SignInPage.tsx            # Sign-in page shell
            ├── UnauthorizedPage.tsx      # 403 page with role-based back link
            ├── PaymentStatus.tsx         # Post-payment confirmation screen
            ├── VisitEntryPage.tsx        # Visit entry form (main operational page)
            ├── Analytics.tsx             # Full analytics page (manager + owner)
            ├── ArtistDashboardLayout.tsx # Artist dashboard shell with permission-gated sidebar
            ├── OwnerDashboard.tsx        # Owner's dashboard shell + routes
            ├── ManagerDashboard.tsx      # Manager's dashboard shell + routes
            ├── ReceptionistDashboard.tsx # Receptionist's dashboard shell
            ├── PrivacyPolicyPage.tsx     # Legal page
            ├── TermsOfServicePage.tsx    # Legal page
            │
            └── dashboard/               # Sub-pages rendered inside dashboards
                ├── ArtistManagement.tsx      # Artist directory + edit modal
                ├── ArtistStatsView.tsx        # Artist's personal commission & KPI stats
                ├── ServiceManagement.tsx     # Service catalog + edit modal
                ├── TeamManagement.tsx         # Staff accounts + edit modal
                ├── PaymentHistory.tsx         # Transaction ledger
                ├── ArtistDashboardView.tsx    # Manager/owner read-only view of an artist's data
                └── shared/
                    ├── DashboardOverview.tsx  # Welcome + today's KPIs (analytics gated by analytics.view)
                    ├── DashboardAnalyticsView.tsx  # Analytics inside dashboard
                    └── ServicesView.tsx        # Read-only service list
```

---

## 4. Environment Variables

### Backend (`backend/.env`)

```env
# MongoDB connection string from MongoDB Atlas
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/hair-salon

# Session encryption secret — use a long random string in production
SESSION_SECRET=some-very-long-random-secret-string

# Razorpay payment gateway credentials (from Razorpay dashboard)
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# Auto-seeded owner account credentials
OWNER_EMAIL=owner@thexpertshair.com
OWNER_PASSWORD=YourSecureOwnerPassword123

# Frontend URL (used for Razorpay payment-link callback)
FRONTEND_URL=https://www.thexpertshair.com

# Environment flag — enables secure cookies in production
NODE_ENV=production
```

### Frontend (`frontend/.env`)

```env
# Backend API base URL
VITE_BACKEND_URL=https://api.thexpertshair.com

# Razorpay public key (safe to expose — only the secret is private)
VITE_RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxx
```

> **Why two separate `.env` files?**  
> The backend runs on Node.js where `process.env` is available. The frontend runs in the browser — Vite prefixes public env vars with `VITE_` so only those are bundled into the client-side code. Secret keys (Razorpay secret, MongoDB URI) must NEVER go in the frontend `.env`.

---

## 5. Database Models

### Visit — `backend/models/Visit.js`

The most important model. Every client visit creates one document here.

```
Visit {
  // Client
  name          String    — Client's full name
  contact       String    — 10-digit phone number
  age           String    — Age range bucket (e.g. "21-25")
  gender        String    — male | female | other | prefer_not

  // Timing
  date          Date      — Calendar date of the visit
  startTime     String    — "HH:mm" 24-hour format
  endTime       String    — "HH:mm" 24-hour format
  visitDurationMins Number — Computed (endTime - startTime) in minutes

  // Service details
  artist        String    — Snapshot of artist name (not a reference — protects history)
  services      Array     — [{name, price, duration}] — snapshot at time of visit
  filledBy      String    — Name of the staff member who filled the form

  // Billing
  subtotal        Number  — Sum of service prices
  discountPercent Number  — Discount percentage (0-100)
  discountAmount  Number  — Computed rupee discount
  finalTotal      Number  — subtotal - discountAmount

  // Payment
  paymentMethod   String  — online | cash | partial
  cashAmount      Number  — Cash portion (for partial or full-cash payments)
  onlineAmount    Number  — Razorpay portion
  paymentStatus   String  — pending | success | failed
  razorpayPaymentId String — Razorpay's payment ID after successful payment
}
```

**Key design decision — Snapshot pattern:** The `artist` field stores the artist's **name as a string** (not a MongoDB ObjectId reference). Similarly, `services` stores a copy of `{name, price, duration}` at the moment of visit. This means if an artist is renamed or a service price changes tomorrow, all historical visit records remain accurate. This is called a "snapshot" pattern.

**Indexes:**
- `{ date: 1 }` — date range queries in analytics
- `{ artist: 1, date: 1 }` — per-artist analytics
- `{ contact: 1 }` — repeat customer detection

---

### Artist — `backend/models/Artist.js`

Represents a salon staff member who performs services.

```
Artist {
  name          String    — Full name (used as snapshot key in visits)
  phone         String    — Unique 10-digit Indian mobile number
  email         String    — Optional, used as dashboard login email
  registrationId String   — Optional internal employee ID
  commission    Number    — Commission percentage (0-100)
  photo         String    — URL string (null post-Cloudinary removal)
  userId        ObjectId  — Reference to User document for dashboard login
  isActive      Boolean   — Soft-delete flag
}
```

**The Artist↔User link:** An artist can optionally be linked to a `User` document (role: "artist"). This allows them to sign in and see their own personal dashboard. When an owner edits an artist's email/password in the `ArtistManagement` page, the linked `User` document is also updated to keep credentials in sync.

---

### User — `backend/models/User.js`

Staff accounts used for dashboard login.

```
User {
  name          String    — Display name
  email         String    — Unique login email
  passwordHash  String    — bcrypt hash (never stored as plain text)
  role          String    — receptionist | manager | owner | artist
  permissions   [String]  — PBAC permission keys (e.g. ["analytics.view", "visit.create"])
  createdBy     ObjectId  — Reference to the owner/manager who created this account
  isActive      Boolean   — Soft-delete; deactivated users cannot sign in
}
```

**Instance method `verifyPassword(plain)`** — Calls `bcrypt.compare(plain, this.passwordHash)` and returns a boolean. This is attached to every User document and used in the login route.

**Permissions array:** Each user carries a `permissions` field — an array of PBAC permission key strings (see Section 8 for the full list). When a new account is created, the `permissions` array is seeded from `ROLE_DEFAULTS` in `constants/permissions.js`. The owner role bypasses PBAC entirely (checked at middleware level), so its array is intentionally empty. A Mongoose validator ensures only valid keys from the `PERMISSIONS` registry can be stored.

---

### Service — `backend/models/Service.js`

A service the salon offers (e.g. "Men's Haircut", "Hair Colour").

```
Service {
  name            String  — Unique service name
  price           Number  — Price in rupees (≥ 0)
  category        String  — Optional grouping label (e.g. "Haircut", "Colour")
  durationMinutes Number  — Expected duration in minutes (used for time analytics)
  isActive        Boolean — Soft-delete; inactive services are hidden from the form
}
```

**Why `durationMinutes`?** This powers the **time performance analytics** feature. When a visit is recorded, the expected total duration is calculated (sum of all selected services' `durationMinutes`). The actual duration is `endTime - startTime`. The difference tells us if an artist is running over or under schedule. A tolerance of ±10 minutes is applied before flagging it as over/under.

---

## 6. Backend — API Endpoints

The backend is mounted at `https://api.thexpertshair.com`. All routes except `/api/auth/login` require an active session (the `authenticate` middleware checks `req.session.userId`).

---

### Auth — `/api/auth`
*File: `backend/routes/auth.js`*

| Method | Path | Access | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | Public | Verifies email + password, creates session, returns `{id, name, email, role}` |
| `POST` | `/api/auth/logout` | Any logged-in | Destroys session |
| `GET` | `/api/auth/me` | Any logged-in | Returns current user from session |

**How login works:**
1. Client sends `{email, password}` in request body
2. Server finds the User document by email
3. Checks `user.isActive` — deactivated accounts are rejected with 403
4. Calls `user.verifyPassword(password)` — bcrypt compare
5. On success: sets `req.session.userId`, `req.session.role`, `req.session.name`, `req.session.email`
6. Session is saved to MongoDB via `connect-mongo`

---

### Form Data — `/api/form-data`
*File: `backend/index.js`*

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/form-data` | Authenticated | Returns `{artists: [{id, name}], services: [{id, name, price, category, durationMinutes}]}` |

This single endpoint powers the visit entry form's dropdowns. It returns only active artists and active services. The `filledBy` field is taken from `req.session.name`.

---

### Visits — `/api/visits`
*File: `backend/routes/visits.js`*

| Method | Path | PBAC Permission | Description |
|---|---|---|---|
| `POST` | `/api/visits/create-order` | `visit.create` | Creates a Razorpay order and returns `{orderId, amount, currency, key}` |
| `POST` | `/api/visits/verify-order` | `visit.create` | Verifies Razorpay HMAC signature, then calls createVisit internally |
| `POST` | `/api/visits` | `visit.create` | Creates a visit record (used directly for cash payments) |
| `GET` | `/api/visits/history` | `payments.view` | Paginated payment history with filters |

**`GET /api/visits/history` query params:**

| Param | Type | Description |
|---|---|---|
| `from` | YYYY-MM-DD | Start date (defaults to first of current month) |
| `to` | YYYY-MM-DD | End date (defaults to today) |
| `customer` | String | Case-insensitive regex filter on client name |
| `artist` | String | Case-insensitive regex filter on artist name |
| `method` | online\|cash\|partial | Filter by payment method |
| `page` | Number | Page number (default: 1) |
| `limit` | Number | Records per page (default: 50, max: 200) |

Response includes `{ visits[], pagination{}, summary{totalRevenue, totalCash, totalOnline, totalDiscount, count} }`.

---

### Analytics — `/api/analytics`
*File: `backend/routes/analytics.js`*
*PBAC: `analytics.view`*

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/analytics/summary` | KPIs: totalRevenue, totalVisits, uniqueCustomers, avgTicket |
| `GET` | `/api/analytics/top-services` | Services ranked by revenue, with count and revenue |
| `GET` | `/api/analytics/employees` | All artists ranked by productivity score (revenue ÷ effective hours) |
| `GET` | `/api/analytics/employee/:name` | Deep-dive stats for one artist — rank, top services, time performance |
| `GET` | `/api/analytics/repeat-customers` | Count of new vs returning customers (by phone number) |
| `GET` | `/api/analytics/export` | Downloads all visits as `.xlsx` Excel file |

All analytics endpoints accept `from` and `to` query params (YYYY-MM-DD). The `dateFilter()` helper converts them to midnight-bounded date objects using local timezone, ensuring no off-by-one errors.

**Productivity Score:** `productivityScore = totalRevenue ÷ effectiveHours`  
Where `effectiveHours = actualHoursWorked + (netExtraMinutes / 60)`. If an artist runs 30 minutes over schedule, those 30 minutes count against their efficiency score.

---

### Artists — `/api/artists`
*File: `backend/routes/artists.js`*

| Method | Path | PBAC Permission | Description |
|---|---|---|---|
| `GET` | `/api/artists` | — | All active artists (for form dropdown) |
| `GET` | `/api/artists/all` | `artists.view` | All artists including inactive, with full details |
| `POST` | `/api/artists` | `artists.crud` | Create artist (optionally with login credentials) |
| `PATCH` | `/api/artists/:id` | `artists.crud` | Update artist profile + sync linked User credentials |
| `DELETE` | `/api/artists/:id` | `artists.crud` | Soft-delete (sets isActive: false) |
| `DELETE` | `/api/artists/:id/permanent` | `artists.crud` | Hard-delete from database |

When an artist is created with email + password, a `User` document (role: "artist") is also created and linked via `artist.userId`. When the artist is edited, the linked User document is kept in sync.

---

### Services — `/api/services`
*File: `backend/routes/services.js`*

| Method | Path | PBAC Permission | Description |
|---|---|---|---|
| `GET` | `/api/services` | — | All active services |
| `GET` | `/api/services/all` | `services.view` | All services including inactive |
| `GET` | `/api/services/categories` | `services.view` | Distinct active category names |
| `POST` | `/api/services` | `services.crud` | Create service (validates name uniqueness, price, durationMinutes) |
| `PATCH` | `/api/services/:id` | `services.crud` | Update service fields |
| `DELETE` | `/api/services/:id` | `services.crud` | Soft-delete (sets isActive: false) |
| `DELETE` | `/api/services/:id/permanent` | `services.crud` | Hard-delete from database |

---

### Admin (Team Management) — `/api/admin`
*File: `backend/routes/admin.js`*
*Mount guard: `authenticate` only — per-route access controlled entirely by PBAC permissions below*

| Method | Path | PBAC Permission | Description |
|---|---|---|---|
| `GET` | `/api/admin/users` | `team.view` | List all staff users |
| `POST` | `/api/admin/users` | `team.manage` | Create receptionist or manager account (seeds default permissions) |
| `PATCH` | `/api/admin/users/:id` | `team.manage` | Edit name, email, role, password, isActive, permissions |
| `DELETE` | `/api/admin/users/:id` | `team.manage` | Soft-delete (deactivate) a user |
| `DELETE` | `/api/admin/users/:id/permanent` | `team.manage` | Hard-delete from database |

The `PATCH` endpoint invalidates existing sessions for the edited user so that any role or email change takes effect immediately — they are forced to log in again.

---

### Artist Dashboard — `/api/artist-dashboard`
*File: `backend/routes/artistDashboard.js`*
*Access: Artist only — the single route prefix guarded by `authorize("artist")` (identity-scope, not a grantable permission)*

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/artist-dashboard/profile` | Artist's own profile from Artist collection |
| `GET` | `/api/artist-dashboard/summary` | KPIs: revenue, commission, visits, hours, avgTicket |
| `GET` | `/api/artist-dashboard/services` | Services breakdown for this artist |
| `GET` | `/api/artist-dashboard/daily-trend` | Day-by-day revenue + commission data |
| `GET` | `/api/artist-dashboard/time-performance` | Expected vs actual time per visit |

---

### Owner → Artist Dashboard — `/api/owner/artist-dashboard`
*File: `backend/routes/ownerArtistDashboard.js`*
*PBAC: `artist_dashboard.view`*

Same endpoints as above but takes `:artistId` as a path parameter. Allows any user with the `artist_dashboard.view` permission to view an artist's dashboard from their own UI without needing to log in as that artist.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/owner/artist-dashboard/:artistId/profile` | |
| `GET` | `/api/owner/artist-dashboard/:artistId/summary` | |
| `GET` | `/api/owner/artist-dashboard/:artistId/services` | |
| `GET` | `/api/owner/artist-dashboard/:artistId/daily-trend` | |

---

### Razorpay (inline in index.js)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/razorpay/order` | Creates Razorpay order, returns orderId + amount |
| `GET` | `/api/health` | DB status + server uptime |

---

## 7. Frontend — Pages & Screens

### Public Pages (accessible by anyone)

**`/` — Landing Page (`LandingPage.tsx`)**  
The homepage of the salon website. Has animated hero section with `background-beams.tsx` effect, services overview, and call-to-action.

**`/about` — About Page (`AboutPage.tsx`)**  
Salon story, team description, and philosophy.

**`/contact` — Contact Page (`ContactPage.tsx`)**  
Contact details, address, working hours.

**`/privacy` — Privacy Policy (`PrivacyPolicyPage.tsx`)**  
Legal privacy policy.

**`/terms` — Terms of Service (`TermsOfServicePage.tsx`)**  
Legal terms.

**`/signin` — Sign In Page (`SignInPage.tsx` + `SignInForm.tsx`)**  
The login page. After successful login, redirects to the appropriate dashboard based on the user's role.

---

### Operational Pages (require login)

**`/visit-entry` — Visit Entry Form (`VisitEntryPage.tsx`)**  
*Access: Receptionist, Manager, Owner, Artist (requires `visit.create` permission)*

The core operational page. Staff fills this form for every client visit:
- **Section 1 — Client Details:** Name, phone, age range (dropdown), gender
- **Section 2 — Visit Details:** Date, artist (dropdown), start time (typed), end time (auto-filled, typed), services (multi-select searchable)
- **Section 3 — Payment:** Auto-computed subtotal, optional discount %, payment mode (Cash / Online / Split)

The form logic lives entirely in `useVisitForm.ts` (custom hook) — the page just renders the UI.

**`/payment-status` — Payment Status (`PaymentStatus.tsx`)**  
After completing a visit entry, the user is redirected here. Shows payment confirmation/failure details.

---

### Dashboards

All dashboards use `DashboardLayout.tsx` — a responsive sidebar + main content area.

**`/dashboard/owner/*` — Owner Dashboard (`OwnerDashboard.tsx`)**

| Sub-route | Component | Description |
|---|---|---|
| `/` (index) | `DashboardOverview.tsx` | Welcome + today's stats + mini leaderboard |
| `/analytics` | `DashboardAnalyticsView.tsx` | Full analytics suite |
| `/payments` | `PaymentHistory.tsx` | Transaction ledger |
| `/services` | `ServiceManagement.tsx` | Full CRUD for services |
| `/artists` | `ArtistManagement.tsx` | Artist directory + credential management |
| `/artist-view/:id` | `ArtistDashboardView.tsx` | Read-only view of any artist's dashboard |
| `/team` | `TeamManagement.tsx` | Staff user accounts + permission editor |

Sidebar also has a "New Visit Entry" link to `/visit-entry`. The owner is exempt from PBAC — all sidebar links always appear and all CRUD buttons are always rendered.

**`/dashboard/manager/*` — Manager Dashboard (`ManagerDashboard.tsx`)**

| Sub-route | Component | PBAC Permission | Description |
|---|---|---|---|
| `/` (index) | `DashboardOverview.tsx` | — | Welcome + today's stats |
| `/analytics` | `DashboardAnalyticsView.tsx` | `analytics.view` | Full analytics suite |
| `/payments` | `PaymentHistory.tsx` | `payments.view` | Transaction ledger |
| `/services` | `ServiceManagement.tsx` | `services.view` OR `services.crud` | Service catalogue (CRUD buttons gated by `services.crud`) |
| `/artists` | `ArtistManagement.tsx` | `artists.view` OR `artists.crud` | Artist directory (CRUD buttons gated by `artists.crud`) |
| `/artist-view/:id` | `ArtistDashboardView.tsx` | `artist_dashboard.view` | Read-only view of an artist's dashboard |
| `/team` | `TeamManagement.tsx` | `team.view` OR `team.manage` | Staff accounts (CRUD buttons gated by `team.manage`) |

Sidebar also has a "New Visit Entry" link to `/visit-entry` (requires `visit.create`).

**`/dashboard/receptionist/*` — Receptionist Dashboard (`ReceptionistDashboard.tsx`)**

| Sub-route | Component | PBAC Permission | Description |
|---|---|---|---|
| `/` (index) | `DefaultRedirect` | — | Redirects to the first permitted sidebar link |
| `/payments` | `PaymentHistory.tsx` | `payments.view` | Transaction ledger |
| `/analytics` | `DashboardAnalyticsView.tsx` | `analytics.view` | Full analytics suite |
| `/services` | `ServiceManagement.tsx` | `services.view` OR `services.crud` | Service catalogue (CRUD gated) |
| `/artists` | `ArtistManagement.tsx` | `artists.view` OR `artists.crud` | Artist directory (CRUD gated) |
| `/artist-view/:id` | `ArtistDashboardView.tsx` | `artist_dashboard.view` | Read-only view of an artist's dashboard |
| `/team` | `TeamManagement.tsx` | `team.view` OR `team.manage` | Staff accounts (CRUD gated) |

Sidebar also has a "New Visit Entry" link to `/visit-entry` (requires `visit.create`). All sidebar links are dynamically shown/hidden based on the user's `permissions[]` array — only links the user has at least one matching permission for will appear.

**`/dashboard/artist/*` — Artist Dashboard (`ArtistDashboardLayout.tsx`)**

Artists get a full permission-gated sidebar dashboard, identical in structure to the manager and receptionist dashboards. The index route always shows personal commission stats; all other sidebar links are gated by PBAC permissions assigned by the owner.

| Sub-route | Component | PBAC Permission | Description |
|---|---|---|---|
| `/` (index) | `ArtistStatsView.tsx` | — | Personal commission KPIs, top services, daily earnings trend, time performance |
| `/analytics` | `DashboardAnalyticsView.tsx` | `analytics.view` | Full salon analytics suite |
| `/payments` | `PaymentHistory.tsx` | `payments.view` | Transaction ledger |
| `/services` | `ServiceManagement.tsx` | `services.view` OR `services.crud` | Service catalogue (CRUD buttons gated by `services.crud`) |
| `/artists` | `ArtistManagement.tsx` | `artists.view` OR `artists.crud` | Artist directory (CRUD buttons gated by `artists.crud`) |

Sidebar also has a "New Visit Entry" link to `/visit-entry` (requires `visit.create`). By default, artists have no permissions assigned — the owner grants them individually through the permission editor in Team Management.

**`ArtistStatsView.tsx`** (index route) fetches the artist's own data from `/api/artist-dashboard/*`:

| Section | Description |
|---|---|
| Commission Hero | Large card showing total commission earned with % rate badge |
| Date Range Filter | Today / This Month / 3 Months / This Year / Custom |
| 5 KPI Cards | Total Revenue, Customers Served, Services Done, Hours Worked, ₹/Hour |
| Top Services | Bar chart of most performed services by revenue |
| Daily Earnings | Day-by-day revenue vs commission bars |
| Period Summary | Numeric recap table |
| Time Performance | Expected vs actual visit duration comparison |

---

### Unauthorized Page

**`/unauthorized` — (`UnauthorizedPage.tsx`)**  
Shown when a logged-in user tries to access a route above their permission level. Displays a back-link to the correct dashboard for their role.

---

## 8. Access Control — PBAC

The system uses a **PBAC-only** (Permission-Based Access Control) model. All route prefixes are authenticated with `authenticate`, and each individual route handler is gated by `authorizePermission(key)`. There are no role-based gates at the route level — a receptionist or a manager can be granted any subset of permissions by the owner.

There is **one exception**: the `/api/artist-dashboard` prefix also applies `authorize("artist")` as an **identity-scope guard**, ensuring that only the logged-in artist can read their own dashboard data. This is not a grantable permission and has nothing to do with the PBAC system.

### Layer 1 — Backend Authentication Middleware

Every protected API route mount uses `authenticate` from `authMiddleware.js`:

```
authenticate → checks req.session.userId exists (401 if not)
```

This runs before any route handler can execute. A frontend manipulation (e.g., changing a role in localStorage) is completely ineffective — the server reads its own session store in MongoDB.

**Route mounts in `backend/index.js`:**

| Mount prefix | Mount-level middleware | Per-route enforcement |
|---|---|---|
| `/api/auth` | none | public |
| `/api/admin` | `authenticate` | `authorizePermission` per route |
| `/api/artists` | `authenticate` | `authorizePermission` per route |
| `/api/services` | `authenticate` | `authorizePermission` per route |
| `/api/visits` | `authenticate` | `authorizePermission` per route |
| `/api/analytics` | `authenticate` | `authorizePermission` per route |
| `/api/artist-dashboard` | `authenticate` + `authorize("artist")` | identity-scope guard only |
| `/api/owner/artist-dashboard` | `authenticate` | `authorizePermission(ARTIST_DASHBOARD_VIEW)` |

### Layer 2 — Backend PBAC Middleware (`authorizePermission`)

After authentication passes, individual routes are gated by `authorizePermission(key)`:

```js
authorizePermission(PERMISSIONS.SERVICES_CRUD)
```

- **Owner role always bypasses** — short-circuits before any DB lookup.
- **All other roles (receptionist, manager, artist)** — the middleware fetches `user.permissions[]` from MongoDB (with a 60-second in-process cache) and checks if the required key is present. Returns 403 with `{ error: "Permission denied", required: key }` if absent.
- **Cache eviction** — `evictPermissionCache(userId)` is called whenever a user's permissions or role are changed (in the admin PATCH route), ensuring the cached permissions are never stale after an edit.

### Layer 3 — Frontend Route Guard + PBAC UI Gating

**Route-level guard:** The `ProtectedRoute.tsx` component wraps every dashboard route in `main.tsx`:

```tsx
<ProtectedRoute allowedRoles={["owner", "manager"]}>
  <OwnerDashboard />
</ProtectedRoute>
```

While the auth state loads → shows a spinner  
If no user (not logged in) → redirects to `/signin`  
If role not in allowedRoles → redirects to `/unauthorized`

**Sidebar filtering:** Each sidebar link in every dashboard carries a `requiredPermission` field (type: `string | string[]`). The `DashboardLayout` filters links before rendering — only links where the user holds at least one matching permission are shown. Array values use OR logic: `["services.view", "services.crud"]` means the link appears if either permission is present.

**CRUD button gating:** Inside `ArtistManagement`, `ServiceManagement`, and `TeamManagement`, the `usePermission(key)` hook controls whether Add/Edit/Delete buttons are rendered. A user with `services.view` (but not `services.crud`) sees the service catalogue in read-only mode — no Add, Edit, or Delete buttons appear.

**Default redirect:** The `ReceptionistDashboard` uses a `DefaultRedirect` component that iterates the sidebar links array and redirects to the first link the user has permission for. This prevents landing on a page the user can't access when their default permissions change.

---

### PBAC Permission Keys

*Defined in: `backend/constants/permissions.js`*

| Key | Label | Description |
|---|---|---|
| `analytics.view` | View Analytics Dashboard | Access to all analytics endpoints + dashboard tab |
| `payments.view` | View Payment History | Access to `/api/visits/history` + Payments tab |
| `services.view` | View Services List | Access to `/api/services/all` + Services tab (read-only) |
| `services.crud` | Manage Services | Create / Edit / Delete services |
| `artists.view` | View Artist Directory | Access to `/api/artists/all` + Artists tab (read-only) |
| `artists.crud` | Manage Artists | Create / Edit / Deactivate artists |
| `artist_dashboard.view` | View Artist Dashboards | Access to `/api/owner/artist-dashboard/:id/*` endpoints |
| `team.view` | View Team Management | Access to `/api/admin/users` list |
| `team.manage` | Manage Team Accounts | Create / Edit / Deactivate staff accounts + edit permissions |
| `visit.create` | Create Visit Entries | Access to visit creation endpoints + "New Visit Entry" sidebar link |

### Default Permissions by Role

When a new user account is created via `POST /api/admin/users`, their `permissions` array is seeded from `ROLE_DEFAULTS`:

| Role | Default Permissions |
|---|---|
| **Receptionist** | `payments.view`, `visit.create` |
| **Manager** | `analytics.view`, `payments.view`, `services.view`, `artists.view`, `artists.crud`, `visit.create` |
| **Owner** | *(bypasses PBAC — all features always available)* |
| **Artist** | *(empty by default — permissions granted individually by the owner)* |

The owner can later customize any user's permissions through the permission editor in Team Management.

### Permission Editor UI

When editing a team member in `TeamManagement.tsx`, the edit modal includes a **Permission Editor** section (visible only to users with the `team.manage` permission). The UI is organised into groups defined in `PERMISSION_GROUPS`:

| Group | Permissions |
|---|---|
| Visit Operations | `visit.create` |
| Financials | `payments.view` |
| Analytics | `analytics.view` |
| Artists | `artists.view`, `artists.crud`, `artist_dashboard.view` |
| Services | `services.view`, `services.crud` |
| Administration | `team.view`, `team.manage` |

Each permission has a human-readable label from `PERMISSION_LABELS`, and the groups provide a logical structure for the checklist UI.

### `usePermission` Hook

*File: `frontend/src/hooks/usePermission.ts`*

```ts
export function usePermission(key: string): boolean {
  const { user } = useAuth();
  if (!user) return false;
  if (user.role === "owner") return true; // owner is always exempt
  return user.permissions.includes(key);
}
```

Used in `ArtistManagement`, `ServiceManagement`, `TeamManagement`, `ArtistDashboardLayout`, and `DashboardOverview` to conditionally render CRUD buttons and gate analytics calls. Also referenced by `DashboardLayout` for sidebar link filtering.

### Migration Script

*File: `backend/scripts/migratePermissions.js`*

A one-time script that backfills the `permissions[]` array for existing user accounts that were created before the PBAC system was added. It applies `ROLE_DEFAULTS[user.role]` to every user document that has an empty or missing `permissions` array.

---

### Session Architecture

Sessions are stored in a `sessions` MongoDB collection via `connect-mongo`. Configuration:

```js
cookie: {
  httpOnly: true,          // JavaScript cannot read this cookie
  secure: true,            // Only sent over HTTPS in production
  sameSite: "lax",         // Prevents CSRF from cross-site requests
  maxAge: 8 * 60 * 60 * 1000  // 8 hours — forces re-login after work day
}
```

The session contains: `{ userId, role, name, email }`. The `authenticate` middleware reads `req.session.userId` on every request — no JWT decoding, no extra database lookup per request for authentication. Permission checks (`authorizePermission`) do make a database call once per user (with a 60-second in-process cache).

---

## 9. Feature Walkthrough

### 9.1 Visit Entry Form

**File:** `frontend/src/pages/VisitEntryPage.tsx` + `frontend/src/hooks/useVisitForm.ts`

All form logic is extracted into the `useVisitForm` custom hook. The page component purely renders JSX using values and handlers from the hook.

**How the form works step by step:**

1. **Mount** — `useEffect` fires `fetchFormData()` to load artists + services from `GET /api/form-data`. The `endTime` is pre-filled with the current system time (`nowHHMM()`).

2. **Artist dropdown** — Populated from `dropdownData.artists`. Each option's value is the artist's `_id` (ObjectId string). On selection, the form stores the ID; the backend resolves the name from the ID when saving.

3. **Time inputs** — Both `startTime` and `endTime` use `MaskedTimeInput`. The user types up to 4 digits (HHMM) and an AM/PM toggle button sits alongside. The component internally keeps 12-hour display state but always fires `onChange` with a 24-hour `"HH:mm"` string.

4. **Duration badge** — `durationMins` is computed via `useMemo` whenever `startTime` or `endTime` changes: `endMins - startMins`. If end ≤ start, it returns `null` and shows an error badge instead.

5. **Services multi-select** — Uses the custom `MultiSelect` component. Each service displays `name (₹price)`. Selections are stored as an array of service IDs. The `subtotal` is derived via `useMemo` by summing the prices of selected services.

6. **Discount** — Staff type a `discountPercent` (0-100). `discountAmt = Math.round(subtotal × discountPercent / 100)`. `payable = subtotal - discountAmt`.

7. **Payment mode selection:**
   - **Cash** → submit goes directly to `createVisit()` → navigate to `/payment-status?method=cash`
   - **Online** → `loadRazorpayScript()` → `createOrder()` → open Razorpay modal → on success `verifyOrderPayment()` → `createVisit()` → navigate to payment status
   - **Partial (Split)** → staff enter a cash amount → the remainder is handled via Razorpay → same flow as online but with cashAmount passed to createVisit

8. **Form reset** — `handleReset()` clears all fields and re-fills `endTime` with the current time.

---

### 9.2 Payment History

**Files:** `frontend/src/pages/dashboard/PaymentHistory.tsx`, `backend/routes/visits.js`

**What it shows:** A paginated table of all visit records with summary cards (Total Revenue, Cash, Online, Discounts Given).

**Filters available:**
- **Date preset tabs:** Today / This Month / 3 Months / This Year / Custom
- **Customer name search:** Type and press Enter or click the search icon (case-insensitive regex on the `name` field)
- **Artist name search:** Same mechanism on the `artist` field
- **Payment method:** All / Cash / Online / Partial

**Export:** Clicking "Export Excel" generates an `.xlsx` file client-side using SheetJS. Columns: Date, Client, Contact, Artist, Services, Subtotal (₹), Discount %, Discount (₹), Total (₹), Method, Cash (₹), Online (₹), Razorpay ID, Status, Filled By, Created At. Column widths are auto-fitted.

**Pagination:** 50 records per page. Navigation with Previous/Next buttons. Resetting any filter automatically snaps back to page 1.

---

### 9.3 Artist Management

**File:** `frontend/src/pages/dashboard/ArtistManagement.tsx`

The artist directory shows a card/table for every artist with: name, phone, registration ID, commission %, status badge, and created date. Available in all three dashboards (Owner, Manager, Receptionist) — sidebar visibility is controlled by `artists.view` or `artists.crud` permission.

**PBAC gating:** The component uses `usePermission("artists.crud")` to determine whether to render Add, Edit, Deactivate, Reactivate, and Delete buttons. Users with only `artists.view` see the directory in read-only mode. A separate `usePermission("artist_dashboard.view")` controls visibility of the "Dashboard" button per artist card.

**Edit modal** includes all profile fields plus a "Dashboard Login Credentials" section with email and optional new password. On save:
1. `PATCH /api/artists/:id` is called with all fields
2. Backend updates the `Artist` document
3. If a `User` is linked, updates that `User` document's email, name, and password hash
4. Calls `invalidateUserSessions()` — destroys all active sessions for that user so they must re-login with new credentials

**Navigation:** The "Dashboard" button navigates to a relative `artist-view/:id` path (rather than a hardcoded `/dashboard/owner/...` path), making it work correctly in all three dashboard contexts. The back button in `ArtistDashboardView` uses `navigate(-1)` for the same reason.

**Soft-delete:** Clicking "Deactivate" sets `isActive: false`. The artist disappears from the visit entry form dropdown but their historical visits are preserved intact (because visits store the name as a string snapshot, not a reference).

---

### 9.4 Service Management

**File:** `frontend/src/pages/dashboard/ServiceManagement.tsx`

Available in all three dashboards (Owner, Manager, Receptionist). Sidebar visibility is controlled by `services.view` or `services.crud` permission (OR logic).

**PBAC gating:** The component uses `usePermission("services.crud")` to conditionally render Add, Edit, Deactivate, and Delete buttons. Users with only `services.view` see the service catalogue in read-only mode — no mutation controls are shown. The edit modal's footer changes: the Cancel button becomes "Close" and the Save button is hidden when the user lacks `services.crud`.

**Add/edit fields:**
- Name (must be unique, case-insensitive)
- Price (rupees)
- Category (optional grouping)
- Duration in Minutes (optional — enables time analytics)
- Active/inactive toggle

**Timestamps** are shown on each service card (Created / Last Updated).

**Soft vs Hard delete:** "Deactivate" sets `isActive: false` (safe — historical visits still reference the service name). "Delete Permanently" removes the document entirely — only advisable for services that have never been used in a visit.

---

### 9.5 Team Management

**File:** `frontend/src/pages/dashboard/TeamManagement.tsx`

Creates and manages `receptionist` and `manager` accounts. Available in all three dashboards — sidebar visibility is controlled by `team.view` or `team.manage` permission (OR logic).

**PBAC gating:** The component uses `usePermission("team.manage")` to conditionally render Add, Edit, Deactivate, Reactivate, and Delete buttons. Users with only `team.view` see a read-only list of staff accounts. The permission editor inside the edit modal is also gated by `team.manage`.

**Security details:**
- When editing an owner-role account, the role dropdown is replaced with a read-only "Owner (cannot change)" display — preventing accidental role changes for the salon owner
- Email uniqueness is enforced server-side before saving
- Password field is optional on edit — leave blank to keep existing password
- Deactivated accounts (`isActive: false`) cannot log in — the login route explicitly checks `user.isActive`

---

### 9.6 Analytics

**Files:** `frontend/src/pages/Analytics.tsx`, `frontend/src/components/analytics/*`

The analytics page is a composition of six independent components, each fetching its own data. All components accept `api` (base URL) and `qs` (query string with `from=` and `to=` params).

| Component | Data source | What it shows |
|---|---|---|
| `SummaryCards` | `/api/analytics/summary` | 4 KPI cards |
| `TopServices` | `/api/analytics/top-services` | Revenue-ranked services bar list |
| `EmployeeLeaderboard` | `/api/analytics/employees` | Artist table ranked by ₹/effective hour |
| `EmployeeDeepDive` | `/api/analytics/employee/:name` | Per-artist drill-down with Recharts bar chart |
| `RepeatCustomers` | `/api/analytics/repeat-customers` | Donut chart: new vs returning (by phone) |
| `ExportButton` | `/api/analytics/export` | Downloads full visit history as `.xlsx` |
| `DateFilter` | (local state) | Presets + custom date range controls |

---

### 9.7 Time Performance Analytics

**How it works end-to-end:**

1. Admin adds `durationMinutes` to each service in Service Management
2. When a visit is created, the frontend computes `visitDurationMins = endTime - startTime` and includes it in the payload
3. Each service snapshot in `visit.services[].duration` also stores the service's `durationMinutes` at that moment
4. The analytics backend calculates:
   - `expectedMins = sum(service.duration for services with non-null duration)`
   - `actualMins = visit.visitDurationMins` (only if expectedMins > 0)  
   - `tolerance = 10 minutes` — within ±10 min is considered "on time"
   - `extraMins = max(0, actualMins - expectedMins - 10)` for overtime  
   - `effectiveHours = actualHours + extraMins / 60`
5. `productivityScore = revenue ÷ effectiveHours` — an artist who takes longer than scheduled earns a lower score, even if their revenue is the same

---

### 9.8 Date Filtering

All analytics and payment history endpoints accept `from` and `to` params. On the backend, the `dateFilter()` helper:

```js
function dateFilter({ from, to }) {
  const f = from ? new Date(from) : startOfMonth();
  const t = to ? new Date(to) : new Date();
  f.setHours(0, 0, 0, 0);   // Start of from-day
  t.setHours(23, 59, 59, 999); // End of to-day
  return { date: { $gte: f, $lte: t } };
}
```

This ensures the boundaries are midnight-to-midnight in the server's local timezone, avoiding off-by-one errors where visits at 11 PM might be excluded.

---

## 10. Security Architecture

### Password Security
- **bcryptjs with salt factor 12** — Each hash takes ~250ms on modern hardware. An attacker who steals the database cannot crack passwords quickly.
- Passwords are validated server-side (minimum 8 characters via express-validator before creation, checked in frontend for UX but not relied upon for security)

### Rate Limiting
- **200 requests per 15 minutes per IP** — Applied globally. Prevents brute-force login attacks and DDoS
- The login endpoint itself is not separately rate-limited; the global limiter covers it

### HTTP Security Headers (Helmet)
Automatically applied headers include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (prevents clickjacking)
- `Strict-Transport-Security` (forces HTTPS)
- `X-XSS-Protection`

### CORS
Explicitly allowlisted origins:
- `https://www.thexpertshair.com`
- `https://thexpertshair.com`
- `*.vercel.app` (Vercel preview deployments)
- `localhost:5173/5174/5175` (local dev)

All other origins receive a CORS error — the browser blocks the request before it reaches any endpoint.

### Session Security
- `httpOnly: true` — Cookie is invisible to JavaScript (prevents XSS theft)
- `secure: true` in production — Cookie only sent over HTTPS
- `sameSite: "lax"` — Prevents CSRF attacks from external sites
- 8-hour expiry — Forces re-login after a working day

### Payment Security
- Razorpay payment verification uses **HMAC-SHA256 signature**
- The `razorpay_order_id + "|" + razorpay_payment_id` string is signed with the Razorpay secret key
- The server computes its own HMAC and compares it with the client's signature using `crypto.timingSafeEqual()` (prevents timing attacks)
- A payment is only recorded in the database after signature verification passes

### Input Validation
Every mutating endpoint uses `express-validator` for type checking, range validation, and required field checks. Invalid requests receive a structured 400 response before any database interaction occurs. MongoDB ObjectId params are validated by the `validateId` middleware — malformed IDs return 400 instead of triggering a Mongoose CastError 500.

---

## 11. Analytics System

### Dashboard Overview KPIs
*File: `frontend/src/pages/dashboard/shared/DashboardOverview.tsx`*

Loads two summary calls on mount:
1. `from=today&to=today` → Today's revenue + visits
2. `from=monthStart&to=today` → Month-to-date revenue + visits

Also renders a mini `EmployeeLeaderboard` and `TopServices` for the month.

### Employee Leaderboard Algorithm
*File: `backend/routes/analytics.js`*

```
For each artist:
  1. Find all visits in date range where visit.artist = artistName
  2. Sum revenue = Σ finalTotal
  3. Calculate hoursWorked = Σ (endTime - startTime) for all visits
  4. For visits with duration data:
       expectedMins = Σ service.duration
       actualMins = visitDurationMins
       extraMins = max(0, actualMins - expectedMins - 10)
  5. effectiveHours = hoursWorked + totalExtraMins / 60
  6. productivityScore = revenue / effectiveHours
  7. revenuePerHour = round(productivityScore)

Sort artists by productivityScore DESC → assigns rank 1, 2, 3...
```

---

## 12. Payment Integration

### Razorpay Flow — Online Payment

```
User selects "Online" → clicks submit
    ↓
Frontend calls POST /api/visits/create-order
    → Backend: razorpay.orders.create({ amount: paise, currency: "INR" })
    → Returns: { orderId, amount, currency, key }
    ↓
Frontend loads Razorpay script (if not already loaded)
    → Opens Razorpay checkout modal (name, phone pre-filled)
    ↓
User completes payment (UPI / Card / NetBanking)
    ↓
Razorpay calls frontend handler with { razorpay_payment_id, razorpay_order_id, razorpay_signature }
    ↓
Frontend calls POST /api/visits/verify-order
    → Backend computes HMAC-SHA256 of orderId|paymentId using RAZORPAY_KEY_SECRET
    → Compares with razorpay_signature using timingSafeEqual
    → If match: calls createVisit internally
    → Returns visit ID
    ↓
Frontend navigates to /payment-status?method=online&status=success
```

### Cash Payment Flow

```
User selects "Cash" → clicks "Record Cash Payment"
    ↓
Frontend calls POST /api/visits (directly, no Razorpay)
    → paymentMethod: "cash", cashAmount: payable, onlineAmount: 0
    → paymentStatus: "success"
    ↓
Navigate to /payment-status?method=cash
```

### Partial (Split) Payment Flow

```
User selects "Split" → enters cash amount
    ↓
onlinePayable = payable - cashAmount shown in UI
    ↓
Razorpay order created for onlinePayable only
    ↓
User pays online portion via Razorpay modal
    ↓
verify-order called → creates visit with cashAmount + onlinePayable both recorded
    → paymentMethod: "partial"
```

---

## 13. Running Locally

### Prerequisites
- Node.js 18+
- MongoDB Atlas account (free tier works) or local MongoDB
- Razorpay account (test mode is fine for development)

### Backend

```bash
cd backend
npm install

# Create .env file (copy from Environment Variables section above, use test Razorpay keys)
# Then:
npm run dev
# Server starts on http://localhost:3000 (or the port in your config)
```

The `--watch` flag in `"dev": "node --watch index.js"` auto-restarts the server when files change (built into Node 18+, no nodemon needed).

### Frontend

```bash
cd frontend
npm install

# Create .env file:
# VITE_BACKEND_URL=http://localhost:3000
# VITE_RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxx

npm run dev
# Vite dev server starts at http://localhost:5173
```

### Seeding Initial Data (optional)

If you want to populate the database with sample data:

```bash
cd backend

# Seed the owner account (also done automatically on first request)
node scripts/seedOwner.js

# Seed sample artists
node scripts/seedArtists.js

# Seed sample services
node scripts/seedServices.js

# Create an artist dashboard login (links Artist to User)
node scripts/seedArtistUser.js
```

---

## 14. Deployment

Both the frontend and backend are deployed on **Vercel** as separate projects.

### Backend Deployment

**Configuration: `backend/vercel.json`**
```json
{
  "version": 2,
  "builds": [{ "src": "index.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "index.js" }]
}
```

All routes are forwarded to `index.js`. Vercel runs it as a serverless Node.js function. Each request may start a cold process — this is why `db.js` uses a singleton connection cache, and why the owner-seed check uses an `ownerSeeded` flag to avoid running twice.

**Environment Variables to set in Vercel backend project:**
- `MONGODB_URI`
- `SESSION_SECRET`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `OWNER_EMAIL`
- `OWNER_PASSWORD`
- `FRONTEND_URL`
- `NODE_ENV=production`

### Frontend Deployment

**Configuration: `frontend/vercel.json`**
```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://api.thexpertshair.com/api/:path*" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

- The API rewrite proxies `/api/*` calls to the backend domain — this sidesteps CORS issues in some configurations
- The catch-all rewrite sends all other paths to `index.html` — this is **essential for client-side routing** so that refreshing `/dashboard/owner/artists` doesn't 404

**Build command:** `npm run build` (`tsc -b && vite build`)  
**Output directory:** `dist/`

**Environment Variables to set in Vercel frontend project:**
- `VITE_BACKEND_URL=https://api.thexpertshair.com`
- `VITE_RAZORPAY_KEY_ID`

---

## 15. File Reference

A quick description of every file in the project:

### Backend

| File | Purpose |
|---|---|
| `index.js` | App entry point. Configures CORS, helmet, rate limiting, session, Razorpay, and mounts all routers. Also contains the owner auto-seed logic and `/api/form-data` endpoint. |
| `db.js` | Singleton MongoDB connection. Caches the connection promise to avoid duplicate connections in serverless environments. |
| `constants/permissions.js` | Canonical registry of all PBAC permission keys (`PERMISSIONS`), role defaults (`ROLE_DEFAULTS`), human-readable labels (`PERMISSION_LABELS`), and UI groupings (`PERMISSION_GROUPS`). |
| `middleware/authMiddleware.js` | `authenticate()` — checks session exists. `authorize(...roles)` — identity-scope role check (used only for `/api/artist-dashboard`). `authorizePermission(key)` — PBAC permission check with in-process cache (60s TTL). Also exports `evictPermissionCache()`. |
| `middleware/validateId.js` | Validates `:id` route params are valid MongoDB ObjectIds before the route handler runs. |
| `models/Visit.js` | Schema for client visit records. Includes snapshot sub-documents for services. |
| `models/Artist.js` | Schema for salon artists. Optional link to a User account. |
| `models/Service.js` | Schema for salon services, including optional `durationMinutes`. |
| `models/User.js` | Schema for staff accounts. Role enum: receptionist, manager, owner, artist. Includes `permissions: [String]` with Mongoose validator. |
| `routes/auth.js` | Login, logout, and session check endpoints. Login response now includes `permissions[]`. |
| `routes/admin.js` | Team management — create/edit/deactivate staff accounts. PBAC: `team.view` (read), `team.manage` (write). Seeds `ROLE_DEFAULTS` on account creation. |
| `routes/artists.js` | Artist CRUD with linked User account sync. PBAC: `artists.view` (read), `artists.crud` (write). |
| `routes/services.js` | Service CRUD with soft and hard delete. PBAC: `services.view` (read), `services.crud` (write). |
| `routes/visits.js` | Visit creation (cash and Razorpay), payment history endpoint. PBAC: `visit.create`, `payments.view`. |
| `routes/analytics.js` | All analytics queries — summary, top services, employee leaderboard, deep-dive, repeat customers, Excel export. PBAC: `analytics.view`. |
| `routes/artistDashboard.js` | Artist's own dashboard data endpoints. |
| `routes/ownerArtistDashboard.js` | Any authorised user's view of an artist's dashboard data (same queries but by artistId). PBAC: `artist_dashboard.view`. |
| `scripts/migratePermissions.js` | One-time script to backfill `permissions[]` for existing users created before PBAC. |

### Frontend

| File | Purpose |
|---|---|
| `main.tsx` | React Router `<Routes>` tree. Defines all routes wrapped in `ProtectedRoute`. |
| `context/AuthContext.tsx` | Global auth state. Calls `GET /api/auth/me` on load to restore session. Provides `user`, `loading`, `logout`. |
| `hooks/useVisitForm.ts` | All visit form logic — state, derived values, validation, form submission. Keeps `VisitEntryPage.tsx` clean. |
| `hooks/usePermission.ts` | PBAC hook — reads `user.permissions[]` from AuthContext. Owner always returns `true`. Used by management components, `ArtistDashboardLayout`, and `DashboardOverview` for CRUD button gating and analytics call gating. |
| `layouts/AppLayout.tsx` | Navbar with auth-aware links, avatar dropdown, and mobile hamburger. "Dashboard" link shown for all logged-in staff roles. |
| `layouts/DashboardLayout.tsx` | Sidebar navigation shell used by all four dashboards. Accepts `sidebarLinks` + `pageTitle` props. Filters sidebar links by `requiredPermission` (supports `string \| string[]` with OR logic). |
| `layouts/AuthLayout.tsx` | Centered card layout for the sign-in page. |
| `components/ProtectedRoute.tsx` | Wraps routes with auth check + role check. Shows spinner during loading. |
| `components/ui/time-picker.tsx` | Two exports: `MaskedTimeInput` (typed 12h input + AM/PM toggle) and `TimePicker` (drum-roll scroll — unused in current form but still available). |
| `components/ui/multi-select.tsx` | Searchable multi-value dropdown for service selection built on `cmdk`. |
| `components/ui/SignInForm.tsx` | Login form. On success, reads role from response and navigates to the correct dashboard path. |
| `components/analytics/EmployeeLeaderboard.tsx` | Table ranking all artists by productivity (₹/effective hour). |
| `components/analytics/EmployeeDeepDive.tsx` | Dropdown to select artist + detailed breakdown with Recharts bar chart. |
| `components/analytics/SummaryCards.tsx` | Four KPI cards fetched from `/api/analytics/summary`. |
| `components/analytics/TopServices.tsx` | Services ranked by revenue with horizontal bar indicator. |
| `components/analytics/RepeatCustomers.tsx` | Donut chart showing new vs returning customer ratio. |
| `components/analytics/ExportButton.tsx` | Downloads analytics export from backend as `.xlsx`. |
| `services/api.ts` | Typed helper functions: `fetchFormData`, `createOrder`, `verifyOrderPayment`, `createVisit`. All send `credentials: "include"` so the session cookie is attached. |
| `services/razorpay.ts` | Dynamically loads the Razorpay checkout.js script from Razorpay's CDN on demand. |
| `pages/VisitEntryPage.tsx` | Renders the visit entry form UI using hooks and components. |
| `pages/ArtistDashboardLayout.tsx` | Artist dashboard shell with permission-gated sidebar nav and sub-routes. Mirrors manager/receptionist dashboard structure. |
| `pages/dashboard/ArtistStatsView.tsx` | Artist's personal commission stats — KPI cards, top services, daily earnings trend, time performance. Fetches from `/api/artist-dashboard/*`. |
| `pages/dashboard/PaymentHistory.tsx` | Full transaction ledger with date presets, customer/artist/method filters, summary cards, paginated table, and Excel export. |
| `pages/dashboard/ArtistManagement.tsx` | Artist directory cards + add/edit/deactivate modals. CRUD buttons gated by `usePermission("artists.crud")`. Dashboard button gated by `usePermission("artist_dashboard.view")`. Edit modal includes email and password for dashboard login credentials. |
| `pages/dashboard/ServiceManagement.tsx` | Service catalog table + add/edit/deactivate/delete modals with duration field. CRUD buttons gated by `usePermission("services.crud")`. |
| `pages/dashboard/TeamManagement.tsx` | Staff account management. CRUD buttons gated by `usePermission("team.manage")`. Edit modal shows read-only "Owner" label if editing an owner account (cannot change role). Includes permission editor checklist. |
| `pages/dashboard/ArtistDashboardView.tsx` | Read-only proxy view of any artist's dashboard using `/api/owner/artist-dashboard/:id/*` endpoints. Available to any user with `artist_dashboard.view` permission. Back button uses `navigate(-1)` for role-agnostic navigation. |
| `pages/dashboard/shared/DashboardOverview.tsx` | Welcome page inside dashboards. Loads today + month KPIs and shows mini leaderboard. Analytics calls and charts are gated behind `usePermission("analytics.view")`. |
| `pages/dashboard/shared/DashboardAnalyticsView.tsx` | Full analytics suite rendered inside a dashboard. Composes all analytics components. |
| `pages/dashboard/shared/ServicesView.tsx` | Legacy read-only active services list. Replaced by `ServiceManagement` (which self-gates CRUD buttons via `usePermission`) in all dashboards. |
| `types/visit.ts` | TypeScript interfaces for `VisitFormData`, `CreateVisitPayload`, etc. |

---

*This documentation was written to explain every design decision and implementation detail of the system. If you're a developer picking this up, start by reading `backend/index.js` to understand the server structure, then `useVisitForm.ts` to understand the core business logic, then `main.tsx` to understand routing.*
