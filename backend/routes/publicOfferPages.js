/**
 * @file publicOfferPages.js
 * @description Public reads for offer landing pages (D62). Mounted inside /api/public
 * (see routes/public.js), so it shares the database middleware and the early mount.
 *
 *   GET /offer-pages/now          the offer whose dates contain today (India time), or {offer: null}
 *   GET /offer-pages/:slug        that offer, with state live | scheduled | ended; 404 if unknown or paused
 *
 * Short shared cache only: the answer changes at midnight India time and when the owner edits.
 */

const express = require("express");
const { param } = require("express-validator");
const { publicReadLimit } = require("../middleware/memoryRateLimit");
const offerPages = require("../utils/offerPages");
const { salonDate } = require("../utils/time");

const router = express.Router();
const readLimit = publicReadLimit; // in memory, shared with the other public reads (audit #18)
const cacheFor = (res, s) => res.set("Cache-Control", `public, s-maxage=${s}, stale-while-revalidate=${s * 2}`);

router.get("/offer-pages/now", readLimit, async (_req, res) => {
  try {
    const today = salonDate();
    const c = await offerPages.findNow(today);
    cacheFor(res, 60);
    return res.json({ today, offer: c ? await offerPages.toPublic(c, today) : null });
  } catch (err) {
    console.error("[public] offer-pages/now error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

router.get("/offer-pages/:slug", readLimit, param("slug").matches(/^[a-z0-9-]{1,60}$/), async (req, res) => {
  try {
    const today = salonDate();
    const c = await offerPages.findBySlug(req.params.slug);
    if (!c) return res.status(404).json({ error: "NOT_FOUND" });
    cacheFor(res, 60);
    return res.json({ today, offer: await offerPages.toPublic(c, today) });
  } catch (err) {
    console.error("[public] offer-pages error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

module.exports = router;
