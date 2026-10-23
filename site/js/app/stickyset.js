/* Sticky-note boards (sticky.js) apart from the page: what a board holds, cleaned as it comes in, where a note lands when
   it moves, how the votes add up, and the board as a file. Nothing here touches the room or the screen. */
import { str, arr, isObj } from "./clean.js?v=dev";

// the same limits as the rules (tools/rules.py BOARD); lim (notes each person may put up) and max are kept by the page
export const BOARD = { title: 60, text: 200, col: 30, cols: 6, colours: 6, votes: [1, 3, 5], lims: [3, 5, 10, 20], max: 300 };
// the columns a board can start with, by the names' text keys (written into the board in the host's language)
export const TEMPLATES = {
  one: ["sbColIdeas"],
  pros: ["sbColPros", "sbColCons"],
  kpt: ["sbColKeep", "sbColProblem", "sbColTry"],
  retro: ["sbColWell", "sbColBetter", "sbColAction"],
};
export const PHASES = ["add", "vote", "done"];
const NOTE_ID = /^[\w-]{20}$/;   // a note's id is a push key

// where a board is at: ph, the votes each person has (v), the notes each may put up (lim), anonymous (an), paused (lock)
export const cleanLive = (x) => (isObj(x) && PHASES.includes(x.ph) ? {
  ph: x.ph, v: BOARD.votes.includes(x.v) ? x.v : 3, lim: BOARD.lims.includes(x.lim) ? x.lim : 10, an: x.an !== false, lock: x.lock === true,
} : null);
// the columns, [{ k, n }] in order, each key once
export function cleanCols(x) {
  const out = [], seen = new Set();
  for (const c of arr(x)) {
    const k = typeof c?.k === "string" && /^[0-5]$/.test(c.k) ? c.k : null;
    if (k && !seen.has(k)) { seen.add(k); out.push({ k, n: str(c.n, BOARD.col) }); }
  }
  return out.slice(0, BOARD.cols);
}
// a note as stored (v), its words and name from v itself in a plain room or from what its x opened to (p) in a Private Salon
export function cleanNote(v, p) {
  if (!isObj(v)) return null;
  const w = v.x ? p : v;
  if (!isObj(w)) return null;
  const text = str(w.t, BOARD.text);
  if (!text) return null;
  const name = str(v.x ? w.n : v.nm, 24), av = str(v.x ? w.a : v.av, 8);
  return {
    t: text, c: /^[0-5]$/.test(v.c) ? +v.c : 0, k: /^[0-5]$/.test(v.k) ? v.k : "0",
    o: typeof v.o === "string" && /^[0-9a-z]{1,40}$/.test(v.o) ? v.o : "i", at: +v.at || 0,
    ...(name ? { nm: name, av: av || "👤" } : {}),
  };
}
// someone's votes, as stored ("a,a,b") or opened: the notes picked, one entry per vote, at most `most` of them
export const cleanPicks = (s, most) => (typeof s === "string" && s ? s.split(",").filter((id) => NOTE_ID.test(id)).slice(0, most) : []);

/* ---------- a note's place in its column ----------
   Each note carries a string (o) that sorts it among its neighbours; moving one writes only its own, made to sort between
   the two it lands between. The digits never end in 0, so there is always room for one more in between. */
const DIG = "0123456789abcdefghijklmnopqrstuvwxyz";
export function between(a = "", b = null) {
  if (b != null && b <= a) b = null;
  let out = "";
  for (let i = 0; ; i++) {
    const lo = i < a.length ? DIG.indexOf(a[i]) : 0;
    const hi = b != null && i < b.length ? DIG.indexOf(b[i]) : DIG.length;
    if (hi - lo > 1) return out + DIG[Math.floor((lo + hi) / 2)];
    out += DIG[lo];
    if (lo < hi) b = null; // past where they differ, anything above a will do
  }
}
// notes in the order they sit: by place, then by when they went up
export const byPlace = (a, b) => (a.o < b.o ? -1 : a.o > b.o ? 1 : a.at - b.at || (a.id < b.id ? -1 : 1));
// the place for a note going in at position i of a column's notes (in order, without the note itself)
export const placeAt = (list, i) => between(list[i - 1]?.o || "", list[i]?.o ?? null);

/* ---------- the result ---------- */
// votes per note: { note: n }, counting each person's first `most` picks, on notes still there
export function tally(ballots, notes, most) {
  const out = {};
  for (const picks of Object.values(ballots || {})) for (const id of picks.slice(0, most)) if (notes.has(id)) out[id] = (out[id] || 0) + 1;
  return out;
}
// every note with its column, best first (votes, then place); cols decides which column a stray note counts in
export function ranked(cols, notes, counts) {
  const keys = new Set(cols.map((c) => c.k));
  return [...notes].map(([id, n]) => ({ id, ...n, k: keys.has(n.k) ? n.k : cols[0]?.k || "0", v: counts[id] || 0 }))
    .sort((a, b) => b.v - a.v || byPlace(a, b));
}
const csvCell = (x) => (/[",\n\r]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
// the board as a CSV file (a spreadsheet opens it): column, note, votes, and who wrote it on a named board
export function boardCsv(cols, rows, head, named) {
  const name = Object.fromEntries(cols.map((c) => [c.k, c.n]));
  const lines = [head.slice(0, named ? 4 : 3), ...cols.flatMap((c) => rows.filter((r) => r.k === c.k).map((r) => [c.n, r.t, r.v, ...(named ? [r.nm || ""] : [])]))];
  return "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
// ...and as Markdown: a heading per column, a line per note with its votes (votes: the words for "n votes")
export function boardMd(title, cols, rows, votes, named) {
  return `# ${title}\n` + cols.map((c) => `\n## ${c.n}\n\n` + (rows.filter((r) => r.k === c.k)
    .map((r) => `- ${r.t.replace(/\s*\n\s*/g, " ")}${r.v ? ` (${votes(r.v)})` : ""}${named && r.nm ? ` — ${r.nm}` : ""}`).join("\n") || "-")).join("\n") + "\n";
}
