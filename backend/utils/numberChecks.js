/**
 * @file numberChecks.js
 * @description Spotting numbers that were probably typed wrong (D54).
 *
 * The front desk types a client's number at every visit. A slipped digit makes
 * the same person look like two clients, which splits their history and, worse,
 * makes payment tracking confusing: the money is real but it sits under a
 * number nobody will search for. These helpers decide when two numbers are
 * "close enough to be the same person's typo" and when a number cannot be real.
 *
 * Pure functions, no database: the route feeds them grouped visits. The same
 * rules produced the August/September PDF review, so the tab and the report
 * agree.
 */

/** Digits only, Indian country code dropped, last 10 kept. */
const last10 = (c) => {
  const d = String(c ?? "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
};

/** A real Indian mobile: 10 digits, first digit 6–9. */
const isValidPhone = (c) => /^[6-9]\d{9}$/.test(last10(c)) && String(c ?? "").replace(/\D/g, "").length <= 12;

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** "identical" | "similar" | null */
function nameMatch(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return null;
  if (x === y || x.replace(/ /g, "") === y.replace(/ /g, "")) return "identical";
  if (levenshtein(x, y) <= 3) return "similar";
  const [tx, ty] = [x.split(" "), y.split(" ")];
  if (tx[0] === ty[0] || tx[0].startsWith(ty[0]) || ty[0].startsWith(tx[0])) return "similar"; // surname dropped / nickname
  return null;
}

/** What differs between two 10-digit numbers, or null if they are not close. */
function phoneDiff(a, b) {
  if (a.length !== 10 || b.length !== 10) return null;
  const at = [];
  for (let i = 0; i < 10; i++) if (a[i] !== b[i]) at.push(i);
  if (at.length === 1) return { kind: 1, text: `digit ${at[0] + 1}: ${a[at[0]]} → ${b[at[0]]}` };
  if (at.length === 2 && at[1] === at[0] + 1 && a[at[0]] === b[at[1]] && a[at[1]] === b[at[0]]) {
    return { kind: "swap", text: `digits ${at[0] + 1}–${at[1] + 1} swapped (${a.slice(at[0], at[1] + 1)} → ${b.slice(at[0], at[1] + 1)})` };
  }
  if (at.length >= 2 && at.length <= 3) return { kind: at.length, text: at.map((i) => `digit ${i + 1}: ${a[i]} → ${b[i]}`).join("; ") };
  return null;
}

/**
 * Are these two numbers (with the names typed against them) a probable typo
 * pair? Strong = same name; otherwise only a near-identical name with a very
 * small number difference, so unrelated people are not flagged.
 */
function typoPair(keyA, nameA, keyB, nameB) {
  const diff = phoneDiff(keyA, keyB);
  if (!diff) return null;
  const nm = nameMatch(nameA, nameB);
  if (!nm) return null;
  if (nm === "identical") return { diff, name: "identical", confidence: diff.kind === 1 || diff.kind === "swap" ? "high" : "medium" };
  if (diff.kind === 1 || diff.kind === 2 || diff.kind === "swap") return { diff, name: "similar", confidence: "medium" };
  return null;
}

module.exports = { last10, isValidPhone, levenshtein, norm, nameMatch, phoneDiff, typoPair };
