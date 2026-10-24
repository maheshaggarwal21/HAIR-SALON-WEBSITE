/**
 * @file otp.js
 * @description WhatsApp one-time codes for online booking
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §5, §14, §18, T2.6).
 *
 *   send(phone)          6 digits from crypto.randomInt → WhatsApp "otp" template
 *   check(phone, code)   newest live code for that phone; 5 tries; works once
 *
 * Rate limits (3 per phone per 15 min, 10 per IP per hour) and Turnstile are
 * applied by the route before send() runs.
 *
 * Delivery: WhatsApp only (D7, D52) until MSG91's DLT registration clears, by Meta or by
 * AiSensy's `otp_code` campaign, chosen with OTP_PROVIDER (utils/whatsapp.js). The code is
 * never written to a log in production; a failure logs the status and a masked number. Outside
 * production with no WhatsApp configured the code is printed to the server
 * console (channel "dev"), so the booking flow can be tested end to end. In
 * production an undeliverable code is an error the customer sees ("message us
 * on WhatsApp"), never a silent success.
 */

const crypto = require("crypto");
const OtpChallenge = require("../models/OtpChallenge");
const { phoneHash } = require("./bookingToken");
const whatsapp = require("./whatsapp");

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hashCode = (salt, code) => crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");

/**
 * @returns {Promise<{ok: true, channel: string, expiresAt: Date} | {ok: false, error: string}>}
 */
async function send(phone, purpose = "booking", now = new Date()) {
  // randomInt is cryptographically secure; padStart keeps leading zeros ("000042"), so the code is always 6 characters.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  // Last guard before anything leaves the server: never send a code that is not exactly 6 digits.
  if (!/^\d{6}$/.test(code)) throw new Error("OTP code must be exactly 6 digits");
  const delivery = await whatsapp.sendTemplate({ phone, type: "otp", params: { code } });
  const channel = delivery.channel === "dev" ? "dev" : "whatsapp";
  if (delivery.status !== "sent" && channel !== "dev") {
    // Only the status goes in the log (the part before any ":" of the provider's reply), and a masked number.
    const status = String(delivery.error ?? "unknown").split(":")[0].slice(0, 80);
    console.error(`[otp] WhatsApp code to ${phone.slice(0, 2)}******${phone.slice(-2)} not sent (${whatsapp.otpProvider()}): ${status}`);
    return { ok: false, error: "OTP_UNAVAILABLE" };
  }
  // Local development with no provider only: the one place a code is printed, so the flow can be tried. Never in production.
  if (channel === "dev" && process.env.NODE_ENV !== "production") console.warn(`[otp] DEV code for ${phone.slice(0, 2)}******${phone.slice(-2)}: ${code}`);

  const salt = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await OtpChallenge.create({ phoneHash: phoneHash(phone), codeHash: hashCode(salt, code), salt, purpose, expiresAt, channel });
  return { ok: true, channel, expiresAt };
}

/**
 * @returns {Promise<{ok: true} | {ok: false, error: "OTP_INVALID"|"OTP_EXPIRED", attemptsLeft?: number}>}
 */
async function check(phone, code, purpose = "booking", now = new Date()) {
  const challenge = await OtpChallenge.findOne({
    phoneHash: phoneHash(phone),
    purpose,
    consumedAt: null,
    expiresAt: { $gt: now },
  }).sort({ createdAt: -1 });
  if (!challenge) return { ok: false, error: "OTP_EXPIRED" };
  if (challenge.attempts >= MAX_ATTEMPTS) return { ok: false, error: "OTP_EXPIRED" };

  const given = Buffer.from(hashCode(challenge.salt, String(code)));
  const want = Buffer.from(challenge.codeHash);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    const after = await OtpChallenge.findOneAndUpdate(
      { _id: challenge._id },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" }
    ).lean();
    const left = Math.max(0, MAX_ATTEMPTS - (after?.attempts ?? MAX_ATTEMPTS));
    return left > 0 ? { ok: false, error: "OTP_INVALID", attemptsLeft: left } : { ok: false, error: "OTP_EXPIRED" };
  }

  // Conditional: two tabs submitting the same right code → exactly one wins.
  const used = await OtpChallenge.updateOne({ _id: challenge._id, consumedAt: null }, { $set: { consumedAt: now } });
  return used.modifiedCount === 1 ? { ok: true } : { ok: false, error: "OTP_EXPIRED" };
}

module.exports = { send, check, CODE_TTL_MS, MAX_ATTEMPTS };
