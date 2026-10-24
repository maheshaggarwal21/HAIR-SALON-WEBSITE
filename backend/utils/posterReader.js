/**
 * @file posterReader.js
 * @description "Read a poster" (D63): a photo of an offer poster goes in; the packages on it
 * (name, price, the old price if crossed out, and the services listed) come out, ready for
 * the owner to CHECK and turn into bundles.
 *
 * How: one call to Claude with the picture (vision) and a fixed answer shape (structured
 * output), through the official SDK. Fancy poster fonts and columns are why this uses a vision
 * model and not a plain text-reader.
 *
 * Safety by design:
 *   - NOTHING is saved here. The result is a draft; the owner reviews every line in the staff
 *     app and nothing reaches the website until she saves the offer. Prices are checked again
 *     by the server against the real menu when she does (utils/offers.js prepareOfferLines).
 *   - The model is told to copy what is printed and never to guess; anything it is unsure of
 *     goes in `notes` for the owner to look at.
 *   - Off until ANTHROPIC_API_KEY is set. Without it the staff app says reading posters is not
 *     set up and everything else keeps working.
 *   - Cost: one request per poster, a few rupees. The route limits reads per person per day.
 */

const MODEL = process.env.POSTER_READER_MODEL || "claude-opus-5-5";
const MAX_PACKAGES = 12;
const MAX_LINES = 30;

class PosterReaderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "PosterReaderError";
    this.status = status;
  }
}

const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });

/** The only shape the model may answer in. */
const SCHEMA = {
  type: "object",
  properties: {
    title: nullable("string"),
    packages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: nullable("integer"),
          regularPrice: nullable("integer"),
          services: { type: "array", items: { type: "string" } },
        },
        required: ["name", "price", "regularPrice", "services"],
        additionalProperties: false,
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["title", "packages", "notes"],
  additionalProperties: false,
};

const INSTRUCTIONS = `You are reading a salon offer poster so its packages can be typed into a price list. Copy what is printed; never guess or invent.

Return:
- title: the poster's headline (for example "Karva Chauth Special"), or null.
- packages: every package, bundle or combo box on the poster, in the order they appear (left to right, top to bottom). For each:
  - name: its label as printed (for example "Package 1").
  - price: the price the customer PAYS, in whole rupees, as a number with no symbol or commas. When two prices are shown and one is crossed out, the crossed-out one is NOT the price.
  - regularPrice: the crossed-out or "was" price in whole rupees, or null when there is none.
  - services: every service listed in that package, one entry per line, spelled as printed (keep brackets such as "(Rica)" and slashes such as "Bleach / D-tan"). Do not merge, split, translate or reorder lines, and do not add services that are not printed.
- notes: short plain sentences for anything the owner should double-check: a price or word you could not read clearly, a package with no price, text that looked like a condition or an expiry date, or lines that might belong to a different package. Use an empty list when there is nothing.

Ignore phone numbers, addresses, social handles, slogans and decorations. If the picture is not an offer poster, return no packages and say so in notes.`;

let injected = null;
/** Tests replace the SDK client with a stub (no network, no key). */
const setClientForTests = (c) => {
  injected = c;
};

function getClient() {
  if (injected) return injected;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require("@anthropic-ai/sdk");
  const Client = Anthropic.default || Anthropic;
  return new Client({ timeout: 120_000, maxRetries: 1 });
}

const isConfigured = () => Boolean(injected || process.env.ANTHROPIC_API_KEY);

const wholeRupees = (v) => (Number.isFinite(v) && v >= 0 && v <= 10_000_000 ? Math.round(v) : null);
const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Tidy the model's answer: right types, sane sizes, nothing the owner could not read. */
function tidy(raw) {
  const packages = (Array.isArray(raw?.packages) ? raw.packages : [])
    .map((p, i) => ({
      name: clean(p?.name, 60) || `Package ${i + 1}`,
      price: wholeRupees(p?.price),
      regularPrice: wholeRupees(p?.regularPrice),
      services: (Array.isArray(p?.services) ? p.services : []).map((s) => clean(s, 80)).filter(Boolean).slice(0, MAX_LINES),
    }))
    .filter((p) => p.services.length > 0 || p.price !== null)
    .slice(0, MAX_PACKAGES); // empty boxes first, then the cap, so they never use up a place
  return {
    title: clean(raw?.title, 90) || null,
    packages,
    notes: (Array.isArray(raw?.notes) ? raw.notes : []).map((n) => clean(n, 200)).filter(Boolean).slice(0, 10),
  };
}

/**
 * @param {{imageUrl: string}} p  a public https link to the poster picture
 * @returns {Promise<{title: string|null, packages: {name: string, price: number|null, regularPrice: number|null, services: string[]}[], notes: string[]}>}
 */
async function readPoster({ imageUrl }) {
  const client = getClient();
  if (!client) throw new PosterReaderError("Reading posters isn't set up yet. Ask your developer to add the Claude key.", 503);

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: imageUrl } },
            { type: "text", text: INSTRUCTIONS },
          ],
        },
      ],
    });
  } catch (err) {
    console.error("[posterReader] API error:", err?.status, err?.message);
    if (err?.status === 400) throw new PosterReaderError("That picture couldn't be read. Use a clear JPG, PNG or WebP image under 5 MB.", 422);
    throw new PosterReaderError("Reading the poster didn't work this time. Try again in a minute.", 502);
  }

  if (response.stop_reason === "refusal") throw new PosterReaderError("The poster couldn't be read. Type the bundles in by hand instead.", 422);
  if (response.stop_reason === "max_tokens") throw new PosterReaderError("The poster has too much on it to read in one go. Crop it to the price boxes and try again.", 422);

  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PosterReaderError("Reading the poster didn't work this time. Try again in a minute.", 502);
  }
  return tidy(raw);
}

module.exports = { readPoster, isConfigured, setClientForTests, tidy, SCHEMA, MODEL, PosterReaderError };
