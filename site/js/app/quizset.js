/* A quiz's questions and its scoring, apart from any room or page: cleaned the same way whether they come from this
   device's library, a file someone made, or the room (where only the owner and co-hosts write them, but every device
   checks what it reads). Nothing here touches the page, so the tests run it as it is.

   A set: { t: title, q: [question] }. A question: { t: the question, o: up to 4 options, c: which options are right
   (one or more), d: seconds to answer, p: points (0 none, 1 standard, 2 double) }. A question as asked in the room
   leaves out c, and an option left empty in the editor is left out, so o has 2 to 4 entries there.
   A question may have a picture: in a set (the library, a file) img = { d: the JPEG as base64url, w, h }; in the room
   the picture is in R2 and the question has im = { f: its id there, w, h } instead (quiz.js puts it there). */

export const QUIZ = {
  title: 60, question: 200, option: 80, options: 4, questions: 100,
  times: [5, 10, 20, 30, 60, 90, 120], points: [0, 1, 2],
  lead: 4000,   // ms: each question is out this long before answering opens, so every phone has it first
  grace: 1500,  // ms: an answer sent just in time still gets in (the rules allow the same)
  max: 1000,    // points for a right answer at once; half of it for one in the last moment
  imgEdge: 1024, imgMax: 160000, // a question's picture: at most this many pixels on its long side, and bytes
  imgChars: 220000,              // ...and as base64url, with room to spare
};
export const SHAPES = ["▲", "◆", "●", "■"];
export const FILE_KIND = "stoatalk-quiz";

const str = (x, n) => (typeof x === "string" ? x.trim().slice(0, n) : "");
const pick = (x, list, dflt) => (list.includes(x) ? x : dflt);
export const pad = (i) => String(i).padStart(2, "0");
const size = (x) => { const w = Math.round(+x.w), h = Math.round(+x.h); return w > 0 && h > 0 && w <= 4096 && h <= 4096 ? { w, h } : null; };
// a question's picture as a set keeps it, or null
export function cleanImg(x) {
  if (!x || typeof x !== "object" || typeof x.d !== "string" || !x.d || x.d.length > QUIZ.imgChars || !/^[A-Za-z0-9_-]+$/.test(x.d)) return null;
  const wh = size(x);
  return wh && { d: x.d, ...wh };
}
// ...and as the room has it: where it is in R2 (its id starts with the quiz's; worker/src/index.js QUIZ_IMG)
export const IMG_ID = /^[A-Za-z0-9_-]{20}[A-Za-z0-9]{10}$/;
export function cleanImgRef(x) {
  if (!x || typeof x !== "object" || typeof x.f !== "string" || !IMG_ID.test(x.f)) return null;
  const wh = size(x);
  return wh && { f: x.f, ...wh };
}
const withImg = (q, x) => { const img = cleanImg(x.img), im = cleanImgRef(x.im); if (img) q.img = img; if (im) q.im = im; return q; };

export const blankQuestion = () => ({ t: "", o: ["", "", "", ""], c: [0], d: 20, p: 1 });
// one question as kept in a set (o padded to 4 slots, for the editor), or null when it isn't one
export function cleanQuestion(x) {
  if (!x || typeof x !== "object") return null;
  const o = (Array.isArray(x.o) ? x.o : []).slice(0, QUIZ.options).map((s) => str(s, QUIZ.option));
  while (o.length < QUIZ.options) o.push("");
  const c = [...new Set((Array.isArray(x.c) ? x.c : [x.c]).filter((k) => Number.isInteger(k) && k >= 0 && k < QUIZ.options))].sort();
  return withImg({ t: str(x.t, QUIZ.question), o, c, d: pick(x.d, QUIZ.times, 20), p: pick(x.p, QUIZ.points, 1) }, x);
}
export function cleanSet(x) {
  if (!x || typeof x !== "object") return null;
  return { t: str(x.t, QUIZ.title), q: (Array.isArray(x.q) ? x.q : []).slice(0, QUIZ.questions).map(cleanQuestion).filter(Boolean) };
}
// what keeps a question from being asked: no words, fewer than two options, or no right one among them
export function problem(q) {
  if (!q.t) return "qzNeedQ";
  if (q.o.filter(Boolean).length < 2) return "qzNeedOpts";
  if (!q.c.some((k) => q.o[k])) return "qzNeedRight";
  return null;
}
// the first thing to fix before a set can be played: { i (the question, or -1 for the set), why }, or null
export function setProblem(set) {
  if (!set.t) return { i: -1, why: "qzNeedTitle" };
  if (!set.q.length) return { i: -1, why: "qzNeedOne" };
  const i = set.q.findIndex(problem);
  return i < 0 ? null : { i, why: problem(set.q[i]) };
}
// a question as it's asked (no right answers, no empty options) and its right answers in that order of options
export function asked(q) {
  const keep = q.o.map((s, k) => (s ? k : -1)).filter((k) => k >= 0);
  return [{ t: q.t, o: keep.map((k) => q.o[k]), d: q.d, p: q.p, ...(q.im ? { im: q.im } : {}) }, keep.map((k, n) => (q.c.includes(k) ? n : -1)).filter((n) => n >= 0)];
}

/* ---------- read from the room ---------- */
// a question as asked, or null
export function cleanAsked(x) {
  if (!x || typeof x !== "object") return null;
  const o = (Array.isArray(x.o) ? x.o : []).slice(0, QUIZ.options).map((s) => str(s, QUIZ.option));
  if (o.length < 2) return null;
  const q = { t: str(x.t, QUIZ.question), o, d: pick(x.d, QUIZ.times, 20), p: pick(x.p, QUIZ.points, 1) }, im = cleanImgRef(x.im);
  return im ? { ...q, im } : q;
}
export const cleanKey = (x) => (Array.isArray(x) ? [...new Set(x.filter((k) => Number.isInteger(k) && k >= 0 && k < QUIZ.options))] : []);
export function cleanLive(x) {
  if (!x || typeof x !== "object" || !/^(lobby|q|rev|end)$/.test(x.ph) || !/^[0-9]{2}$/.test(x.i)) return null;
  return { ph: x.ph, i: x.i, at: +x.at || 0, d: +x.d || 0, n: Math.min(Math.max(+x.n || 1, 1), QUIZ.questions), lock: x.lock === true };
}
const numMap = (m, hi) => Object.fromEntries(Object.entries(m && typeof m === "object" ? m : {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.min(Math.max(Math.round(v), 0), hi)]));
// the scores after a question: n (how many picked each option), g (points each player got for it), sc (each player's
// total so far), r (their right answers so far), ms (their time on right answers so far, which breaks ties)
export function cleanScores(x) {
  if (!x || typeof x !== "object") return null;
  return { n: (Array.isArray(x.n) ? x.n : []).slice(0, QUIZ.options).map((v) => Math.max(0, Math.round(+v || 0))),
    g: numMap(x.g, QUIZ.max * 2), sc: numMap(x.sc, QUIZ.max * 2 * QUIZ.questions), r: numMap(x.r, QUIZ.questions), ms: numMap(x.ms, 864e5) };
}
export const cleanPlayer = (x) => (x && typeof x === "object" ? { n: str(x.n, 24) || "？", a: str(x.a, 8) || "👤" } : null);
export const cleanChoice = (x) => (Number.isInteger(x) && x >= 0 && x < QUIZ.options ? x : null);

/* ---------- scoring ---------- */
// a right answer's points: all of them at once, half in the last moment; none for a wrong one
export function points(q, ms) {
  const t = Math.min(Math.max(ms, 0), q.d * 1000) / (q.d * 1000);
  return Math.round(QUIZ.max * q.p * (1 - t / 2));
}
// the scores after a question: q as asked, key its right answers, answers { uid: { c, at } } (server times), players
// { uid }, before: the scores after the question before (or null), at: when answering opened
export function settle(q, key, answers, players, before, at) {
  const out = { n: q.o.map(() => 0), g: {}, sc: {}, r: {}, ms: {} };
  for (const uid of Object.keys(players)) {
    const a = answers[uid], right = !!a && key.includes(a.c), ms = a ? Math.max(0, a.at - at) : 0;
    if (a && a.c < out.n.length) out.n[a.c]++;
    out.g[uid] = right ? points(q, ms) : 0;
    out.sc[uid] = (before?.sc[uid] || 0) + out.g[uid];
    out.r[uid] = (before?.r[uid] || 0) + (right ? 1 : 0);
    out.ms[uid] = (before?.ms[uid] || 0) + (right ? Math.min(ms, q.d * 1000) : 0);
  }
  return out;
}
// everyone best first: more points, then less time on right answers; the same place on a tie
export function ranking(s) {
  const list = Object.keys(s?.sc || {}).map((uid) => ({ uid, s: s.sc[uid], r: s.r[uid] || 0, ms: s.ms[uid] || 0 })).sort((a, b) => b.s - a.s || a.ms - b.ms);
  list.forEach((r, i) => (r.rank = i && list[i - 1].s === r.s && list[i - 1].ms === r.ms ? list[i - 1].rank : i + 1));
  return list;
}

/* ---------- a file to keep, or to bring into another room ---------- */
// (a picture goes in the file itself; where a room kept one means nothing anywhere else)
const noRef = ({ im, ...q }) => q;
export const toFile = (set) => JSON.stringify({ kind: FILE_KIND, v: 1, t: set.t, q: set.q.map((q) => noRef(cleanQuestion(q))) }, null, 1);
// a file's set, or null when it isn't one
export function fromFile(text) {
  let x;
  try { x = JSON.parse(text); } catch (e) { return null; }
  if (!x || x.kind !== FILE_KIND || !Array.isArray(x.q)) return null;
  const set = cleanSet(x);
  set.q = set.q.map(noRef);
  return set.q.length ? set : null;
}
// the scores as a spreadsheet: rank, name, points, right answers
export function scoresCsv(rows, head) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return "﻿" + [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
