/* Comments under a long post: shown only on the post's page, never in the chat. Each is { by, at, name, avatar, text,
   rp } in pc/{post}/{id} (in a Private Salon { by, at, x } with the words, name and reply sealed, bound to the post and
   the author), with reactions like a message's. Writing one also names it in the post's card (msgs/{post}/cc/{id}), so
   the card counts them and everyone's chat hears of a new one: the post's author and anyone it @mentions are told.
   A comment keeps the room going like a message does, can be reported to the hosts and StoaTalk's operator, and goes
   with its post. */
import { LIMITS, REACTS } from "./constants.js?v=dev";
import { t, fmtTime, fmtWhen } from "./text.js?v=dev";
import { el, toast, icon, avatar, sheet, confirmSheet, orToast, grouped } from "./dom.js?v=dev";
import { str, PUSH_ID } from "./clean.js?v=dev";
import { backend, isDenied } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { linkify, mentionsMe } from "./richtext.js?v=dev";
import { posts as queue } from "./composer.js?v=dev";
import { isBlocked } from "./blocking.js?v=dev";
import { noteComment } from "./notify.js?v=dev";

export const SHOWN = 200; // the newest this many are shown under a post
const aad = (pid, by) => `c:${pid}:${by}`;
export const commentCount = (v) => Object.keys(v?.cc || {}).length;

// a stored comment, as shown (null for one that isn't a comment)
async function openComment(r, pid, id, c) {
  if (!c || typeof c.by !== "string") return null;
  const base = { id, by: c.by, at: +c.at || 0, re: c.re && typeof c.re === "object" ? c.re : {} };
  const p = c.x ? await r.open(r.cipher?.aes, c.x, aad(pid, c.by)) : { t: c.text, n: c.name, a: c.avatar, r: c.rp };
  if (!p) return { ...base, text: t("cantDecrypt"), name: "？", avatar: "👤", bad: true };
  return { ...base, text: str(p.t, LIMITS.comment), name: str(p.n, 24) || "？", avatar: str(p.a, 8) || "👤", ...(typeof p.r === "string" && PUSH_ID.test(p.r) ? { rp: p.r } : {}) };
}
async function openAll(r, pid, raw) {
  const list = await Promise.all(Object.entries(raw || {}).map(([id, c]) => openComment(r, pid, id, c)));
  return list.filter(Boolean).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}
// every comment of a post, fetched once (for an export); kept by post id
export async function loadComments(pid) {
  const r = room;
  const list = await openAll(r, pid, await backend.val(r.api.ref("pc/" + pid)));
  (r.comments ||= new Map()).set(pid, list);
  return list;
}
export const knownComments = (pid) => room?.comments?.get(pid) || null;

/* ---------- writing one ---------- */
async function send(pid, text, rp) {
  const r = room, uid = backend.uid, m = r?.members[uid];
  if (!r || r.gone || !m) return false;
  if (r.readOnly) { toast(t("roNoPost")); return false; }
  const id = backend.pushKey(r.api.ref("pc/" + pid)), T = backend.stamp();
  const body = r.cipher ? { x: await r.cipher.seal({ t: text, n: m.name, a: m.avatar, ...(rp ? { r: rp } : {}) }, aad(pid, uid)) }
    : { name: m.name, avatar: m.avatar, text, ...(rp ? { rp } : {}) };
  const at = (path) => r.api.root(path);
  return queue.write({ [at(`pc/${pid}/${id}`)]: { by: uid, at: T, ...body }, [at(`msgs/${pid}/cc/${id}`)]: true,
    [at("meta/last")]: T, [at(`members/${uid}/ls`)]: T, [at(`members/${uid}/lc`)]: id }, "comments");
}
// the author deletes one, or the owner or a co-host takes it down (with any reports on it)
export function removeComment(pid, c) {
  const r = room;
  return r.api.removeComment(pid, c.id, r.isStaff()).then(() => { if (c.by !== backend.uid) toast(t("removedToast")); }, () => toast(t("delFail")));
}

/* ---------- under the post ---------- */
// the comments of post pid, kept up to date, with a box to write one at the foot of the page (foot)
export function commentsView(pid, foot) {
  const r = room, uid = backend.uid, fb = backend.fb;
  const head = el("h3", { class: "chead" }), list = el("ol", { class: "clist" }), more = el("p", { class: "muted small", hidden: true });
  const section = el("section", { class: "comments", "aria-label": t("comments") }, head, more, list);
  let shown = new Map(), reply = null, seq = 0;

  const draw = (items) => {
    shown = new Map(items.map((c) => [c.id, c]));
    const n = commentCount(r.msgs.get(pid));
    head.textContent = n ? t("commentsN", { n }) : t("comments");
    more.hidden = n <= SHOWN; more.textContent = t("commentsMore", { n: SHOWN });
    const vis = items.filter((c) => !isBlocked(c.by));
    list.replaceChildren(...(vis.length ? vis.map(item) : [el("li", { class: "muted cnone", text: t("commentNone") })]));
  };
  function item(c) {
    const who = r.author(c), to = c.rp ? shown.get(c.rp) : null;
    const reacts = el("div", { class: "re" }, REACTS.map((emo, k) => {
      const ids = Object.keys(c.re[k] || {});
      return ids.length ? el("button", { type: "button", class: "chip" + (ids.includes(uid) ? " on" : ""), "aria-pressed": String(ids.includes(uid)),
        disabled: r.readOnly || r.gone || null, onclick: () => orToast(r.api.reactComment(pid, c.id, k, !ids.includes(uid))) }, `${emo} ${ids.length}`) : null;
    }));
    return el("li", { class: "cmt" + (c.by === uid ? " mine" : ""), id: "c-" + c.id },
      el("span", { class: "av" }, avatar(who.avatar)),
      el("div", { class: "cbody" },
        el("div", { class: "cwho" }, el("b", { text: who.name + r.badge(c.by) }), el("time", { text: fmtTime(c.at) })),
        c.rp ? el("div", { class: "cquote", text: to ? `↪ ${r.author(to).name}${t("colon")}${to.text.slice(0, 60)}` : "↪ " + t("commentGone") }) : null,
        el("div", { class: "ctext" + (c.bad ? " muted" : "") }, c.bad ? c.text : linkify(c.text, true)),
        reacts),
      el("button", { type: "button", class: "icon small", "aria-label": t("msgMenu"), onclick: () => actions(c) }, icon("more")));
  }
  const stop = fb.onValue(fb.query(r.api.ref("pc/" + pid), fb.limitToLast(SHOWN)), async (s) => {
    const mine = ++seq, items = await openAll(r, pid, s.val());
    if (mine === seq && section.isConnected !== false) draw(items);
  }, () => {});
  // the count in the heading follows the card
  const changed = (id) => { if (id === pid) { const n = commentCount(r.msgs.get(pid)); head.textContent = n ? t("commentsN", { n }) : t("comments"); } };
  r.on("msg-changed", changed);

  // the box at the foot of the page: a line saying who's being answered, the words, and send
  const input = el("textarea", { class: "field cin", rows: 1, maxlength: LIMITS.comment, placeholder: t("commentPh"), "aria-label": t("commentPh") });
  const replyBar = el("div", { class: "creply", hidden: true }, el("span", { class: "rtxt" }),
    el("button", { type: "button", class: "icon small", "aria-label": t("cancel"), onclick: () => setReply(null) }, icon("close")));
  const sendBtn = el("button", { type: "button", class: "btn small primary", text: t("commentSend"), onclick: () => go() });
  function setReply(c) {
    reply = c;
    replyBar.hidden = !c;
    if (c) { replyBar.querySelector(".rtxt").textContent = t("commentReplyTo", { name: r.author(c).name }); input.focus(); }
  }
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
  let sending = false;
  async function go() {
    const text = input.value.trim().slice(0, LIMITS.comment);
    if (!text || sending) return;
    if (!r.msgs.get(pid)) return toast(t("postGone"));
    sending = true; sendBtn.disabled = true;
    try {
      if (await send(pid, text, reply?.id)) { input.value = ""; grow(); setReply(null); requestAnimationFrame(() => list.lastElementChild?.scrollIntoView({ block: "nearest" })); }
    } finally { sending = false; sendBtn.disabled = false; }
  }
  const box = r.readOnly || r.gone ? el("p", { class: "muted small cro", text: t("commentRo") })
    : el("div", { class: "cform" }, replyBar, el("div", { class: "crow" }, input, sendBtn));
  foot.replaceChildren(box);

  async function actions(c) {
    if (!room || room.gone) return;
    const mine = c.by === uid, name = r.author(c).name, live = !r.readOnly && !r.gone;
    const entries = grouped([
      ["reply", t("reply"), () => live && !c.bad, () => setReply(c)],
      ["copy", t("copyText"), () => !c.bad, () => navigator.clipboard?.writeText(c.text).then(() => toast(t("copied")), () => toast(t("cantCopy")))],
      ["at", t("mentionName", { name }), () => live && !mine && r.members[c.by], () => { input.value += (input.value && !/\s$/.test(input.value) ? " " : "") + "@" + name + " "; grow(); input.focus(); }],
      { group: "" },
      ["report", t("report"), () => !mine && !r.isStaff(), () => reportComment(pid, c)],
      ["del", t("commentDel"), () => mine, async () => { if (await confirmSheet(t("commentDel"), t("delMsgBody"), t("del"))) removeComment(pid, c); }, "danger"],
      ["remove", t("commentRemove"), () => !mine && r.isStaff(), async () => { if (await confirmSheet(t("commentRemove"), t("delMsgBody"), t("removeMsg"))) removeComment(pid, c); }, "danger"],
    ], ([, , when]) => when());
    const reacts = live ? el("div", { class: "reactrow" }, REACTS.map((emo, k) =>
      el("button", { type: "button", class: "chip big" + (c.re[k]?.[uid] ? " on" : ""), "data-a": "re" + k, text: emo }))) : null;
    let picked = null;
    const a = await sheet("", el("div", {}, el("time", { class: "mwhen", text: fmtWhen(c.at) }), el("blockquote", { class: "quote", text: c.text.length > 140 ? c.text.slice(0, 140) + "…" : c.text }), reacts),
      entries.map((e) => (Array.isArray(e) ? [e[0], e[1], e[4]] : e)),
      { onOpen: (ov) => reacts?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { picked = +b.dataset.a.slice(2); ov.close("react"); } }) });
    if (a === "react") return orToast(r.api.reactComment(pid, c.id, picked, !c.re[picked]?.[uid]));
    entries.find((e) => e[0] === a)?.[3]();
  }
  return { el: section, stop: () => { stop(); r.un("msg-changed", changed); } };
}

/* ---------- reports ---------- */
async function reportComment(pid, c) {
  const a = await sheet(t("reportTitle"), el("p", { class: "muted", text: t("reportBody") }), [0, 1, 2, 3].map((k) => ["r" + k, t("why" + k)]).concat([["no", t("cancel")]]));
  if (!a?.startsWith("r") || !room || room.gone) return;
  const seen = { who: c.by, p: pid, t: c.text.slice(0, LIMITS.text), n: String(c.name || "").slice(0, LIMITS.shownName) };
  if (room.cipher) seen.enc = true;
  room.api.report(c.id, +a.slice(1), seen).then(() => toast(t("reportedToast")), (e) => toast(t(isDenied(e) ? "reportedAlready" : "tryAgain")));
}
// a reported comment, for the hosts' list of reports (null once it's gone)
export async function reportedComment(pid, id) {
  const r = room;
  return r.msgs.has(pid) ? openComment(r, pid, id, await backend.val(r.api.ref(`pc/${pid}/${id}`))) : null;
}

/* ---------- telling people ---------- */
// a post's card changed: new comments on my post, or ones that @mention me, are worth telling about
export async function noteComments(pid, v, old) {
  if (!v?.post || !old?.post || !room?.ready) return;
  const added = Object.keys(v.cc || {}).filter((id) => !old.cc?.[id]);
  const r = room, uid = backend.uid;
  for (const id of added) {
    const c = await openComment(r, pid, id, await backend.val(r.api.ref(`pc/${pid}/${id}`)));
    if (!c || c.bad || c.by === uid || isBlocked(c.by) || r !== room) continue;
    const atMe = mentionsMe(c.text);
    if (v.by !== uid && !atMe) continue;
    if (!document.hidden && document.querySelector(`.reader[data-post="${pid}"]`)) continue; // reading it already
    noteComment(v, c, atMe);
  }
}
