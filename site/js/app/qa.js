/* Lecture Q&A. The owner turns it on (meta/qa); people ask in the ❓ tab, by name or anonymously, and upvote each
   other's questions, which sort by votes. The owner and co-hosts mark one as being answered now (meta/qnow, shown
   large on the projector) and others as answered, and take any down. With review on (meta/qmod) a question waits
   in qq/ until they let it through. Who asked sits in qby/{id}, which only the asker can read: anonymous means
   anonymous to the owner too. In an encrypted room a question is sealed with the room key, bound to its id. */
import { LIMITS } from "./constants.js?v=dev";
import { t, fmtTime } from "./text.js?v=dev";
import { $, el, toast, sheet, confirmSheet, orToast, icon, avatar, bare } from "./dom.js?v=dev";
import { StoredList, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { me } from "./identity.js?v=dev";
import { linkify } from "./richtext.js?v=dev";
import { posts } from "./composer.js?v=dev";
import { LIST, setView } from "./chat.js?v=dev";

const MAX_MINE = 200;
export function watchQa(r) {
  r.on("meta", renderQa).on("qq", renderQa).on("qs", () => { renderQa(); if (r.myWait.size) refreshWait(); });
}

// the questions this device asked in a room (so it can take them back, and knows not to upvote them)
const myQList = (code = room.code) => new StoredList(KEYS.myQs(code));
const isMyQ = (id) => myQList().includes(id);
export const byVotes = (a, b) => b.up.length - a.up.length || a.at - b.at;
const askAnon = () => $("#askAnon").checked;

export async function ask(text) {
  text = (text || "").trim().slice(0, LIMITS.question);
  if (!text || !room || room.gone) return false;
  if (!room.meta?.qa) { toast(t("qaClosedToast")); return false; }
  const r = room, uid = backend.uid, T = backend.stamp(), id = backend.pushKey(r.api.ref("qs")), at = (p) => r.api.root(p);
  const m = r.members[uid] || me(), named = !askAnon(), wait = r.meta.qmod === true && !r.isStaff(); // the owner's and co-hosts' own skip review
  const body = r.cipher ? { x: await r.cipher.seal(named ? { t: text, n: m.name, a: m.avatar } : { t: text }, "q:" + id), at: T }
    : { text, ...(named ? { name: m.name, avatar: m.avatar } : {}), at: T };
  myQList().save([...myQList().all(), id].slice(-MAX_MINE));
  r.justAsked.add(id);
  if (wait) r.myWait.add(id);
  posts.write({ [at(`${wait ? "qq" : "qs"}/${id}`)]: body, [at(`qby/${id}`)]: uid, [at(`members/${uid}/ls`)]: T, [at(`members/${uid}/lq`)]: id, [at("meta/last")]: T }, "qs")
    .then((ok) => {
      if (r !== room) return;
      if (!ok) { r.myWait.delete(id); return renderQa(); }
      if (wait) toast(t("qWaitToast"));
    });
  renderQa();
  return true;
}
// the owner or a co-host lets a waiting question through, word for word
async function approveQ(id) {
  const v = room.qqRaw[id] || (await backend.val(room.api.ref("qq/" + id)));
  if (!v || !room || room.gone) return;
  const q = {};
  ["at", "text", "x", "name", "avatar"].forEach((k) => { if (v[k] != null) q[k] = v[k]; });
  orToast(room.api.approve(id, q));
}
async function removeQ(id, waiting) {
  const mine = isMyQ(id) && !room.isStaff(), word = mine ? "qTakeBack" : "qRemove";
  if (!waiting && !(await confirmSheet(t(word), t(mine ? "qTakeBackBody" : "qRemoveBody"), t(word)))) return;
  orToast(room.api.removeQuestion(id, { waiting, clearNow: room.isStaff() && room.meta?.qnow === id }));
}
const markDone = (id, on) => orToast(room.api.markDone(id, on, on && room.meta?.qnow === id));
// write, rewrite or take down the answer; saving one also marks the question answered (and keeps it on the projector if it's the live one)
async function answerQ(q) {
  const input = el("textarea", { class: "field", maxlength: LIMITS.answer, rows: 6, id: "ansText", placeholder: t("qAnsPh"), "aria-label": t("qAnsTitle") });
  input.value = q.ans && !q.ans.bad ? q.ans.text : "";
  const a = await sheet(t("qAnsTitle"), el("div", {}, el("p", { class: "muted qansq", text: q.text }), input),
    [["no", t("cancel")], ...(q.ans ? [["del", t("qAnsDel"), "danger"]] : []), ["yes", t("save"), "primary"]], { onOpen: () => input.focus() });
  if (!a || a === "no" || !room || room.gone) return;
  if (a === "del") return orToast(room.api.deleteAnswer(q.id));
  const text = input.value.trim().slice(0, LIMITS.answer);
  if (!text) return;
  if (q.ans && !q.ans.bad && text === q.ans.text) return;
  const m = room.members[backend.uid] || me(), uid = backend.uid, T = backend.stamp();
  const ans = room.cipher ? { by: uid, at: T, x: await room.cipher.seal({ t: text, n: m.name, a: m.avatar }, "a:" + q.id) } : { by: uid, at: T, text, name: m.name, avatar: m.avatar };
  room.api.answer(q.id, ans, !q.done).then(() => !q.done && toast(t("qAnsSaved")), () => toast(t("tryAgain")));
}
export function setQa(on) {
  room.api.setMeta({ qa: on }).then(() => {
    toast(t(on ? "qaOnToast" : "qaOffToast"));
    if (on) { backend.stat("qa"); if (room && !room.gone) setView("qa"); }
  }, () => toast(t("tryAgain")));
}
// which of my questions are still waiting for review (each one only I can read)
export async function refreshWait() {
  if (!room || room.gone || room.isStaff()) return;
  const r = room, still = new Set(), list = myQList(r.code);
  await Promise.all(list.all().filter((id) => !r.qs.has(id)).map((id) => r.justAsked.has(id) ? still.add(id)
    : backend.fb.get(r.api.ref("qq/" + id)).then((s) => s.exists() && still.add(id), () => still.add(id))));
  if (r !== room) return;
  list.save(list.all().filter((id) => r.qs.has(id) || still.has(id)));
  const changed = still.size !== r.myWait.size || [...still].some((id) => !r.myWait.has(id));
  r.myWait = still;
  if (changed) renderQa();
}

/* ---------- drawing the questions ---------- */
function qCard(q, waiting) {
  const staff = room.isStaff(), mine = isMyQ(q.id), uid = backend.uid;
  const live = !waiting && room.meta?.qnow === q.id && (!q.done || !!q.ans), voted = q.up.includes(uid);
  const btn = (label, fn, cls = "") => el("button", { type: "button", class: "btn small " + cls, text: label, onclick: fn });
  const tools = [];
  if (waiting) tools.push(btn(t("qApprove"), () => approveQ(q.id), "primary"), btn(t("qReject"), () => removeQ(q.id, true), "danger"));
  else if (!room.gone) {
    if (staff && !q.bad) tools.push(btn(t(q.ans ? "qAnsEdit" : "qAnsWrite"), () => answerQ(q), q.ans ? "" : "primary"));
    if (staff && (!q.done || live)) tools.push(btn(t(live ? "qNowOff" : "qNowOn"), () => orToast(room.api.setQNow(live ? null : q.id))));
    if (staff) tools.push(btn(t(q.done ? "qUndone" : "qDone"), () => markDone(q.id, !q.done)));
    // taking a question down is quiet red text at the far end
    if (staff || mine) tools.push(btn(t(mine && !staff ? "qTakeBack" : "qRemove"), () => removeQ(q.id, false), "danger end"));
  }
  // vote | question, the host's tools on a row of their own; a waiting question shows an hourglass where the vote goes
  return el("div", { class: "qcard" + (live ? " live" : "") + (q.done ? " done" : "") + (waiting ? " waiting" : ""), id: "q-" + q.id },
    waiting ? el("span", { class: "wicon" }, icon("hourglass")) : el("button", { type: "button", class: "upvote" + (voted ? " on" : ""), "aria-pressed": String(voted), "aria-label": t("qUpvote"),
      title: mine ? t("qMine") : t("qUpvote"), disabled: mine || room.gone || q.bad, onclick: () => orToast(room.api.upvote(q.id, !voted)) },
      icon("upvote", "sm"), el("b", { text: q.up.length })),
    el("div", { class: "qbody" },
      live ? el("span", { class: "tag live", text: t("qLive") }) : q.done ? el("span", { class: "tag ok" }, icon("answered"), t("qDoneTag")) : null,
      qWho(q.name, q.avatar, mine ? el("small", { class: "qmine", text: t("qMine") }) : null, el("time", { text: fmtTime(q.at) })),
      el("p", { class: "qtext" }, linkify(q.text)),
      q.ans ? ansBox(q.ans, fmtTime) : null),
    tools.length ? el("div", { class: "qtools" }, tools) : null);
}
// who asked: their animal and name, or the anonymous mark
export const qWho = (name, av, ...more) => el("div", { class: "qwho" },
  name ? el("span", { class: "qav" }, avatar(av)) : el("span", { class: "qav anon" }, icon("anonymous", "sm")),
  el("span", { class: "nm", text: name || bare(t("anonAsker")) }), ...more);
// an answer under its question; when: how its time reads
export const ansBox = (a, when) => el("div", { class: "qans" },
  el("div", { class: "qwho" }, icon("chat", "sm"), a.name ? el("span", { class: "qav" }, avatar(a.avatar)) : null, a.name ? el("span", { class: "nm", text: a.name }) : null,
    el("small", { text: t("qAnsLabel") }), a.at ? el("time", { text: when(a.at) }) : null),
  el("p", { class: "qtext" }, linkify(a.text)));
export function renderQa() {
  if (!room || room.ui.view !== "qa" || $("#chat").hidden) return;
  const list = LIST(), keep = list.scrollTop, staff = room.isStaff(), meta = room.meta;
  const all = [...room.qs.values()];
  const onScreen = (q) => meta?.qnow === q.id && !!q.ans; // an answered question stays up top while it's on the projector
  const open = all.filter((q) => !q.done || onScreen(q)).sort(byVotes), done = all.filter((q) => q.done && !onScreen(q)).sort((a, b) => b.done - a.done);
  const parts = [];
  if (!meta?.qa) parts.push(el("p", { class: "note", text: t("qaClosedNote") }));
  else if (meta.qmod) parts.push(el("p", { class: "note qnote" }, icon("info", "sm"), el("span", { text: t(staff ? "qModStaffNote" : "qModNote") })));
  if (staff && room.qq.size) parts.push(el("h3", { class: "qh", text: t("qWaitingN", { n: room.qq.size }) }), ...[...room.qq.values()].sort((a, b) => a.at - b.at).map((q) => qCard(q, true)), el("h3", { class: "qh", text: t("qOpenN", { n: open.length }) }));
  if (!staff && room.myWait.size) parts.push(el("p", { class: "note qnote wait" }, icon("hourglass", "sm"), el("span", { text: t("qMineWaiting", { n: room.myWait.size }) })));
  if (open.length) parts.push(...open.map((q) => qCard(q)));
  else if (!done.length && meta?.qa) parts.push(el("p", { class: "empty", text: t("qEmpty") }));
  if (done.length) {
    const d = el("details", { class: "qdone", open: room.ui.qdoneOpen }, el("summary", {}, icon("expand", "sm chev"), t("qDoneN", { n: done.length })), done.map((q) => qCard(q)));
    d.addEventListener("toggle", () => (room.ui.qdoneOpen = d.open));
    parts.push(d);
  }
  list.replaceChildren(...parts);
  list.scrollTop = keep;
}
