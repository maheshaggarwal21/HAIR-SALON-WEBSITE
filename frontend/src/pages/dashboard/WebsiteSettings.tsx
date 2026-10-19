/**
 * @file WebsiteSettings.tsx
 * @description What the customer website shows about the salon: contact
 * details, opening hours and closed days (T1.5). Permission: website.manage.
 *
 * Contact fields start empty on purpose. The website hides the WhatsApp, call
 * and directions buttons until they're filled in here — a wrong number on a
 * public page is worse than a missing button.
 *
 * Opening hours and closed days decide which days customers can pick on the
 * request form. Hours are Patiala time (IST).
 *
 * Artists: every ACTIVE artist appears on the website automatically, so
 * customers can name one on a request (owner, K6). The switch here hides one;
 * deactivating an artist in the Artist Directory removes them too. Saved on
 * each tap, separately from the Save button below.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, Eye, EyeOff, Globe, Loader2, Plus, Save, Star, Trash2, X } from "lucide-react";
import MediaInput from "@/components/website/MediaInput";

const API = import.meta.env.VITE_BACKEND_URL || "";

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;
type Day = (typeof DAYS)[number][0];

interface Interval {
  open: string;
  close: string;
}

/** One hero slider slide (CF D31). */
interface HeroSlide {
  kind: "video" | "image";
  url: string;
  poster: string | null;
  alt: string | null;
  /** Optional landscape (16:9) version shown on computers; phones use `url`. */
  wideUrl: string | null;
  widePoster: string | null;
}

const isVideoUrl = (u: string) => /\.(mp4|webm|mov)(\?|#|$)/i.test(u);

interface Transformation {
  before: string;
  after: string;
  caption: string | null;
  consent: boolean;
}

/** One review copied from the salon's Google page (CF D27). */
interface FeaturedReview {
  author: string;
  rating: number;
  text: string;
  service: string | null;
  visible: boolean;
}

interface Settings {
  contact: {
    phone: string | null;
    whatsapp: string | null;
    address: string | null;
    mapUrl: string | null;
    mapEmbedUrl: string | null;
    instagram: string | null;
    parkingNote: string | null;
  };
  openingHours: Record<Day, Interval[]>;
  holidays: string[];
  media: {
    heroVideoUrl: string | null;
    heroPosterUrl: string | null;
    forHerImage: string | null;
    forHimImage: string | null;
    salonImages: string[];
    heroSlides: HeroSlide[];
    /** "See us in action" carousel (CF D33). */
    gallery: { url: string; caption: string | null }[];
  };
  transformations: Transformation[];
  /** Kept as text while typing; converted to numbers on save. */
  reviews: { rating: string; count: string; url: string; featured: FeaturedReview[] };
  /** "Meet the owner" on the home page (CF D32). */
  owner: { name: string; title: string; bio: string; photo: string | null; visible: boolean };
}

const inputClass =
  "w-full h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 placeholder:text-stone-400";
const labelClass = "block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider";

export default function WebsiteSettings() {
  const [form, setForm] = useState<Settings | null>(null);
  const [newHoliday, setNewHoliday] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** E23: bookings on a newly added holiday, shown before it is saved. */
  const [holidayConflicts, setHolidayConflicts] = useState<{ ref: string; name: string; contact: string; date: string }[] | null>(null);

  useEffect(() => {
    fetch(`${API}/api/website/settings`, { credentials: "include" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed to load");
        setForm({
          contact: {
            phone: d.contact?.phone ?? "",
            whatsapp: d.contact?.whatsapp ?? "",
            address: d.contact?.address ?? "",
            mapUrl: d.contact?.mapUrl ?? "",
            mapEmbedUrl: d.contact?.mapEmbedUrl ?? "",
            instagram: d.contact?.instagram ?? "",
            parkingNote: d.contact?.parkingNote ?? "",
          },
          openingHours: Object.fromEntries(DAYS.map(([k]) => [k, d.openingHours?.[k] ?? []])) as Record<Day, Interval[]>,
          holidays: d.holidays ?? [],
          media: {
            heroVideoUrl: d.media?.heroVideoUrl ?? null,
            heroPosterUrl: d.media?.heroPosterUrl ?? null,
            forHerImage: d.media?.forHerImage ?? null,
            forHimImage: d.media?.forHimImage ?? null,
            salonImages: d.media?.salonImages ?? [],
            gallery: (d.media?.gallery ?? []).map((g: { url: string; caption: string | null }) => ({ url: g.url, caption: g.caption ?? null })),
            heroSlides: (d.media?.heroSlides ?? []).map((x: HeroSlide) => ({
              kind: x.kind,
              url: x.url,
              poster: x.poster ?? null,
              alt: x.alt ?? null,
              wideUrl: x.wideUrl ?? null,
              widePoster: x.widePoster ?? null,
            })),
          },
          transformations: (d.transformations ?? []).map((t: Transformation) => ({
            before: t.before,
            after: t.after,
            caption: t.caption ?? null,
            consent: Boolean(t.consent),
          })),
          owner: {
            name: d.owner?.name ?? "",
            title: d.owner?.title ?? "",
            bio: d.owner?.bio ?? "",
            photo: d.owner?.photo ?? null,
            visible: d.owner?.visible !== false,
          },
          reviews: {
            rating: d.reviews?.rating != null ? String(d.reviews.rating) : "",
            count: d.reviews?.count != null ? String(d.reviews.count) : "",
            url: d.reviews?.url ?? "",
            featured: (d.reviews?.featured ?? []).map((r: FeaturedReview) => ({
              author: r.author,
              rating: r.rating,
              text: r.text,
              service: r.service ?? null,
              visible: r.visible !== false,
            })),
          },
        });
      })
      .catch((e) => setMessage({ ok: false, text: e.message }));
  }, []);

  if (!form) {
    return (
      <div className="flex justify-center py-16">
        {message ? <p className="text-sm text-red-600">{message.text}</p> : <Loader2 className="w-6 h-6 animate-spin text-stone-400" />}
      </div>
    );
  }

  const setContact = (k: keyof Settings["contact"], v: string) => setForm({ ...form, contact: { ...form.contact, [k]: v } });
  const setDay = (d: Day, list: Interval[]) => setForm({ ...form, openingHours: { ...form.openingHours, [d]: list } });
  const setMedia = (k: keyof Settings["media"], v: string | null | string[] | HeroSlide[] | Settings["media"]["gallery"]) =>
    setForm({ ...form, media: { ...form.media, [k]: v } });
  const gallery = form.media.gallery;
  const setGallery = (i: number, patch: Partial<Settings["media"]["gallery"][number]>) =>
    setMedia("gallery", gallery.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const moveGallery = (i: number, d: -1 | 1) => {
    const next = [...gallery];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setMedia("gallery", next);
  };
  const slides = form.media.heroSlides;
  const setSlide = (i: number, patch: Partial<HeroSlide>) => setMedia("heroSlides", slides.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const moveSlide = (i: number, d: -1 | 1) => {
    const next = [...slides];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setMedia("heroSlides", next);
  };
  const setPair = (i: number, patch: Partial<Transformation>) =>
    setForm({ ...form, transformations: form.transformations.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const setReviews = (patch: Partial<Settings["reviews"]>) => setForm({ ...form, reviews: { ...form.reviews, ...patch } });
  const setOwner = (patch: Partial<Settings["owner"]>) => setForm({ ...form, owner: { ...form.owner, ...patch } });
  const setReview = (i: number, patch: Partial<FeaturedReview>) =>
    setReviews({ featured: form.reviews.featured.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  async function save(forceHolidays = false) {
    if (!form) return;
    setSaving(true);
    setMessage(null);
    setHolidayConflicts(null);
    try {
      const res = await fetch(`${API}/api/website/settings`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // Half-filled before/after pairs and reviews aren't sent; they'd be refused anyway.
        body: JSON.stringify({
          ...form,
          forceHolidays,
          transformations: form.transformations.filter((t) => t.before && t.after),
          media: { ...form.media, heroSlides: form.media.heroSlides.filter((x) => x.url), gallery: form.media.gallery.filter((g) => g.url) },
          reviews: {
            rating: form.reviews.rating.trim() ? Number(form.reviews.rating) : null,
            count: form.reviews.count.trim() ? Number(form.reviews.count) : null,
            url: form.reviews.url.trim() || null,
            featured: form.reviews.featured.filter((r) => r.author.trim() && r.text.trim()),
          },
          owner: {
            name: form.owner.name.trim() || null,
            title: form.owner.title.trim() || null,
            bio: form.owner.bio.trim() || null,
            photo: form.owner.photo,
            visible: form.owner.visible,
          },
        }),
      });
      const d = await res.json();
      if (res.status === 409 && Array.isArray(d.conflicts)) setHolidayConflicts(d.conflicts);
      if (!res.ok) throw new Error(d.error || "Failed to save");
      setMessage({ ok: true, text: "Saved. The website picks this up within a few minutes." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="max-w-3xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <Globe className="w-6 h-6 text-amber-500" /> Website Settings
        </h2>
        <p className="text-sm text-stone-500 mt-0.5">Contact details and opening hours shown on the customer website.</p>
      </div>

      {/* Contact */}
      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5">
        <h3 className="font-semibold text-stone-900 mb-1">Contact</h3>
        <p className="text-xs text-stone-500 mb-4">Leave a field empty to hide that button on the website.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>WhatsApp number</label>
            <input
              value={form.contact.whatsapp ?? ""}
              onChange={(e) => setContact("whatsapp", e.target.value.replace(/\D/g, "").slice(0, 10))}
              inputMode="numeric"
              placeholder="10 digits, no +91"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Phone number</label>
            <input
              value={form.contact.phone ?? ""}
              onChange={(e) => setContact("phone", e.target.value.replace(/\D/g, "").slice(0, 10))}
              inputMode="numeric"
              placeholder="10 digits, no +91"
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>Address</label>
            <input value={form.contact.address ?? ""} onChange={(e) => setContact("address", e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Google Maps link</label>
            <input
              value={form.contact.mapUrl ?? ""}
              onChange={(e) => setContact("mapUrl", e.target.value.trim())}
              placeholder="https://maps.app.goo.gl/…"
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>Map on the website (Google Maps → Share → Embed a map → copy HTML)</label>
            <input
              value={form.contact.mapEmbedUrl ?? ""}
              onChange={(e) => setContact("mapEmbedUrl", e.target.value.trim())}
              placeholder="Paste the <iframe …> code here. Empty = no map"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Instagram</label>
            <input
              value={form.contact.instagram ?? ""}
              onChange={(e) => setContact("instagram", e.target.value.replace(/^@/, "").trim())}
              placeholder="handle, without @"
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Hours */}
      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5">
        <h3 className="font-semibold text-stone-900 mb-4">Opening hours (IST)</h3>
        <div className="space-y-2">
          {DAYS.map(([key, label]) => {
            const list = form.openingHours[key];
            const open = list.length > 0;
            return (
              <div key={key} className="flex flex-wrap items-center gap-3">
                <span className="w-28 text-sm text-stone-700">{label}</span>
                <label className="flex items-center gap-2 text-sm text-stone-600">
                  <input
                    type="checkbox"
                    checked={open}
                    onChange={(e) => setDay(key, e.target.checked ? [{ open: "09:00", close: "20:00" }] : [])}
                  />
                  Open
                </label>
                {open && (
                  <>
                    <input
                      type="time"
                      value={list[0].open}
                      onChange={(e) => setDay(key, [{ ...list[0], open: e.target.value }])}
                      className="h-9 px-2 rounded-lg border border-stone-200 bg-stone-50 text-sm"
                    />
                    <span className="text-stone-400">to</span>
                    <input
                      type="time"
                      value={list[0].close}
                      onChange={(e) => setDay(key, [{ ...list[0], close: e.target.value }])}
                      className="h-9 px-2 rounded-lg border border-stone-200 bg-stone-50 text-sm"
                    />
                  </>
                )}
                {!open && <span className="text-sm text-stone-400">Closed</span>}
              </div>
            );
          })}
        </div>
      </section>

      <ArtistsOnWebsite />

      {/* Photos and video */}
      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5 space-y-4">
        <div>
          <h3 className="font-semibold text-stone-900 mb-1">Photos and video</h3>
          <p className="text-xs text-stone-500">Real photos of the salon&apos;s own work only. Anything left empty is simply not shown on the website.</p>
        </div>
        {/* Home page slider (CF D31) */}
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1 uppercase tracking-wider">Home page slider</label>
          <p className="text-xs text-stone-500 mb-3">
            Plays in this order as the background behind the headline: each video to its end, each photo for 5 seconds, then the
            next. Visitors can also step through. Everything fills the background and is cropped to fit, never stretched.
            <strong>Landscape (16:9, 1920×1080)</strong> looks sharpest on computers; vertical reels look best on phones. Videos: under
            30 s, MP4, under about 6 MB (upload the original, not a re-shared copy); they play without sound.
          </p>
          <div className="space-y-3">
            {slides.map((sl, i) => (
              <div key={i} className="rounded-lg border border-stone-200 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-stone-500 w-16">
                    {i + 1}. {sl.kind === "video" ? "Video" : "Photo"}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button disabled={i === 0} onClick={() => moveSlide(i, -1)} aria-label="Move up" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 disabled:opacity-30">
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button disabled={i === slides.length - 1} onClick={() => moveSlide(i, 1)} aria-label="Move down" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 disabled:opacity-30">
                      <ArrowDown className="w-4 h-4" />
                    </button>
                    <button onClick={() => setMedia("heroSlides", slides.filter((_, j) => j !== i))} aria-label="Remove slide" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <MediaInput
                  label="Video or photo"
                  kind="any"
                  folder="hero"
                  value={sl.url || null}
                  onChange={(u) => setSlide(i, { url: u ?? "", kind: u && isVideoUrl(u) ? "video" : "image" })}
                />
                {sl.kind === "video" && (
                  <>
                    <MediaInput label="Cover photo (first frame)" folder="hero" value={sl.poster} onChange={(u) => setSlide(i, { poster: u })} hint="Shown while the video loads, and to visitors who turn motion off." />
                    <MediaInput
                      label="Wide version for computers (optional)"
                      kind="video"
                      folder="hero"
                      value={sl.wideUrl}
                      onChange={(u) => setSlide(i, { wideUrl: u })}
                      hint="A landscape (16:9) cut of the same video fills the whole background on computers. Without it, computers show the full upright video on the right over a soft blurred copy."
                    />
                    {sl.wideUrl && (
                      <MediaInput label="Cover photo for the wide version" folder="hero" value={sl.widePoster} onChange={(u) => setSlide(i, { widePoster: u })} />
                    )}
                  </>
                )}
                <input
                  value={sl.alt ?? ""}
                  maxLength={120}
                  onChange={(e) => setSlide(i, { alt: e.target.value || null })}
                  placeholder="What it shows, e.g. Beard trim and moustache styling"
                  className="w-full h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
                />
              </div>
            ))}
            {slides.length < 10 && (
              <button
                onClick={() => setMedia("heroSlides", [...slides, { kind: "video", url: "", poster: null, alt: null, wideUrl: null, widePoster: null }])}
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50"
              >
                <Plus className="w-4 h-4" /> Add a slide
              </button>
            )}
          </div>
        </div>
        {/* Salon gallery (CF D33) */}
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1 uppercase tracking-wider">Salon gallery (“See us in action”)</label>
          <p className="text-xs text-stone-500 mb-3">Real photos of the salon and your work, with a short caption. Landscape photos look best. Up to 12.</p>
          <div className="space-y-3">
            {gallery.map((g, i) => (
              <div key={i} className="rounded-lg border border-stone-200 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-stone-500">Photo {i + 1}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <button disabled={i === 0} onClick={() => moveGallery(i, -1)} aria-label="Move up" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 disabled:opacity-30">
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button disabled={i === gallery.length - 1} onClick={() => moveGallery(i, 1)} aria-label="Move down" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 disabled:opacity-30">
                      <ArrowDown className="w-4 h-4" />
                    </button>
                    <button onClick={() => setMedia("gallery", gallery.filter((_, j) => j !== i))} aria-label="Remove photo" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <MediaInput label="Photo" folder="gallery" value={g.url || null} onChange={(u) => setGallery(i, { url: u ?? "" })} />
                <input
                  value={g.caption ?? ""}
                  maxLength={80}
                  onChange={(e) => setGallery(i, { caption: e.target.value || null })}
                  placeholder="Caption, e.g. Bridal makeup room"
                  className="w-full h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
                />
              </div>
            ))}
            {gallery.length < 12 && (
              <button
                onClick={() => setMedia("gallery", [...gallery, { url: "", caption: null }])}
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50"
              >
                <Plus className="w-4 h-4" /> Add a gallery photo
              </button>
            )}
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <MediaInput label="“For her” photo" folder="panels" value={form.media.forHerImage} onChange={(u) => setMedia("forHerImage", u)} />
          <MediaInput label="“For him” photo" folder="panels" value={form.media.forHimImage} onChange={(u) => setMedia("forHimImage", u)} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">Salon photos (Visit us)</label>
          <div className="space-y-2">
            {form.media.salonImages.map((src, i) => (
              <MediaInput
                key={i}
                label={`Photo ${i + 1}`}
                folder="salon"
                value={src}
                onChange={(u) =>
                  setMedia(
                    "salonImages",
                    u ? form.media.salonImages.map((x, j) => (j === i ? u : x)) : form.media.salonImages.filter((_, j) => j !== i)
                  )
                }
              />
            ))}
            {form.media.salonImages.length < 4 && (
              <MediaInput label="Add a salon photo" folder="salon" value={null} onChange={(u) => u && setMedia("salonImages", [...form.media.salonImages, u])} />
            )}
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">Parking or directions note</label>
          <input
            value={form.contact.parkingNote ?? ""}
            maxLength={140}
            onChange={(e) => setContact("parkingNote", e.target.value)}
            placeholder="e.g. Parking in front of the salon"
            className={inputClass}
          />
        </div>
      </section>

      {/* Before / after */}
      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5">
        <h3 className="font-semibold text-stone-900 mb-1">Before and after</h3>
        <p className="text-xs text-stone-500 mb-4">
          Same angle and light in both photos. A pair appears on the website only when you tick that the client agreed to it.
        </p>
        <div className="space-y-4">
          {form.transformations.map((t, i) => (
            <div key={i} className="rounded-lg border border-stone-200 p-3 space-y-2">
              <div className="grid sm:grid-cols-2 gap-3">
                <MediaInput label="Before" folder="transformations" value={t.before || null} onChange={(u) => setPair(i, { before: u ?? "" })} />
                <MediaInput label="After" folder="transformations" value={t.after || null} onChange={(u) => setPair(i, { after: u ?? "" })} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  value={t.caption ?? ""}
                  maxLength={80}
                  onChange={(e) => setPair(i, { caption: e.target.value || null })}
                  placeholder="Caption, e.g. Keratin, long hair"
                  className="flex-1 min-w-48 h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
                />
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  <input type="checkbox" checked={t.consent} onChange={(e) => setPair(i, { consent: e.target.checked })} />
                  Client agreed to be shown
                </label>
                <button
                  onClick={() => setForm({ ...form, transformations: form.transformations.filter((_, j) => j !== i) })}
                  aria-label="Remove pair"
                  className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          {form.transformations.length < 12 && (
            <button
              onClick={() => setForm({ ...form, transformations: [...form.transformations, { before: "", after: "", caption: null, consent: false }] })}
              className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50"
            >
              <Plus className="w-4 h-4" /> Add a before/after pair
            </button>
          )}
        </div>
      </section>

      {/* Meet the owner (CF D32) */}
      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-stone-900">Meet the owner (home page)</h3>
          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={form.owner.visible} onChange={(e) => setOwner({ visible: e.target.checked })} /> Show on the website
          </label>
        </div>
        <p className="text-xs text-stone-500">
          A photo and a few lines about the owner. Keep it true and personal: years of experience, training, what you love doing.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Name</label>
            <input value={form.owner.name} maxLength={60} onChange={(e) => setOwner({ name: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Title</label>
            <input value={form.owner.title} maxLength={80} onChange={(e) => setOwner({ title: e.target.value })} placeholder="Founder & owner, The Experts" className={inputClass} />
          </div>
        </div>
        <MediaInput label="Photo" folder="owner" value={form.owner.photo} onChange={(u) => setOwner({ photo: u })} hint="Upright or square, face clearly visible." />
        <div>
          <label className={labelClass}>About the owner</label>
          <textarea
            value={form.owner.bio}
            maxLength={1200}
            rows={5}
            onChange={(e) => setOwner({ bio: e.target.value })}
            className="w-full px-4 py-2.5 rounded-xl border border-stone-200 bg-stone-50 text-sm"
          />
          <p className="mt-1 text-[11px] text-stone-400">Leave an empty line between paragraphs.</p>
        </div>
      </section>

      {/* Google rating + selected reviews (CF D27) */}
      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5">
        <h3 className="font-semibold text-stone-900 mb-1 flex items-center gap-2">
          <Star className="w-4 h-4 text-amber-500" /> Google rating and reviews
        </h3>
        <p className="text-xs text-stone-500 mb-4">
          Copy these from the salon's Google page. The rating shows on the website only when both the score and the number of
          reviews are filled in. Paste reviews word for word. The website shows only the first name and the first letter of the
          surname.
        </p>
        <div className="grid sm:grid-cols-3 gap-3 mb-5">
          <div>
            <label className={labelClass}>Rating</label>
            <input
              value={form.reviews.rating}
              onChange={(e) => setReviews({ rating: e.target.value.replace(/[^\d.]/g, "").slice(0, 3) })}
              inputMode="decimal"
              placeholder="e.g. 4.8"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Number of reviews</label>
            <input
              value={form.reviews.count}
              onChange={(e) => setReviews({ count: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              inputMode="numeric"
              placeholder="e.g. 126"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Google reviews link</label>
            <input
              value={form.reviews.url}
              onChange={(e) => setReviews({ url: e.target.value })}
              placeholder="https://maps.app.goo.gl/…"
              className={inputClass}
            />
          </div>
        </div>
        <div className="space-y-4">
          {form.reviews.featured.map((r, i) => (
            <div key={i} className={`rounded-lg border border-stone-200 p-3 space-y-2 ${r.visible ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  value={r.author}
                  maxLength={60}
                  onChange={(e) => setReview(i, { author: e.target.value })}
                  placeholder="Reviewer's name as on Google"
                  className="flex-1 min-w-40 h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
                />
                <div className="flex" role="radiogroup" aria-label="Stars">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      role="radio"
                      aria-checked={r.rating === n}
                      aria-label={`${n} star${n > 1 ? "s" : ""}`}
                      onClick={() => setReview(i, { rating: n })}
                      className="h-10 w-8 inline-flex items-center justify-center"
                    >
                      <Star className={`w-5 h-5 ${n <= r.rating ? "fill-amber-400 text-amber-400" : "text-stone-300"}`} />
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  <input type="checkbox" checked={r.visible} onChange={(e) => setReview(i, { visible: e.target.checked })} />
                  Show
                </label>
                <button
                  onClick={() => setReviews({ featured: form.reviews.featured.filter((_, j) => j !== i) })}
                  aria-label="Remove review"
                  className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <textarea
                value={r.text}
                maxLength={600}
                rows={3}
                onChange={(e) => setReview(i, { text: e.target.value })}
                placeholder="The review, word for word"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 bg-stone-50 text-sm"
              />
              <input
                value={r.service ?? ""}
                maxLength={80}
                onChange={(e) => setReview(i, { service: e.target.value || null })}
                placeholder="Services Google lists under the review (optional), e.g. Haircut"
                className="w-full h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
              />
            </div>
          ))}
          {form.reviews.featured.length < 12 && (
            <button
              onClick={() => setReviews({ featured: [...form.reviews.featured, { author: "", rating: 5, text: "", service: null, visible: true }] })}
              className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50"
            >
              <Plus className="w-4 h-4" /> Add a review
            </button>
          )}
        </div>
      </section>

      {/* Holidays */}
      <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5">
        <h3 className="font-semibold text-stone-900 mb-1">Closed days</h3>
        <p className="text-xs text-stone-500 mb-4">Customers can't pick these dates on the request form.</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {form.holidays.length === 0 && <span className="text-sm text-stone-400">None</span>}
          {form.holidays.map((h) => (
            <span key={h} className="inline-flex items-center gap-1 pl-3 pr-1 h-8 rounded-full bg-stone-100 text-sm text-stone-700">
              {new Date(`${h}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}
              <button
                aria-label={`Remove ${h}`}
                onClick={() => setForm({ ...form, holidays: form.holidays.filter((x) => x !== h) })}
                className="w-6 h-6 rounded-full hover:bg-stone-200 flex items-center justify-center"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input type="date" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} className="h-10 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm" />
          <button
            disabled={!newHoliday}
            onClick={() => {
              setForm({ ...form, holidays: [...new Set([...form.holidays, newHoliday])].sort() });
              setNewHoliday("");
            }}
            className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm text-stone-700 disabled:opacity-40 hover:bg-stone-50"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={() => save()}
          disabled={saving}
          className="inline-flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-5 py-2.5 hover:bg-stone-800 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
        </button>
        {message && <span className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-600"}`}>{message.text}</span>}
      </div>
      {holidayConflicts && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm space-y-2">
          <p className="font-medium text-amber-900">Bookings on the new holiday — move or cancel them on the Today board:</p>
          <ul className="space-y-1 text-stone-700">
            {holidayConflicts.map((c) => (
              <li key={c.ref}>
                {c.date} · {c.ref} · {c.name} · {c.contact}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => save(true)} disabled={saving} className="h-9 px-3 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700">
            Save anyway — I'll handle them
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ── Artists on the website ───────────────────────────────────────────────────
interface WebArtist {
  _id: string;
  name: string;
  publicProfile?: { visible?: boolean | null; displayName?: string | null };
}

function ArtistsOnWebsite() {
  const [artists, setArtists] = useState<WebArtist[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API}/api/website/artists`, { credentials: "include" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed to load artists");
        setArtists(d);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function update(a: WebArtist, publicProfile: Record<string, unknown>) {
    setBusy(a._id);
    setError("");
    try {
      const res = await fetch(`${API}/api/website/artists/${a._id}/public`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicProfile }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      setArtists((list) => list?.map((x) => (x._id === a._id ? { ...x, publicProfile: d.publicProfile } : x)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-5">
      <h3 className="font-semibold text-stone-900 mb-1">Artists on the website</h3>
      <p className="text-xs text-stone-500 mb-4">
        Every active artist is listed automatically, so customers can ask for them on a request. Hide anyone who
        shouldn&apos;t appear. The website name is optional; it uses the artist&apos;s name when left blank.
      </p>
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {!artists ? (
        <Loader2 className="w-5 h-5 animate-spin text-stone-400" />
      ) : artists.length === 0 ? (
        <p className="text-sm text-stone-400">No active artists.</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {artists.map((a) => {
            const shown = a.publicProfile?.visible !== false;
            return (
              <li key={a._id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className={`w-40 text-sm ${shown ? "text-stone-900" : "text-stone-400 line-through"}`}>{a.name}</span>
                <input
                  defaultValue={a.publicProfile?.displayName ?? ""}
                  placeholder="Website name (optional)"
                  maxLength={60}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== (a.publicProfile?.displayName ?? null)) update(a, { displayName: v });
                  }}
                  className="h-9 flex-1 min-w-40 px-3 rounded-lg border border-stone-200 bg-stone-50 text-sm"
                />
                <button
                  disabled={busy === a._id}
                  onClick={() => update(a, { visible: shown ? false : null })}
                  className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-sm disabled:opacity-50 ${
                    shown ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 text-stone-500"
                  }`}
                >
                  {busy === a._id ? <Loader2 className="w-4 h-4 animate-spin" /> : shown ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {shown ? "Shown" : "Hidden"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
