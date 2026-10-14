# TASKS.md — customer platform build plan

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.
Every task has an ID. Use it in branch names (`t2-04-availability-engine`) and commit messages.
Specs: CONTROL_FLOW_AND_DATA_LOGIC.md (CF §n) and DESIGN.md (DS §n).
Gates: CHECKPOINTS.md (CP n).

Key dates (2026): Dussehra 20 Oct · Karva Chauth 29 Oct · Dhanteras 6 Nov · Diwali 8 Nov ·
Bhai Dooj 11 Nov · wedding season from mid-Nov.

| Phase | Window | Ships | Gate |
|---|---|---|---|
| 0 | 13–15 Oct | Decisions, data cleanup, accounts, repo setup | CP0 |
| 1 | 15–21 Oct | Karva Chauth page + request-lite booking | CP1 (21 Oct) |
| 1b | 21–24 Oct | Full landing, public menu, artists, reels, domain switch | CP2 (24 Oct) |
| 1.5 | 26 Oct–3 Nov | Gift cards for Diwali / Bhai Dooj | CP3 (3 Nov) |
| 2 | 4–30 Nov | Slot engine, Today board, OTP, deposits, instant booking, reminders | CP4 (30 Nov) |
| 3 | 1–20 Dec | Campaign CMS, packages, funnel analytics, rebook nudges, polish | CP5 (20 Dec) |

---

## Phase 0 — Foundations (13–15 Oct)

| ID | Task | Acceptance |
|---|---|---|
| T0.1 | [ ] Make the GitHub repo private; add Pursharth + owner as collaborators | Repo private; Vercel deploys still work |
| T0.2 | [~] Owner decisions meeting: Q1–Q10 (CF §24) | Answers written into CF §24 |
| T0.3 | [~] Export service catalogue; owner marks `showOnWebsite`, `audience`, public names, exceptions to 50% | Signed-off sheet in `docs/customer-platform/data/services-public.csv` |
| T0.4 | [~] Migration M3 (`publicPrice`) + M4 (categories) with `--dry-run` | Dry-run report reviewed; applied |
| T0.5 | [~] Migration M2 (durations from `actualDurationMins`) | Report lists services still without duration |
| T0.6 | [~] Add backend test runner (`node:test` + `mongodb-memory-server` replica set) | `npm test` runs in CI with one passing test |
| T0.7 | [~] Scaffold `customer/` (Next.js App Router, TS, Tailwind 4, ESLint, `typecheck` script) | Vercel project "experts-customer" deploys a placeholder on a preview URL |
| T0.8 | [ ] Confirm Vercel plan (cron frequency), create env vars in all three projects | CF §22 vars present (placeholders OK) |
| T0.9 | [ ] Submit WhatsApp templates in Wati: request received, booking confirmed, reminder 24h, reminder 2h, cancelled, OTP (auth), gift card | All submitted; approval status tracked here |
| T0.10 | [ ] Content shoot: 1 day, women's work first (colour, keratin, facial, bridal look), 6–8 before/after pairs, 1 hero loop, artist portraits, ladies' area photos. Consent form signed per client | Assets in shared drive, consent sheet complete |
| T0.11 | [ ] Cloudflare Turnstile site + secret keys | Keys in env |
| T0.12 | [ ] Google Places API key restricted to Places (New); find `SALON_PLACE_ID` | Key + place ID in env |

---

## Phase 1 — Karva Chauth request-lite (15–21 Oct) → CP1

Backend
| ID | Task | Acceptance |
|---|---|---|
| T1.1 | [~] Service model: public fields (CF §2.1) + migration | Existing staff flows unaffected (manual smoke test) |
| T1.2 | [x] Artist model: `publicProfile`, `gender`, `level`, `onlineBookable` | Owner can edit via API |
| T1.3 | [~] `Customer` model + M1 backfill | Count ≈ unique contacts in Visits (1,779 as of 13 Oct) |
| T1.4 | [x] `Appointment` model (fields needed for request-lite + full schema stubs) | Indexes created |
| T1.5 | [x] `SiteSettings` singleton + seed | GET returns hours/contact |
| T1.6 | [x] Mongo-backed rate limiter for `/api/public/*` (`RateLimitHit`) | Tests: limit enforced across two app instances |
| T1.7 | [x] Public routes: `GET /site`, `/services`, `/services/:slug`, `/artists`, `/packages` (static KC packages), `POST /requests` (request-lite, Turnstile) | Returns public fields only (test asserts no `price`, `commission`, phone of staff) |
| T1.8 | [~] Telegram alert on new request (reuse `utils/telegram.js`) | Owner receives within 10s |
| T1.9 | [~] CORS: add customer + app domains | Preflight passes from preview and prod |

Staff app
| ID | Task | Acceptance |
|---|---|---|
| T1.10 | [~] "Requests" list page (`bookings.view`): requested → confirm with time / decline, note field | Receptionist can process a request in < 30s |
| T1.11 | [x] Add `bookings.view`, `bookings.manage` permissions + defaults | Permission editor shows them |

Customer site
| ID | Task | Acceptance |
|---|---|---|
| T1.12 | [x] Design tokens, fonts, base components (Button, Chip, PriceTag, ServiceCard) per DS §3, §5 | Storybook-free visual check page at `/_dev/ui` (excluded from prod) |
| T1.13 | [~] `/offers/karva-chauth` landing: hero, 2–3 packages, before/after (or photos), FAQ, request form | Lighthouse mobile ≥ 90 perf; LCP ≤ 2.5s throttled |
| T1.14 | [~] Request-lite booking sheet (services → date + window → details) with honest "request" wording | Creates Appointment; Telegram fires; thank-you screen |
| T1.15 | [x] UTM capture (first touch) + attach to request | UTM visible on the request in staff app |
| T1.16 | [x] WhatsApp button + sticky mobile bar | Opens WhatsApp with prefilled text |

---

## Phase 1b — Full site launch (21–24 Oct) → CP2

| ID | Task | Acceptance |
|---|---|---|
| T1.17 | [~] Home page sections 1–13 (DS §6.1) with motion system (DS §4) | Reduced-motion mode verified |
| T1.18 | [x] `/services` and `/services/[slug]` with variant selector | All `showOnWebsite` services reachable |
| T1.19 | [x] `/artists/[slug]` | "Book with" pre-fills artist |
| T1.20 | [~] Reels: manual upload (until Instagram API confirmed) via `/api/website/reels`; `ReelTile` + lightbox | One video plays at a time on mobile |
| T1.21 | [~] Google reviews cache (daily cron) + `RatingBadge`; owner-entered rating + selected reviews meanwhile (D27) | Shows live rating with attribution |
| T1.22 | [x] SEO: metadata, JSON-LD (HairSalon, Service), sitemap, robots | Rich results test passes |
| T1.23 | [~] Domain switch: staff app → `app.thexpertshair.com`; customer → apex + www; redirects for `/signin`, `/dashboard/*`, `/visit-entry` etc. to app subdomain | Staff can log in on new domain; old staff URLs redirect; Telegram gate still works |
| T1.24 | [x] Revalidate endpoint in `customer/` + backend calls on service/artist edits | Edit in staff app reflects on site ≤ 60s |
| T1.25 | [~] Legal pages: privacy (consent, data use), terms, cancellation policy | Linked in footer and booking form |

---

## Phase 1.5 — Gift cards (26 Oct–3 Nov) → CP3

| ID | Task | Acceptance |
|---|---|---|
| T1.5.1 | [ ] `GiftCard` model, code generator (unambiguous alphabet), hashing | Unit tests |
| T1.5.2 | [ ] Razorpay order `kind=giftcard` + webhook branch | Card created only from webhook; replay-safe |
| T1.5.3 | [ ] `/gift-cards` page and purchase flow (OTP optional in 1.5: Turnstile + phone) | End-to-end test with Razorpay test mode |
| T1.5.4 | [ ] WhatsApp delivery to purchaser (+ recipient optional) | Template approved and sending |
| T1.5.5 | [ ] Visit: `giftCardAmount` bucket + redemption UI in Visit Entry + atomic balance update | Invariant test: buckets sum to `finalTotal` |
| T1.5.6 | [ ] Payments/analytics: show gift card sales separately; cash collection excludes gift card amounts | Reports reconcile with Razorpay |

---

## Phase 2 — Real booking (4–30 Nov) → CP4

Engine and data
| ID | Task | Acceptance |
|---|---|---|
| T2.1 | [~] Artist `skills`, `schedule`, `onlineShare`; `TimeOff`; `Resource` models + staff UI — skills by gender/artist + Artist Skills screen done (D35); schedules = salon hours for all (D36); TimeOff/Resource staff UI pending | Owner sets full week for all artists |
| T2.2 | [ ] `SlotLock` model with unique + TTL indexes | Index test |
| T2.3 | [ ] Time utilities (IST grid, opening hours, holidays) with tests around UTC midnight | E20 passes |
| T2.4 | [ ] Availability engine (CF §4) as pure module + tests | E9, E13, E14 pass; 1,000 random scenarios never double-assign |
| T2.5 | [ ] `GET /availability`, `POST /quote` | Server ignores client prices |
| T2.6 | [ ] OTP (`OtpChallenge`, Wati auth template, dev channel) + `bookingToken` | Limits per CF §14 |
| T2.7 | [ ] Create-appointment transaction (CF §5.1) | E1, E11, E12, E17, E19 pass under concurrent test |
| T2.8 | [ ] Deposits + pay-in-full choice (D18): Razorpay order, webhook branch, verify-payment, hold expiry handling, partial refund on late cancel of a full payment | E3, E4, E5 + Example D pass |
| T2.9 | [ ] Move public rate limiting fully to Mongo store; exempt verify-payment | Load test: 50 parallel availability calls OK |
| T2.10 | [ ] Request mode on engine (holds until SLA) + Telegram approve/decline buttons | Approve from Telegram confirms booking |
| T2.11 | [ ] Manage link: view, .ics, cancel, reschedule (CF §9) | Cutoff rules enforced |
| T2.12 | [ ] Cron `bookings-tick` (expiry, reminders, review requests) with `JobRun` lock | Idempotent on double run |
| T2.13 | [ ] `NotificationLog` + `notify()` wrapper | E21 passes |

Staff app
| ID | Task | Acceptance |
|---|---|---|
| T2.14 | [ ] Today board (CF §7): timeline per artist, now line, legend, 30s poll | Matches mockup; renders 10 artists × 12h |
| T2.15 | [ ] Walk-in quick add (≤ 3 taps) writing firm locks | E2 passes |
| T2.16 | [ ] Check-in → Visit Entry prefilled; `/visits/v2` accepts `appointmentId`; deposit maths (CF §8) | Examples A, B, C pass as tests |
| T2.17 | [ ] Move/reassign, no-show, cancel, refund, block time | Audit log entries for each |
| T2.18 | [ ] Conflict warnings: leave/holiday over bookings (E8, E23) | Warning lists affected bookings |

Customer site
| ID | Task | Acceptance |
|---|---|---|
| T2.19 | [ ] Full booking sheet (DS §7): who → services → professional → time → details/OTP → deposit → done | Works in Instagram in-app browser on Android |
| T2.20 | [ ] Group booking (up to 4 guests) | E13 passes |
| T2.21 | [ ] `/booking/[token]` manage page | Cancel/reschedule flows tested |
| T2.22 | [ ] Switch site from request-lite to engine per artist (`onlineBookable`) | Barbers still walk-in only |

Rollout: women's artists only for the first 2 weeks (Q4), then review CP4 metrics.

---

## Phase 3 — Growth tools (1–20 Dec) → CP5

| ID | Task | Acceptance |
|---|---|---|
| T3.1 | [~] Campaign CMS: banners, popups (trigger, frequency), schedule — bar + pop-up + schedule done early (D29); promo codes, scroll/exit triggers pending | Owner creates a campaign without developer help |
| T3.2 | [ ] Promo codes with caps (server-validated) | E17 passes |
| T3.3 | [ ] Packages with total/day caps, bookable via engine | E18 passes |
| T3.4 | [ ] Funnel events + Funnel report by `utm_campaign` with revenue | Report reconciles with Visits revenue |
| T3.5 | [ ] Rebook nudges (opt-in only) per service interval | Sends only to opted-in customers |
| T3.6 | [ ] Instagram API sync (if Q7 = yes) + token refresh + owner tagging "Book this look" | Token refresh alert tested |
| T3.7 | [ ] Meta Conversions API `Schedule` event on confirmed bookings (consent-gated) | Event visible in Meta Events Manager test tool |
| T3.8 | [ ] Weekday "Happy Hour" off-peak offer as a campaign with time windows | Applies only inside the window |
| T3.9 | [ ] Membership / prepaid wallet design doc (owner decision first) | Doc approved before any build |
| T3.10 | [ ] Accessibility audit (WCAG 2.1 AA) and performance re-audit | DS §9 and §10 budgets met |

---

## Backlog (not scheduled)

- Colour processing time (artist free while colour develops).
- Re-host reels on Cloudinary/Vercel Blob with 720p transcodes.
- SMS OTP fallback after MSG91 DLT registration.
- Customer accounts with saved preferences (currently phone + OTP only).
- Hindi/Punjabi language toggle.
- Waitlist for fully booked festive days.

---

## Log

| Date | Task | Note |
|---|---|---|
| 13 Oct 2026 | — | Plan created |
| 13 Oct 2026 | — | Docs moved from `customer/.claude/` to `docs/customer-platform/` + root `CLAUDE.md` (the layout in the docs zip). `backend/.env` set up locally; Atlas `hair-salon` DB reachable (182 services, 14 artists, 5,519 visits, 1,780 unique contacts) |
| 13 Oct 2026 | T0.6 | `npm test` green locally (22 tests). `.github/workflows/backend-test.yml` added — not yet run on GitHub, so acceptance not yet met |
| 13 Oct 2026 | T1.1 | Public fields on `Service` + tests. All 182 live services validate against the new schema (read-only check). Still to do: manual staff smoke test (log in → Visit Entry → cash visit → analytics) after deploy |
| 13 Oct 2026 | T0.3 | Draft sheet `data/services-public.draft.csv` (182 rows, 16 flagged). Owner fills `owner_*` columns, saves as `services-public.csv` |
| 13 Oct 2026 | T0.4 | M3 + M4 dry runs: M3 would set 182 `publicPrice`; M4 would set 181 `displayCategory` + merge 2 "hair" → "Hair"; "Any item" left unmapped. Flags for owner: "Side Locks (Thread)" ₹4,000 (40× threading median — likely a typo); 3 accessories; possible duplicates (Head Massage / Head Massage (Men), Cheeks (wax) / Cheeks wax (men), Organic Bleach (Face) / Organic Bleach Face (women)). NOT applied — waiting on owner review |
| 13 Oct 2026 | T0.5 | M2 dry run: 85 services get a duration; 97 still without, including most women's chemical treatments (keratin, smoothening, botox, nanoplastia) and all makeup but one — owner must supply these before CP0. NOT applied |
| 13 Oct 2026 | T0.7 | `customer/` scaffolded: Next.js 16.4, TS, Tailwind 4, ESLint, `typecheck`; DS §3 tokens, fonts, `/api/public/*` rewrite, noindex placeholder. `lint`, `typecheck`, `build` green. Vercel project not created yet |
| 13 Oct 2026 | T0.4 / T0.5 | Owner decisions (CF D11–D13): website price is 50% of list for all services; every service ≥ 60 min until real times are entered; `customer/` layout kept. M2 rewritten — dry run now sets all 182 (97 no data → 60, 83 measured < 60 → 60, 2 measured longer kept: Balayage Short 65, Basic Party Make-up 90). M3 dry run unchanged (182). Service Management: new services default to 60 min + half price, list-price edits move `publicPrice`, website price shown, all service changes audited. 29 tests green. Local backend PORT → 4000; `frontend/.env.local` added. Still NOT applied to Atlas |
| 13 Oct 2026 | T0.5 | D14: `Service.durationConfirmed` added. M2 writes estimates unconfirmed; Visits snapshot only confirmed times (`Service.performanceDuration`), so estimates never touch artist performance. Service Management marks estimates, and typing a time confirms it. 31 tests green. Still NOT applied to Atlas |
| 14 Oct 2026 | T1.2–T1.6 | Models: Artist public layer (`publicProfile`, gender, level, onlineBookable), `Customer` (+ M1 insert-only backfill, dry run only), `Appointment` (full §2.2 shape + `requestedWindow`, preferred artist, `internalNote`), `SiteSettings` singleton (defaults = CF Q6; contact empty until owner fills it), `RateLimitHit` + Mongo limiter (two-instance test). IST helpers in `utils/time.js` with UTC-midnight tests |
| 14 Oct 2026 | T1.7–T1.9, T1.11 | `/api/public/*` mounted before session + global limiter (no cookie on public responses — tested through real index.js). Request-lite `POST /requests`: unknown fields rejected (no browser prices), Turnstile, 10/IP/h + 5/phone/day + 3 open per phone, IST date/holiday checks, Telegram alert awaited before reply. `config/packages.js` empty until owner approves packages. Permissions `bookings.view/manage`, `website.manage`. CORS + `app.thexpertshair.com`. Telegram/CORS acceptance needs a deploy |
| 14 Oct 2026 | T1.10 | Staff app "Website Requests" (owner, manager, receptionist with bookings.view): call/WhatsApp links, time chips inside the customer's window, artist, decline/cancel, staff note, 30s refresh. Conditional status updates (two people confirming → one 409). "Website Settings" page for contact/hours/closed days. `/api/website/*` for settings, artist profiles, service website fields (all audited) |
| 14 Oct 2026 | T1.12–T1.16 | `customer/`: Button, Chip, PriceTag, ServiceCard + `/_dev/ui` (404 in production). `/offers/karva-chauth`: hero, menu from API, how-it-works, visit, FAQ, request sheet (services → day + window → details → sent), sticky mobile bar (appears after hero CTA scrolls away), UTM first-touch capture, `NEXT_PUBLIC_BOOKING_MODE=whatsapp` rollback. Builds with API down (partial prerender) and fully static with API up. Local e2e against in-memory DB: request through the site's rewrite → `requested`. JS 179 KB gzip (budget 200). Lighthouse/LCP still to measure on a real deploy + Android. 69 backend tests green |
| 14 Oct 2026 | T0.3 | M6 import (`npm run migrate:m6`): reads the owner-signed `services-public.csv`, yes → on the website (request mode), blanks accept proposals, fills empty fields only, reports conflicts/bad rows. Dry run on the draft against Atlas: 182 rows parse, 0 problems. Waiting on the owner's sheet |
| 14 Oct 2026 | T0.2 | Owner answers recorded in CF §24 (K1–K6, Q1–Q10, F1–F5). Hours 9–9, Tuesday off → SiteSettings defaults. Open: phone number conflict, real map link, KC package variants + dates, Vercel Hobby vs cron needs |
| 14 Oct 2026 | K6 / T1.2 | Artists follow the staff app: every active artist is listed on the website unless the owner hides them (`publicProfile.visible` null/true/false), URL keys generated from names (duplicates get an id suffix). Staff app Website Settings → "Artists on the website" show/hide + website name. Request form can name any listed artist. 75 tests green |
| 14 Oct 2026 | D18 | Payment choice (deposit + rest at salon, or pay in full online) specified in CF §5.2/§8 and `Appointment.deposit.kind`; built with T2.8 |
| 14 Oct 2026 | K1 / K3 | Contact defaults: WhatsApp + calls 9814830550, address "near Sunrise Hotel", owner's Google Maps place, Instagram. Karva Chauth Special in `config/packages.js` (₹2,500; half arm rica, half leg honey; women; no dates) — DRAFT until the owner confirms the facial (Fruit Facial assumed). Separate total ₹3,310 shown honestly |
| 14 Oct 2026 | D19 | Free scheduler: `/api/cron/requests-tick` (SLA nudge in working hours, JobRun lock, bearer secret), `vercel.json` health cron daily. cron-job.org setup pending (needs an account + CRON_SECRET in Vercel) |
| 14 Oct 2026 | D18 / Phase 2 (parked) | Payment rule corrected (always paid online: full or ₹500 deposit; customer cancel/no-show keeps ₹500, refunds the rest). Phase 2 groundwork built and tested but NOT wired to any route: Artist skills/skillCategories/schedule/onlineShare, TimeOff, Resource, SlotLock, IST grid helpers, availability engine (`utils/availability.js`, 1,000 random scenarios), loader, quote with D18. Resumes after Phase 1b |
| 14 Oct 2026 | T1.17–T1.25 | Phase 1b built. Customer site: shared shell (header, footer, request sheet, sticky bar on every page); home with all 13 DS §6.1 sections, each hidden until its content exists (hero video, before/after, reels, reviews, packages); `/services` (her/him tabs, category chips, search), `/services/[slug]` (variant picker, Service JSON-LD, 154 prerendered), `/artists`, `/artists/[slug]` ("Ask for …"); legal pages; sitemap, robots, HairSalon JSON-LD; `/api/revalidate`; staff-URL redirects behind STAFF_APP_URL. Motion CSS-first; GSAP (hero card-expand, pinned services) and Lenis load on desktop only. Home JS 187 KB gzip (budget 200). Builds with the API down. Backend: Reel + ReviewCache models, `/api/public/reels`, `/reviews`, rating on `/site`, media + consent-gated before/after in SiteSettings, `/api/website/reels`, Blob upload tokens, revalidate pings after every service/artist/settings/reel edit, daily `reviews-refresh` cron (Vercel daily, Hobby-OK). Staff app: Website Menu, Website Reels, media section in Website Settings. 101 backend tests green |
| 14 Oct 2026 | T1.21 | [!] Blocked: Google key returns PERMISSION_DENIED (billing or Places API (New) not enabled on the project). Code + daily job ready; needs place ID via `npm run find:place` |
| 14 Oct 2026 | Owner review (D25–D27) | Palette "Cream & Champagne Gold" (no black sections, charcoal buttons, gold accents). Fixed: glued headline words (space inside inline-block mask), signature row (GSAP pin → snap row with arrows, cards no longer wider than their slot), /services and request sheet scrolling (Lenis removed), For her/him tabs not following header links (useSearchParams), closed sheet's shadow showing at the screen edge. Legal links in the request form; hero video never autoplays before the reduced-motion check. Reviews: owner-entered rating/count/link + selected reviews in Website Settings (starting list: 4 real Google reviews), drifting review cards on home. Rating stays hidden until the owner enters it. 102 backend tests green |
| 14 Oct 2026 | D28 | Reviews stats row (rating ★, clients served +, Google reviews +) with count-up. Clients served counted from paid Visits server-side, rounded down, hidden below 100. 103 backend tests green |
| 14 Oct 2026 | D29 / T3.1 (early) | Website Offers: owner/manager create offers with IST dates, colour theme, label, headline, details, poster, button link, pop-up delay and frequency; pause or delete. Site: animated offer bar above the header on every page + poster pop-up while an offer runs. Old hard-coded Karva Chauth strip removed: the owner creates the Karva Chauth offer with its real dates. 104 backend tests green |
| 14 Oct 2026 | D30 | Service photos: 29 shoot photos → 58 WebP files (59.6 MB → 2.54 MB). Central mapping `lib/serviceImages.ts`; every card resolves (only Waxing uses a fallback). Photos on menu cards, signature row, Karva Chauth page, service detail page; For her / For him tiles with cream fade. Verified at 390/768/1440: no broken images, no sideways overflow, even grids, strip scrolls, phones load 640px files only |
| 14 Oct 2026 | D30 (waxing) | Six waxing photos (12.3 MB → 0.47 MB WebP). Waxing cards map by area: face, underarm, arms, legs, back, tools (stomach/bikini/body); men-only Nose/Ear/Forehead/Full Face wax by keyword. Waxing fallback → wax-legs. All 154 cards now have a dedicated photo; no category fallbacks. Verified at 390/1440 on both tabs: 0 broken, rows even |
| 14 Oct 2026 | D30 / D31 | Owner photo upload per service (Website Menu → Blob; replaces the stock photo). Hero slider beside the headline: 3 reels + 3 photos in the owner's order, story bars, auto-advance (video end / 5 s), ‹ ›, swipe; only the current video downloads; reduced motion = manual. Website Settings → Home page slider (↑/↓, cover frame, description). GSAP and the old hero video component removed. Ready-to-upload files in ~/Downloads/hair-salon-media/hero-slider-ready. 105 backend tests green |
| 14 Oct 2026 | D31–D33 | Hero: face-following landscape (16:9) cuts of the reels for desktop (`wideUrl`), video 3 zoomed out with blurred sides; phones keep the reels. Home: Meet the owner (Ajit Singh photo + draft bio, editable) replaces Meet the artists; See us in action gallery (3 salon photos from frontend/public, editable). 107 backend tests green |
| 14 Oct 2026 | D34 | Menu groups: 30 look-alike groups as one card with priced options (config overlay, no DB change). For her 125 → 35 cards, For him 123 → 31. Detail pages by group URL; old member URLs still work. SERVICE_IMAGES.md lists the pre-grouping cards (group titles now map in serviceImages.ts). 114 backend tests green |
| 14 Oct 2026 | D34 / D30 | Option dropdown replaces option chips (service page: pick one; request sheet: tick several where `pick: "many"`, e.g. threading/waxing; levels stay alternatives). New salon photos for Keratin, Botox, Nanoplastia, Hair Perming and Olaplex spa (bond repair). 115 backend tests green |
| 14 Oct 2026 | D34 | Menu: Everyone tab (all services, same-name men/women cards merged with labelled options; 39 cards). Couple haircut split out of Men's haircut (renamed from "Hair Cut (Creative Styling)", couple photo); new Men's haircut photo; men-only hair cards now use it. 117 backend tests green |
| 14 Oct 2026 | D35 / D36 | Artist skills: gender rules + per-artist rule (all / sections / sub-groups / services), engine follows it; staff app Artist Skills screen (owner; manager with artists.view). Everyone starts on all services; all artists on salon hours 9–9, Tuesday off; receptionist checks walk-ins in on the Today board (Phase 2). Fixed: website.campaign_changed audit entries were being refused (not in the AuditLog enum); new test checks every audited action is allowed. 121 backend tests green |
| 14 Oct 2026 | T1.23 | Staff app is staff-only: `/` goes straight to sign-in; old landing, About, Contact, Privacy and Terms pages removed; old public URLs forward to the customer site (VITE_CUSTOMER_SITE_URL, default https://thexpertshair.com); "Back to the website" on sign-in; robots noindex. Customer site: "Staff sign in" in header + footer → app.thexpertshair.com/signin |
| 14 Oct 2026 | DS §3 | Layout tightened after owner review ("site feels stretched"): one 1160px content column (`max-w-site`) with header, offer bar, hero slide controls and footer on the same edges; section titles 64→56px, hero 96→84px, page titles 80→72px; Visit us = details + hours left, map right; FAQ = title left, questions right (home + Karva Chauth). Checked at 390 / 768 / 1024 / 1280 / 1470 / 1920: no sideways scroll, every section's left edge identical |
