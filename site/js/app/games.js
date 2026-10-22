/* Mini-games: three short puzzles to pass the time before a meeting (puzzles.js makes them, boards.js draws them).
   Everyone in a room gets the same puzzle of each game each day, and plays it once for a score of 0 to 100; time
   only breaks ties. The scores sit in games/{day}/{game}/{uid} (sealed in a Private Salon), written once and never
   changed, and make the room's leaderboard for today and for the week. A score is checked on every device by
   playing its record back, and one that doesn't add up is left off. Sharing a result to the chat is up to the
   player: a card with the score and no spoilers, and a button for others to play the same puzzle. Practice rounds
   (after today's) don't count and stay on the device. The owner can turn games off for the room (meta/ng). */
import { t } from "./text.js?v=dev";
import { el, sheet, toast, icon, pause, busy } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { post } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";
import { GAMES, MM, dayOf, seedOf, puzzleOf, checkScore, scoreMm, scoreHints, mmMark, LINE_DIGITS } from "./puzzles.js?v=dev";
import { mmBoard, qnBoard, zpBoard, markDots } from "./boards.js?v=dev";

export const GAME = {
  mm: { name: "gmMm", rule: "gmMmRule", help: "gmMmHelp", icon: "lock", board: mmBoard },
  qn: { name: "gmQn", rule: "gmQnRule", help: "gmQnHelp", icon: "owner", board: qnBoard, hint: true },
  zp: { name: "gmZp", rule: "gmZpRule", help: "gmZpHelp", icon: "route", board: zpBoard, hint: true },
};
const WEEK = 7;
export const today = () => dayOf(backend.now());
export const gamesOn = () => !!room && !room.meta?.ng;
const canPlay = () => gamesOn() && !room.gone && !room.readOnly;
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const shortDay = (d) => `${+d.slice(5, 7)}/${+d.slice(8)}`;

// puzzles are the same everywhere, so each is made once per visit
const made = new Map();
const puzzle = (g, seed) => { if (!made.has(seed)) made.set(seed, puzzleOf(g, seed)); return made.get(seed); };
// a record as finished on this device: [what goes to the room, what the share card shows]
function result(g, p, st) {
  const t_ = Math.round((st.ms || 0) / 1000);
  if (g === "mm") {
    const solved = st.tries.includes(p.code), n = st.tries.length, s = scoreMm(n, solved);
    return [{ s, t: t_, l: st.tries.join(",") }, { s, t: t_, n, r: st.tries.map((x) => mmMark(x, p.code).join("")).join(",") }];
  }
  const s = scoreHints(st.h, g === "qn" ? st.m : 0), l = g === "qn" ? p.cols.join("") : LINE_DIGITS(p.line);
  const out = { s, t: t_, ...(st.h ? { h: st.h } : {}), ...(g === "qn" && st.m ? { m: st.m } : {}) };
  return [{ ...out, l }, out];
}

/* ---------- the scores ---------- */
const aad = (day, g, uid) => `g:${day}:${g}:${uid}`;
// everyone's checked scores of a day: { g: { uid: { s, t, h, m } } }
async function dayScores(day) {
  const raw = (await backend.val(room.api.ref("games/" + day))) || {}, out = {};
  for (const g of GAMES) {
    out[g] = {};
    for (const [uid, v] of Object.entries(raw[g] || {})) {
      const rec = v?.x ? room.cipher && (await room.cipher.unseal(v.x, aad(day, g, uid))) : v;
      if (!rec || typeof rec.s !== "number") continue;
      await pause(0); // making a puzzle can take a moment: let the page breathe in between
      if (checkScore(g, puzzle(g, seedOf(room.code, day, g)), rec) === rec.s) out[g][uid] = { s: rec.s, t: +rec.t || 0, h: rec.h || 0, m: rec.m || 0 };
    }
  }
  return out;
}
async function myRecord(day, g) {
  const v = await backend.val(room.api.ref(`games/${day}/${g}/${backend.uid}`));
  if (!v) return null;
  return v.x ? room.cipher && room.cipher.unseal(v.x, aad(day, g, backend.uid)) : v;
}
function saveScore(day, g, rec) {
  const at = backend.stamp();
  return (room.cipher ? room.cipher.seal(rec, aad(day, g, backend.uid)).then((x) => ({ x, at })) : Promise.resolve({ ...rec, at }))
    .then((v) => room.api.gameScore(day, g, v));
}
// the leaderboard: the people still here, best first (score, then the shorter time), sharing a place on a tie
function ranking(days, g) {
  const sum = new Map();
  for (const d of days) for (const k of g ? [g] : GAMES) for (const [uid, r] of Object.entries(d[k] || {})) {
    if (!room.members[uid]) continue;
    const a = sum.get(uid) || { uid, s: 0, t: 0, n: 0 };
    a.s += r.s; a.t += r.t; a.n++; sum.set(uid, a);
  }
  const list = [...sum.values()].sort((a, b) => b.s - a.s || a.t - b.t);
  list.forEach((r, i) => (r.rank = i && list[i - 1].s === r.s && list[i - 1].t === r.t ? list[i - 1].rank : i + 1));
  return list;
}
function board(rows, single) {
  if (!rows.length) return el("p", { class: "muted small lbnone", text: t("gmNone") });
  return el("ol", { class: "lb" }, rows.map((r) => {
    const m = room.who(r.uid);
    return el("li", { class: r.uid === backend.uid ? "you" : null },
      el("span", { class: "rk", text: r.rank }),
      el("span", { class: "who", text: `${m.avatar} ${m.name}` }),
      el("small", { class: "muted", text: single ? clock(r.t) : t("gmRounds", { n: r.n }) }),
      el("b", { class: "pts", text: r.s }));
  }));
}

/* ---------- the games sheet: the three games and the leaderboard ---------- */
export async function gamesSheet() {
  if (!room) return;
  const list = el("div", { class: "gmlist" });
  const lbBox = el("div", { class: "lbbox" }, el("p", { class: "muted small", text: t("loading") }));
  let span = "day", which = "";
  const segs = (opts, value, pick) => {
    const seg = el("div", { class: "seg row lbseg", role: "radiogroup" }, opts.map(([v, label]) => el("button", { type: "button", role: "radio", "aria-checked": String(v === value), "data-v": v, text: label })));
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); pick(b.dataset.v);
    });
    return seg;
  };
  let days = null;
  const show = () => { if (days) lbBox.replaceChildren(board(ranking(span === "day" ? days.slice(0, 1) : days, which), span === "day" && !!which)); };
  const note = !gamesOn() ? t("gmOff") : !canPlay() ? t("gmClosed") : null;
  const body = el("div", { class: "games" },
    note ? el("p", { class: "note warn", text: note }) : null,
    list,
    el("h3", { class: "lbh" }, icon("trophy", "sm"), el("span", { text: t("gmBoard") })),
    segs([["day", t("gmDay")], ["week", t("gmWeek")]], span, (v) => { span = v; show(); }),
    segs([["", t("gmAll")], ...GAMES.map((g) => [g, t(GAME[g].name)])], which, (v) => { which = v; show(); }),
    lbBox,
    el("p", { class: "muted small", text: t("gmNew") }));
  const rows = (mine) => list.replaceChildren(...GAMES.map((g) => el("button", { type: "button", class: "gmrow", "data-g": g, disabled: !canPlay() },
    el("span", { class: "gmic" }, icon(GAME[g].icon)),
    el("span", { class: "gmtx" }, el("b", { text: t(GAME[g].name) }), el("small", { class: "muted", text: t(GAME[g].rule) })),
    mine[g] ? el("span", { class: "gmst done" }, icon("check", "sm"), t("gmPts", { n: mine[g].s })) : el("span", { class: "gmst", text: t("gmPlay") }))));
  rows({});
  const picked = sheet(t("games"), body, [["close", t("close")]], {
    onOpen: (ov) => list.addEventListener("click", (e) => { const b = e.target.closest(".gmrow"); if (b && !b.disabled) ov.close("g:" + b.dataset.g); }),
  });
  // the scores come in while the sheet is already up
  (async () => {
    try {
      const all = [];
      for (let k = 0; k < WEEK; k++) all.push(await dayScores(dayOf(backend.now() - k * 864e5)));
      days = all;
      rows(Object.fromEntries(GAMES.map((g) => [g, all[0][g][backend.uid]]).filter(([, r]) => r)));
      show();
    } catch (e) { console.error(e); lbBox.replaceChildren(el("p", { class: "muted small", text: t("tryAgain") })); }
  })();
  const a = await picked;
  if (a?.startsWith("g:")) play(a.slice(2));
}

/* ---------- playing ---------- */
// today's puzzle of game g (practice: a new one that doesn't count)
export async function play(g, { practice = false } = {}) {
  if (!room || !GAME[g]) return;
  if (!canPlay()) return toast(t(gamesOn() ? "gmClosed" : "gmOff"));
  const day = today(), code = room.code;
  if (!practice) {
    busy(true);
    const mine = await myRecord(day, g).finally(() => busy(false));
    if (mine && typeof mine.s === "number") return resultSheet(g, day, mine);
  }
  const seed = practice ? `${code}|practice|${Date.now()}` : seedOf(code, day, g);
  busy(true); await pause(30);
  const p = puzzle(g, seed);
  busy(false);
  const key = practice ? null : KEYS.game(code, day, g);
  dropOldGames(day);
  const st = (key && store.json(key)) || {};
  st.ms ||= 0;
  // time counts only while the game is on screen
  let since = document.hidden ? 0 : performance.now();
  const tick = () => { if (since) { st.ms += performance.now() - since; since = 0; } };
  const vis = () => { if (document.hidden) tick(); else since = performance.now(); };
  document.addEventListener("visibilitychange", vis);
  const save = () => { if (key) { tick(); if (!document.hidden) since = performance.now(); store.set(key, JSON.stringify(st)); } };

  const stat = el("p", { class: "gmstat" });
  const info = () => (g === "mm" ? t("gmTriesLeft", { n: MM.tries - st.tries.length }) : g === "qn" ? t("gmQnStat", { h: st.h, m: st.m }) : t("gmZpStat", { h: st.h, n: p.n * p.n - st.path.length }));
  const end = el("div", { class: "gmend", hidden: true });
  let finished = false;
  const b = GAME[g].board(p, st, { change: () => { save(); stat.textContent = info(); }, done: () => finish() });
  const hintBtn = GAME[g].hint ? el("button", { type: "button", class: "icon", "aria-label": t("gmHint"), title: t("gmHint"), onclick: async () => {
    if (finished) return;
    if (await sheet(t("gmHint"), el("p", { class: "muted", text: t(practice ? "gmHintFree" : "gmHintCost") }), [["no", t("cancel")], ["yes", t("gmHint"), "primary"]]) === "yes") b.hint();
  } }, icon("hint")) : null;
  const close = () => { save(); document.removeEventListener("visibilitychange", vis); ov.remove(); };
  const ov = el("div", { class: "overlay gameov" }, el("div", { class: "gamebox", role: "dialog", "aria-label": t(GAME[g].name) },
    el("header", { class: "gmhead" },
      el("button", { type: "button", class: "icon", "aria-label": t("close"), onclick: close }, icon("close")),
      el("div", { class: "gmttl" }, el("b", { text: t(GAME[g].name) }), el("small", { class: "muted", text: practice ? t("gmPractice") : `${t("gmToday")} · ${shortDay(day)}` })),
      el("button", { type: "button", class: "icon", "aria-label": t("gmHelp"), title: t("gmHelp"), onclick: () => help(g) }, icon("info")),
      hintBtn),
    stat, b.el, end));
  document.body.append(ov);
  stat.textContent = info();
  if (!key || !store.get(key)) help(g, true);

  async function finish() {
    if (finished) return;
    finished = true; tick(); save();
    if (hintBtn) hintBtn.disabled = true;
    ov.firstChild.classList.add("over");
    const [rec, card] = result(g, p, st);
    let saved = practice;
    if (!practice) {
      try { await saveScore(day, g, rec); saved = true; if (key) store.set(key, null); backend.stat("games"); }
      catch (e) { console.error(e); toast(t("tryAgain")); finished = false; return; }
    }
    end.hidden = false;
    end.replaceChildren(resultBox(g, practice ? null : day, card, p),
      el("div", { class: "actions" + (practice ? " pair" : "") },
        !practice && saved ? el("button", { type: "button", class: "btn primary", onclick: () => { share(g, day, card); close(); } }, icon("share"), el("span", { text: t("gmShare") })) : null,
        el("button", { type: "button", class: "btn", onclick: () => { close(); play(g, { practice: true }); }, text: t("gmAgain") }),
        el("button", { type: "button", class: "btn", onclick: close, text: t("close") })));
    end.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  // a game finished before (the score didn't go through): try again straight away
  if (b.over()) finish();
}
function help(g, first) {
  return sheet(t(GAME[g].name), el("div", {}, el("p", { text: t(GAME[g].help) }), first ? el("p", { class: "muted small", text: t("gmFirst") }) : null), [["ok", t("gmPlay"), "primary"]]);
}
// a finished game of today, opened again: the score, and sharing or practice from here
async function resultSheet(g, day, rec) {
  const p = puzzle(g, seedOf(room.code, day, g));
  const card = { s: rec.s, t: rec.t || 0, ...(rec.h ? { h: rec.h } : {}), ...(rec.m ? { m: rec.m } : {}) };
  if (g === "mm" && typeof rec.l === "string") { const tries = rec.l.split(","); card.n = tries.length; card.r = tries.map((x) => mmMark(x, p.code).join("")).join(","); }
  const a = await sheet(t(GAME[g].name), el("div", {}, resultBox(g, day, card, p), el("p", { class: "muted small", text: t("gmNew") })),
    [["again", t("gmAgain")], ["share", t("gmShare"), "primary"]]);
  if (a === "share") share(g, day, card);
  if (a === "again") play(g, { practice: true });
}
const share = (g, day, card) => post(KIND.game, { g, d: day, ...card });

/* ---------- a result: in the game, in a sheet, and as the card in the chat ---------- */
// what a game's score was made of, in a line
export function detail(g, x) {
  const parts = g === "mm" ? [x.s ? t("gmMmIn", { n: x.n }) : t("gmMmFail")]
    : [t("gmHints", { n: x.h || 0 }), g === "qn" ? t("gmMistakes", { n: x.m || 0 }) : null];
  return [...parts, x.t ? t("gmTime", { t: clock(x.t) }) : null].filter(Boolean).join(" · ");
}
const marks = (r) => el("div", { class: "gmmarks", "aria-hidden": "true" }, r.split(",").map((m) => el("span", {}, markDots([+m[0], +m[1]]).map((d) => el("i", { class: "d" + d })))));
function resultBox(g, day, x, p) {
  return el("div", { class: "gmresult" },
    el("div", { class: "gscore" }, el("b", { text: x.s }), el("span", { text: t("gmPtsUnit") })),
    el("small", { class: "pf", text: detail(g, x) }),
    g === "mm" && x.r ? marks(x.r) : null,
    g === "mm" && !x.s && p ? el("p", { class: "muted small", text: t("gmCode") + " " + p.code.split("").map((k) => "●▲■◆★♥"[k]).join(" ") }) : null,
    day ? null : el("small", { class: "muted", text: t("gmPracticeNote") }));
}
// a shared result in the chat (live: in a room, with a button to play the same game)
export function gameCard(x, live) {
  const isToday = live && x.d === today();
  return el("div", { class: "gamebox-card" },
    el("div", { class: "ph" }, el("span", {}, icon(GAME[x.g].icon, "sm"), t(GAME[x.g].name)), el("small", { text: isToday ? t("gmToday") : shortDay(x.d) })),
    el("div", { class: "gscore" }, el("b", { text: x.s }), el("span", { text: t("gmPtsUnit") })),
    el("small", { class: "pf", text: detail(x.g, x) }),
    x.g === "mm" && x.r ? marks(x.r) : null,
    live && room && gamesOn() && !room.gone && !room.readOnly
      ? el("button", { type: "button", class: "btn small gmjoin", onclick: () => play(x.g) }, icon("game", "sm"), el("span", { text: t(isToday ? "gmJoin" : "gmJoinToday") }))
      : null);
}
export const gameText = (x) => `🧩 ${t(GAME[x.g].name)} ${x.d} · ${t("gmPts", { n: x.s })}\n${detail(x.g, x)}`;

// games kept on this device from days gone by
function dropOldGames(day) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(KEYS.gamePrefix) && !k.includes(":" + day + ":")) localStorage.removeItem(k);
    }
  } catch (e) {}
}
