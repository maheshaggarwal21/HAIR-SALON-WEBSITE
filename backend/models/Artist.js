/**
 * @file Artist.js
 * @description Mongoose model for salon artists.
 *
 * Artists have an optional linked User account (role: "artist") for
 * dashboard access. They also carry commission %, registration ID,
 * and a photo URL — all managed from the owner/manager panels.
 *
 * Soft-delete via `isActive: false` keeps historical visit references intact.
 *
 * ── Public layer (customer website, CF §2.1, T1.2) ────────────────────────────
 * `publicProfile` is everything the website may show about an artist. Nothing
 * outside it is public — phone, email, commission and registration ID never
 * leave the staff app (utils/publicCatalogue.js projects publicProfile only).
 *
 * Who appears on the website follows the staff app (owner, T0.2 K6): every
 * ACTIVE artist is listed automatically, and the owner can hide one. So
 * `publicProfile.visible` is tri-state — null = follow active status (the
 * default, and what the 14 existing artists have), false = hidden by the
 * owner, true = shown. Deactivating an artist removes them from the site.
 *
 * `onlineBookable` is the Phase 2 master switch for the slot engine. In Phase 1
 * (request-lite) it only decides whether customers can name this artist as a
 * preference on a request.
 */

const mongoose = require("mongoose");

const GENDERS = ["female", "male", "other"];
const LEVELS = ["senior", "stylist", "junior"];

const artistSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Artist name is required"],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
      unique: true,
      validate: {
        validator: (v) => /^[6-9]\d{9}$/.test(v),
        message: "Enter a valid 10-digit Indian mobile number",
      },
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    registrationId: {
      type: String,
      trim: true,
      default: null,
    },
    commission: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    photo: {
      type: String,
      trim: true,
      default: null,
    },
    /** Link to the User document that lets this artist sign in */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isActive: { type: Boolean, default: true },

    // ── Public layer ──────────────────────────────────────────────────────────
    /** Only used for the optional "female artist" filter (waxing, threading). */
    gender: { type: String, enum: [...GENDERS, null], default: null },
    /** Display only in v1. */
    level: { type: String, enum: [...LEVELS, null], default: null },
    onlineBookable: { type: Boolean, default: false },

    // ── Booking engine (Phase 2, CF §2.1, §4) ─────────────────────────────────
    /**
     * Which services this artist may be booked for (CF D35, utils/skills.js).
     * "inherit" (default) = follow the salon's rule for the artist's gender
     * (SiteSettings.artistSkillDefaults, "all services" to start with);
     * "custom" = the four fields below.
     */
    skillMode: { type: String, enum: ["inherit", "custom"], default: "inherit" },
    /** Custom rule: every service. */
    skillAll: { type: Boolean, default: false },
    /** Custom rule: whole menu sub-groups / cards (config/menuGroups.js slugs or a variantGroup). */
    skillGroups: { type: [String], default: [] },
    /** Custom rule: exact services. */
    skills: { type: [mongoose.Schema.Types.ObjectId], ref: "Service", default: [] },
    /**
     * Whole website categories this artist can do ("Threading", "Makeup", …).
     * A service is in the artist's skills if it is listed in `skills` OR its
     * displayCategory is here — so the owner ticks a few categories instead of
     * 182 services (D21). Custom rule with nothing ticked = not bookable online.
     */
    skillCategories: { type: [String], default: [] },
    /** Max % of this artist's working minutes per day that may be sold online. */
    onlineShare: { type: Number, default: 100, min: 0, max: 100 },
    schedule: {
      /**
       * IST wall clock per weekday, e.g. { mon: [{start:"10:00", end:"19:00"}] }.
       * null = works whenever the salon is open (D21). An empty array for a
       * day = off that day.
       */
      weekly: { type: mongoose.Schema.Types.Mixed, default: null },
      /** Recurring breaks, e.g. { day: "mon"|"all", start: "14:00", end: "14:30" }. */
      breaks: {
        type: [
          new mongoose.Schema(
            { day: { type: String, required: true }, start: { type: String, required: true }, end: { type: String, required: true } },
            { _id: false }
          ),
        ],
        default: [],
      },
    },

    publicProfile: {
      /**
       * URL key. NO default, same reason as Service.slug: the unique index is
       * sparse, which skips a document only when the field is ABSENT. A null
       * default would make every unslugged artist collide.
       */
      slug: {
        type: String,
        trim: true,
        lowercase: true,
        match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug may only contain a–z, 0–9 and single hyphens"],
      },
      displayName: { type: String, trim: true, default: null },
      bio: { type: String, trim: true, maxlength: 600, default: null },
      specialties: { type: [String], default: [] },
      photo: { type: String, trim: true, default: null },
      portfolio: { type: [String], default: [] },
      /** Handle without the @, e.g. "mansi.makeovers". */
      instagram: { type: String, trim: true, default: null },
      sortOrder: { type: Number, default: 0 },
      /** null = shown while active · false = hidden by the owner · true = shown. */
      visible: { type: Boolean, default: null },
    },
  },
  { timestamps: true }
);

/** Index for quick lookups in the form-data endpoint. */
artistSchema.index({ isActive: 1, name: 1 });
artistSchema.index({ userId: 1 });
artistSchema.index({ email: 1 }, { sparse: true });
artistSchema.index({ "publicProfile.slug": 1 }, { unique: true, sparse: true });
/** Public list: GET /api/public/artists */
artistSchema.index({ "publicProfile.visible": 1, "publicProfile.sortOrder": 1 });

module.exports = mongoose.model("Artist", artistSchema);
module.exports.GENDERS = GENDERS;
module.exports.LEVELS = LEVELS;
