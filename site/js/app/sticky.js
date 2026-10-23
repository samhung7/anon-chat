/* Sticky-note boards (便利貼): the owner or a co-host opens a board, which posts a card in the chat; people tap it to open
   the board on a page over the chat, where everyone puts notes up in its columns. Then the host may call a vote (each
   person has 1, 3 or 5 votes, more than one on a note if they like) and closes it: the notes come out best first, the
   card shows the top three, and anyone can take the board away as a file.
   Notes are anonymous unless the host opens a named board: who wrote a note sits apart where only its author reads it
   (tools/rules.py BOARD), so not even the hosts know. Its author changes it or takes it back while notes go up; the
   hosts move any note (dragging it, or "move to") and take any down. Votes go in under a key only their voter knows,
   and nobody sees anyone's until the result is out.
   Room.followBoard keeps up with each board; this draws it and makes the moves. stickyset.js does the sums. */
import { t } from "./text.js?v=dev";
import { el, toast, icon, sheet, pickSheet, orToast, confirmSheet, saveFile } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { me } from "./identity.js?v=dev";
import { post, posts } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";
import { choice } from "./polls.js?v=dev";
import { BOARD, TEMPLATES, byPlace, placeAt, tally, ranked, boardCsv, boardMd } from "./stickyset.js?v=dev";

const boardOf = (b) => room?.boards.get(b) || null;
// a host's write: JSON in a plain room, sealed in a Private Salon (Room.openBlob reads it back)
const blob = async (r, x, aad) => (r.cipher ? r.cipher.seal(x, aad) : JSON.stringify(x));
const open = (e) => !!e?.live && e.live.ph !== "done";
const fmt = (n) => n.toLocaleString(I18N.lang);
// the columns as shown: a note in a column that's gone counts in the first
const colsOf = (e) => (e.cols.length ? e.cols : [{ k: "0", n: "" }]);
const colOf = (e, n) => (colsOf(e).some((c) => c.k === n.k) ? n.k : colsOf(e)[0].k);
const counts = (e) => (e.live?.ph === "done" ? tally(e.votes, e.notes, e.live.v) : {});
const myVotes = (e) => { const out = {}; e.picks.forEach((id) => (out[id] = (out[id] || 0) + 1)); return out; };
const canMove = (e, id) => !!e.live && e.live.ph !== "done" && (room.isStaff() || (e.mine.has(id) && e.live.ph === "add"));

/* ---------- opening one ---------- */
export async function newBoard() {
  if (!room || room.gone) return;
  if (room.readOnly) return toast(t("roNoPost"));
  if (!room.isStaff()) return toast(t("sbHostsOnly"));
  const on = [...room.boards.entries()].find(([id, e]) => open(e) && room.msgs.get(id)?.board);
  if (on) { toast(t("sbOneAtATime")); return openBoard(on[0]); }
  const title = el("input", { class: "field", id: "sbTitle", maxlength: BOARD.title, placeholder: t("sbTitlePh"), autocomplete: "off" });
  const names = el("div", { class: "sbcolset" });
  const addBtn = el("button", { type: "button", class: "btn small", text: t("sbColAdd"), onclick: () => { addCol(""); names.lastElementChild?.querySelector("input").focus(); } });
  const addCol = (n) => {
    const i = names.children.length + 1;
    if (i > BOARD.cols) return;
    const row = el("div", { class: "sbcolrow" }, el("input", { class: "field", maxlength: BOARD.col, value: n, placeholder: t("sbColPh", { n: i }), "aria-label": t("sbColPh", { n: i }), autocomplete: "off" }),
      el("button", { type: "button", class: "icon", "aria-label": t("sbColDrop"), onclick: () => { row.remove(); addBtn.hidden = false; } }, icon("close")));
    names.append(row);
    addBtn.hidden = names.children.length >= BOARD.cols;
  };
  const fill = (tpl) => { names.replaceChildren(); TEMPLATES[tpl].forEach((k) => addCol(t(k))); };
  fill("one");
  let an = true, v = 3;
  const lim = el("select", { class: "field", id: "sbLim", "aria-label": t("sbLim") }, BOARD.lims.map((n) => el("option", { value: String(n), text: t("sbLimN", { n }), selected: n === 10 })));
  const warn = el("p", { class: "note warn", hidden: true });
  const body = el("div", { class: "sbnew" }, warn,
    el("label", { class: "lbl", for: "sbTitle", text: t("sbTitle") }), title,
    el("label", { class: "lbl", text: t("sbTpl") }),
    el("div", { class: "sbtpls" }, Object.keys(TEMPLATES).map((k) => el("button", { type: "button", class: "chip", onclick: () => fill(k) }, TEMPLATES[k].map((x) => t(x)).join(" / ")))),
    el("label", { class: "lbl", text: t("sbCols") }), names, addBtn,
    el("label", { class: "lbl", text: t("sbWho") }), choice([["an", t("sbAnon")], ["named", t("sbNamed")]], "an", (x) => (an = x === "an")),
    el("p", { class: "muted small", text: t("sbAnonHint") }),
    el("label", { class: "lbl", text: t("sbVotes") }), choice(BOARD.votes.map((n) => [String(n), fmt(n)]), "3", (x) => (v = +x)),
    el("label", { class: "lbl", for: "sbLim", text: t("sbLim") }), lim);
  for (;;) {
    const a = await sheet(t("sbNew"), body, [["no", t("cancel")], ["yes", t("sbOpen"), "primary"]], { onOpen: () => title.focus() });
    if (a !== "yes" || !room || room.gone) return;
    const name = title.value.trim().slice(0, BOARD.title);
    const cols = [...names.querySelectorAll("input")].map((x) => x.value.trim().slice(0, BOARD.col)).filter(Boolean).map((n, i) => ({ k: String(i), n }));
    if (!name) { warn.textContent = t("sbNeedTitle"); warn.hidden = false; continue; }
    if (!cols.length) { warn.textContent = t("sbNeedCol"); warn.hidden = false; continue; }
    return start(name, cols, { v, an, lim: +lim.value });
  }
}
// the card and the board go in one write: who opened it, its columns, and where it's at
async function start(name, cols, { v, an, lim }) {
  const r = room, uid = backend.uid;
  let b = null;
  const ok = await post(KIND.board, { t: name }, async (id) => {
    b = id;
    return {
      [r.api.root(`sb/${id}/by`)]: uid,
      [r.api.root(`sb/${id}/cols`)]: await blob(r, cols, `bm:${id}`),
      [r.api.root(`sb/${id}/live`)]: { ph: "add", v, lim, an, lock: false },
    };
  }, { wait: true });
  if (ok && b && r === room) openBoard(b);
}

/* ---------- the host's moves ---------- */
const step = (b, fields) => orToast(room.api.boardStep(b, fields));
async function hostMenu(b) {
  const e = boardOf(b), l = e?.live;
  if (!l) return;
  const rows = [
    l.ph === "add" ? ["vote", t("sbToVote"), "primary"] : null,
    l.ph === "vote" ? ["add", t("sbToAdd")] : null,
    l.ph !== "done" ? ["done", t("sbToDone"), l.ph === "vote" ? "primary" : ""] : null,
    l.ph === "add" ? (l.lock ? ["unlock", t("sbUnlock")] : ["lock", t("sbLock")]) : null,
    l.ph !== "done" ? ["cols", t("sbEditCols")] : null,
    ["export", t("sbExport")],
    ["close", t("close")],
  ].filter(Boolean);
  const a = await sheet(room.msgs.get(b)?.board.t || t("sticky"), null, rows);
  if (a === "vote") step(b, { "live/ph": "vote" });
  else if (a === "add") step(b, { "live/ph": "add" });
  else if (a === "done" && (await confirmSheet(t("sbToDone"), t("sbDoneBody"), t("sbToDone"), "primary"))) step(b, { "live/ph": "done" });
  else if (a === "lock" || a === "unlock") step(b, { "live/lock": a === "lock" });
  else if (a === "cols") editCols(b);
  else if (a === "export") exportBoard(b);
}
// rename, add, or take away an empty column
async function editCols(b) {
  const e = boardOf(b);
  if (!e) return;
  const used = new Set([...e.notes.values()].map((n) => colOf(e, n)));
  const list = el("div", { class: "sbcolset" });
  const addBtn = el("button", { type: "button", class: "btn small", text: t("sbColAdd") });
  const row = (k, n) => {
    const r = el("div", { class: "sbcolrow", "data-k": k }, el("input", { class: "field", maxlength: BOARD.col, value: n, placeholder: t("sbColName"), "aria-label": t("sbColName"), autocomplete: "off" }),
      el("button", { type: "button", class: "icon", "aria-label": t("sbColDrop"), title: used.has(k) ? t("sbColUsed") : null, disabled: used.has(k) || null,
        onclick: () => { r.remove(); addBtn.hidden = false; } }, icon("close")));
    list.append(r);
    addBtn.hidden = list.children.length >= BOARD.cols;
  };
  colsOf(e).forEach((c) => row(c.k, c.n));
  addBtn.onclick = () => {
    const taken = new Set([...list.children].map((r) => r.dataset.k));
    const k = ["0", "1", "2", "3", "4", "5"].find((x) => !taken.has(x));
    if (k) { row(k, ""); list.lastElementChild.querySelector("input").focus(); }
  };
  const warn = el("p", { class: "note warn", hidden: true });
  for (;;) {
    const a = await sheet(t("sbEditCols"), el("div", {}, warn, list, addBtn), [["no", t("cancel")], ["yes", t("save"), "primary"]]);
    if (a !== "yes" || !room) return;
    const cols = [...list.children].map((r) => ({ k: r.dataset.k, n: r.querySelector("input").value.trim().slice(0, BOARD.col) }));
    if (!cols.length || cols.some((c) => !c.n)) { warn.textContent = t("sbNeedCol"); warn.hidden = false; continue; }
    return step(b, { cols: await blob(room, cols, `bm:${b}`) });
  }
}

/* ---------- notes ---------- */
// write a note (new, or mine changed): sealed in a Private Salon with my name, if the board names people
async function noteBody(b, id, e, { t: text, c, k, o }) {
  const m = room.members[backend.uid] || me(), named = !e.live.an;
  if (room.cipher) return { x: await room.cipher.seal({ t: text, ...(named ? { n: m.name, a: m.avatar } : {}) }, `bn:${b}:${id}`), c: String(c), k, o };
  return { t: text, c: String(c), k, o, ...(named ? { nm: m.name, av: m.avatar } : {}) };
}
// the box a note is written in: its words, its colour and its column
async function noteSheet(e, { title, text = "", c = 0, k }) {
  const ta = el("textarea", { class: "field sbta", maxlength: BOARD.text, rows: 4, placeholder: t("sbNotePh"), "aria-label": t("sbNotePh") });
  ta.value = text;
  const left = el("small", { class: "muted sbleft" });
  const count = () => (left.textContent = `${ta.value.length}/${BOARD.text}`);
  ta.addEventListener("input", count); count();
  let colour = c;
  const swatches = el("div", { class: "sbswatch", role: "radiogroup", "aria-label": t("sbColour") }, Array.from({ length: BOARD.colours }, (_, i) =>
    el("button", { type: "button", role: "radio", class: `sbsw sn${i}`, "aria-checked": String(i === c), "aria-label": t("sbColour" + i), title: t("sbColour" + i) })));
  swatches.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".sbsw"); if (!btn) return;
    colour = [...swatches.children].indexOf(btn);
    swatches.querySelectorAll(".sbsw").forEach((x) => x.setAttribute("aria-checked", String(x === btn)));
    ta.className = `field sbta sn${colour}`;
  });
  ta.className = `field sbta sn${colour}`;
  const cols = colsOf(e);
  const where = el("select", { class: "field", id: "sbWhere", "aria-label": t("sbWhere") }, cols.map((x) => el("option", { value: x.k, text: x.n || t("sticky"), selected: x.k === k })));
  const body = el("div", { class: "sbedit" }, ta, left, el("label", { class: "lbl", text: t("sbColour") }), swatches,
    cols.length > 1 ? [el("label", { class: "lbl", for: "sbWhere", text: t("sbWhere") }), where] : null);
  ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) ta.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
  for (;;) {
    const a = await sheet(title, body, [["no", t("cancel")], ["yes", t(text ? "save" : "sbPut"), "primary"]], { onOpen: () => ta.focus() });
    if (a !== "yes") return null;
    const words = ta.value.trim().slice(0, BOARD.text);
    if (words) return { t: words, c: colour, k: cols.length > 1 ? where.value : cols[0].k };
    toast(t("sbNeedText"));
  }
}
async function addNote(b, k) {
  const e = boardOf(b);
  if (!e?.live || e.live.ph !== "add") return;
  if (e.live.lock) return toast(t("sbLocked"));
  if (e.mine.size >= e.live.lim) return toast(t("sbLimHit", { n: e.live.lim }));
  if (e.notes.size >= BOARD.max) return toast(t("sbFull"));
  const n = await noteSheet(e, { title: t("sbNew1"), k });
  if (!n || !room || boardOf(b) !== e) return;
  if (e.live.ph !== "add" || e.live.lock) return toast(t("sbNotAdding"));
  const id = backend.pushKey(room.api.ref(`sb/${b}/n`));
  const last = [...e.notes.entries()].map(([nid, x]) => ({ id: nid, ...x })).filter((x) => colOf(e, x) === n.k).sort(byPlace).pop();
  const body = await noteBody(b, id, e, { ...n, o: placeAt(last ? [last] : [], last ? 1 : 0) });
  e.mine.add(id); e.asked.add(id);
  if (!(await posts.write(room.api.newNote(b, id, body), "notes"))) e.mine.delete(id);
}
async function editNote(b, id) {
  const e = boardOf(b), n = e?.notes.get(id);
  if (!n) return;
  const out = await noteSheet(e, { title: t("sbEdit1"), text: n.t, c: n.c, k: colOf(e, n) });
  if (!out || !room) return;
  const cur = e.notes.get(id);
  if (!cur) return toast(t("sbNoteGone"));
  // moved to another column: at the end of it
  const o = out.k === colOf(e, cur) ? cur.o : placeAt(colNotes(e, out.k).filter((x) => x.id !== id), colNotes(e, out.k).filter((x) => x.id !== id).length);
  orToast(room.api.editNote(b, id, { ...(await noteBody(b, id, e, { ...out, o })), at: cur.at }));
}
async function dropNote(b, id) {
  const e = boardOf(b);
  if (!e || !(await confirmSheet(t("sbDrop"), t("sbDropBody"), t("sbDrop")))) return;
  orToast(room.api.dropNote(b, id, e.mine.has(id)));
}
const colNotes = (e, k) => [...e.notes.entries()].map(([id, n]) => ({ id, ...n })).filter((n) => colOf(e, n) === k).sort(byPlace);
function moveNote(b, id, k, i) {
  const e = boardOf(b);
  if (!e?.notes.has(id) || !canMove(e, id)) return;
  const list = colNotes(e, k).filter((n) => n.id !== id);
  i = Math.max(0, Math.min(i, list.length));
  const o = placeAt(list, i), n = e.notes.get(id);
  if (n.k === k && n.o === o) return;
  // drawn where it lands straight away; the database follows
  e.notes.set(id, { ...n, k, o }); draw();
  orToast(room.api.moveNote(b, id, k, o));
}
async function moveTo(b, id) {
  const e = boardOf(b);
  if (!e) return;
  const cols = colsOf(e), n = e.notes.get(id);
  const body = el("div", { class: "seg" }, cols.map((c) => el("button", { type: "button", "data-k": c.k, "aria-checked": String(c.k === colOf(e, n)), role: "radio", text: c.n })));
  const k = await pickSheet(t("sbMoveTo"), body, "button[data-k]", (x) => x.dataset.k);
  if (k != null) moveNote(b, id, k, colNotes(e, k).filter((x) => x.id !== id).length);
}
// a note opened: its whole text, and what I may do with it
async function noteMenu(b, id) {
  const e = boardOf(b), n = e?.notes.get(id), l = e?.live;
  if (!n) return;
  const mine = e.mine.has(id), staff = room.isStaff();
  const card = el("div", { class: `sbbig sn${n.c}` }, el("p", { text: n.t }),
    el("small", { class: "muted" }, [n.nm ? `${n.av} ${n.nm}` : null, mine ? t("sbYours") : null, l.ph === "done" ? t("sbVotesGot", { n: counts(e)[id] || 0 }) : null].filter(Boolean).join(" · ")));
  const rows = [
    mine && l.ph === "add" ? ["edit", t("sbEdit1")] : null,
    canMove(e, id) && colsOf(e).length > 1 ? ["move", t("sbMoveTo")] : null,
    (mine && l.ph === "add") || staff ? ["del", t("sbDrop"), "danger"] : null,
    ["close", t("close")],
  ].filter(Boolean);
  const a = await sheet(null, card, rows);
  if (a === "edit") editNote(b, id);
  else if (a === "move") moveTo(b, id);
  else if (a === "del") dropNote(b, id);
}
// one more vote on a note (or one fewer), under my own key; nobody sees whose until the result is out
async function vote(b, id, more) {
  const e = boardOf(b), r = room;
  if (!e?.live || e.live.ph !== "vote") return;
  const picks = [...e.picks];
  if (more) { if (picks.length >= e.live.v) return toast(t("sbNoVotesLeft")); picks.push(id); }
  else { const i = picks.lastIndexOf(id); if (i < 0) return; picks.splice(i, 1); }
  const first = !e.key, key = e.key || r.api.voteKey(b), s = picks.join(",");
  const was = e.picks;
  e.picks = picks; e.key = key; draw();
  const val = s && r.cipher ? await r.cipher.seal(s, `bv:${b}:${key}`) : s;
  r.api.boardVote(b, key, val, first).catch(() => { e.picks = was; if (first) e.key = null; toast(t("tryAgain")); draw(); });
}

/* ---------- following along ---------- */
let view = null; // the board on screen: { b, ov, body, drag }
export function watchBoards(r) {
  r.on("board", (b) => {
    document.querySelectorAll(`.sbbub[data-b="${b}"]`).forEach((n) => { const v = r.msgs.get(b); if (v?.board) n.replaceWith(boardCard(b, v)); });
    if (view?.b === b) draw();
  }).on("msg-removed", (id) => { if (view?.b === id) { closeView(); toast(t("sbGone")); } });
  r.off.push(() => closeView());
}

/* ---------- the card in the chat ---------- */
function status(e) {
  const l = e?.live;
  if (!l) return t("loading");
  return `${t(l.ph === "add" ? (l.lock ? "sbPaused" : "sbAdding") : l.ph === "vote" ? "sbVoting" : "sbOver")} · ${t("sbNotesN", { n: e.notes.size })}`;
}
const top3 = (rows) => el("ol", { class: "sbtop" }, rows.slice(0, 3).map((r) => el("li", {},
  el("span", { class: `sbdot sn${r.c}`, "aria-hidden": "true" }), el("span", { class: "tx", text: r.t }), el("b", { class: "pts", text: fmt(r.v) }))));
export function boardCard(id, v) {
  const e = boardOf(id), l = e?.live;
  const rows = l?.ph === "done" && e.votes ? ranked(colsOf(e), e.notes, counts(e)).filter((r) => r.v > 0) : [];
  return el("div", { class: "bub sbbub", "data-b": id },
    el("span", { class: "ptag" }, icon("sticky", "sm"), el("span", { text: t("sticky") })),
    el("b", { class: "pt", text: v.board.t }),
    el("small", { class: "muted", text: status(e) }),
    rows.length ? top3(rows) : null,
    l ? el("button", { type: "button", class: "btn small" + (l.ph === "done" ? "" : " primary"), onclick: () => openBoard(id) },
      el("span", { text: t(l.ph === "done" ? "sbResults" : "sbOpenIt") })) : null);
}
// as kept in a record: its title and its notes, best first
export function savedBoardCard(m) {
  return el("div", { class: "bub sbbub ro" },
    el("span", { class: "ptag" }, icon("sticky", "sm"), el("span", { text: t("sticky") })),
    el("b", { class: "pt", text: m.board.t }),
    m.board.r?.length ? el("small", { class: "muted", text: t("sbNotesN", { n: m.board.r.length }) }) : null,
    m.board.r?.length ? el("ol", { class: "sbtop" }, m.board.r.slice(0, 3).map((r) => el("li", {}, el("span", { class: "tx", text: r.t }), el("b", { class: "pts", text: fmt(r.v) })))) : null);
}
// the notes as a record keeps them: [{ c (column), t, v }], best first
export function boardResult(id) {
  const e = boardOf(id);
  if (!e) return [];
  const name = Object.fromEntries(colsOf(e).map((c) => [c.k, c.n]));
  return ranked(colsOf(e), e.notes, counts(e)).map((r) => ({ c: name[r.k] || "", t: r.t, v: r.v }));
}
export const boardText = (m) => `🗒️ ${m.board.t}` + (m.board.r?.length ? "\n" + m.board.r.map((r) => `· ${r.c ? `[${r.c}] ` : ""}${r.t}${r.v ? ` (${t("sbVotesGot", { n: r.v })})` : ""}`).join("\n") : "");

/* ---------- the board's page ---------- */
export function openBoard(b) {
  const e = boardOf(b), v = room?.msgs.get(b);
  if (!e || !v?.board) return toast(t("sbGone"));
  closeView();
  const body = el("div", { class: "sbbody" });
  const esc = (ev) => { if (ev.key === "Escape" && view?.ov === document.querySelector(".overlay:last-of-type")) closeView(); };
  const more = el("button", { type: "button", class: "icon", "aria-label": t("sbMenu"), title: t("sbMenu"), onclick: () => (room.isStaff() ? hostMenu(b) : exportBoard(b)) }, icon("more"));
  const ov = el("div", { class: "overlay gameov sbov" }, el("div", { class: "gamebox sbbox", role: "dialog", "aria-label": v.board.t },
    el("header", { class: "gmhead" },
      el("button", { type: "button", class: "icon", "aria-label": t("close"), onclick: closeView }, icon("close")),
      el("div", { class: "gmttl" }, el("b", { text: v.board.t }), el("small", { class: "muted sbstep" })),
      more),
    body));
  // a dragged note scrolls nothing under it
  ov.addEventListener("touchmove", (ev) => { if (view?.drag?.on) ev.preventDefault(); }, { passive: false });
  document.addEventListener("keydown", esc);
  document.body.append(ov);
  view = { b, ov, body, esc, drag: null, more };
  room.mineOn(b, true);
  draw();
}
function closeView() {
  if (!view) return;
  view.drag?.stop?.(false);
  room?.mineOn(view.b, false);
  view.ov.remove(); document.removeEventListener("keydown", view.esc);
  view = null;
}
function draw() {
  const e = boardOf(view?.b);
  if (!e) return;
  if (view.drag?.on) { view.drag.later = true; return; } // drawn again once the note is dropped
  const l = e.live, b = view.b, staff = room.isStaff();
  view.ov.querySelector(".sbstep").textContent = l ? status(e) : "";
  view.more.hidden = !l || (!staff && l.ph !== "done");
  if (!l) return view.body.replaceChildren(el("p", { class: "muted", text: t("loading") }));
  // where it was scrolled to stays
  const box = view.ov.querySelector(".sbbox"), old = view.body.querySelector(".sbcols");
  const top = box.scrollTop, left = old?.scrollLeft || 0;
  const votes = counts(e), mineV = myVotes(e), cols = colsOf(e);
  const bar = el("div", { class: "sbbar " + l.ph },
    el("b", { text: t(l.ph === "add" ? (l.lock ? "sbPaused" : "sbAdding") : l.ph === "vote" ? "sbVoting" : "sbOver") }),
    el("span", { text: l.ph === "add" ? t(l.lock ? "sbLockedHint" : l.an ? "sbAddHintAnon" : "sbAddHintNamed") : l.ph === "vote" ? t("sbVotesLeft", { n: l.v - e.picks.length, total: l.v }) : t("sbOverHint") }),
    l.ph === "done" ? el("button", { type: "button", class: "btn small", onclick: () => exportBoard(b) }, icon("download", "sm"), el("span", { text: t("sbExport") })) : null);
  const tabs = cols.length > 1 ? el("div", { class: "sbtabs", role: "tablist" }, cols.map((c) => el("button", { type: "button", class: "chip", "data-k": c.k,
    onclick: () => view.body.querySelector(`.sbcol[data-k="${c.k}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" }) },
    el("span", { text: c.n }), el("small", { text: colNotes(e, c.k).length })))) : null;
  const canAdd = l.ph === "add" && !l.lock;
  const colsBox = el("div", { class: "sbcols" + (cols.length === 1 ? " one" : "") }, cols.map((c) => {
    let list = colNotes(e, c.k);
    if (l.ph === "done") list = list.map((n) => ({ ...n, v: votes[n.id] || 0 })).sort((x, y) => y.v - x.v || byPlace(x, y));
    return el("section", { class: "sbcol", "data-k": c.k, "aria-label": c.n },
      el("h3", { class: "sbch" }, el("span", { text: c.n }), el("small", { class: "muted", text: list.length })),
      el("div", { class: "sbnotes" },
        list.map((n) => noteEl(b, e, n, { votes: votes[n.id] || 0, mine: mineV[n.id] || 0 })),
        canAdd ? el("button", { type: "button", class: "sbadd", onclick: () => addNote(b, c.k) }, icon("plus", "sm"), el("span", { text: t("sbPut1") })) : null,
        !list.length && !canAdd ? el("p", { class: "muted small sbnone", text: t("sbEmpty") }) : null));
  }));
  view.body.replaceChildren(bar, tabs || "", colsBox);
  colsBox.scrollLeft = left; box.scrollTop = top;
}
function noteEl(b, e, n, { votes, mine }) {
  const l = e.live, own = e.mine.has(n.id);
  const foot = el("div", { class: "sbfoot" },
    n.nm ? el("span", { class: "who", text: `${n.av} ${n.nm}` }) : own ? el("span", { class: "who", text: t("sbYours") }) : el("span"),
    l.ph === "done" ? el("b", { class: "sbv" + (votes ? "" : " none"), "aria-label": t("sbVotesGot", { n: votes }) }, icon("upvote", "sm"), el("span", { text: fmt(votes) })) : null,
    l.ph === "vote" ? el("span", { class: "sbvote" },
      mine ? el("button", { type: "button", class: "sbvbtn", "aria-label": t("sbUnvote"), onclick: (ev) => { ev.stopPropagation(); vote(b, n.id, false); } }, "−") : null,
      mine ? el("b", { class: "sbmine", "aria-label": t("sbMyVotes", { n: mine }), text: "●".repeat(Math.min(mine, 5)) }) : null,
      el("button", { type: "button", class: "sbvbtn plus", "aria-label": t("sbVote"), disabled: e.picks.length >= l.v || null, onclick: (ev) => { ev.stopPropagation(); vote(b, n.id, true); } }, "+")) : null);
  const node = el("div", { class: `sbnote sn${n.c}` + (own ? " own" : "") + (canMove(e, n.id) ? " movable" : ""), "data-id": n.id, role: "button", tabindex: "0",
    "aria-label": n.t, onclick: () => { if (!view?.drag?.moved) noteMenu(b, n.id); },
    onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); noteMenu(b, n.id); } } },
    el("p", { text: n.t }), foot);
  if (canMove(e, n.id)) node.addEventListener("pointerdown", (ev) => pressNote(ev, b, n.id, node));
  return node;
}

/* ---------- dragging a note ----------
   With a mouse a note follows as soon as it moves; with a finger after holding it still for a moment (a quick swipe
   scrolls the board instead). Where it's let go decides its column and its place: before the note under the finger
   if it's on that note's first half, after it otherwise, at the end of a column if it's on no note. */
const HOLD = 350, SLOP = 8, EDGE = 48;
function pressNote(ev, b, id, node) {
  if (ev.button > 0 || !view) return;
  const touch = ev.pointerType !== "mouse";
  const d = view.drag = { b, id, node, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, on: false, moved: false, pid: ev.pointerId, timer: 0, ghost: null, raf: 0, later: false };
  if (touch) d.timer = setTimeout(() => { if (view?.drag === d) begin(d); }, HOLD);
  const move = (m) => {
    if (m.pointerId !== d.pid) return;
    d.x = m.clientX; d.y = m.clientY;
    const far = Math.hypot(d.x - d.x0, d.y - d.y0) > SLOP;
    if (!d.on) { if (far) { if (touch) return cancel(); begin(d); } else return; }
    m.preventDefault();
    place(d);
  };
  const up = (u) => { if (u.pointerId !== d.pid) return; finish(u.type === "pointerup"); };
  const cancel = () => finish(false);
  const finish = (drop) => {
    clearTimeout(d.timer);
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    if (d.on && drop) land(d);
    endDrag();
  };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  d.stop = finish;
}
function begin(d) {
  if (d.on) return;
  d.on = true; d.moved = true;
  const r = d.node.getBoundingClientRect();
  d.dx = d.x0 - r.left; d.dy = d.y0 - r.top;
  d.ghost = d.node.cloneNode(true);
  d.ghost.classList.add("sbghost");
  Object.assign(d.ghost.style, { width: r.width + "px", height: r.height + "px" });
  document.body.append(d.ghost);
  d.node.classList.add("dragging");
  navigator.vibrate?.(10);
  place(d);
  const tick = () => { if (!d.on) return; edges(d); d.raf = requestAnimationFrame(tick); };
  d.raf = requestAnimationFrame(tick);
}
// near an edge of the board, it scrolls that way (columns sideways, the page up and down)
function edges(d) {
  const cols = view?.body.querySelector(".sbcols"), box = view?.ov.querySelector(".sbbox");
  if (!cols || !box) return;
  const c = cols.getBoundingClientRect(), bx = box.getBoundingClientRect();
  if (d.x < c.left + EDGE) cols.scrollLeft -= 10; else if (d.x > c.right - EDGE) cols.scrollLeft += 10;
  if (d.y < bx.top + EDGE) box.scrollTop -= 10; else if (d.y > bx.bottom - EDGE) box.scrollTop += 10;
  place(d);
}
// where it would land: { k, i } and a mark showing it
function target(d) {
  const under = document.elementFromPoint(d.x, d.y);
  const col = under?.closest(".sbcol");
  if (!col || !view?.body.contains(col)) return null;
  const k = col.dataset.k, e = boardOf(d.b);
  const list = colNotes(e, k).filter((n) => n.id !== d.id);
  const on = under.closest(".sbnote");
  if (!on || on.dataset.id === d.id) {
    // on no note: before the first one it's above, or at the end
    const nodes = [...col.querySelectorAll(".sbnote:not(.dragging)")];
    const next = nodes.find((n) => { const r = n.getBoundingClientRect(); return d.y < r.top || (d.y < r.bottom && d.x < r.left); });
    return { k, i: next ? list.findIndex((n) => n.id === next.dataset.id) : list.length, mark: next || col, end: !next };
  }
  const r = on.getBoundingClientRect(), wide = r.width > col.getBoundingClientRect().width * 0.7;
  const before = wide ? d.y < r.top + r.height / 2 : d.x < r.left + r.width / 2;
  const i = list.findIndex((n) => n.id === on.dataset.id);
  return { k, i: before ? i : i + 1, mark: on, end: false, after: !before };
}
function place(d) {
  d.ghost.style.transform = `translate(${d.x - d.dx}px, ${d.y - d.dy}px) rotate(2deg)`;
  view.body.querySelectorAll(".dropb, .dropa, .dropend").forEach((n) => n.classList.remove("dropb", "dropa", "dropend"));
  const at = target(d);
  d.at = at;
  if (at) at.mark.classList.add(at.end ? "dropend" : at.after ? "dropa" : "dropb");
}
function land(d) {
  const at = d.at;
  d.on = false;
  if (at && at.i >= 0) moveNote(d.b, d.id, at.k, at.i);
}
function endDrag() {
  const d = view?.drag;
  if (!d) return;
  clearTimeout(d.timer); cancelAnimationFrame(d.raf);
  d.stop = null;
  d.ghost?.remove(); d.node.classList.remove("dragging");
  view.body.querySelectorAll(".dropb, .dropa, .dropend").forEach((n) => n.classList.remove("dropb", "dropa", "dropend"));
  const later = d.later || d.on;
  d.on = false;
  // the click that follows a drag doesn't open the note
  setTimeout(() => { if (view?.drag === d) view.drag = null; }, 0);
  if (later) draw();
}

/* ---------- taking it away ---------- */
async function exportBoard(b) {
  const e = boardOf(b), v = room?.msgs.get(b);
  if (!e || !v) return;
  const a = await sheet(t("sbExport"), el("p", { class: "muted", text: t("sbExportBody") }), [["csv", t("sbCsv")], ["md", t("sbMd")], ["close", t("cancel")]]);
  if (a !== "csv" && a !== "md") return;
  const rows = ranked(colsOf(e), e.notes, counts(e)), named = !e.live?.an;
  const text = a === "csv" ? boardCsv(colsOf(e), rows, [t("sbCsvCol"), t("sbCsvNote"), t("sbCsvVotes"), t("sbCsvWho")], named)
    : boardMd(v.board.t, colsOf(e), rows, (n) => t("sbVotesGot", { n }), named);
  const url = URL.createObjectURL(new Blob([text], { type: a === "csv" ? "text/csv" : "text/markdown" }));
  saveFile(url, `notes-${room.code}-${v.board.t.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40)}.${a}`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  backend.stat("exports");
}
