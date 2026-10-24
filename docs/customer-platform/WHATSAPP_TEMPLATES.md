# WhatsApp templates and Meta setup

WhatsApp only delivers a message the salon starts (a code, a confirmation, a reminder) if it
uses a **template approved by Meta**. This file is the exact text to submit, with the variables
numbered in the order the code fills them (`ORDER` in `backend/utils/whatsapp.js`). If you change
a template's wording, keep the `{{n}}` order. If you add or reorder a variable, change `ORDER` too.

Provider: Meta's own WhatsApp Cloud API (D52). Wati was removed (D57). Marketing broadcasts are sent by the owner from AiSensy on the same number; this app never calls AiSensy.

## Set-up checklist (Meta, one time)

1. Create or use a **Meta Business account** (business.facebook.com) and run **business verification**
   (Business settings → Security centre). Until verified, Meta limits how many people we can message
   per day.
2. Create a Meta app (developers.facebook.com → Create app → Business) and add the **WhatsApp** product.
3. Add a **phone number for notifications**. It cannot already be signed in to the normal WhatsApp or
   WhatsApp Business app on a phone (unless Meta offers coexistence for it — check). Recommended: a
   separate number for notifications; the salon's main WhatsApp number stays for talking to customers.
4. Create a **System User** (Business settings → Users → System users), give it the WhatsApp account,
   and generate a **permanent token** with `whatsapp_business_messaging` and
   `whatsapp_business_management`. The 24-hour token on the API-setup page is for testing only.
5. Copy the **Phone number ID** (API setup page).
6. In **WhatsApp Manager → Message templates**, create each template below (language: English).
   Approval usually takes minutes to a day.
7. In Vercel (backend project) set: `WHATSAPP_PROVIDER=meta`, `META_WA_TOKEN`,
   `META_WA_PHONE_NUMBER_ID`, and each `WHATSAPP_TEMPLATE_<TYPE>` to the template's name.
8. Add a payment method in WhatsApp Manager (Billing) — Meta bills per delivered template message.

## Rules Meta enforces on the text

- A variable cannot be the very first or very last thing in the body — hence the sign-off line.
- Variables are filled in order `{{1}}`, `{{2}}`… and cannot contain line breaks (the code cleans them).
- Give a sample value for every variable when submitting.
- Category **Utility** for everything below except the code, which is **Authentication**.

## The "talk to us" line

Every template except the code carries this line, filled from Website Settings → contact → WhatsApp,
sent as the last variable (`salon_link`, e.g. `https://wa.me/919814830550`):

> To talk to us, click here to message our main salon number: {{n}}

WhatsApp shows the link as tappable. **The code message cannot carry it**: Meta's authentication
templates have a fixed format (the code and a copy button) and allow no extra text or links.

## Templates

Suggested names; whatever you name them goes in `WHATSAPP_TEMPLATE_<TYPE>`.

### `otp` — name `otp_code` — Authentication
Choose "Copy code" button. Add the 5-minute expiry warning if offered. Meta writes the text itself
("*123456* is your verification code."). The code is sent in the body and the button.

### `booking_confirmed` — name `booking_confirmed_v1` — Utility
```
Hi {{1}}, your booking {{2}} at The Experts is confirmed for {{3}}.

To view, move or cancel it: {{4}}

To talk to us, click here to message our main salon number: {{5}}

Thank you, The Experts
```
Samples: Asha · EXP-ABCDE · Fri, 16 Oct, 11:00 am · https://www.thexpertshair.com/booking/abc · https://wa.me/919814830550

### `reminder_24h` — name `reminder_24h_v1` — Utility
```
Hi {{1}}, a reminder that your appointment {{2}} at The Experts is on {{3}}.

See or change it (free until 24 hours before): {{4}}
Find us: {{5}}

To talk to us, click here to message our main salon number: {{6}}

See you soon, The Experts
```

### `reminder_2h` — name `reminder_2h_v1` — Utility
```
Hi {{1}}, see you in a couple of hours! Your appointment {{2}} at The Experts is at {{3}}.

Details: {{4}}
Find us: {{5}}

To talk to us, click here to message our main salon number: {{6}}

Thank you, The Experts
```

### `booking_moved` — name `booking_moved_v1` — Utility
```
Hi {{1}}, your booking {{2}} at The Experts has moved to {{3}}.

View it: {{4}}

To talk to us, click here to message our main salon number: {{5}}

Thank you, The Experts
```

### `booking_artist_changed` — name `artist_changed_v1` — Utility
```
Hi {{1}}, an update on your booking {{2}} on {{3}}: your artist has changed from {{4}} to {{5}}. Reason: {{6}}. The time is the same.

If you would rather not go ahead, you can cancel for free: {{7}}

To talk to us, click here to message our main salon number: {{8}}

Thank you, The Experts
```

### `artist_day_sheet` — name `artist_day_sheet_v1` — Utility
Sent to the ARTIST (not a customer) at 08:15 when they have bookings that day. No salon link line.
```
Good morning {{1}}, here is your day for {{2}}: {{3}} client(s) booked. {{4}}

Have a good day, The Experts
```
Sample: `Asha` · `Mon, 19 Oct` · `3` · `10:00am Sita (Haircut) | 12:30pm Kamla (Facial) | 3:00pm Gita (Colour)`

### `booking_cancelled` — name `booking_cancelled_v1` — Utility
```
Hi {{1}}, your booking {{2}} at The Experts has been cancelled. The refund due to you is ₹{{3}}; it goes back to the account you paid from.

To talk to us, click here to message our main salon number: {{4}}

Thank you, The Experts
```

### `booking_declined` — name `booking_declined_v1` — Utility
```
Hi {{1}}, sorry, we could not accept booking {{2}} at The Experts. The refund due to you is ₹{{3}}; it goes back to the account you paid from.

To talk to us, click here to message our main salon number: {{4}}

Thank you, The Experts
```

### `request_declined` — name `request_declined_v1` — Utility
Sent when reception declines an UNPAID request made from an offer page or a WhatsApp ad link (D62). No refund line, because nothing was paid. (`booking_declined` above is for paid online bookings.)
```
Hi {{1}}, sorry, we could not take your booking request {{2}} at The Experts for that time. Nothing was charged. Please message us and we will find a time that suits you.

To talk to us, click here to message our main salon number: {{3}}

Thank you, The Experts
```
Samples: Asha · EXP-ABCDE · https://wa.me/919988872800
Env var: `WHATSAPP_TEMPLATE_REQUEST_DECLINED=request_declined_v1`

### `request_cancelled` — name `request_cancelled_v1` — Utility
Sent when an UNPAID offer-page or WhatsApp-ad booking is cancelled, by the salon or by the customer from the link (D62). No refund line, because nothing was paid. (`booking_cancelled` above is for paid online bookings.)
```
Hi {{1}}, your booking {{2}} at The Experts has been cancelled. Nothing was charged. If you would like to book another time, please message us.

To talk to us, click here to message our main salon number: {{3}}

Thank you, The Experts
```
Samples: Asha · EXP-ABCDE · https://wa.me/919988872800
Env var: `WHATSAPP_TEMPLATE_REQUEST_CANCELLED=request_cancelled_v1`

### `booking_refund` — name `booking_refund_v1` — Utility
```
Hi {{1}}, your refund for booking {{2}} of ₹{{3}} is on its way to the account you paid from. Your bank may take 5 to 7 working days to show it.

To talk to us, click here to message our main salon number: {{4}}

Thank you, The Experts
```

### `request_received` — name `request_received_v1` — Utility
Sent the moment someone sends a request from an offer page or a WhatsApp ad link (D62), and for older website requests. Needed for those requests to get a confirmation message. Env var: `WHATSAPP_TEMPLATE_REQUEST_RECEIVED=request_received_v1`.
```
Hi {{1}}, we have received your booking request {{2}} for {{3}} and will confirm it shortly. View it: {{4}}

To talk to us, click here to message our main salon number: {{5}}

Thank you, The Experts
```

## Messages we do NOT send

There is no review-request message (D50): it would be billed as a marketing message.

## Marketing and broadcasts

Offers and broadcasts to many customers are **marketing** messages: separate templates, sent only to
customers who ticked the unticked-by-default marketing checkbox, and billed at Meta's higher
marketing rate. They are not built into this system.
