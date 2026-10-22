/* Quizzes (競答): a Kahoot-style contest in the room. The owner or a co-host starts one from a question set
   (quizedit.js keeps those on their device), which posts a card in the chat; people tap it to play, on a page over
   the chat. The host asks one question at a time: it's out a few seconds before answering opens (so every phone has
   it first), answering runs on the server's clock, and when time is up (or everyone has answered) the right answers
   and everyone's points come out, worked out on the host's device. Points go to right answers, more for faster ones;
   the total after the last question is the result, which the card then shows.
   What may be read when is held by the rules (tools/rules.py QUIZ): the whole set only by the hosts, a question only
   once asked, its right answers only once answering is over, and nobody's answer but your own while it's open.
   A question's picture goes to R2 like a photo (photos.js) when the quiz starts, sealed in a Private Salon; the room's
   copy of the set says where each one is, and a question as asked carries that along once it's out.
   Room.followQuiz keeps up with each quiz; this draws it and makes the host's moves, and the projector screen
   (show.js) shows the one that's on, larger, for a room watching together. */
import { t } from "./text.js?v=dev";
import { el, toast, icon, avatar, orToast, confirmSheet, saveFile, busy } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend, PHOTOS } from "./backend.js?v=dev";
import { b64u, unb64u } from "./crypto.js?v=dev";
import { uploadPhoto, pictureBytes, jpegUrl, dropPhoto } from "./photos.js?v=dev";
import { SHOW, openShow } from "./show.js?v=dev";
import { room } from "./session.js?v=dev";
import { me } from "./identity.js?v=dev";
import { post } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";
import { QUIZ, SHAPES, pad, asked, settle, ranking, cleanSet, cleanScores, scoresCsv } from "./quizset.js?v=dev";
import { library } from "./quizedit.js?v=dev";

const AUTO_NEXT = 6000; // ms the scores stay up before the next question, when the host lets it go on by itself
const SHOW_AFTER = 5 * 60e3; // ms the projector keeps showing a quiz's result after it saw the quiz end
const quizOf = (z) => room?.quizzes.get(z) || null;
const nameOf = (e, uid) => e.p?.[uid] || (room.who(uid) ? { n: room.who(uid).name, a: room.who(uid).avatar } : { n: t("someoneLeft"), a: "👤" });
// a host's write: JSON in a plain room, sealed in a Private Salon (Room.openBlob reads it back)
const blob = async (r, x, aad) => (r.cipher ? r.cipher.seal(x, aad) : JSON.stringify(x));
const running = (e) => !!e?.live && e.live.ph !== "end";

/* ---------- starting one ---------- */
// the card and the quiz go in one write: who runs it, the whole set (for the hosts' eyes), and the lobby. The pictures
// go to R2 first, each under an id that starts with the quiz's and goes on with 10 random letters, so nobody can
// guess where one is before its question is out
export async function startQuiz(set) {
  if (!room || room.gone) return false;
  if (room.readOnly) { toast(t("roNoPost")); return false; }
  if (!room.isStaff()) { toast(t("qzHostsOnly")); return false; }
  const on = [...room.quizzes.entries()].find(([, e]) => running(e));
  if (on) { toast(t("qzOneAtATime")); openQuiz(on[0]); return false; }
  if (!PHOTOS && set.q.some((q) => q.img)) { toast(t("qzImgFail")); return false; }
  const r = room, uid = backend.uid;
  let z = null;
  const ok = await post(KIND.quiz, { t: set.t, n: set.q.length }, async (id) => {
    z = id;
    return {
      [r.api.root(`qz/${id}/by`)]: uid,
      [r.api.root(`qz/${id}/src`)]: await blob(r, { t: set.t, q: await putPictures(r, id, set.q) }, `zs:${id}`),
      [r.api.root(`qz/${id}/live`)]: { ph: "lobby", i: "00", at: backend.now(), d: 0, n: set.q.length, lock: false },
    };
  }, { wait: true }).catch((err) => { console.error(err); toast(t("qzImgFail")); return false; });
  if (ok && z && r === room) openQuiz(z);
  return ok;
}

const PIC_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const picId = (z) => z + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => PIC_ID[b % PIC_ID.length]).join("");
// the questions as the room keeps them: each picture put in R2, and where it is in its place
async function putPictures(r, z, qs) {
  const total = qs.filter((q) => q.img).length;
  if (!total) return qs.map(({ img, im, ...q }) => q);
  busy(true);
  try {
    const out = [];
    for (const { img, im, ...q } of qs) {
      if (img) {
        toast(t("qzImgUp", { n: out.filter((x) => x.im).length + 1, total }));
        const f = picId(z), bytes = unb64u(img.d);
        await uploadPhoto(r.code, f, r.cipher ? await r.cipher.sealRaw(bytes, `zi:${z}:${f}`) : bytes, !!r.cipher);
        r.imgs.set("zi" + f, Promise.resolve(jpegUrl(bytes))); // no need to fetch my own
        q.im = { f, w: img.w, h: img.h };
      }
      out.push(q);
    }
    return out;
  } finally { busy(false); }
}
// a question's picture as a blob: URL, fetched once per visit (null if it's gone); by: who started the quiz
export function quizPicture(r, z, by, f) {
  const key = "zi" + f;
  if (!r.imgs.has(key)) r.imgs.set(key, pictureBytes(r, by, f, `zi:${z}:${f}`).then((b) => (b ? jpegUrl(b) : null), () => null)
    .then((u) => { if (!u) r.imgs.delete(key); return u; }));
  return r.imgs.get(key);
}
// ...as an <img>, the same one each time (the page is drawn again with every answer that comes in)
const pics = new Map();
function picture(z, q) {
  if (!q?.im) return null;
  const f = q.im.f;
  if (!pics.has(f)) {
    const img = el("img", { class: "qzimg", width: q.im.w, height: q.im.h, alt: t("qzImg"), decoding: "async" });
    quizPicture(room, z, room.msgs.get(z)?.by, f).then((u) => { if (u) img.src = u; else img.hidden = true; });
    pics.set(f, img);
  }
  return pics.get(f);
}
// when a quiz's card is deleted: its pictures out of R2 too, those this device knows of (the hourly cleanup takes the rest)
export async function dropQuizPictures(z, by) {
  const r = room;
  if (!r || !z) return;
  const ids = new Set(Object.values(quizOf(z)?.q || {}).map((q) => q?.im?.f).filter(Boolean));
  const set = await sets.get(r.code + ":" + z)?.catch(() => null);
  set?.q.forEach((q) => q.im && ids.add(q.im.f));
  ids.forEach((f) => dropPhoto(r.code, by, f));
}

/* ---------- the host's moves ---------- */
// the whole set, answers and all, read once per quiz (only the hosts can)
const sets = new Map();
function setOf(r, z) {
  const key = r.code + ":" + z;
  if (!sets.has(key)) sets.set(key, backend.val(r.api.ref(`qz/${z}/src`)).then((b) => r.openBlob(b, `zs:${z}`)).then(cleanSet)
    .then((s) => { if (!s?.q.length) throw new Error("no set"); return s; }).catch((e) => { sets.delete(key); throw e; }));
  return sets.get(key);
}
// the scores after question n, read fresh (another host's device may have worked them out)
async function scoresAfter(r, z, n) {
  if (n < 0) return null;
  return cleanScores(await r.openBlob(await backend.val(r.api.ref(`qz/${z}/s/${pad(n)}`)), `zr:${z}:${pad(n)}`));
}
// question n goes out; answering opens a few seconds on
async function ask(z, n) {
  const r = room, e = quizOf(z);
  try {
    const q = (await setOf(r, z)).q[n];
    if (!q || !e?.live) return;
    const [pub] = asked(q), i = pad(n);
    await r.api.quizStep(z, { [`q/${i}`]: await blob(r, pub, `zq:${z}:${i}`), live: { ...e.live, ph: "q", i, at: backend.now() + QUIZ.lead, d: q.d } });
  } catch (err) { console.error(err); toast(t("tryAgain")); }
}
// answering is over: no more answers first, then the right answers and the points
const closing = new Set();
async function close(z) {
  const r = room, e = quizOf(z);
  if (!e?.live || e.live.ph !== "q" || closing.has(z)) return;
  closing.add(z);
  const { i, at } = e.live, n = +i;
  try {
    await r.api.quizStep(z, { "live/ph": "rev" });
    const [set, raw, players, before] = await Promise.all([setOf(r, z), backend.val(r.api.ref(`qz/${z}/a/${i}`)), backend.val(r.api.ref(`qz/${z}/p`)), scoresAfter(r, z, n - 1)]);
    const answers = {};
    for (const [uid, v] of Object.entries(raw || {})) { const a = await r.openAnswer(z, i, uid, v); if (a) answers[uid] = a; }
    const [pub, key] = asked(set.q[n]);
    const s = settle(pub, key, answers, players || {}, before, at);
    await r.api.quizStep(z, { [`k/${i}`]: await blob(r, key, `zk:${z}:${i}`), [`s/${i}`]: await blob(r, s, `zr:${z}:${i}`) });
  } catch (err) { console.error(err); toast(t("tryAgain")); }
  finally { closing.delete(z); }
}
function next(z) {
  const e = quizOf(z);
  if (!e?.live) return;
  const n = +e.live.i + 1;
  return n < e.live.n ? ask(z, n) : finish(z);
}
// over: the last question with scores is where the result is read from
function finish(z) {
  const e = quizOf(z), done = Object.keys(e?.s || {}).sort().pop() || "00";
  return orToast(room.api.quizStep(z, { live: { ...e.live, ph: "end", i: done } }));
}
async function endNow(z) {
  if (await confirmSheet(t("qzEnd"), t("qzEndBody"), t("qzEnd"))) finish(z);
}

/* ---------- playing ---------- */
async function join(z) {
  const r = room, uid = backend.uid, m = r.members[uid] || me(), at = backend.stamp();
  const rec = r.cipher ? { x: await r.cipher.seal({ n: m.name, a: m.avatar }, `zp:${z}:${uid}`), at } : { n: m.name, a: m.avatar, at };
  orToast(r.api.quizJoin(z, rec));
}
async function answer(z, i, k) {
  const r = room, e = quizOf(z), uid = backend.uid;
  if (!e || e.mine[i]) return;
  e.mine[i] = { c: k, at: 0 }; draw();
  const at = backend.stamp();
  const rec = r.cipher ? { x: await r.cipher.seal(k, `za:${z}:${i}:${uid}`), at } : { c: String(k), at };
  r.api.quizAnswer(z, i, rec).catch(() => { delete e.mine[i]; toast(t("qzLate")); draw(); });
}

/* ---------- following along ---------- */
// what a quiz shows now: where it's at, and for a question being asked whether it's about to open, open, or over
function stage(e) {
  const l = e?.live;
  if (!l) return "";
  if (l.ph !== "q") return l.ph + l.i;
  const now = backend.now();
  return l.i + (now < l.at ? "pre" : now <= l.at + l.d * 1000 ? "open" : "over");
}
let view = null;       // the quiz page on screen: { z, ov, body, stage }
const hosting = new Set(); // quizzes this device runs (a host who opened its page, or started it)
const revAt = new Map();   // when each quiz's scores came out on this device, for going on by itself
const autoNext = () => store.get(KEYS.quizAuto) === "1";
export function watchQuiz(r) {
  r.on("quiz", (z) => {
    document.querySelectorAll(`.quizbub[data-z="${z}"]`).forEach((n) => { const v = r.msgs.get(z); if (v?.quiz) n.replaceWith(quizCard(z, v)); });
    if (view?.z === z) draw();
  }).on("msg-removed", (id) => { if (view?.z === id) { closeView(); toast(t("qzGone")); } });
  const tick = setInterval(() => {
    if (!r.current || r.gone) return;
    for (const [z, e] of r.quizzes) if (running(e) && r.isStaff() && !SHOW() && (hosting.has(z) || r.msgs.get(z)?.by === backend.uid)) drive(z, e);
    if (view && quizOf(view.z)) {
      if (stage(quizOf(view.z)) !== view.stage) draw(); else clock();
    }
  }, 200);
  r.off.push(() => { clearInterval(tick); closeView(); hosting.clear(); revAt.clear(); pics.clear(); });
}
// a host's device moves the quiz on by itself: answering stops at the end of the time or once everyone has answered,
// and with "next by itself" on, the next question follows a few seconds after the scores
function drive(z, e) {
  const l = e.live, now = backend.now();
  if (l.ph === "q") {
    const players = Object.keys(e.p), answered = players.filter((uid) => e.all[l.i]?.[uid]).length;
    if (now > l.at + l.d * 1000 + QUIZ.grace || (now >= l.at && players.length && answered >= players.length)) close(z);
  } else if (l.ph === "rev" && e.s[l.i] && autoNext()) {
    const key = z + l.i;
    if (!revAt.has(key)) revAt.set(key, now);
    else if (now - revAt.get(key) > AUTO_NEXT) { revAt.set(key, Infinity); next(z); }
  }
}

/* ---------- the card in the chat ---------- */
function status(e) {
  const l = e?.live;
  if (!l) return t("loading");
  if (l.ph === "lobby") return `${t("qzLobby")} · ${t("qzPlayers", { n: Object.keys(e.p).length })}`;
  if (l.ph === "end") return t("qzOver");
  return `${t("qzOn")} · ${t("qzQ", { n: +l.i + 1, total: l.n })}`;
}
const podium = (e, rows) => el("ol", { class: "qzpodium" }, rows.slice(0, 3).map((r) => {
  const p = nameOf(e, r.uid);
  return el("li", { class: r.uid === backend.uid ? "you" : null }, el("span", { class: "rk", text: ["🥇", "🥈", "🥉"][r.rank - 1] || r.rank }),
    el("span", { class: "who", text: `${p.a} ${p.n}` }), el("b", { class: "pts", text: r.s.toLocaleString(I18N.lang) }));
}));
export function quizCard(id, v) {
  const e = quizOf(id), l = e?.live, staff = room?.isStaff(), playing = !!e?.p[backend.uid];
  const rows = l?.ph === "end" && e.final ? ranking(e.final) : [];
  const label = !l ? null : l.ph === "end" ? "qzResults" : staff ? "qzHost" : playing ? "qzBack" : "qzJoin";
  return el("div", { class: "bub quizbub", "data-z": id },
    el("span", { class: "ptag" }, icon("trophy", "sm"), el("span", { text: t("quiz") })),
    el("b", { class: "pt", text: v.quiz.t }),
    el("small", { class: "muted", text: `${t("qzN", { n: v.quiz.n })} · ${status(e)}` }),
    rows.length ? podium(e, rows) : null,
    label ? el("button", { type: "button", class: "btn small" + (l.ph === "end" ? "" : " primary"), onclick: () => openQuiz(id) }, el("span", { text: t(label) })) : null);
}
// as kept in a record: its title, how many questions, and the result
export function savedQuizCard(m) {
  return el("div", { class: "bub quizbub ro" },
    el("span", { class: "ptag" }, icon("trophy", "sm"), el("span", { text: t("quiz") })),
    el("b", { class: "pt", text: m.quiz.t }), el("small", { class: "muted", text: t("qzN", { n: m.quiz.n }) }),
    m.quiz.r?.length ? el("ol", { class: "qzpodium" }, m.quiz.r.slice(0, 3).map((r, i) => el("li", {}, el("span", { class: "rk", text: ["🥇", "🥈", "🥉"][i] }),
      el("span", { class: "who", text: `${r.a} ${r.n}` }), el("b", { class: "pts", text: r.s.toLocaleString(I18N.lang) })))) : null);
}
// the result as a record keeps it: [{ n, a, s }], best first
export function quizResult(id) {
  const e = quizOf(id);
  return e?.final ? ranking(e.final).map((r) => { const p = nameOf(e, r.uid); return { n: p.n, a: p.a, s: r.s }; }) : [];
}

/* ---------- the quiz's page ---------- */
export function openQuiz(z) {
  const e = quizOf(z), v = room?.msgs.get(z);
  if (!e || !v?.quiz) return toast(t("qzGone"));
  closeView();
  if (room.isStaff()) hosting.add(z);
  const body = el("div", { class: "qzbody" });
  const esc = (ev) => { if (ev.key === "Escape" && view?.ov === document.querySelector(".overlay:last-of-type")) closeView(); };
  const ov = el("div", { class: "overlay gameov quizov" }, el("div", { class: "gamebox quizbox", role: "dialog", "aria-label": v.quiz.t },
    el("header", { class: "gmhead" },
      el("button", { type: "button", class: "icon", "aria-label": t("close"), onclick: closeView }, icon("close")),
      el("div", { class: "gmttl" }, el("b", { text: v.quiz.t }), el("small", { class: "muted qzstep" })),
      room.isStaff() ? el("button", { type: "button", class: "icon", "aria-label": t("qzProject"), title: t("qzProject"), onclick: openShow }, icon("projector")) : null),
    body));
  document.addEventListener("keydown", esc);
  document.body.append(ov);
  view = { z, ov, body, stage: null, esc };
  draw();
}
function closeView() {
  if (!view) return;
  view.ov.remove(); document.removeEventListener("keydown", view.esc);
  view = null;
}
const secsLeft = (l) => Math.max(0, Math.ceil((l.at + l.d * 1000 - backend.now()) / 1000));
// the parts that run with the clock, between redraws (on the quiz's page, or the projector's: root)
function clock(root = view.body, z = view.z) {
  const l = quizOf(z)?.live;
  if (!l || l.ph !== "q") return;
  const now = backend.now();
  root.querySelectorAll(".qzcount").forEach((n) => (n.textContent = Math.max(1, Math.ceil((l.at - now) / 1000))));
  root.querySelectorAll(".qzsecs").forEach((n) => (n.textContent = secsLeft(l)));
  root.querySelectorAll(".qzbar i").forEach((n) => (n.style.width = `${Math.max(0, Math.min(100, (100 * (l.at + l.d * 1000 - now)) / (l.d * 1000)))}%`));
}
function draw() {
  const e = quizOf(view?.z);
  if (!e) return;
  const l = e.live, host = room.isStaff(), z = view.z;
  view.stage = stage(e);
  view.ov.querySelector(".qzstep").textContent = !l ? "" : l.ph === "lobby" ? t("qzLobby") : l.ph === "end" ? t("qzOver") : t("qzQ", { n: +l.i + 1, total: l.n });
  const parts = !l ? [el("p", { class: "muted", text: t("loading") })]
    : l.ph === "lobby" ? lobby(e, host, z)
    : l.ph === "end" ? results(e, host, z)
    : [joinBox(e, host, z), l.ph === "q" ? question(e, host, z) : reveal(e, host, z)];
  view.body.replaceChildren(...parts.filter(Boolean));
  clock();
}
// not playing yet: a way in, while there is one
function joinBox(e, host, z) {
  if (host || e.p[backend.uid] || e.live.ph === "end") return null;
  if (e.live.ph !== "lobby" && e.live.lock) return el("p", { class: "note", text: t("qzLocked") });
  const m = room.members[backend.uid] || me();
  return el("div", { class: "qzjoin" }, el("button", { type: "button", class: "btn primary", onclick: () => join(z) }, el("span", { text: t("qzJoinAs", { who: `${m.avatar} ${m.name}` }) })));
}
function players(e, host, z) {
  const ids = Object.keys(e.p);
  if (!ids.length) return el("p", { class: "muted small", text: t("qzNoPlayers") });
  return el("div", { class: "qzplayers" }, ids.map((uid) => {
    const p = e.p[uid], label = `${p.a} ${p.n}`;
    return host ? el("button", { type: "button", class: "chip", title: t("qzKick"), onclick: async () => {
      if (await confirmSheet(t("qzKick"), t("qzKickBody", { who: label }), t("qzKick"))) orToast(room.api.quizDrop(z, uid));
    } }, label) : el("span", { class: "chip" + (uid === backend.uid ? " on" : ""), text: label });
  }));
}
function lobby(e, host, z) {
  const n = Object.keys(e.p).length;
  return [
    joinBox(e, host, z),
    !host && e.p[backend.uid] ? el("p", { class: "qzwait", text: t("qzJoined") }) : null,
    el("h3", { class: "lbh", text: t("qzPlayers", { n }) }),
    players(e, host, z),
    host ? el("label", { class: "qzcheck" }, el("input", { type: "checkbox", checked: e.live.lock || null, onchange: (ev) => orToast(room.api.quizStep(z, { "live/lock": ev.target.checked })) }), el("span", { text: t("qzLock") })) : null,
    host ? autoBox() : null,
    host ? el("div", { class: "actions pair" },
      el("button", { type: "button", class: "btn", onclick: () => endNow(z), text: t("qzEnd") }),
      el("button", { type: "button", class: "btn primary", onclick: () => ask(z, 0), text: t("qzStart") })) : null,
  ];
}
const autoBox = () => el("label", { class: "qzcheck" }, el("input", { type: "checkbox", checked: autoNext() || null, onchange: (ev) => store.set(KEYS.quizAuto, ev.target.checked ? "1" : null) }), el("span", { text: t("qzAuto") }));
const ptsTag = (q) => (q.p === 1 ? null : el("span", { class: "tag", text: t(q.p ? "qzDouble" : "qzNoPts") }));
function question(e, host, z) {
  const l = e.live, i = l.i, q = e.q[i], now = backend.now();
  if (!q) return el("p", { class: "muted", text: t("loading") });
  const head = el("div", { class: "qzq" }, ptsTag(q), el("h2", { class: "qzt", text: q.t }));
  if (now < l.at) return el("div", { class: "qzpre" }, head, picture(z, q), el("p", { class: "muted", text: t("qzGetReady") }), el("b", { class: "qzcount", "aria-live": "polite" }));
  const open = now <= l.at + l.d * 1000, mine = e.mine[i], playing = !!e.p[backend.uid];
  const opts = el("div", { class: "qzopts" }, q.o.map((o, k) => el(host || !playing ? "div" : "button", {
    type: host || !playing ? null : "button", class: `qzopt qz${k}` + (mine?.c === k ? " picked" : "") + (mine && mine.c !== k ? " dim" : ""),
    disabled: !host && playing && (!!mine || !open) ? true : null,
    onclick: host || !playing ? null : () => answer(z, i, k),
  }, el("span", { class: "shape", "aria-hidden": "true", text: SHAPES[k] }), el("span", { class: "otext", text: o }))));
  const ids = Object.keys(e.p), answered = ids.filter((uid) => e.all[i]?.[uid]).length;
  return el("div", { class: "qzlive" }, head, picture(z, q),
    el("div", { class: "qztime" }, el("span", { class: "qzbar" }, el("i")), el("b", { class: "qzsecs" })),
    opts,
    host ? el("p", { class: "muted small", text: t("qzAnswered", { n: answered, total: ids.length }) }) : null,
    !host && playing ? el("p", { class: "qzwait", text: mine ? t("qzWaitOthers") : open ? "" : t("qzTimeUp") }) : null,
    host ? el("div", { class: "actions" }, el("button", { type: "button", class: "btn", onclick: () => close(z), text: t("qzCloseNow") })) : null);
}
// the board: the top five, and me below them if I'm further down
function board(e, s, top = 5) {
  const rows = ranking(s), mine = rows.find((r) => r.uid === backend.uid);
  const shown = rows.slice(0, top);
  if (mine && !shown.includes(mine)) shown.push(mine);
  if (!shown.length) return el("p", { class: "muted small", text: t("qzNobody") });
  return el("ol", { class: "lb" }, shown.map((r) => {
    const p = nameOf(e, r.uid);
    return el("li", { class: r.uid === backend.uid ? "you" : null }, el("span", { class: "rk", text: r.rank }),
      el("span", { class: "who", text: `${p.a} ${p.n}` }), el("b", { class: "pts", text: r.s.toLocaleString(I18N.lang) }));
  }));
}
function reveal(e, host, z) {
  const l = e.live, i = l.i, q = e.q[i], key = e.k[i], s = e.s[i];
  if (!q || !key || !s) return el("p", { class: "muted qzwait", text: t("qzScoring") });
  const total = Math.max(1, s.n.reduce((a, b) => a + b, 0)), mine = e.mine[i], playing = !!e.p[backend.uid];
  const opts = el("div", { class: "qzopts shown" }, q.o.map((o, k) => el("div", { class: `qzopt qz${k}` + (key.includes(k) ? " right" : " dim") + (mine?.c === k ? " picked" : "") },
    el("span", { class: "shape", "aria-hidden": "true", text: SHAPES[k] }), el("span", { class: "otext", text: o }),
    key.includes(k) ? icon("check", "sm") : null,
    el("span", { class: "ocount", text: s.n[k] || 0 }),
    el("span", { class: "obar", style: `width:${(100 * (s.n[k] || 0)) / total}%` }))));
  const rows = ranking(s), me_ = rows.find((r) => r.uid === backend.uid);
  const mineLine = !playing || host ? null : el("div", { class: "qzme " + (mine && key.includes(mine.c) ? "ok" : "no") },
    el("b", { text: t(!mine ? "qzNone" : key.includes(mine.c) ? "qzRight" : "qzWrong") }),
    s.g[backend.uid] ? el("span", { text: t("qzGot", { n: s.g[backend.uid] }) }) : null,
    me_ ? el("small", { text: t("qzTotal", { n: me_.s.toLocaleString(I18N.lang), r: me_.rank }) }) : null);
  const last = +i + 1 >= l.n;
  return el("div", { class: "qzlive" }, el("div", { class: "qzq" }, el("h2", { class: "qzt", text: q.t })), mineLine, opts,
    el("h3", { class: "lbh" }, icon("trophy", "sm"), el("span", { text: t("qzBoard") })), board(e, s),
    host ? autoBox() : null,
    host ? el("div", { class: "actions pair" },
      el("button", { type: "button", class: "btn", onclick: () => endNow(z), text: t("qzEnd") }),
      el("button", { type: "button", class: "btn primary", onclick: () => next(z), text: t(last ? "qzFinish" : "qzNext") })) : null);
}
function results(e, host, z) {
  const s = e.final || e.s[e.live.i];
  if (!s) return [el("p", { class: "muted", text: t("loading") })];
  const rows = ranking(s), mine = rows.find((r) => r.uid === backend.uid);
  return [
    rows.length ? podium(e, rows) : el("p", { class: "muted", text: t("qzNobody") }),
    mine ? el("p", { class: "qzme ok" }, el("b", { text: t("qzPlace", { n: mine.rank }) }), el("span", { text: t("qzPts", { n: mine.s.toLocaleString(I18N.lang) }) })) : null,
    rows.length > 3 ? el("h3", { class: "lbh" }, icon("trophy", "sm"), el("span", { text: t("qzBoard") })) : null,
    rows.length > 3 ? board(e, s, 100) : null,
    host ? el("div", { class: "actions pair" },
      el("button", { type: "button", class: "btn", onclick: () => saveCsv(e, s, z), text: t("qzCsv") }),
      el("button", { type: "button", class: "btn primary", onclick: () => keepSet(z), text: t("qzSaveLib") })) : null,
  ];
}
function saveCsv(e, s, z) {
  const rows = ranking(s).map((r) => { const p = nameOf(e, r.uid); return [r.rank, p.n, r.s, r.r]; });
  const csv = scoresCsv(rows, [t("qzRank"), t("qzName"), t("qzPoints"), t("qzRights")]);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  saveFile(url, `quiz-${room.code}-${(room.msgs.get(z)?.quiz.t || "").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40)}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
// the set this quiz was played from, into this device's library (for a co-host who didn't make it, or a set from a file)
async function keepSet(z) {
  const r = room, by = r.msgs.get(z)?.by;
  try {
    const set = await setOf(r, z);
    // the pictures back from R2, into the set itself
    const q = await Promise.all(set.q.map(async ({ im, ...q }) => {
      const b = im && (await pictureBytes(r, by, im.f, `zi:${z}:${im.f}`).catch(() => null));
      return b ? { ...q, img: { d: b64u(b), w: im.w, h: im.h } } : q;
    }));
    await library.add({ t: set.t, q });
    toast(t("qzSavedLib"));
  }
  catch (err) { console.error(err); toast(t("qzLibFail")); }
}

/* ---------- on the projector (show.js) ---------- */
// the quiz the projector screen shows: one that's on, or one it saw end a few minutes ago (its result)
const seenOn = new Map(); // quiz -> when this screen last saw it on
export function shownQuiz() {
  const now = backend.now();
  for (const [z, e] of room?.quizzes || []) if (running(e) && room.msgs.get(z)?.quiz) { seenOn.set(z, now); return z; }
  for (const [z, at] of seenOn) if (at > now - SHOW_AFTER && quizOf(z)?.live && room.msgs.get(z)?.quiz) return z;
  return null;
}
// where it's at, to know when to draw it again
export const quizStage = (z) => stage(quizOf(z));
export const quizClock = (root, z) => clock(root, z);
// the screen: everything as large as the room needs it, nothing to tap
export function quizScreen(z) {
  const e = quizOf(z), l = e?.live, v = room.msgs.get(z);
  if (!l || !v) return null;
  const head = el("div", { class: "sqzh" }, el("span", { class: "qlive" }, icon("trophy"), el("span", { text: t("quiz") })), el("b", { text: v.quiz.t }),
    el("span", { class: "sqzstep", text: l.ph === "lobby" ? t("qzLobby") : l.ph === "end" ? t("qzOver") : t("qzQ", { n: +l.i + 1, total: l.n }) }));
  const ids = Object.keys(e.p);
  if (l.ph === "lobby") return el("div", { class: "sqz lobby" }, head, el("p", { class: "sqzjoin", text: t("qzShowJoin") }),
    el("h2", { text: t("qzPlayers", { n: ids.length }) }),
    el("div", { class: "qzplayers" }, ids.map((uid) => el("span", { class: "chip", text: `${e.p[uid].a} ${e.p[uid].n}` }))));
  if (l.ph === "end") {
    const s = e.final || e.s[l.i], rows = s ? ranking(s) : [];
    return el("div", { class: "sqz end" }, head, rows.length ? podium(e, rows) : el("p", { class: "shint big", text: t(s ? "qzNobody" : "loading") }),
      rows.length > 3 ? board(e, s, 10) : null);
  }
  const q = e.q[l.i];
  if (!q) return el("div", { class: "sqz" }, head, el("p", { class: "shint big", text: t("loading") }));
  const title = el("h1", { class: "sqzt", text: q.t });
  if (l.ph === "q" && backend.now() < l.at) return el("div", { class: "sqz pre" }, head, title, picture(z, q), el("b", { class: "qzcount" }));
  const key = l.ph === "rev" ? e.k[l.i] : null, s = l.ph === "rev" ? e.s[l.i] : null, total = s ? Math.max(1, s.n.reduce((a, b) => a + b, 0)) : 1;
  const opts = el("div", { class: "qzopts" + (s ? " shown" : "") }, q.o.map((o, k) => el("div", { class: `qzopt qz${k}` + (key ? (key.includes(k) ? " right" : " dim") : "") },
    el("span", { class: "shape", "aria-hidden": "true", text: SHAPES[k] }), el("span", { class: "otext", text: o }),
    key?.includes(k) ? icon("check") : null,
    s ? el("span", { class: "ocount", text: s.n[k] || 0 }) : null,
    s ? el("span", { class: "obar", style: `width:${(100 * (s.n[k] || 0)) / total}%` }) : null)));
  if (l.ph === "rev") return el("div", { class: "sqz rev" }, head, title, opts,
    s ? board(e, s) : el("p", { class: "shint", text: t("qzScoring") }));
  const answered = ids.filter((uid) => e.all[l.i]?.[uid]).length;
  return el("div", { class: "sqz q" }, head, title, picture(z, q),
    el("div", { class: "qztime" }, el("span", { class: "qzbar" }, el("i")), el("b", { class: "qzsecs" })),
    opts, el("p", { class: "sqzn", text: room.isStaff() ? t("qzAnswered", { n: answered, total: ids.length }) : t("qzPlayers", { n: ids.length }) }));
}
