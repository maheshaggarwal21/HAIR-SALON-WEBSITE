/**
 * @file bookingToken.js
 * @description The short-lived proof that a customer owns a phone number
 * (CONTROL_FLOW_AND_DATA_LOGIC.md §5, §18, T2.6).
 *
 * After a correct WhatsApp OTP the API hands the browser a `bookingToken`:
 *
 *     base64url({ph: phoneHash, exp}) + "." + base64url(HMAC-SHA256(payload))
 *
 * signed with PUBLIC_TOKEN_SECRET and valid for 30 minutes — long enough to
 * pick a time and pay, short enough that a token copied off a shared phone is
 * soon useless. It holds a HASH of the phone, never the number, so a token in
 * a log or a screenshot gives nothing away. POST /appointments sends the phone
 * again and the server checks it hashes to the same value.
 *
 * Why HMAC and not a session: public visitors never get a cookie (CF D16), and
 * a stateless token needs no database read to check.
 *
 * `phoneHash` is also an HMAC (keyed with the same secret), not a bare sha256:
 * there are only ~4 billion Indian mobile numbers, so an unkeyed hash of one is
 * reversible in minutes. OtpChallenge stores phones the same way.
 */

const crypto = require("crypto");

const TOKEN_TTL_MS = 30 * 60 * 1000;
const DEV_SECRET = "dev-public-token-secret-not-for-production";

function secret() {
  const s = process.env.PUBLIC_TOKEN_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("PUBLIC_TOKEN_SECRET is not set");
  return DEV_SECRET;
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function phoneHash(phone) {
  return crypto.createHmac("sha256", secret()).update(`phone:${phone}`).digest("hex");
}

function signature(payload) {
  return crypto.createHmac("sha256", secret()).update(`token:${payload}`).digest();
}

/** @returns {{ token: string, expiresAt: Date }} */
function issue(phone, now = new Date()) {
  const exp = now.getTime() + TOKEN_TTL_MS;
  const payload = b64(JSON.stringify({ ph: phoneHash(phone), exp }));
  return { token: `${payload}.${b64(signature(payload))}`, expiresAt: new Date(exp) };
}

/**
 * True when `token` is genuine, unexpired and was issued for `phone`.
 * Constant-time on the signature; never throws on garbage input.
 */
function verify(token, phone, now = new Date()) {
  if (typeof token !== "string" || !phone) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const given = Buffer.from(sig, "base64url");
  const expected = signature(payload);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof body?.exp !== "number" || body.exp <= now.getTime()) return false;
  const want = Buffer.from(phoneHash(phone));
  const got = Buffer.from(String(body.ph || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/**
 * Manage-link token for an appointment (§9): HMAC of its id with the same
 * secret, base64url. The database stores only sha256(token)
 * (`Appointment.manageTokenHash`), so a database leak reveals no working
 * links — but the server can rebuild the link whenever it sends a message
 * (confirmation, reminders), which a random token stored only as a hash
 * could not do.
 */
function manageToken(appointmentId) {
  return crypto.createHmac("sha256", secret()).update(`manage:${appointmentId}`).digest("base64url");
}

const hashManageToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

module.exports = { issue, verify, phoneHash, manageToken, hashManageToken, TOKEN_TTL_MS };
