/**
 * Shapes returned by the salon API's public routes (backend/routes/public.js,
 * backend/utils/publicCatalogue.js). Keep in step with those files — they are
 * the only fields the API will ever send.
 */

export type Audience = "her" | "him" | "unisex";
export type WindowKey = "morning" | "afternoon" | "evening";
export type BookingMode = "instant" | "request" | "walkin_only" | "hidden";

export interface ServiceOption {
  id: string;
  slug: string | null;
  label: string | null;
  price: number;
  /** While an offer runs (D59): the normal price, shown crossed out, and the offer's last day (IST). */
  regularPrice: number | null;
  offerEndsOn: string | null;
  /** Only set when the owner has confirmed the time (D14). */
  durationMinutes: number | null;
  bookingMode: BookingMode;
}

export interface ServiceCard {
  slug: string;
  name: string;
  displayCategory: string | null;
  audience: Audience | null;
  shortDescription: string | null;
  images: string[];
  featured: boolean;
  sortOrder: number;
  requiresConsultation: boolean;
  requiresPatchTest: boolean;
  fromPrice: number;
  /** The cheapest option's normal price and the offer's last day, only while it is on offer (D59). */
  fromRegularPrice: number | null;
  offerEndsOn: string | null;
  /** "many": options can be combined in a request (threading areas); "one": alternatives (D34). */
  pick?: "one" | "many";
  options: ServiceOption[];
  /** Detail responses only (GET /services/:slug). */
  description?: string | null;
  seo?: { title: string | null; description: string | null };
}

export interface PublicArtist {
  id: string;
  slug: string | null;
  name: string;
  level: "senior" | "stylist" | "junior" | null;
  gender: "female" | "male" | "other" | null;
  bio: string | null;
  specialties: string[];
  photo: string | null;
  portfolio: string[];
  instagram: string | null;
  sortOrder: number;
  onlineBookable: boolean;
}

export interface PublicPackage {
  slug: string;
  name: string;
  description: string | null;
  audience: Audience | null;
  image: string | null;
  price: number;
  /** IST dates, or null when the offer has no fixed dates. */
  validFrom: string | null;
  validTo: string | null;
  items: { id: string; name: string; price: number }[];
}

export interface Interval {
  open: string;
  close: string;
}

export interface RequestWindow {
  label: string;
  start: string;
  end: string;
}

export interface SiteInfo {
  timezone: string;
  openingHours: Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", Interval[]>;
  holidays: string[];
  specialHours: { date: string; open?: string; close?: string }[];
  requestWindows: Record<WindowKey, RequestWindow>;
  horizonDays: number;
  requestSlaMinutes: number;
  policyVersion: string;
  contact: {
    phone: string | null;
    whatsapp: string | null;
    address: string | null;
    mapUrl: string | null;
    mapEmbedUrl: string | null;
    instagram: string | null;
    parkingNote: string | null;
  };
  media: {
    heroVideoUrl: string | null;
    heroPosterUrl: string | null;
    forHerImage: string | null;
    forHimImage: string | null;
    salonImages: string[];
    /** "See us in action" gallery (CF D33), in order; [] hides the section. */
    gallery: { url: string; caption: string | null }[];
    /** Hero slider, in order (CF D31). Falls back to the single hero video server-side. */
    heroSlides: {
      kind: "video" | "image";
      url: string;
      poster: string | null;
      alt: string | null;
      /** Optional landscape version for wide screens (phones use `url`). */
      wideUrl: string | null;
      widePoster: string | null;
    }[];
  };
  /** Only pairs with the client's recorded consent reach the API. */
  transformations: { id: string; before: string; after: string; caption: string | null }[];
  /** Google rating: live from the Places feed, else as the owner copied it from Google (CF D27). Null until known. */
  rating: { value: number; count: number; mapsUri: string | null; source: "Google" } | null;
  /** "Meet the owner" on the home page (CF D32); null when the owner hid it. */
  owner?: { name: string; title: string; bio: string; photo: string | null } | null;
  /** Counted from paid visits and already rounded down by the server (CF D28). Null below 100. */
  stats?: { clientsServed: number | null };
  /**
   * Phase 2 live booking (T2.22). `enabled` only when at least one artist is
   * switched on and payments + WhatsApp codes work; otherwise the site uses
   * the request form.
   */
  onlineBooking?: {
    enabled: boolean;
    maxGuests: number;
    holdMinutes: number;
    cancellationFeePercent: number;
    cancellationFeeMin: number;
    noticeHours: number;
    razorpayKeyId: string | null;
  };
}

// ── Phase 2: live booking (backend/routes/publicBooking.js) ──────────────────

export interface Slot {
  startAt: string;
  endAt: string;
  /** "16:30", salon time. */
  time: string;
  period: "morning" | "afternoon" | "evening";
  /** How many different artists could take it, capped at 3 — the honest "N left". */
  remaining: number;
  guests: { key: string; items: { serviceId: string; name: string; artistName: string; startAt: string; endAt: string }[] }[];
}

export interface Quote {
  lines: { guestKey: string; serviceId: string; name: string; price: number; regularPrice: number | null; durationMinutes: number | null; inPackage: boolean }[];
  subtotal: number;
  discount: number;
  total: number;
  mode: "instant" | "request";
  payment: { options: { kind: "full" | "deposit"; amount: number; label: string }[]; cancellationFee: number; noticeHours: number; note: string };
}

export interface PublicBooking {
  ref: string;
  status: "pending_payment" | "requested" | "confirmed" | "checked_in" | "completed" | "cancelled" | "declined" | "expired" | "no_show";
  mode: "instant" | "request";
  startAt: string | null;
  endAt: string | null;
  holdExpiresAt: string | null;
  guests: { key: string; name: string | null; items: { name: string; price: number; artistName: string | null; startAt: string | null; endAt: string | null }[] }[];
  pricing: { subtotal: number; discount: number; total: number };
  payment: { kind: "full" | "deposit"; amount: number; status: string };
}

export interface ManageView {
  booking: PublicBooking;
  rules: {
    canCancel: boolean;
    canReschedule: boolean;
    rescheduleBefore: string | null;
    reschedulesLeft: number;
    cancel: { refund: number; kept: number };
    needsOtp: boolean;
  };
  refund: { amount: number; status: string } | null;
  phoneHint: string;
  salon: { phone: string | null; whatsapp: string | null; mapUrl: string | null; address: string | null; openingHours: SiteInfo["openingHours"]; holidays: string[] };
}

/** An offer's own landing page (D62): /offers/now and /offers/<slug>. */
export interface OfferPageData {
  slug: string;
  /** live = inside its dates today; scheduled = not started; ended = past its last day (India time). */
  state: "live" | "scheduled" | "ended";
  theme: "festive" | "rose" | "emerald" | "midnight";
  eyebrow: string | null;
  headline: string;
  offerText: string | null;
  /** Whole rupees, shown only. Never applied to a booking. */
  price: number | null;
  priceNote: string | null;
  image: string | null;
  /** Up to 5 pictures or posters for the slideshow, in the owner's order (D63). */
  images: string[];
  reel: { mediaType: "video" | "image"; mediaUrl: string; thumbnailUrl: string | null } | null;
  startDate: string;
  endDate: string;
  /** What the booking form on the page books. */
  services: { id: string; name: string }[];
}

export interface PublicReel {
  id: string;
  mediaType: "video" | "image";
  mediaUrl: string;
  thumbnailUrl: string | null;
  permalink: string | null;
  caption: string | null;
  service: { slug: string; name: string; optionId: string } | null;
}

export interface PublicReviews {
  rating: number | null;
  count: number | null;
  mapsUri?: string | null;
  attribution: string | null;
  /** True when these are reviews the owner selected (CF D27), not Google's live feed. */
  curated?: boolean;
  reviews: {
    author: string | null;
    authorUri: string | null;
    profilePhoto: string | null;
    rating: number;
    text: string;
    relativeTime: string | null;
    /** Services Google lists under the review, when the owner copied them. */
    service?: string | null;
  }[];
}

export interface RequestResult {
  ref: string;
  status: "requested";
  requestedWindow: { date: string; window: WindowKey };
  items: { name: string; price: number }[];
  packageName: string | null;
  total: number;
  slaMinutes: number;
}

export interface ApiError {
  error: string;
  message?: string;
  fields?: string[];
}

/** A website offer (CF D29): top bar + optional pop-up, between two IST dates (inclusive). */
export interface PublicCampaign {
  id: string;
  startDate: string;
  endDate: string;
  theme: "festive" | "rose" | "emerald" | "midnight";
  showBar: boolean;
  showPopup: boolean;
  content: {
    eyebrow: string | null;
    headline: string;
    body: string | null;
    image: string | null;
    ctaLabel: string;
    ctaHref: string;
  };
  popup: { delaySeconds: number; frequency: "session" | "day" };
}
