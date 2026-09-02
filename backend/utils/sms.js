/**
 * @file sms.js
 * @description MSG91 SMS delivery for the OTP fallback path.
 *
 * DLT (TRAI) compliance: the message body must match a template registered on
 * the DLT portal *character for character*. MSG91's flow API therefore takes a
 * template id plus variables rather than free text — we never build the body
 * client-side. OTP_TEMPLATE_TEXT below is kept only as documentation of what
 * the registered template must say; it is not transmitted.
 *
 * Until DLT registration clears, MSG91_AUTH_KEY / MSG91_TEMPLATE_ID will be
 * unset. In that state sendOtp() logs a warning and returns
 * { sent: false, reason: "not_configured" } — it never throws, so the approval
 * gate degrades to "Telegram only" rather than taking down login.
 *
 * In development (NODE_ENV !== "production") the OTP is printed to the server
 * console so the flow is testable end to end with no provider at all.
 */

/**
 * The DLT-registered template. Static by design — do not interpolate.
 * {#var#} is the OTP; MSG91 substitutes it from the `otp` flow variable.
 */
const OTP_TEMPLATE_TEXT =
  "Your OTP for login approval is {#var#}. Valid for 5 minutes. Do not share this code.";

const MSG91_ENDPOINT = "https://control.msg91.com/api/v5/flow/";

function config() {
  return {
    authKey:    process.env.MSG91_AUTH_KEY    || null,
    templateId: process.env.MSG91_TEMPLATE_ID || null,
    senderId:   process.env.MSG91_SENDER_ID   || null,
  };
}

function isConfigured() {
  const { authKey, templateId } = config();
  return Boolean(authKey && templateId);
}

/**
 * Send a login OTP.
 *
 * @param {string} phone 10-digit Indian mobile, no country code
 * @param {string} code  6-digit OTP
 * @returns {Promise<{sent: boolean, reason?: string, providerId?: string}>}
 */
async function sendOtp(phone, code) {
  if (!phone) return { sent: false, reason: "no_phone" };

  const { authKey, templateId, senderId } = config();

  if (!isConfigured()) {
    // Expected state until DLT clears. Loud in dev, quiet-but-logged in prod.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[sms] MSG91 not configured — DEV OTP for +91${phone} is ${code}`
      );
    } else {
      console.warn("[sms] MSG91 not configured — OTP fallback unavailable");
    }
    return { sent: false, reason: "not_configured" };
  }

  try {
    const res = await fetch(MSG91_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: authKey,
      },
      body: JSON.stringify({
        template_id: templateId,
        ...(senderId ? { sender: senderId } : {}),
        short_url: "0",
        recipients: [
          {
            // MSG91 expects the country code inline.
            mobiles: `91${phone}`,
            otp: code,
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.type === "error") {
      console.error("[sms] MSG91 send failed:", data.message || res.status);
      return { sent: false, reason: "provider_error" };
    }

    return { sent: true, providerId: data.request_id ?? null };
  } catch (err) {
    console.error("[sms] MSG91 network error:", err.message);
    return { sent: false, reason: "network_error" };
  }
}

/** `98765 43210` → `98••• ••210`, for showing the staff where the code went. */
function maskPhone(phone) {
  if (!phone || phone.length < 4) return "•••••";
  return `${phone.slice(0, 2)}•••••${phone.slice(-3)}`;
}

module.exports = { sendOtp, isConfigured, maskPhone, OTP_TEMPLATE_TEXT };
