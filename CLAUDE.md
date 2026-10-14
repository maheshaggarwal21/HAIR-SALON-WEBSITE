# CLAUDE.md — The Experts Hair Salon platform

Read this file first in every session. It tells you what this repo is, the rules that
must never be broken, and where the detailed specs live.

## What this repo is

One salon (The Experts, Sirhind–Patiala Rd, Patiala), one database, three apps:

| Folder      | App                              | Users                              | Stack                                   | Domain (target)          |
|-------------|----------------------------------|------------------------------------|-----------------------------------------|--------------------------|
| `backend/`  | API + booking engine             | Both apps below                    | Node, Express (CommonJS), Mongoose      | `api.thexpertshair.com`  |
| `frontend/` | Staff app (owner, manager, reception, artists) | Salon staff          | React 19, Vite, TS, Tailwind 4          | `app.thexpertshair.com`  |
| `customer/` | Customer website + online booking | Public                            | Next.js (App Router), TS, Tailwind 4    | `thexpertshair.com`      |

All three deploy on Vercel as separate projects from this one repo (Root Directory =
the folder). MongoDB Atlas is the only datastore.

The customer site NEVER connects to MongoDB. It only calls `backend/` through
`/api/public/*`. The staff app only calls `/api/*` staff routes with a session cookie.

## Read order for any task

1. `docs/customer-platform/TASKS.md` — find the task ID you are working on.
2. `docs/customer-platform/CONTROL_FLOW_AND_DATA_LOGIC.md` — models, state machines,
   booking engine, payments. Any backend or booking change must match this file.
3. `docs/customer-platform/DESIGN.md` — any UI in `customer/` must match this file.
4. `docs/customer-platform/CHECKPOINTS.md` — before calling a phase done.

If the code and a doc disagree, stop and flag it. Update the doc in the same PR as
the code when a decision changes. Record decisions in the "Decisions" table at the
bottom of CONTROL_FLOW_AND_DATA_LOGIC.md.

## Commands

```bash
# backend
cd backend && npm install && npm run dev        # node --watch index.js
npm test                                         # node:test + in-memory Mongo replica set
npm run seed:owner                               # deploy-time owner seed
npm run migrate:m1                               # M1 Customer backfill (insert-only)
npm run migrate:m3                               # any migration: dry run by default
npm run migrate:m3 -- --apply                    # …writes only with --apply
npm run export:catalogue                         # T0.3 owner review sheet
npm run migrate:m6                               # T0.3 import the owner-signed sheet (dry run)

# staff app
cd frontend && npm install && npm run dev        # Vite
npm run build && npm run lint

# customer site
cd customer && npm install && npm run dev        # Next.js
npm run build && npm run lint && npm run typecheck
```

Backend tests live in `backend/test/` (node:test + mongodb-memory-server, single-node
replica set so transactions work). They never touch Atlas. New booking-engine code must
ship with tests from day one.

## Non-negotiable rules

### Money
- The server computes every price, discount, deposit and total. Never trust a price,
  total or discount sent by a browser.
- Razorpay webhook is the source of truth for "money received". The browser flow is a
  convenience. This rule exists because 14 payments (₹3,185.70) were lost when it wasn't.
- On a Visit, `cashAmount + cardAmount + onlineAmount (+ giftCardAmount when added)`
  must equal `finalTotal`. Every write path must keep this invariant.
- A deposit is money already received. It is deducted at checkout and never counted twice.
- Payment-completion endpoints must never be rate-limited (see `PAYMENT_CRITICAL` in
  `backend/index.js`).

### Prices shown to customers
- Customers see the real price they pay (`Service.publicPrice`), which is currently 50%
  of the internal list price. Never show a permanent strike-through "discount".
- Strike-through is allowed only for a time-boxed `Campaign` with real start and end dates.

### Time
- Store all instants in UTC. Compute slots, "today", opening hours and reminders in
  `Asia/Kolkata`. Vercel runs in UTC — never use the server's local time.
- Use `dayjs` with the `utc` and `timezone` plugins (already a frontend dependency).

### Booking integrity
- A booking may only be confirmed inside a MongoDB transaction that inserts its
  `SlotLock` rows. The unique index on `SlotLock {artistId, blockStart}` is what
  prevents double booking. Do not replace it with an application-level check.
- Walk-ins logged on the Today board also write `SlotLock` rows. If they don't, online
  booking will double-book.
- Bookings snapshot price and duration at the time of booking, exactly like `Visit` does.
- Never delete an Appointment. Change its status.

### Serverless (Vercel)
- Finish all DB writes before sending the response. Work after `res.send()` may never run.
- Call `connectDB()` at the start of every route handler (see `backend/db.js`).
- No long polling, no in-process timers, no in-memory queues. Use Vercel Cron + idempotent jobs.
- In-memory rate limiters are per-instance. Public endpoints use the Mongo-backed limiter (T2.9).

### Privacy and consent
- Collect the minimum. Phone, name, optional email, gender of the person served.
- WhatsApp marketing opt-in is a separate, unticked checkbox. Transactional messages
  (OTP, confirmation, reminder) don't need it.
- No health notes except `patchTestDoneAt` for colour clients.
- Before/after photos need a recorded consent flag per photo.
- Public endpoints return public fields only. Never return another customer's data.

### Honesty in marketing UI
- Countdowns and "only N left" only when backed by real data (campaign end date,
  package cap, actual free slots). Fake urgency is a dark pattern under India's consumer
  protection guidelines and also damages the premium positioning.

## Existing code conventions (backend)

- CommonJS (`require`), Express routers in `backend/routes/`, Mongoose models in `backend/models/`.
- Auth: `authenticate` session middleware; permissions via `authorizePermission(PERMISSIONS.X)`.
  New permissions go in `backend/constants/permissions.js` with a label and a group.
- Owner bypasses PBAC. Artists start with no permissions.
- Use `utils/audit.js` for any owner/manager change to services, artists, prices,
  campaigns, schedules or bookings.
- Use `utils/telegram.js` for owner alerts. It never throws; keep it that way.
- Long, explanatory file headers that say WHY are the house style. Keep them.

## Customer site conventions

- App Router. Server Components by default; `"use client"` only for interactive parts
  (booking sheet, sliders, video, motion).
- Data from `/api/public/*` through `customer/lib/api.ts`: `'use cache'` functions with
  `cacheTag` + `cacheLife` (Next 16 Cache Components, CF D15). On-demand revalidation via
  `/api/revalidate` (secret) calling `revalidateTag` when the owner edits content.
- Design tokens live in `customer/app/globals.css` (`@theme`) and mirror DESIGN.md exactly.
- Motion is CSS-first plus small client components (word-rise, reveal, marquee,
  review drift, hero slider). No GSAP, no Lenis, no pinned sections (CF D26, D31).
  Every animation respects `prefers-reduced-motion`.
- Performance budget is a requirement, not a goal (see DESIGN.md §9). Check it on a
  throttled mid-range Android profile before merging any landing-page change.

## Do not

- Do not add a second database, ORM or backend.
- Do not expose staff routes, sessions or cookies to the customer site.
- Do not add Three.js or real-time 3D to the customer site.
- Do not embed Instagram via iframes; use the synced reels feed.
- Do not edit `Visit` history to "fix" analytics. Write a migration with a dry-run mode.
- Do not commit secrets. `.env*` files other than `.env.example` stay out of git.
- Do not push to `main` without the checkpoint for that phase passing.

## Glossary

| Term | Meaning |
|------|---------|
| List price | `Service.price`. Internal menu price. Billing currently applies 50% off. |
| Public price | `Service.publicPrice`. What the customer actually pays and what the website shows. |
| Appointment | A booking made before the customer arrives (online, phone or front desk). |
| Visit | Existing record of a completed, paid service session. Analytics read Visits. |
| Today board | Staff screen: one row per artist, timeline of the day, bookings + walk-ins. |
| Slot lock | One 15-minute block of one artist's time, uniquely owned by one appointment or walk-in. |
| Request booking | Customer asks; salon approves. Used for chemical, bridal and consultation services. |
| Instant booking | Confirmed immediately if the slot is free. |
| Hold | A temporary slot lock (10 min) while the customer verifies OTP or pays a deposit. |
