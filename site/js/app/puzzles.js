/* The puzzles behind the mini-games, with no page in sight: making one from a seed, checking a move, scoring a
   finished game and checking a score someone else wrote. Everyone in a room gets the same puzzle each day, because
   it's made from the room's code and the day, the same way on every device; so a score can be checked by playing
   its record back on another device, and one that doesn't add up isn't shown.

     mm  密碼鎖 / Code Lock: guess a code of 4 colours out of 6 (repeats allowed) in at most 8 tries; each try says
         how many are the right colour in the right place, and how many the right colour in the wrong place.
     qn  皇后格 / Crowns: a 7×7 board in 7 coloured areas; one crown in each row, column and area, and no two
         crowns touching, not even corner to corner. There's exactly one way to do it.
     zp  一筆連 / One Line: one line through every square of a 6×6 board, starting at 1 and passing the numbered
         squares in order. There's exactly one such line. */

// a number from a string (FNV-1a), and a stream of random numbers in [0, 1) from it (mulberry32)
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : hash(String(seed));
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const below = (r, n) => Math.floor(r() * n);
const shuffled = (r, list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = below(r, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// a day's puzzles change at midnight in Taiwan (UTC+8): "2026-10-22"
export const TZ_MS = 8 * 3600e3;
export const dayOf = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
export const DAY_RE = /^20\d\d-[01]\d-[0-3]\d$/;
// the seed of a room's puzzle of the day; practice rounds use any other seed
export const seedOf = (code, day, g) => `${code}|${day}|${g}`;

/* ---------- 密碼鎖 Code Lock ---------- */
export const MM = { pegs: 4, colours: 6, tries: 8 };
export const mmSecret = (seed) => { const r = rng(seed + "|mm"); return Array.from({ length: MM.pegs }, () => below(r, MM.colours)).join(""); };
// [right place, right colour wrong place] for a guess against the code, both as strings of digits
export function mmMark(guess, code) {
  let exact = 0; const g = [], c = [];
  for (let i = 0; i < code.length; i++) if (guess[i] === code[i]) exact++; else { g.push(guess[i]); c.push(code[i]); }
  let near = 0;
  for (const x of g) { const k = c.indexOf(x); if (k >= 0) { near++; c.splice(k, 1); } }
  return [exact, near];
}
const MM_GUESS = /^[0-5]{4}$/;

/* ---------- 皇后格 Crowns ---------- */
export const QN = { n: 7 };
// the crowns' columns, row by row, that fit the areas (a list of n*n area numbers); stops counting at `cap`
export function qnSolve(areas, n, cap = 2) {
  const cols = [], usedC = new Set(), usedA = new Set(), out = [];
  const go = (row) => {
    if (out.length >= cap) return;
    if (row === n) { out.push([...cols]); return; }
    for (let c = 0; c < n; c++) {
      const a = areas[row * n + c];
      if (usedC.has(c) || usedA.has(a) || (row && Math.abs(cols[row - 1] - c) < 2)) continue;
      cols.push(c); usedC.add(c); usedA.add(a);
      go(row + 1);
      cols.pop(); usedC.delete(c); usedA.delete(a);
    }
  };
  go(0);
  return out;
}
// a board with exactly one answer: crowns placed at random, each grows an area around itself until the board is
// covered, and boards with more than one answer are thrown back
export function qnPuzzle(seed) {
  const r = rng(seed + "|qn"), n = QN.n;
  for (let tries = 0; ; tries++) {
    const cols = [];
    const place = (row) => {
      if (row === n) return true;
      for (const c of shuffled(r, [...Array(n).keys()])) {
        if (cols.includes(c) || (row && Math.abs(cols[row - 1] - c) < 2)) continue;
        cols.push(c); if (place(row + 1)) return true; cols.pop();
      }
      return false;
    };
    place(0);
    const areas = Array(n * n).fill(-1);
    cols.forEach((c, row) => (areas[row * n + c] = row));
    let left = n * n - n;
    while (left) {
      const i = below(r, n * n);
      if (areas[i] !== -1) continue;
      const x = i % n, y = (i / n) | 0;
      const near = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < n && b < n && areas[b * n + a] !== -1);
      if (!near.length) continue;
      const [a, b] = near[below(r, near.length)];
      areas[i] = areas[b * n + a]; left--;
    }
    const answers = qnSolve(areas, n);
    if (answers.length === 1) return { n, areas, cols: answers[0], tries };
  }
}
// two crowns (cell numbers) clash: same row, column or area, or touching
export const qnClash = (p, a, b) => {
  const n = p.n, ax = a % n, ay = (a / n) | 0, bx = b % n, by = (b / n) | 0;
  return a !== b && (ax === bx || ay === by || p.areas[a] === p.areas[b] || (Math.abs(ax - bx) < 2 && Math.abs(ay - by) < 2));
};

/* ---------- 一筆連 One Line ---------- */
export const ZP = { n: 6, budget: 30000 }; // budget: the most steps spent proving a board has only one line
const zpNext = (n, i) => { const x = i % n, y = (i / n) | 0, out = []; if (x) out.push(i - 1); if (x < n - 1) out.push(i + 1); if (y) out.push(i - n); if (y < n - 1) out.push(i + n); return out; };
// the lines through every square that pass the numbered squares in order (nums: square -> its number, 1 first);
// stops at `cap` lines, or after `budget` steps, which it then marks with over = true (so not proven the only one)
export function zpSolve(n, nums, cap = 2, budget = Infinity) {
  const total = n * n, last = nums.size, seen = new Uint8Array(total), path = [], out = [];
  let start = -1, end = -1;
  for (const [i, k] of nums) { if (k === 1) start = i; if (k === last) end = i; }
  // a square's colour on a chessboard: the line alternates colours, so what's left must balance out
  const dark = (i) => ((i % n) + ((i / n) | 0)) & 1;
  let steps = 0;
  // the squares not yet on the line must hang together, the next one along the line must be the other colour, and
  // a square with only one way in left can only be where the line ends
  const fine = (head) => {
    let free = 0, from = -1, bal = 0;
    for (let i = 0; i < total; i++) if (!seen[i]) { free++; if (from < 0) from = i; bal += dark(i) !== dark(head) ? 1 : -1; }
    if (!free) return true;
    if (bal !== 0 && bal !== 1) return false;
    const reach = new Uint8Array(total), stack = [from]; reach[from] = 1; let got = 1;
    while (stack.length) {
      const i = stack.pop();
      let deg = 0;
      for (const j of zpNext(n, i)) {
        if (j === head) deg++;
        if (seen[j]) continue;
        deg++;
        if (!reach[j]) { reach[j] = 1; got++; stack.push(j); }
      }
      if (deg < 2 && i !== end) return false;
    }
    return got === free;
  };
  const go = (i, want) => {
    if (out.length >= cap || ++steps > budget) return;
    seen[i] = 1; path.push(i);
    if (path.length === total) { if (i === end) out.push([...path]); }
    else if (i !== end && fine(i)) for (const j of zpNext(n, i)) {
      if (seen[j]) continue;
      const k = nums.get(j);
      if (k && k !== want) continue;
      go(j, k ? want + 1 : want);
    }
    seen[i] = 0; path.pop();
  };
  go(start, 2);
  out.over = steps > budget;
  return out;
}
// a random line through every square (a walk that prefers squares with the fewest ways on)
function zpLine(r, n) {
  const total = n * n;
  for (;;) {
    const seen = new Uint8Array(total), path = [below(r, total)];
    seen[path[0]] = 1;
    let steps = 0;
    const go = () => {
      if (path.length === total) return true;
      if (++steps > 20000) return false;
      const head = path[path.length - 1];
      const opts = shuffled(r, zpNext(n, head).filter((j) => !seen[j]))
        .map((j) => [j, zpNext(n, j).filter((k) => !seen[k] && k !== j).length]).sort((a, b) => a[1] - b[1]);
      for (const [j] of opts) { seen[j] = 1; path.push(j); if (go()) return true; seen[j] = 0; path.pop(); }
      return false;
    };
    if (go()) return path;
  }
}
// a board with exactly one line: numbers at its two ends and along it, more where another line would also fit,
// then as many taken away again as can be while it stays the only one
export function zpPuzzle(seed) {
  const r = rng(seed + "|zp"), n = ZP.n, total = n * n, line = zpLine(r, n);
  const at = new Set([0, total - 1]);
  for (let k = 0; k < 4; k++) at.add(1 + below(r, total - 2));
  const numsOf = (s) => new Map([...s].sort((a, b) => a - b).map((k, i) => [line[k], i + 1]));
  const only = (s) => { const found = zpSolve(n, numsOf(s), 2, ZP.budget); return found.length === 1 && !found.over ? null : found; };
  for (let found; (found = only(at)); ) {
    const other = found.find((p) => p.some((x, k) => x !== line[k]));
    if (other) { // where the other line first turns off, number both squares: the two lines pass them in opposite orders
      const k = other.findIndex((x, i) => x !== line[i]);
      at.add(k); at.add(line.indexOf(other[k]));
    } else at.add(1 + below(r, total - 2)); // a search too long to finish: one more number anywhere
  }
  for (const k of shuffled(r, [...at])) {
    if (k === 0 || k === total - 1 || at.size <= 6) continue;
    at.delete(k);
    if (only(at)) at.add(k);
  }
  const nums = numsOf(at);
  return { n, nums, line, last: nums.size };
}

/* ---------- scores ----------
   Each game scores 0 to 100. A record (rec) is what goes to the room: s the score, t the time played in seconds (only
   breaks ties), h hints taken, m mistakes, l the game played back (mm: the tries "0123,4512"; qn: the crowns'
   columns row by row "3150624"; zp: the line's squares as base-36 digits). */
export const GAMES = ["mm", "qn", "zp"];
export const scoreMm = (tries, solved) => (solved ? Math.max(16, 100 - 12 * (tries - 1)) : 0);
export const scoreHints = (h, m = 0) => Math.max(10, 100 - 20 * h - 5 * m);
const LOG_RE = { mm: /^[0-5]{4}(,[0-5]{4}){0,7}$/, qn: /^[0-6]{7}$/, zp: /^[0-9a-z]{36}$/ };
export function puzzleOf(g, seed) { return g === "mm" ? { code: mmSecret(seed) } : g === "qn" ? qnPuzzle(seed) : zpPuzzle(seed); }
// the score a record should have for this puzzle, or null when it doesn't add up
export function checkScore(g, p, rec) {
  if (!rec || typeof rec.l !== "string" || !LOG_RE[g]?.test(rec.l)) return null;
  const h = rec.h || 0, m = rec.m || 0;
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) return null;
  if (g === "mm") {
    const tries = rec.l.split(","), hit = tries.indexOf(p.code);
    if (hit >= 0 && hit !== tries.length - 1) return null;
    if (hit < 0 && tries.length < MM.tries) return null;
    return scoreMm(tries.length, hit >= 0);
  }
  if (g === "qn") return rec.l === p.cols.join("") ? scoreHints(h, m) : null;
  if (g === "zp") return rec.l === p.line.map((i) => i.toString(36)).join("") ? scoreHints(h) : null;
  return null;
}
export const LINE_DIGITS = (line) => line.map((i) => i.toString(36)).join("");
export { MM_GUESS };
