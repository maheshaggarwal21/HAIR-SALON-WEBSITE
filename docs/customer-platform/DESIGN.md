# DESIGN.md — The Experts customer website

Status: v1 spec, 13 Oct 2026. Owner of this file: Pursharth (Hardcore Developers).
Scope: everything in `customer/`. The staff app keeps its own look.

---

## 1. Goal and audience

**Business goal:** grow the women's segment and high-value services (colour, keratin,
smoothening, facials, bridal) without losing the strong men's base. The site's first job
is to make a woman in Patiala trust the salon enough to book.

**Primary visitor:** a woman, 22–50, on a mid-range Android phone, often arriving from a
Meta ad inside Instagram's in-app browser, on 4G. Secondary: men booking grooming,
husbands buying gift cards, brides and their families.

**What the site must feel like:** sleek, warm, confident, premium-but-approachable.
Not a dark barbershop. Not a cluttered chain template. Not a generic AI-template look
(no sparkles, beams or typewriter text).

---

## 2. Concept: "Cream and champagne gold"

White pages with cream and sand sections, charcoal type, and one quiet accent: champagne
gold. Editorial serif headlines with one italic gold word. Real photos and short videos of
the salon's own work do the heavy lifting. Light and calm, never black (CF D25).

Why: the owner found the original "ivory, ink and rani" look (brown-black sections, rani
pink) dull and harsh on review. Cream and gold reads premium and suits bridal and festive
work. The original concern still holds: black-and-gold reads as a men's barber, so dark
surfaces stay limited to the footer and the buttons are charcoal, not black.

---

## 3. Design tokens

Define these once in `customer/app/globals.css` under `@theme`. Never hardcode hex in components.

### 3.1 Colour

"Cream & Champagne Gold" (owner's choice of 14 Oct 2026, CF D25). It replaced the
original ivory / ink / rani palette, which the owner found dull and too dark in review.
Token names describe the role, not the hue.

| Token | Hex | Use |
|---|---|---|
| `--color-ivory` | `#FFFFFF` | Default page background; text on the dark footer |
| `--color-ivory-2` | `#F7F1E6` | Cream: hero and alternate section tint, raised panels, input fills |
| `--color-sand` | `#F3EADA` | Sand: campaign strip, "For her" panel, artists and visit sections, selected chips |
| `--color-ink` | `#2B2722` | Charcoal: body text, primary buttons, footer background |
| `--color-ink-2` | `#403A33` | Primary button hover; cards on the footer |
| `--color-ink-muted` | `#6E685F` | Secondary text on white, cream and sand |
| `--color-ivory-muted` | `#CFC6B8` | Secondary text on the footer |
| `--color-gold` | `#B08D57` | Champagne gold: accent italic words in large type, stars, marquee outline, hairlines |
| `--color-gold-deep` | `#8A6A3A` | Gold text at small sizes (links, eyebrows, selected chips), focus ring, selected-card ring |
| `--color-line` | `rgba(43,39,34,0.12)` | Dividers on light surfaces |
| `--color-line-dark` | `rgba(255,255,255,0.14)` | Dividers on the footer |
| `--color-success` | `#2E7D5B` | Confirmations |
| `--color-danger` | `#B3261E` | Errors |

Contrast rules:
- White on `--color-ink` (primary button) ≈ 14:1.
- `--color-gold-deep` on white ≈ 5:1 → OK for small text.
- `--color-gold` on white ≈ 3.2:1 → only for text ≥ 24px (the italic accent word) and decoration.
- `--color-ink-muted` on cream ≈ 4.9:1. Body text is always charcoal on a light surface, or white on the footer.

Section rhythm on the landing page: cream → sand → white → cream → white → sand → … →
charcoal footer. No black sections; the footer is the only dark surface. Never two sections
of the same tint back to back. Never more than one charcoal-filled button per viewport.

### 3.2 Typography

| Role | Font | Size (mobile → desktop) | Weight | Notes |
|---|---|---|---|---|
| Display XL (hero) | Instrument Serif | 44 → 96px | 400 | line-height 1.0, letter-spacing -0.02em |
| Display L (section titles) | Instrument Serif | 34 → 64px | 400 | line-height 1.05 |
| Display M (card titles) | Instrument Serif | 24 → 32px | 400 | |
| Eyebrow | Manrope | 12 → 13px | 600 | uppercase, letter-spacing 0.18em, the only uppercase allowed |
| Body L | Manrope | 17 → 19px | 400 | line-height 1.6 |
| Body | Manrope | 15 → 16px | 400 | line-height 1.6 |
| UI / buttons | Manrope | 15px | 600 | |
| Small / meta | Manrope | 13px | 500 | |
| Prices, times | Manrope | as context | 600 | `font-variant-numeric: tabular-nums` |

Load both from Google Fonts via `next/font/google` (self-hosted, `display: swap`, subset latin).

Headline pattern: sentence case, ends with a period, one italic word in gold.
Examples: "Hair that *turns* heads." · "Colour, done *right*." · "Karva Chauth, *sorted*."

### 3.3 Spacing, radius, elevation

- Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96, 128. Section padding: 64 mobile, 128 desktop.
- Content width: 1240px max; text columns 640px max.
- Radius: 10px controls, 18px cards, 28px media cards, full for pills/chips.
- Elevation: no drop shadows on ivory except the booking sheet (`0 24px 60px rgba(23,18,15,0.18)`).
  Depth comes from colour blocks and photography, not shadows.

### 3.4 Iconography and imagery

- Icons: Lucide (already used in the staff app), 1.5px stroke, ink or champagne.
- Photography: real salon work only. Warm white balance, natural light, faces visible
  where consented. No stock photos of models who never visited.
- Video: 9:16 reels for the reels wall, 16:9 or 4:5 loops for the hero. Muted, no captions burned in.
- Before/after pairs must share framing and lighting. Every published photo has `consent: true`.

---

## 4. Motion system

| Name | Spec | Used on |
|---|---|---|
| `rise` | translateY 24→0, opacity 0→1, 600ms, ease `cubic-bezier(.22,1,.36,1)` | Section content on enter |
| `word-rise` | Each word masked, translateY 100%→0, 70ms stagger | Hero and section headlines |
| `card-expand` | Hero video scales from rounded card (radius 28, scale .92) to full-bleed (radius 0, scale 1) as scroll progresses 0→35% | Hero |
| `snap-carousel` | Native CSS scroll-snap; on desktop, arrow buttons scroll one card (CF D26) | Signature services, all devices |
| `marquee` | Infinite horizontal text, 40s per loop, outlined serif | Between sections |
| `peek` | Before/after divider auto-nudges 12% left/right once when 60% visible | Transformations |
| `hover-reel` | Artist card plays a 3s muted clip on hover (tap on mobile) | Artists |
| `count-up` | Numbers count to value over 1.2s when visible | Rating, clients served |
| `cursor` | 10px dot follows pointer; grows to 72px with label "View"/"Play" over media | Desktop only |
| `ripple` | Subtle WebGL displacement on image hover (OGL, < 15KB) | Desktop only, optional, last |
| `sheet` | Booking sheet slides up (mobile) / in from right (desktop), 320ms spring | Booking |

Rules:
- Native scrolling everywhere. No smooth-scroll library and no pinned sections (CF D26): Lenis
  blocked scrolling inside the booking sheet and on the growing menu page.
- `prefers-reduced-motion: reduce` → no scrubbed/pinned motion, no marquee, no autoplay
  video (show poster), fades only.
- Never animate layout properties. Only transform and opacity.
- No animation may delay a primary CTA becoming tappable by more than 600ms.
- Libraries: `motion` (Framer Motion), `gsap` + `ScrollTrigger`, `lenis`. Nothing else for motion.
- No Three.js or real-time 3D. Depth comes from layered parallax and video.

---

## 5. Components

| Component | Notes |
|---|---|
| `Button` | Variants: `primary` (charcoal fill, white text), `secondary` (charcoal outline on light, white outline over photos), `ghost`, `whatsapp` (outline with WhatsApp icon). Height 48px mobile, 52px desktop. |
| `Chip` | Pill, 36px, selectable. Selected = sand fill + gold-deep text. |
| `ServiceCard` photo | Optional 3:2 photo on top (`object-fit: cover`), card radius, lazy, `srcset` 640/1200; price pinned to the bottom so rows stay even (CF D30). |
| `PriceTag` | "₹500" or "from ₹500". Optional campaign strike-through only when a campaign is active. Duration shown beside it: "45 min". |
| `ServiceCard` | Name, one-line benefit, price, duration, badges ("Consultation first", "Patch test 48h before"). Tap → service page or adds to booking. |
| `ArtistCard` | Photo (4:5), name, level, top 2 specialties, Instagram handle, "Book with {name}". Hover reel on desktop. |
| `BeforeAfter` | Draggable divider, keyboard accessible (arrow keys), labels "Before"/"After". |
| `ReelTile` | 9:16 video, poster, plays only while ≥ 60% visible, one at a time on mobile. Tap → lightbox with sound + "Book this look". |
| `RatingBadge` | "4.5 ★ · 25 Google reviews". Pulls from backend, never hardcoded. |
| `CampaignBar` | `OfferBar`: thin top bar on every page, owner-controlled dates and theme, shows the real end date (CF D29). |
| `Popup` | `OfferPopup`: owner-controlled poster card. Max one per session (or per day). Close button 44px. Never blocks the first 5 seconds. Not on the offer's own page or over the request sheet. |
| `StickyMobileBar` | Bottom bar on mobile: Book · WhatsApp · Directions. Hidden while the booking sheet is open. |
| `BookingSheet` | See §7. |
| `Stepper` | Services › Professional › Time › Details › Confirm. Current step in ink, done in gold-deep. |
| `SummaryPanel` | Sticky right panel (desktop) / collapsible bottom bar (mobile): selected services, artist, time, running total and duration. |
| `SlotGrid` | Grouped Morning / Afternoon / Evening. 44px tap targets. Disabled slots hidden, not greyed. |
| `OtpInput` | 6 boxes, autofill from SMS/WhatsApp where possible, resend after 30s. |

---

## 6. Pages

### 6.1 Home `/`
1. **Hero** (cream): full-bleed muted loop of the salon's own work (`card-expand`), headline
   with `word-rise`, sub-line, primary "Book now", secondary "WhatsApp us", `RatingBadge`.
2. **Offer bar** (site-wide, CF D29): sits above the header on every page while an offer runs,
   in the offer's own colour theme (outside the cream palette) with a soft blinking label.
3. **For her / For him** (white, sand and cream panels; full-bleed salon photo with a cream fade behind the text, CF D30): two large image panels. Her first. Each leads to the
   filtered menu and the booking sheet with that audience preselected.
4. **Signature services** (cream): snap carousel on every device, arrow buttons on desktop.
   6–8 services the owner marks `featured`. Prices shown.
5. **Transformations** (white): 3–6 `BeforeAfter` pairs (colour, keratin, smoothening, bridal).
6. **Artists** (sand): `ArtistCard` grid, sorted by owner. "Book with …" deep-links.
7. **Marquee** (white, thin, gold outline): "Colour · Keratin · Bridal · Grooming · Facials ·"
8. **Reels wall** (cream): 6–9 `ReelTile`s from the synced Instagram feed + "Follow" link.
9. **Packages and gift cards** (white): active packages and gift-card CTA.
10. **Reviews** (cream): stats row that counts up (rating ★ · clients served + · Google reviews +,
    real figures only, CF D28), then review cards drifting
    slowly sideways (`review-marquee`, pauses on hover; static row with reduced motion), with
    attribution and a "Read all on Google" link (CF D27).
11. **Visit us** (sand): map, address described as "Green Park Colony, Sirhind–Patiala Rd",
    hours, parking note, photos of the ladies' area.
12. **FAQ** (white): hygiene, products used, consultations, patch tests, deposits,
    cancellation policy, walk-ins.
13. **Footer** (charcoal), the only dark surface.

### 6.2 Other routes
| Route | Content |
|---|---|
| `/services` | Full public menu. Tabs: For her / For him. Category chips, search. |
| `/services/[slug]` | Service detail: what it is, duration, price/options, who does it, before/after, FAQ, "Book this". SEO page ("keratin treatment in Patiala"). |
| `/artists/[slug]` | Profile, specialties, portfolio, reels, "Book with …" |
| `/bridal` | Bridal and family packages, portfolio, "Request a consultation". |
| `/offers/[campaign]` | Ad landing pages. One per campaign. Fast, single CTA. |
| `/gift-cards` | Buy a gift card (Phase 1.5). |
| `/book` | Full-page fallback of the booking sheet (deep-linkable). |
| `/booking/[token]` | Manage booking: view, add to calendar, directions, reschedule, cancel. |
| `/privacy`, `/terms`, `/cancellation-policy` | Legal. |

SEO: `generateMetadata` per page, `HairSalon` + `LocalBusiness` JSON-LD on home and
visit section, `Service` JSON-LD on service pages, sitemap.xml, robots.txt.

---

## 7. Booking UI

The booking sheet opens over the current page. URL reflects state so ads and links can
pre-fill it: `/book?for=her&service=keratin-medium&artist=mansi&promo=KC26`.

| Step | UI | Rules shown to the customer |
|---|---|---|
| 0. Who | Three cards: Just me · Me and others (up to 4) · Gift card | Group = same time, different artists |
| 1. Services | For her / For him toggle per guest, chips, search, `ServiceCard`s, option sheet (hair length, add-ons) | Badges for consultation and patch test; running total |
| 2. Professional | "Any available (most slots)" first, then eligible artists only. Optional "female artist" filter for waxing/threading | Artists who can't do every selected service are not shown |
| 3. Time | Date strip (next 30 days), `SlotGrid` | Only real availability. "2 left" only if true |
| 4. Details | Phone → OTP, name, optional email, notes. Returning customers auto-filled. Policy checkbox (required). WhatsApp offers opt-in (optional, unticked) | Deposit and cancellation rule spelled out before paying |
| 5. Deposit | Razorpay checkout, 10-min hold timer visible | Only when the rule requires it |
| Done | Booking ref, summary, add to calendar, directions, "We've sent this to WhatsApp", manage link | |

Request bookings (chemical, bridal, consultation) say "Request sent — the salon will
confirm on WhatsApp within 2 working hours" instead of "Confirmed".

Error copy (examples): "That slot was just taken. Here are the nearest times." ·
"That code didn't match. Try again or resend." · "Payment didn't go through. Your slot is
held for 6 more minutes."

---

## 8. Copy voice

Short, confident, warm. Sentence case. No exclamation marks in UI. No "please". English
primary; festive campaigns may add one Punjabi/Hindi line (e.g. "Tyaar ho jao."),
never as body copy.

---

## 9. Performance budget (hard requirements)

Measured on Moto G-class profile, 4G, Instagram in-app browser where possible:

| Metric | Budget |
|---|---|
| LCP | ≤ 2.5s |
| CLS | ≤ 0.05 |
| INP | ≤ 200ms |
| JS on landing (gzip) | ≤ 200KB |
| Hero video | ≤ 1.5MB, 720p, H.264 MP4 + WebM, poster preloaded |
| Images | AVIF/WebP via `next/image`, explicit sizes |
| Fonts | 2 families, self-hosted, ≤ 4 files |

Videos below the fold load only when near the viewport. Reels never autoplay more than one at a time on mobile.

---

## 10. Accessibility

- WCAG 2.1 AA. Tap targets ≥ 44px. Visible focus ring (2px gold-deep, 2px offset).
- All motion respects `prefers-reduced-motion`.
- Before/after slider and slot grid are keyboard operable.
- Videos are decorative (muted); any spoken content gets captions.
- Form errors announced via `aria-live`.

---

## 11. What we took from the references

| Reference | Taken | Avoided |
|---|---|---|
| Spoke & Weal | Italic serif headlines with a period, pill chips, team by level with prices and IG handles | Muted dark everywhere |
| Atelier (Boulevard) | Just me / Group / Gift card entry, returning-client recognition, message-consent line | Same price for every stylist, generic header art |
| Code Salon | Stepper, sticky summary with running total, options that change price and time, per-artist price and rating, routing notes, "Any professional" | — |
| Glamourra | Video hero, rating badge, numbered menu cards, before/after, membership wallet, IG grid, sticky mobile bar | Broken text, placeholder copy, many autoplaying videos, duplicate tiers |
| Tweak | Weekday "Happy Hour" off-peak offer idea, 24h cancellation policy | Popup-form "booking", third-party redirect |
| YLG | FAQ on hygiene and bridal, WhatsApp float | Chain-template clutter |

Remove from the current staff-app landing page when the customer site launches:
typewriter text, `background-beams`, `sparkles`, staff login CTA on the public home.
