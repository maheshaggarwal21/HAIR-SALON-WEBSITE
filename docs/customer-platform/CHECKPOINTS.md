# CHECKPOINTS.md — gates before each release

A phase is done only when its checkpoint passes. If an item fails, the release waits or
the item is explicitly waived in the sign-off table with a reason. No silent waivers.

---

## Every merge to `main` (standing checklist)

- [ ] `backend`: `npm test` green. New booking/payment code has tests.
- [ ] `customer`: `npm run lint && npm run typecheck && npm run build` green.
- [ ] `frontend`: `npm run lint && npm run build` green.
- [ ] No secrets, `.env*` (except `.env.example`) or customer data committed.
- [ ] Docs updated if behaviour changed (CF, DS, TASKS log).
- [ ] Migrations run with `--dry-run` first; output attached to the PR.
- [ ] Preview deployment checked on a real Android phone (Chrome + Instagram in-app browser).
- [ ] Staff smoke test: log in → Visit Entry → cash visit → appears in analytics.

---

## CP0 — Foundations ready (target 15 Oct)

- [ ] Repo private; collaborators correct.
- [ ] Owner answered Q1–Q10 or accepted defaults (CF §24).
- [ ] Public catalogue sheet signed off (names, audience, public prices, exceptions).
- [ ] `publicPrice` set for every `showOnWebsite` service; spot-check 10 against owner's real prices.
- [ ] Durations: every service planned for instant booking has `durationMinutes`.
- [ ] WhatsApp templates submitted (approval may still be pending).
- [ ] Content shoot booked or done; consent forms collected.
- [ ] Test runner works in CI.

---

## CP1 — Karva Chauth request-lite live (target 21 Oct)

Functional
- [ ] Request from `/offers/karva-chauth` creates an Appointment `requested` with services, date, window, UTM.
- [ ] Owner receives Telegram alert within 10 seconds.
- [ ] Receptionist confirms with a time in the staff app in under 30 seconds.
- [ ] Every customer-facing string says "request", never "booked/confirmed".
- [ ] Public API returns no list price, commission, staff phone or other customers' data (automated test).
- [ ] Rate limits and Turnstile block 20 rapid requests from one IP.

Quality
- [ ] Lighthouse mobile ≥ 90 performance, ≥ 95 accessibility on the offer page.
- [ ] LCP ≤ 2.5s on throttled 4G mid-range Android profile.
- [ ] Prices on the page match the signed-off sheet.

People
- [ ] Receptionist trained (10 minutes) on the Requests page; owner knows where alerts arrive.

Business watch (daily until 29 Oct): requests/day, % confirmed, no-show count, revenue
from requests (Visits with `source.channel = web`).

Rollback: hide the request form (env flag `NEXT_PUBLIC_BOOKING_MODE=whatsapp`) so CTAs
open WhatsApp instead. Page stays live.

---

## CP2 — Full site live on the main domain (target 24 Oct)

- [ ] All home sections render with real content; no placeholder text anywhere.
- [ ] Reduced-motion mode: no pinned/scrubbed motion, no autoplay video.
- [ ] Only one reel plays at a time on mobile.
- [ ] Rating badge shows the owner-entered rating/count and links to the salon's Google page (D38: no live Google data).
- [ ] Staff app works on `app.thexpertshair.com`: login gate (Telegram approval), Visit Entry,
      Razorpay payment, payment-status redirect, analytics.
- [ ] Old staff URLs on the apex domain redirect to the app subdomain.
- [ ] Razorpay `FRONTEND_URL` / callback URLs updated to the app subdomain; one live ₹1 test payment reconciles.
- [ ] Owner edit to a service name/price appears on the site within 60 seconds.
- [ ] Legal pages linked; consent checkbox unticked by default.
- [ ] Performance budget (DS §9) met on home and a service page.

Rollback: point apex DNS back to the staff app project (keep both Vercel projects live
for 7 days after the switch).

---

## CP3 — Gift cards live (target 3 Nov)

- [ ] Gift card is created only by the webhook; replaying the webhook creates nothing new.
- [ ] Code shown once, stored hashed; WhatsApp delivery works.
- [ ] Redemption decrements balance atomically; two concurrent redemptions cannot overspend (test).
- [ ] Visit invariant holds with gift card amounts (test).
- [ ] Gift card sales appear separately from service revenue; cash collection excludes them.
- [ ] Reconciliation: Razorpay settlements for gift cards = sum of `GiftCard.initialValue` for the period.
- [ ] Receptionist can redeem a card in under 30 seconds.

Rollback: hide `/gift-cards`; existing cards remain redeemable.

---

## CP4 — Real booking engine live (target 30 Nov)

Correctness (automated, must all pass)
- [ ] Edge cases E1–E24 (CF §21) have tests and pass.
- [ ] Concurrency test: 50 parallel confirms for one slot → exactly 1 success.
- [ ] Payment examples A, B, C (CF §8) pass.
- [ ] UTC/IST boundary tests pass.
- [ ] Webhook replay, browser verify after webhook, and hold-expiry-paid cases behave as specified.

Operational (staged rollout)
- [ ] Week 1–2: only women's artists `onlineBookable`; barbers walk-in only.
- [ ] Receptionist logs every walk-in on the Today board at sit-down (owner spot-checks 3 days:
      board vs. actual chairs at 11:00, 14:00, 18:00).
- [ ] Zero double bookings in the first 14 days. Any double booking → pause online booking
      for affected artists, root-cause, then resume.
- [ ] Reminders (24h, 2h) sent and logged.
- [ ] Refund queue empty or each item explained.

Metrics to review at end of week 2
| Metric | Target |
|---|---|
| Online bookings / week (women's services) | baseline from CP1 requests × 1.5 |
| Booking start → confirmed conversion | ≥ 25% |
| No-show rate (online) | ≤ 10% |
| Double bookings | 0 |
| Average time to process a request | ≤ 30 min in opening hours |

Rollback: set all artists `onlineBookable = false` (site falls back to request-lite).
Existing confirmed bookings remain valid.

---

## CP5 — Growth tools (target 20 Dec)

- [ ] Owner creates and schedules a campaign, popup and promo without developer help.
- [ ] Promo and package caps hold under concurrent bookings.
- [ ] Funnel report revenue per `utm_campaign` reconciles with Visit revenue (± 0).
- [ ] Rebook nudges go only to opted-in customers; opt-out works from the message.
- [ ] Meta CAPI events only for consenting customers.
- [ ] Accessibility audit: WCAG 2.1 AA issues fixed or logged with dates.
- [ ] Performance re-audit after content growth; budgets still met.

---

## Sign-off

| Checkpoint | Date | Passed | Waived items (reason) | Signed by |
|---|---|---|---|---|
| CP0 | | | | |
| CP1 | | | | |
| CP2 | | | | |
| CP3 | | | | |
| CP4 | | | | |
| CP5 | | | | |
