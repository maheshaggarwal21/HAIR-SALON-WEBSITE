# The Experts Hair Salon - Workspace README

This README is aligned to the current code in this workspace.

## What This Project Does

This is a full-stack salon operations platform with:

- Session-based staff authentication
- Permission-based access control (PBAC)
- Visit entry with payment-first flow
- Per-service assignment lock workflow (v2)
- Payment history and analytics dashboards
- Artist, service, and team management

## Tech Stack

### Backend

- Node.js + Express
- MongoDB + Mongoose
- express-session + connect-mongo
- express-validator
- Razorpay SDK
- helmet, cors, express-rate-limit
- xlsx for analytics export

### Frontend

- React + TypeScript + Vite
- React Router
- Tailwind CSS
- Radix UI primitives
- Framer Motion
- Recharts

## Workspace Structure

```text
HAIR-SALON-WEBSITE/
  README.md
  backend/
    index.js
    db.js
    package.json
    vercel.json
    constants/
      permissions.js
    middleware/
      authMiddleware.js
      validateId.js
    models/
      Artist.js
      Service.js
      User.js
      Visit.js
    routes/
      admin.js
      analytics.js
      artistDashboard.js
      artists.js
      auth.js
      ownerArtistDashboard.js
      services.js
      visits.js
    utils/
      sessionUtils.js
  frontend/
    index.html
    package.json
    vercel.json
    vite.config.ts
    src/
      main.tsx
      context/
      hooks/
      layouts/
      services/
      components/
      pages/
      types/
```

## Current Core Flow (Visit Entry)

The active frontend flow is payment-first v2:

1. Staff fills customer, date, services, payment mode.
2. Frontend creates paid draft via `POST /api/visits/v2`.
3. App stores `pendingAssignmentVisitId` in localStorage.
4. App redirects to `/visit-assignment/:visitId`.
5. User must assign artist + start/end time for every selected service row.
6. Final confirm uses `POST /api/visits/:id/confirm-assignment`.

Important:

- Age is not collected for new submissions.
- Legacy age data is still preserved in schema (`Visit.age` optional).
- Assignment lock guard in frontend forces return to pending assignment route until completed.

## Authentication and Authorization

### Authentication

- Session cookie auth via `express-session` and Mongo store.
- Login endpoint: `POST /api/auth/login`.
- Session check endpoint: `GET /api/auth/me`.
- Logout endpoint: `POST /api/auth/logout`.

### Authorization Model

- PBAC permissions are defined in `backend/constants/permissions.js`.
- Most protected routes use `authorizePermission(...)`.
- Owner bypasses PBAC checks.
- Artist self-dashboard routes also enforce identity role scope with `authorize("artist")`.

Permission keys:

- `analytics.view`
- `payments.view`
- `services.view`
- `services.crud`
- `artists.view`
- `artists.crud`
- `artist_dashboard.view`
- `team.view`
- `team.manage`
- `visit.create`

Default permission seeds:

- Manager: analytics, payments, services.view, artists.view, artists.crud, artist_dashboard.view, visit.create
- Receptionist: payments.view, visit.create
- Artist: empty (granted explicitly)
- Owner: PBAC bypass

## Backend Route Summary

Base URL locally: `http://localhost:4000`

### Core utility routes in `backend/index.js`

- `GET /api/health`
- `GET /api/form-data`
- `POST /api/create-order`
- `POST /api/verify-order-payment`
- `POST /api/create-payment-link` (legacy payment-link flow)
- `GET /api/verify-payment` (legacy callback verification)

### Auth routes (`/api/auth`)

- `POST /login`
- `POST /logout`
- `GET /me`

### Visits routes (`/api/visits`)

- `POST /` (legacy create)
- `POST /v2` (payment-first draft create)
- `GET /:id/assignment-draft`
- `POST /:id/confirm-assignment`
- `GET /customers/search`
- `GET /history`

### Analytics routes (`/api/analytics`)

- `GET /summary`
- `GET /top-services`
- `GET /employees`
- `GET /employee/:name`
- `GET /repeat-customers`
- `GET /export`
- `GET /health`

### Admin routes (`/api/admin`)

- `GET /permissions`
- `GET /users`
- `POST /users`
- `PATCH /users/:id`
- `DELETE /users/:id`
- `DELETE /users/:id/permanent`

### Artists routes (`/api/artists`)

- `GET /`
- `GET /all`
- `POST /`
- `PATCH /:id`
- `DELETE /:id`
- `DELETE /:id/permanent`

### Services routes (`/api/services`)

- `GET /`
- `GET /all`
- `GET /categories`
- `POST /`
- `PATCH /:id`
- `DELETE /:id`
- `DELETE /:id/permanent`

### Artist dashboards

- Artist self routes: `/api/artist-dashboard/*`
  - `GET /profile`, `/summary`, `/services`, `/daily-trend`, `/time-performance`
- Owner/manager artist view routes: `/api/owner/artist-dashboard/:artistId/*`
  - `GET /profile`, `/summary`, `/services`, `/daily-trend`

## Frontend Routes (from `frontend/src/main.tsx`)

Public:

- `/`
- `/signin`
- `/payment-status`
- `/unauthorized`
- `/about`
- `/contact`
- `/privacy-policy`
- `/terms-of-service`

Protected:

- `/visit-entry` (requires `visit.create`)
- `/visit-assignment/:visitId` (requires `visit.create`)
- `/dashboard/receptionist/*`
- `/dashboard/manager/*`
- `/dashboard/owner/*`
- `/dashboard/artist/*`

## Environment Variables

### Backend (`backend/.env`)

Required:

- `MONGODB_URI`
- `SESSION_SECRET`
- `OWNER_EMAIL`
- `OWNER_PASSWORD`

Needed for online Razorpay flows:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`

Optional/defaulted:

- `FRONTEND_URL` (defaults to `http://localhost:5173`)
- `NODE_ENV`
- `PORT` (defaults to `4000`)

### Frontend (`frontend/.env`)

- `VITE_BACKEND_URL` (example: `http://localhost:4000`)

## Local Development

### Backend

```bash
cd backend
npm install
npm start
```

Available scripts:

- `npm start` -> `node index.js`
- `npm run dev` -> `node --watch index.js`
- `npm run smoke:phase5` -> PowerShell smoke script

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Notes and Gotchas

- If you see old validation behavior (for example age required), ensure no stale node process is running on port 4000.
- This repository has both legacy payment-link routes and active order-based payment flow.
- `frontend/dist` is build output and should not be treated as source of truth.

## Deployment

- Backend and frontend each include `vercel.json`.
- Backend exports Express app from `backend/index.js` for serverless runtime.
- Frontend uses Vite build output (`dist`).

## Source of Truth Files

Start here for behavior:

- Backend entry and middleware: `backend/index.js`
- Visit flow API: `backend/routes/visits.js`
- Permission model: `backend/constants/permissions.js`
- Frontend routing and assignment lock: `frontend/src/main.tsx`
- Visit form logic: `frontend/src/hooks/useVisitForm.ts`
- API client contracts: `frontend/src/services/api.ts`
