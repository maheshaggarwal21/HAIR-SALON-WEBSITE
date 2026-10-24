/**
 * @file posterMatch.js
 * @description Match the service names printed on a poster ("Paragon Facial", "Headwash",
 * "Full Arm Wax (Rica)") to the salon's own menu, so a bundle can be built from them.
 *
 * It only SUGGESTS: every line comes back with its best match (when it is clear) and up to
 * three alternatives, and the owner confirms or changes each one before anything is saved.
 * A line with no good match is returned unmatched, never forced onto a wrong service.
 *
 * Plain word matching, no AI: spelling variants are folded together (headwash = head wash),
 * plurals are dropped (lips = lip), a one-letter typo in a long word is forgiven, and the score
 * is how much of the poster line and the menu name agree.
 */

const ALIASES = [
  [/\bhead ?wash(ing)?\b/g, "head wash"],
  [/\bblow ?dry(ing)?\b/g, "blow dry"],
  [/\bblow ?dry\b/g, "blow dry"],
  [/\bblowdry\b/g, "blow dry"],
  [/\bhair ?spa\b/g, "hair spa"],
  [/\bupper ?lips?\b/g, "upper lip"],
  [/\bfore ?head\b/g, "forehead"],
  [/\bde ?-? ?tan\b/g, "d tan"],
  [/\bpedi( cure)?\b/g, "pedicure"],
  [/\bmani( cure)?\b/g, "manicure"],
  [/\bfull ?(arms?)\b/g, "full arm"],
  [/\bfull ?(legs?)\b/g, "full leg"],
  [/\bhalf ?(arms?)\b/g, "half arm"],
  [/\bhalf ?(legs?)\b/g, "half leg"],
  [/\bwaxing\b/g, "wax"],
  [/\bthreading\b/g, "threading"],
];
const STOP = new Set(["and", "the", "of", "for", "with", "a", "service", "services"]);

function tokens(raw) {
  let s = String(raw ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  for (const [re, to] of ALIASES) s = s.replace(re, to);
  return s
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 1) return 2;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[n];
}

const sameToken = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);

/** 0..1: how well the poster line and a menu name agree (Dice over words, typo-tolerant). */
function score(lineTokens, nameTokens) {
  if (!lineTokens.length || !nameTokens.length) return 0;
  const used = new Set();
  let hits = 0;
  for (const t of lineTokens) {
    const j = nameTokens.findIndex((n, k) => !used.has(k) && sameToken(t, n));
    if (j >= 0) {
      used.add(j);
      hits += 1;
    }
  }
  return (2 * hits) / (lineTokens.length + nameTokens.length);
}

const CLEAR = 0.6; // a best match at least this good, and clearly ahead of the next, is pre-selected
const POSSIBLE = 0.34; // below this a menu item is not even offered as an alternative

/**
 * @param {string} line  as printed on the poster
 * @param {{_id: any, name: string, publicName?: string|null, publicPrice: number}[]} menu
 */
function matchLine(line, menu) {
  const lt = tokens(line);
  const scored = menu
    .map((s) => {
      const a = score(lt, tokens(s.name));
      const b = s.publicName ? score(lt, tokens(s.publicName)) : 0;
      return { s, score: Math.max(a, b) };
    })
    .filter((x) => x.score >= POSSIBLE)
    .sort((x, y) => y.score - x.score || x.s.name.length - y.s.name.length)
    .slice(0, 4);
  // "covers": every word of the printed line is in this menu name (so "Bleach" is covered by "Bleach (Full Body)").
  const covers = (x) => lt.length > 0 && [x.s.name, x.s.publicName].filter(Boolean).some((n) => { const nt = tokens(n); return lt.every((t) => nt.some((m) => sameToken(t, m))); });
  const view = (x) => ({ serviceId: String(x.s._id), name: x.s.publicName || x.s.name, price: x.s.publicPrice, score: Math.round(x.score * 100) / 100, covers: covers(x) });
  const [best, next] = scored;
  const clear = best && best.score >= CLEAR && (!next || best.score - next.score >= 0.12 || best.score === 1);
  return { line, match: clear ? view(best) : null, candidates: scored.map(view) };
}

module.exports = { matchLine, tokens, score };
