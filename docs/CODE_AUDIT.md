# Code audit: The Experts salon platform

Date: 24 Oct 2026. Read-only review. No code was changed or committed; this file is the only thing written.
Branch checked out while reading: `fix/wa-request-manage-link`.

**What this repo does:** One salon in Patiala, one MongoDB database, three apps. `backend/` is the API and the
booking engine (slot locks, Razorpay payments, WhatsApp, cron jobs). `frontend/` is the staff app (Today board,
visit entry, analytics). `customer/` is the public website with online booking.

**Load I assumed:** One salon, about 5 to 10 staff devices on one shared IP, tens of visits a day, and public
traffic that spikes on festival days (Karva Chauth offer runs 27 to 29 Oct). Many people can hit "book" at the
same second; nobody is running thousands of requests per second. Judge "scale" findings against that.

---

## Scores

| Area | Score | Why, in short |
|---|---|---|
| 1. Bloat | **7 / 10** | No dead backend files (I checked every module). But ~1,100 removable lines: a dead legacy visit route, a dead payment-link route, 4 unused staff-app files (866 lines), 2 unused packages. Two files over 1,000 lines each do several jobs. |
| 2. Efficiency | **7 / 10** | Good habits: lazy-loaded staff routes (72 `lazy()` calls), cached public reads, projected queries, bulk lookups instead of loops. Weak spots: `Visit.razorpayPaymentId` has no index, analytics adds up every visit in Node, the 15-minute job does all its work in one request. |
| 3. Logic design | **7.5 / 10** | The core is careful: transactions, unique index on slot locks, conditional status updates, idempotent payment confirm, refund queue with claims. Gaps are at the edges: requests confirmed without locks, a payment-amount mismatch that never refunds, doc and code drifting apart. |
| 4. Risk | **6.5 / 10** | Most money paths follow the rules. But the desk visit routes believe whatever Razorpay payment id the browser sends, one payment can still become two visits under a retry, and a refund can be sent twice for small payments. |

---

## Findings

Numbered across all groups so you can say "fix 2 and 5". Each has an effort: **small** (under an hour),
**medium** (a day), **large** (several days). Areas tagged: BE = backend, FE = staff app, CU = customer site.

### Must fix

**1. A payment id typed or sent by the browser is trusted** (BE, risk, effort: medium)
`backend/routes/visits.js:577-594` (recovery path), `:610-666` (v2 create), `:360-394` and `:431` (booking checkout), `:243-253` (legacy create)
- **What this is:** When staff take an online or part-online payment at the desk, the staff app sends the Razorpay payment id and the server records the visit as "paid online".
- **Problem:** Only the "recover a lost payment" path (`recoveredPaymentId`) checks the id against our own payment records. The normal paths never check that the id exists, was captured, or matches the amount. A wrong id (typo, or the id of a ₹150 payment pasted against a ₹5,000 visit) books ₹5,000 of online revenue for money never received. CLAUDE.md says the webhook is the source of truth for money received.
- **Fix:** One helper used by all three create paths. Look up `PaymentEvent` by id; require `status: "captured"` and `amount` equal to the online part of this visit. If the webhook has not arrived yet (it fires about a second after capture, see the comment at `visits.js:728-734`), fall back to `payments.fetch` on Razorpay. The recovery path already has the first half of this check.
- **If we skip it:** Revenue and the "cash + card + online = total" rule can be satisfied on paper with no money behind it, and nothing would flag it. The unreconciled list only shows the opposite problem (money with no visit).

**2. One payment can still become two visits** (BE, risk, effort: small)
`backend/models/Visit.js:122` (no unique index; indexes are `:167-175`), `backend/routes/visits.js:610-628` (look up), `:672` (create), `frontend/src/hooks/useVisitForm.ts:53-66` (retry)
- **What this is:** "One payment, one visit" is enforced by looking for an existing visit, then creating one (`visits.js:599-628`). The comment says retries are expected.
- **Problem:** Look-then-create is not safe when two requests overlap. Case: the network drops on a slow cold start, the browser sends the save again after 800 ms (`withRetry`), while the first request is still running on the server. Both find nothing, both create. Today's revenue is counted twice. The same missing index also makes `Visit.findOne({razorpayPaymentId})` a full collection scan in the webhook (`backend/index.js:175`) and in the unreconciled sweep (`index.js:682`).
- **Fix:** Add a partial unique index on `razorpayPaymentId` (only where it is a string), and on error code 11000 return the existing visit, as the counter path already does at `visits.js:719-722`. First run a dry-run query for existing duplicates, because the index build fails if any exist. Remember CLAUDE.md: do not edit visit history; write a migration with a dry run.
- **If we skip it:** A flaky connection at the desk doubles one customer's sale in the analytics, and every webhook scans more visits as the collection grows.

**3. A confirmed request takes no slot locks** (BE, logic, effort: medium) — *flagged as a question as well*
`backend/routes/bookings.js:228-236` and header `:18`; doc `CONTROL_FLOW_AND_DATA_LOGIC.md` §6.1 ("No locks until Phase 2"); `CLAUDE.md` "Booking integrity"
- **What this is:** Requests that come from the request form or from WhatsApp offer pages (`channel: wa_ad`) are confirmed by staff with a date, time and optional artist. The code sets `status: "confirmed"` and the times, and nothing else.
- **Problem:** CLAUDE.md says a booking may only be confirmed inside a transaction that inserts its `SlotLock` rows. Here no lock rows exist, and the availability engine only reads locks. Case: reception confirms a Karva Chauth request for Saturday 4:00 pm with Artist A. An online customer then books Artist A at 4:00 pm; the engine sees no lock and sells it. Two customers, one chair.
- **Fix:** When staff confirm with a time and an artist, take firm locks in the same transaction (reuse `lockDocsFor`, as `approveRequest` does at `utils/booking.js:737-774`). On conflict answer 409 with who is in the way, as the walk-in does (`:954-1043`). If no artist is chosen, show it on the board so reception picks one.
- **Question for you:** Is online booking switched on in production right now? If it is off, this only bites once it is on. The code cannot tell me.
- **If we skip it:** Double bookings on exactly the busy days when the offer pages bring in requests.

**4. A payment of the wrong amount is kept, never refunded, and re-checked forever** (BE, money, effort: small)
`backend/utils/booking.js:511-515` (mismatch), `:651-676` (expiry loop)
- **What this is:** When Razorpay says a booking order was paid, `confirmPayment` compares the captured amount with the booking's expected deposit.
- **Problem:** On a mismatch it alerts the owner once and returns `amount_mismatch`. The booking stays `pending_payment`, the customer has paid and has no booking, and no refund is queued. Every 15-minute tick then asks Razorpay about it again (`expireBookings` counts it as `paidLate` and `continue`s without releasing it), so with enough of these the `limit(50)` window fills with them and normal expiries starve. The only test for `amount_mismatch` is in `counter.test.js`, not for bookings.
- **Fix:** Treat it like the "paid after hold expired" branch right below it: cancel by system, queue a refund of what was actually captured, alert. About 10 lines; the `refund_queued` code is already there.
- **If we skip it:** Rare, but when it happens a customer's money sits with nobody acting on it.

### Should fix

**5. A refund can be sent twice when the payment is small** (BE, money, effort: small to medium)
`backend/utils/booking.js:1340-1388`, stale claim `:1332`, retries `:878-896`
- **What this is:** `sendRefund` claims the refund, calls Razorpay, then marks it processed. A claim older than 10 minutes can be taken again.
- **Problem:** If Razorpay accepted the refund but our reply was lost (timeout, function cut off), the booking stays "processing" or "failed". The retry then sends a second refund. For a ₹3,000 payment the second ₹2,500 is refused by Razorpay (not enough left). For a ₹1,000 payment with a ₹500 cancellation fee, a second ₹500 would be accepted and the salon loses the fee. This assumes Razorpay allows several partial refunds up to the captured amount, which is how I know its API; I did not test it.
- **Fix:** Before sending, list the refunds already on that payment and adopt a matching one (same amount and `notes.ref`) instead of sending a new one.
- **If we skip it:** Small payments can be refunded twice after a network hiccup. Refunds are a daily event once online booking is live.

**6. The session cookie secret has a public fallback** (BE, security, effort: small)
`backend/index.js:345`
- **What this is:** `secret: process.env.SESSION_SECRET || "dev-secret-change-in-prod"`.
- **Problem:** If `SESSION_SECRET` is missing or misspelled in a deployment, the app starts and signs cookies with a string that is in the repo. Compare `utils/bookingToken.js:30-35`, which throws in production when its secret is missing. Forging a login still needs a valid session id, so the damage is limited, but the two secrets should behave the same.
- **Fix:** Same three lines as `bookingToken.js`: throw in production if unset.
- **If we skip it:** A config mistake silently weakens staff login instead of failing loudly.

**7. Nothing watches the 15-minute timer** (BE, logic, effort: small)
`backend/utils/jobLock.js:27-47` writes `lastRunAt`; nothing reads it (searched all of `backend/`). `backend/vercel.json` only has the daily health cron.
- **What this is:** The outside timer (cron-job.org) calls `/api/cron/bookings-tick` every 15 minutes. That one job expires unpaid holds, sends 24h and 2h reminders, retries failed messages and retries automatic refunds (`routes/cron.js` bookings-tick).
- **Problem:** If the timer is paused, the secret changes, or the URL 404s (your own notes say it 404'd until Phase 2 shipped), all of that stops with no alert. Unpaid bookings stay `pending_payment`, reminders do not go out, refunds are not retried.
- **Fix:** In the daily morning job (or `/api/health`), read `JobRun` for `bookings-tick` and send a Telegram message if `lastRunAt` is older than about 45 minutes. About 15 lines.
- **If we skip it:** You find out when a customer complains about a missing reminder or a stuck refund.

**8. The 15-minute job does all its work in one request, with no time box** (BE, efficiency, effort: small) — *question about your Vercel plan*
`backend/routes/cron.js` `bookingsTick` (`:176-215`), `utils/booking.js:659-676`
- **What this is:** One request runs expiry (up to 50 bookings, each with a Razorpay call), reminders (up to 200 sends), failed-message retries, up to 25 refund retries, and a counter backfill, one after another.
- **Problem:** After an outage the backlog can be large and the function can run out of time part-way. It is safe (each step can be repeated), so it self-heals, but there is no `maxDuration` in `vercel.json` and no time limit in the loops.
- **Fix:** Set `maxDuration` for the cron route and stop each loop after a time budget. Check your plan's function time limit first.
- **If we skip it:** Slow recovery after an outage, not data loss.

**9. Failed booking attempts use up the daily booking limit** (BE, logic, effort: small)
`backend/routes/publicBooking.js:322-325`
- **What this is:** One phone number may make 5 bookings per 24 hours.
- **Problem:** The counter goes up before the booking is tried. A customer who gets "That slot was just taken" five times while choosing a time on a busy day gets "You've made several bookings today" and gives up. Festival days are when slots go fast.
- **Fix:** Check the count first, but only add to it after `createBooking` succeeds.
- **If we skip it:** Lost customers on the days you most want them.

**10. The riskiest payment code has no tests** (BE, tests, effort: small to medium)
Searched `backend/test/`: `recoveredPaymentId`, `/api/create-order` and `/api/verify-order-payment` appear in no test. `amount_mismatch` is only tested for the counter flow.
- **What this is:** Desk visit creation with an online payment, the recovery path, and the order endpoints.
- **Problem:** These are the paths behind findings 1 and 2, and the original ₹3,185.70 loss.
- **Fix:** Three tests: (a) a made-up payment id is refused (after fix 1); (b) two overlapping creates with the same payment id make one visit (after fix 2); (c) a mismatched booking payment ends cancelled with a refund queued (after fix 4).
- **If we skip it:** The next change to these routes has nothing to catch a regression.

**11. Two payment routes nobody calls, and one of them is the unsafe one** (BE, bloat, effort: small)
`backend/routes/visits.js:142-305` (legacy `POST /api/visits`, about 165 lines), `backend/index.js:727-764` (`POST /api/create-payment-link`)
- **What this is:** Older versions of "save a visit" and "make a payment link".
- **Problem:** I found no caller in `frontend/src` or `customer/`. The frontend wrapper `createVisit` (`frontend/src/services/api.ts:220`) is never called; `create-payment-link` appears only in `README.md:152`. The legacy visit route has no payment-id check and no duplicate guard, so it is the weakest door into the visit table. Tests mount the router; I did not check whether any test posts to the legacy path.
- **Fix:** Delete both routes and `createVisit`. Keep `GET /api/verify-payment` and `PaymentStatus.tsx` only while old payment links may still be in customers' hands (question for you).
- **If we skip it:** An extra way to write unverified revenue stays open, and about 200 lines stay to maintain.

**12. The docs and the code disagree in three places** (BE, docs, effort: small)
- `CONTROL_FLOW_AND_DATA_LOGIC.md:124` says `Visit.depositPaymentId` is unique sparse. `models/Visit.js:106` is a plain field with no index.
- §9 says the manage link is 32 random bytes. `utils/bookingToken.js:78-80` builds it from an HMAC of the booking id, deliberately, so the server can rebuild links for reminders. The consequence is not written down: changing `PUBLIC_TOKEN_SECRET` breaks every link already sent on WhatsApp.
- §6.1 says confirmed requests get no locks "until Phase 2" (see finding 3).
- **Fix:** CLAUDE.md says to update the doc in the same change. Fix the doc or the code in each case, and add one line to the Decisions table about the secret.
- **If we skip it:** A future change trusts the doc and breaks live links or locking.

**13. The 50% desk price is typed in two places, and the setting that should drive it is not used** (BE, logic, effort: small)
`backend/utils/booking.js:913`, `backend/utils/checkout.js:62`, `backend/models/SiteSettings.js:272` (`publicPriceRatio`)
- **Problem:** `publicPriceRatio` is read nowhere (searched backend, customer, frontend). Both fallbacks hard-code `0.5`. If the owner ever changes the ratio, online prices and desk prices disagree.
- **Fix:** Either read the setting in one `deskPrice` helper, or delete the setting so nobody thinks it works.
- **If we skip it:** A price change shows different amounts on the website and at the desk.

**14. Analytics adds up every visit in memory** (BE, efficiency, effort: medium) — *scale assumed: about 50 visits a day*
`backend/routes/analytics.js:58-85`, `backend/routes/dataPipeline.js:36` and `:241-251`
- **What this is:** Reports load all matching visits into Node and total them in JavaScript. The code comment says 2.8 MB on today's data.
- **Problem:** Grows with every day of trading. `dataPipeline` caps at 20,000 rows and sets `truncated`. At the assumed rate that is reached in about 13 months, after which an all-time report silently leaves out the oldest visits (I did not check whether the staff screen shows the `truncated` flag).
- **Fix:** Do totals with `$group` in MongoDB; keep row-level loading only for exports.
- **If we skip it:** Slower reports next year, and eventually wrong all-time totals.

**15. The website ships both booking forms to every page** (CU, efficiency, effort: small to medium) — *not measured*
`customer/app/layout.tsx:9-10` (static imports), `:88-93` (only one renders); no `next/dynamic` anywhere in `customer/`
- **What this is:** `BookingSheet` (1,000 lines) and `RequestSheet` (605 lines) are both imported at the top of the layout. Only one is shown, chosen by `bookingEnabled`.
- **Problem:** The unused one still downloads and runs on every page, on a site where DESIGN.md §9 sets a speed budget for mid-range Android phones. I could not measure the size (the build output was not available and the disk is nearly full).
- **Fix:** Load the one that applies with `next/dynamic`, on the first "Book" click. Check size before and after.
- **If we skip it:** Slower first load for visitors who never open the form.

**16. Unused code across the apps** (FE, BE, bloat, effort: small)
- Staff app files nothing imports: `components/ui/background-beams.tsx` (107 lines), `combobox.tsx` (129), `time-picker.tsx` (491, also has 2 lint errors), `pages/dashboard/shared/ServicesView.tsx` (139). Total 866 lines. Confirmed by searching the whole of `frontend/src` for each name.
- Packages in `frontend/package.json` that nothing imports: `react-hook-form` (`:29`), `@radix-ui/react-slot` (`:16`).
- Backend functions defined and never called anywhere (including tests): `percentOff` (`utils/offers.js:79`), `isSplitPayment` (`utils/paymentLines.js:71`), `blockStarts` (`utils/time.js:116`).
- **Fix:** Delete them. Run `npm run build` and `npm run lint` in `frontend/` afterwards (lint currently reports 24 errors, 11 of them `set-state-in-effect`; that is a separate cleanup).
- **If we skip it:** Dead weight that people will read and be misled by.

### Nice to have

**17. CORS trusts every `*.vercel.app` site, with cookies allowed** (BE, security, effort: small) — *question*
`backend/index.js:75-83`, `:95`, `:101`
- Any site on `vercel.app` may make requests with credentials. The session cookie is `SameSite=Lax` (`index.js:373`), which stops browsers sending it on cross-site calls, so this is a layer that is missing rather than a hole. The comment ("real security is handled by session auth") is only true because of Lax. Fix: list your own preview project names instead.

**18. Cached public reads each cause a database write** (BE, efficiency, effort: small)
`backend/middleware/mongoRateLimit.js:35-58`, used at `routes/public.js:76`
- Every `/site`, `/services`, `/artists` call does an upsert to count the hit, even though the website caches those responses for minutes or hours. Low volume today. Fix: skip the limiter on cached catalogue reads and keep it on quote, availability, OTP and booking.

**19. Two different checks for the same Razorpay signature** (BE, bloat/security, effort: small)
`backend/index.js:578` uses `!==`; `backend/utils/payments.js:65-72` (`checkoutSignatureOk`) has the constant-time version. `index.js:583-590` also hands back the `amount` the browser sent, as if it were verified. Use `payments.checkoutSignatureOk`, and check what the staff app does with `amount` before dropping it.

**20. Long files that do several jobs, and small copy-paste** (BE, CU, bloat, effort: medium)
- `utils/booking.js` is 1,631 lines: create, payment, expiry, reminders, refunds, walk-ins, moves, manage-link and calendar files. `routes/visits.js` is 1,244. `index.js` (961) holds the payment routes inside the server entry file. Only worth splitting when you next touch them: refunds (`booking.js:857-899`, `:1340-1409`) are the cleanest first cut, because findings 4 and 5 both change that code.
- `routes/cron.js:109`, `:125`, `:138`, `:157`, `:202` repeat the same get-and-post loop five times.
- `customer/components/booking/ManageBooking.tsx:35-45` and `customer/components/request/BookingSheet.tsx:90-100` each define their own `fmtTime`, `fmtDay` and `post`.

(No smaller findings were left out beyond these 20.)

---

## App by app

### backend (read most closely)
Read in full or near-full: `index.js`, `utils/booking.js` (create, confirm, expire, reminders, close, refunds, walk-in start, manage, reschedule), `utils/checkout.js`, `utils/payments.js`, `utils/bookingToken.js`, `utils/turnstile.js`, `middleware/mongoRateLimit.js`, `middleware/authMiddleware.js`, `routes/publicBooking.js`, `routes/visits.js` (create paths), `routes/bookings.js` (confirm and cancel), `routes/cron.js`, `routes/auth.js` (outline), `models/*` (indexes), plus the first 460 lines of the control-flow doc.
Findings here: 1 to 14, 16 to 20. What is solid: the webhook is mounted before the body parser and the rate limiter and writes before it answers (`index.js:123-251`); slot locks have a unique index and every booking write is a transaction with a conditional status update; `confirmPayment` is idempotent and has a "paid after the hold expired" branch; refunds are claimed atomically; notifications use a unique key; public routes are mounted before sessions; Turnstile and the booking token fail closed in production; there are no dead modules (every file in `utils/`, `routes/`, `models/` and `middleware/` is required from non-test code).

### frontend (staff app)
Read: `package.json`, `main.tsx` (lazy routes), `hooks/useVisitForm.ts` checkout flow (lines 585-720 plus `withRetry`), `services/api.ts`, bundle sizes from the last build, lint output, unused-file scan. Findings: 2 (retry), 16.
Solid: every page is lazy-loaded; heavy export code (xlsx, jspdf, about 700 KB) is loaded only when exporting (`DataPipeline.tsx:571` comment, and separate chunks in the build); the two-witness payment check (checkout handler plus server poll, guarded by one `settled` flag) is a good answer to the 7 Aug loss.

### customer (public site)
Read: `app/layout.tsx`, `lib/api.ts`, `app/api/revalidate/route.ts`, the structure of `BookingSheet`, `RequestSheet`, `ManageBooking`, `WaRequestForm`, `next.config.ts`. Findings: 15, 20.
Solid: all data comes through `/api/public/*` (no database access); caching uses `cacheTag` with a failure lifetime of 30 to 60 seconds; the revalidate route compares its secret in constant time and only accepts known tags; the browser never sends a price.
Note: this site's own build tool refused to finish on Next.js 16.4.0 with a security-advisory warning. I did not investigate the advisory; treat it as a separate task.

---

## (a) Top 10 changes worth doing, in order

1. **Check the Razorpay payment id on desk visits** (finding 1).
2. **Unique index on `Visit.razorpayPaymentId`, with a duplicate-safe create** (finding 2).
3. **Take slot locks when staff confirm a request** (finding 3), after you tell me whether online booking is live.
4. **Refund, don't strand, a payment of the wrong amount** (finding 4).
5. **Look for an existing refund before sending one** (finding 5).
6. **Alert when the 15-minute timer stops** (finding 7).
7. **Stop failed attempts using up the daily booking limit** (finding 9).
8. **Add the three payment tests** (finding 10), written alongside 1, 2 and 4.
9. **Delete the legacy visit and payment-link routes** (finding 11).
10. **Make the session secret fail closed** (finding 6).

## (b) Looks fine; leave it alone

- Slot-lock design and the unique index, plus the transactions around create, confirm, move, reschedule and walk-in. Do not replace it with an application-level check.
- The Razorpay webhook as source of truth, mounted ahead of the parser and limiter (`index.js:123`).
- Idempotent `confirmPayment`, `NotificationLog` unique keys, `JobRun` locks, and the refund claim/attempt counters.
- Public routes outside the session, Mongo-backed limits for the public API, Turnstile and the booking token failing closed.
- Input validation and unknown-field rejection on public routes (`only(...)`), audit logging, and the 351 tests.
- Sessions are destroyed when an account is changed or deactivated (`routes/admin.js:232`, `:275`, `:315`), and `/api/auth/me` re-checks `isActive` (`routes/auth.js:493`).
- `utils/booking.js` splitting between the pure engine (`availability.js`) and the loader (`availabilityLoader.js`).
- Heavy staff-app export libraries already lazy-loaded.

## (c) Overall health

The core of the system is in good shape for a one-salon business: the booking and payment design is careful, it has been written with the real losses in mind (the comments name the ₹3,185.70 loss and the 7 Aug payment), and it has 351 tests. The weaknesses are not in the main path but at its edges: the desk visit routes trust the browser about money, one retry can still double a visit, requests confirmed by hand bypass the lock rules, and a few failure branches (amount mismatch, double refund, a stopped timer) leave money or time hanging without anyone being told. All of these are small to medium fixes, and fixing 1 to 5 would move the risk score to about 8. The bloat is modest and easy to remove, about 1,100 lines and two packages, with the largest cleanup being the dead legacy routes that are also the least safe.

**Verdict:** Healthy core, fix the payment-id check (1), the duplicate-visit race (2) and the unlocked request confirmation (3) first, because they touch money and double bookings.

**Lean:** -1,100 lines, -2 dependencies possible (about 866 staff-app lines, about 200 legacy backend lines, a few dead functions and duplicates).

**Not checked:**
- I did not run the test suite (your notes say booking-engine and public-API tests hang on this disk), the app, `npm audit`, or a production build, so findings are from reading code only.
- Not read or only skimmed: `utils/availability.js` (the slot algorithm itself) and the rest of `availabilityLoader.js`, `utils/counter.js` and `routes/counter*.js`, `routes/management.js`, `routes/admin.js` beyond session handling, `routes/dataFixes.js`, `utils/artistAttribution.js`, `utils/whatsapp.js` and `notify.js`, `utils/posterReader.js`, `routes/website.js` beyond uploads and revalidation, `routes/public.js` request-lite and `publicWaRequest.js`, `utils/booking.js` lines 1-195 and the move/reassign/no-show functions, and most staff-app pages other than the checkout hook.
- Customer bundle size (not measured), accessibility and the customer's mobile behaviour.
- Whether online booking is switched on in production, and what the live Razorpay account settings are (partial refunds, auto-capture).
