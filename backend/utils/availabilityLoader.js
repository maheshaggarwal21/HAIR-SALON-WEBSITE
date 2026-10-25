/**
 * @file availabilityLoader.js
 * @description Reads everything the availability engine needs for one date
 * from MongoDB and turns it into the engine's pure input (CF §4.1).
 *
 *   1. SiteSettings → opening intervals (holidays, special hours), lead time.
 *   2. The requested services → durations, buffers, categories, stations, mode.
 *   3. Candidate artists: active AND onlineBookable (the per-artist switch, T2.22).
 *   4. Each artist's working intervals: weekly schedule (null = salon hours,
 *      D21) ∩ opening hours − breaks − time off.
 *   5. Slot locks that day: firm, or holds that haven't expired.
 *   6. Minutes already sold online per artist (for onlineShare).
 *
 * Durations: the engine books `durationMinutes` — the owner's confirmed time or
 * the one-hour estimate (D11) — so estimates are generous rather than tight.
 */

const Service = require("../models/Service");
const Artist = require("../models/Artist");
const TimeOff = require("../models/TimeOff");
const Resource = require("../models/Resource");
const SlotLock = require("../models/SlotLock");
const Appointment = require("../models/Appointment");
const SiteSettings = require("../models/SiteSettings");
const { effectiveRule, ruleSets, serviceKeys } = require("./skills");
const { liveOffers, applyOffer } = require("./offers");
const { openingIntervals, intersect, subtract, salonInstant, weekdayKey } = require("./time");

const ONLINE_MODES = ["instant", "request"];
const DAY_MS = 24 * 60 * 60 * 1000;

class BookingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * D49: once online booking is on, every service the website offers is booked
 * instantly and paid for — colour and bridal included. There is no "request"
 * tier in the engine any more (the Website Requests inbox is only for when
 * online booking is off). Hidden and walk-in-only services stay off the site.
 */
function effectiveMode(s) {
  return s.bookingMode === "request" ? "instant" : s.bookingMode;
}

/** Working intervals of one artist on `date`, as epoch-ms pairs. */
function artistIntervals(artist, opening, date, timeOffs) {
  const key = weekdayKey(date);
  const weekly = artist.schedule?.weekly;
  let base = opening;
  if (weekly && typeof weekly === "object") {
    const own = (weekly[key] || [])
      .map((i) => ({ start: salonInstant(date, i.start)?.getTime(), end: salonInstant(date, i.end)?.getTime() }))
      .filter((i) => i.start != null && i.end > i.start);
    base = intersect(opening, own);
  }
  const breaks = (artist.schedule?.breaks || [])
    .filter((b) => b.day === key || b.day === "all")
    .map((b) => ({ start: salonInstant(date, b.start).getTime(), end: salonInstant(date, b.end).getTime() }));
  const off = timeOffs.map((t) => ({ start: new Date(t.startAt).getTime(), end: new Date(t.endAt).getTime() }));
  return subtract(subtract(base, breaks), off);
}

/**
 * Load and validate the services for a booking. Every service must be active,
 * have a website price and be bookable online (instant or request).
 * @returns {Map<string, object>} id → lean Service
 */
async function loadServices(ids, { allowPackageOnly = new Set() } = {}) {
  const unique = [...new Set(ids.map(String))];
  const docs = await Service.find({ _id: { $in: unique }, isActive: true, publicPrice: { $ne: null } }).lean();
  // Live offer prices (D59). A package's own items keep their normal price: the
  // package price already replaces them, and stacking both would discount twice.
  const offers = await liveOffers();
  const byId = new Map(docs.map((d) => [String(d._id), applyOffer(d, offers, allowPackageOnly)]));
  for (const id of unique) {
    const s = byId.get(id);
    if (!s) throw new BookingError("SERVICE_UNAVAILABLE", "One of those services isn't available online. Refresh and try again.");
    const mode = effectiveMode(s);
    // Items that come with an approved package may be "hidden" on the menu (D20).
    if (!ONLINE_MODES.includes(mode) && !(allowPackageOnly.has(id) && mode === "hidden")) {
      throw new BookingError("SERVICE_UNAVAILABLE", `${s.publicName || s.name} can't be booked online.`);
    }
    if (mode === "instant" && !(s.durationMinutes > 0)) {
      throw new BookingError("SERVICE_UNAVAILABLE", `${s.publicName || s.name} has no duration set.`);
    }
  }
  return byId;
}

/**
 * @param {object}   opts
 * @param {string}   opts.date                "YYYY-MM-DD" (IST)
 * @param {{key:string, serviceIds:string[]}[]} opts.guests
 * @param {Map}      opts.services           from loadServices
 * @param {string}   [opts.artistId]         preferred artist (one guest). A group names one per guest: `guests[].artistId`
 * @param {"parallel"|"series"} [opts.groupMode]  series = one artist, guest after guest (D67)
 * @param {Date}     [opts.now]
 * @param {string}   [opts.excludeAppointmentId]  ignore this booking's own locks (reschedule)
 * @param {boolean}  [opts.patchTestOk]
 * @param {boolean}  [opts.staff]            front desk (E22): every active artist, no lead
 *                                           time, no online share — the desk books for
 *                                           people in front of it or on the phone
 */
async function loadEngineInput({ date, guests, services, artistId = null, groupMode = "parallel", now = new Date(), excludeAppointmentId = null, patchTestOk = false, staff = false }) {
  const settings = (await SiteSettings.getSingleton()).toObject();
  const opening = openingIntervals(settings, date);
  const dayStart = salonInstant(date, "00:00");
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const [artists, timeOffs, locks, resources] = await Promise.all([
    Artist.find(staff ? { isActive: true } : { isActive: true, onlineBookable: true }).lean(),
    TimeOff.find({ startAt: { $lt: dayEnd }, endAt: { $gt: dayStart } }).lean(),
    SlotLock.find({
      blockStart: { $gte: dayStart, $lt: dayEnd },
      $or: [{ state: "firm" }, { expiresAt: { $gt: now } }],
      ...(excludeAppointmentId ? { appointmentId: { $ne: excludeAppointmentId } } : {}),
    }).lean(),
    Resource.find({ active: true }).lean(),
  ]);

  // Online minutes already sold, per artist (§2.1 onlineShare).
  const apptIds = [...new Set(locks.filter((l) => l.appointmentId).map((l) => String(l.appointmentId)))];
  const webAppts = apptIds.length
    ? new Set(
        (await Appointment.find({ _id: { $in: apptIds }, "source.channel": "web" }, { _id: 1 }).lean()).map((a) => String(a._id))
      )
    : new Set();

  const artistLocks = new Set();
  const resourceLocks = new Set();
  const booked = new Map();
  const soldOnline = new Map();
  for (const l of locks) {
    const ms = new Date(l.blockStart).getTime();
    const id = String(l.artistId);
    if (l.kind === "resource") {
      resourceLocks.add(`${id}|${l.resourceUnit || 0}|${ms}`);
      continue;
    }
    artistLocks.add(`${id}|${ms}`);
    booked.set(id, (booked.get(id) || 0) + 15);
    if (l.appointmentId && webAppts.has(String(l.appointmentId))) soldOnline.set(id, (soldOnline.get(id) || 0) + 15);
  }

  const engineArtists = artists.map((a) => ({
    id: String(a._id),
    name: a.publicProfile?.displayName || a.name,
    // Own rule, or the default for the artist's gender (D35).
    ...ruleSets(effectiveRule(a, settings.artistSkillDefaults)),
    intervals: artistIntervals(a, opening, date, timeOffs.filter((t) => String(t.artistId) === String(a._id))),
    onlineShare: staff ? 100 : a.onlineShare ?? 100,
    onlineMinutesSold: soldOnline.get(String(a._id)) || 0,
    bookedMinutes: booked.get(String(a._id)) || 0,
  }));

  const engineGuests = guests.map((g) => ({
    key: g.key,
    // The artist this guest asked for (D67); null = any.
    artistPref: g.artistId ? String(g.artistId) : null,
    items: g.serviceIds
      .map((id, order) => ({ s: services.get(String(id)), order }))
      // Cut before colour, threading before makeup: the owner's sortOrder, then the customer's order.
      .sort((x, y) => (x.s.sortOrder ?? 0) - (y.s.sortOrder ?? 0) || x.order - y.order)
      .map(({ s }) => ({
        serviceId: String(s._id),
        name: s.publicName || s.name,
        durationMin: s.durationMinutes || 60,
        bufferMin: s.bufferMinutes || 0,
        // Same section / sub-group as the menu and the skills screen (D35).
        category: serviceKeys(s).category,
        group: serviceKeys(s).group,
        resourceIds: (s.resourceIds || []).map(String),
        requiresPatchTest: Boolean(s.requiresPatchTest),
      })),
  }));

  const mode = [...services.values()].some((s) => effectiveMode(s) === "request") ? "request" : "instant";

  return {
    settings,
    mode,
    input: {
      now: now.getTime(),
      minLeadMinutes: staff ? 0 : settings.minLeadMinutes,
      opening,
      guests: engineGuests,
      artists: engineArtists,
      locks: artistLocks,
      resources: resources.map((r) => ({ id: String(r._id), capacity: r.capacity })),
      resourceLocks,
      artistPref: artistId ? String(artistId) : null,
      groupMode,
      patchTestOk: staff ? true : patchTestOk,
    },
  };
}

module.exports = { loadEngineInput, loadServices, artistIntervals, effectiveMode, BookingError };
