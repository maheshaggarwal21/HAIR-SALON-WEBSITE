/**
 * @file devGroupDemo.js
 * @description LOCAL ONLY. Starts the real API on http://localhost:4000 with a throwaway in-memory
 * MongoDB and test data for trying group bookings in a browser. It refuses to run against anything
 * but the in-memory database, so it can never touch Atlas. Nothing is sent to WhatsApp, Telegram,
 * Razorpay or Meta (all their keys are blanked). Stop it with Ctrl+C: the data disappears.
 *
 *     cd backend && node scripts/devGroupDemo.js
 *
 * Test data: owner login owner@demo.test / Demo@12345; artists Mansi, Ravi, Neha and Skin Sana
 * (skin only), all taking online bookings; instant services (Hair Spa, Blow Dry, Fruit Facial); the
 * offer page /offers/karwa with two packages; two confirmed group bookings today (one side by side,
 * one with a single artist one after another); one 3-person request waiting.
 *
 * Online booking works too: the code for the phone check is printed here ("[otp] DEV code ..."), and
 * payment is a fake. After "Book and pay" (the Razorpay window will not open), settle it by opening
 *     http://localhost:4100/pay/<the booking reference>
 * Messages that would go to customers are listed at http://localhost:4100/messages.
 */
for (const k of ["TELEGRAM_BOT_TOKEN", "META_WA_TOKEN", "META_WA_PHONE_NUMBER_ID", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "CUSTOMER_SITE_URL", "REVALIDATE_SECRET", "BLOB_READ_WRITE_TOKEN", "CRON_SECRET", "OWNER_EMAIL", "OWNER_PASSWORD", "TURNSTILE_SECRET_KEY", "META_CAPI_TOKEN"]) process.env[k] = "";
Object.assign(process.env, { NODE_ENV: "development", PORT: "4000", PUBLIC_TOKEN_SECRET: "demo", SESSION_SECRET: "demo-secret" });

(async () => {
  const { startDb } = require("../test/helpers/db");
  await startDb();
  if (!/^mongodb:\/\/127\.0\.0\.1/.test(process.env.MONGODB_URI)) throw new Error("refusing: not the in-memory database");
  const bcrypt = require("bcryptjs");
  const app = require("../index.js");
  await new Promise((r) => app.listen(4000, r));
  const m = (n) => require(`../models/${n}`);
  const time = require("../utils/time");
  const booking = require("../utils/booking");
  const hash = await bcrypt.hash("Demo@12345", 8);
  const now = new Date();
  await m("SiteSettings").getSingleton();
  await m("User").collection.insertOne({ name: "Salon Owner", email: "owner@demo.test", passwordHash: hash, role: "owner", isActive: true, permissions: [], createdAt: now, updatedAt: now });

  // Fake Razorpay: orders are made up, nothing leaves this machine. This also switches "online booking" on.
  require("../utils/payments").setClientForTests({
    orders: { create: async (o) => ({ id: `order_demo_${Math.random().toString(36).slice(2, 10)}`, amount: o.amount, currency: o.currency, notes: o.notes }) },
    payments: { refund: async () => ({ id: "rfnd_demo", status: "processed" }) },
  });

  const c = { isActive: true, showOnWebsite: true, durationConfirmed: true, bookingMode: "instant", audience: "her", displayCategory: "Hair" };
  const Service = m("Service");
  const [spa, blow] = await Service.create([
    { ...c, name: "Hair Spa", price: 1600, publicPrice: 800, slug: "hair-spa", durationMinutes: 60 },
    { ...c, name: "Blow Dry", price: 600, publicPrice: 300, slug: "blow-dry", durationMinutes: 30 },
  ]);
  await Service.create({ ...c, name: "Fruit Facial", price: 1800, publicPrice: 900, slug: "fruit-facial", displayCategory: "Skin", durationMinutes: 60 });
  const prof = (slug, name) => ({ slug, displayName: name, visible: true, level: "senior", specialties: ["Hair"] });
  const [mansi, ravi, neha] = await m("Artist").create([
    { name: "Mansi Kumari", phone: "9888800001", commission: 40, gender: "female", onlineBookable: true, publicProfile: prof("mansi", "Mansi") },
    { name: "Ravi", phone: "9888800002", commission: 30, gender: "male", onlineBookable: true, publicProfile: prof("ravi", "Ravi") },
    { name: "Neha", phone: "9888800003", commission: 30, gender: "female", onlineBookable: true, publicProfile: prof("neha", "Neha") },
    { name: "Skin Sana", phone: "9888800004", commission: 30, gender: "female", onlineBookable: true, skillMode: "custom", skillAll: false, skillCategories: ["Skin"], publicProfile: { ...prof("skin-sana", "Sana"), specialties: ["Skin"] } },
  ]);

  const base = "http://127.0.0.1:4000/api";
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@demo.test", password: "Demo@12345" }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const today = time.salonDate();
  const offer = await fetch(`${base}/website/campaigns`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: "Karva Chauth 2026", startDate: today, endDate: time.addDays(today, 10), theme: "festive",
      content: { eyebrow: "Festive offer", headline: "Karva Chauth glow", ctaHref: "/offers/now" },
      page: {
        slug: "karwa", headline: "Karva Chauth glow", offerText: "Pick a package. Come with friends.",
        packages: [
          { name: "Package 1", price: 3500, services: ["Hair Spa", "Blow Dry", "Kanpeki Facial"], durationMinutes: 120 },
          { name: "Package 2", price: 2500, services: ["Hair Spa", "Blow Dry"], durationMinutes: 90 },
        ],
      },
    }),
  });
  if (offer.status !== 201) throw new Error(`offer not created: ${offer.status}`);

  // Two confirmed group bookings TODAY, with their locks (what a confirmed group looks like).
  const at = (hhmm) => time.salonInstant(today, hhmm).getTime();
  const item = (s, artist, from) => ({ serviceId: s._id, name: s.name, publicPrice: s.publicPrice, listPrice: s.price, durationMin: s.durationMinutes, bufferMin: 0, artistId: artist._id, artistName: artist.name, startAt: new Date(from), endAt: new Date(from + s.durationMinutes * 60_000) });
  const make = async (ref, phone, layout) => {
    const t0 = at(layout === "parallel" ? "11:00" : "15:00");
    const guests = layout === "parallel"
      ? [{ guestKey: "g1", name: "Asha Rani", gender: "female", items: [item(spa, mansi, t0)] }, { guestKey: "g2", name: "Bina Devi", gender: "female", items: [item(blow, ravi, t0)] }]
      : [{ guestKey: "g1", name: "Chaya Singh", gender: "female", items: [item(spa, neha, t0)] }, { guestKey: "g2", name: "Dolly Kaur", gender: "female", items: [item(blow, neha, t0 + 60 * 60_000)] }];
    const a = await m("Appointment").create({
      ref, mode: "instant", status: "confirmed", contact: phone, name: guests[0].name, guests, groupMode: layout === "parallel" ? "parallel" : "series",
      startAt: new Date(t0), endAt: new Date(Math.max(...guests.flatMap((g) => g.items.map((i) => i.endAt.getTime())))),
      pricing: { subtotal: 1100, total: 1100 }, source: { channel: "web" }, statusHistory: [{ from: null, to: "confirmed", at: new Date(), by: "demo" }],
    });
    await m("SlotLock").insertMany(booking.lockDocsFor(a.toObject(), { state: "firm", expiresAt: null }));
  };
  await make("EXP-DEMO1", "9876500101", "parallel");
  await make("EXP-DEMO2", "9876500102", "series");

  // A 3-person request waiting for reception (made the way the offer page makes it).
  const day = (() => { let d = time.addDays(today, 2); while (time.weekdayKey(d) === "tue") d = time.addDays(d, 1); return d; })();
  const req = await fetch(`${base}/public/requests/wa`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offerSlug: "karwa", packageSlug: "package-1", date: day, time: "11:00", name: "Meena Gupta", phone: "9876500103", people: 3, guestNames: ["Nisha", "Pooja"], campaign: "karwa" }),
  });
  console.log("group request:", req.status, (await req.json()).ref);
  // A tiny helper on :4100 to settle the fake payment and to see what would have been sent to customers.
  const NotificationLog = m("NotificationLog");
  const Appointment = m("Appointment");
  require("http").createServer(async (q, res) => {
    res.setHeader("content-type", "application/json");
    try {
      const pay = /^\/pay\/(EXP-[A-Z0-9]{5})$/.exec(q.url);
      if (pay) {
        const a = await Appointment.findOne({ ref: pay[1] }).lean();
        if (!a?.deposit?.razorpayOrderId) return res.end(JSON.stringify({ error: "no such booking waiting for payment" }));
        const out = await booking.confirmPayment({ orderId: a.deposit.razorpayOrderId, paymentId: `pay_demo_${a.ref}`, amount: a.deposit.amount });
        return res.end(JSON.stringify({ outcome: out.outcome, ref: a.ref }));
      }
      res.end(JSON.stringify(await NotificationLog.find({}, { type: 1, to: 1, status: 1, params: 1, _id: 0 }).sort({ createdAt: 1 }).lean(), null, 1));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message }));
    }
  }).listen(4100);
  console.log("\nDEMO READY  API http://localhost:4000   login owner@demo.test / Demo@12345   helper http://localhost:4100");
})().catch((e) => { console.error(e); process.exit(1); });
