/* The chat screen: entering a room, its header, the message list (the room's or a private chat's), pinned
   announcements, and what happens when the room goes away. The Room tells this what changed; this draws it. */
import { APP, GROUP_MS, FRESH_MS, KLIPY_KEY, LIMITS, REACTS } from "./constants.js?v=dev";
import { t, tEl, fmtTime } from "./text.js?v=dev";
import { $, el, toast, sheet, orToast } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room, setRoom } from "./session.js?v=dev";
import { Room } from "./room.js?v=dev";
import { kindOf, snippet } from "./kinds.js?v=dev";
import { mentionsMe, linkify } from "./richtext.js?v=dev";
import { isBlocked } from "./blocking.js?v=dev";
import { cancelReply, typing, renderTyping, box } from "./composer.js?v=dev";
import { msgActions } from "./actions.js?v=dev";
import { closePicker } from "./pickers.js?v=dev";
import { renderQa, refreshWait, watchQa } from "./qa.js?v=dev";
import { watchShow, SHOW } from "./show.js?v=dev";
import { noteNew, offerNotify, hiddenUnread, notifyOn } from "./notify.js?v=dev";
import { syncPush } from "./push.js?v=dev";
import { rememberRoom, forgetRoom, roomPath, showChat, home } from "./home.js?v=dev";
import { archive, saveRecord, openRecord, exportSheet } from "./records.js?v=dev";
import { editDesc } from "./menu.js?v=dev";
import { phase, hoursLeft, minutesLeft } from "./expiry.js?v=dev";

export const LIST = () => $("#list");

/* ---------- entering and leaving ---------- */
// stop following a room (typing goes too)
export function stopRoom(r = room) { typing.stop(); r?.stop(); }
export function enter(code, cipher) {
  stopRoom();
  const r = new Room(code, cipher);
  setRoom(r);
  if (SHOW()) backend.stat("shows");
  rememberRoom(code);
  roomPath(code);
  LIST().replaceChildren(); $("#ageBar").hidden = true;
  showChat(); offerNotify();
  watchChat(r); watchQa(r); watchShow(r);
  r.start();
}
function watchChat(r) {
  const inRoomView = () => r.ui.view === "all";
  // the room's age is a matter of time, not only of what the database says: look again every half minute
  const tick = setInterval(() => { if (r.current && !r.gone) renderAge(); }, 30000);
  r.off.push(() => clearInterval(tick));
  r.on("meta", () => { renderHeader(); renderDesc(); renderPins(); refreshNames(); renderAge(); })
    .on("ended", () => gone("ended"))
    .on("lost", checkGone)
    .on("arrivals", ({ joined, left }) => {
      joined.forEach((m) => toast(t("joinedToast", { who: `${m.avatar} ${m.name}` })));
      left.forEach((m) => toast(t("leftToast", { who: `${m.avatar} ${m.name}` })));
    })
    .on("members", () => {
      renderHeader(); refreshNames();
      // once I'm in: this room's push subscription, if this device wants to hear from it while the page is closed
      if (!r.pushSynced && r.members[backend.uid]) { r.pushSynced = true; if (notifyOn(r.code)) syncPush(r.code, true); }
    })
    .on("msg", (id, v) => { if (inRoomView()) addMsg(id, v); if (pinIds().includes(id)) renderPins(); noteNew(v, null); })
    .on("msg-changed", (id, v, old) => { if (inRoomView()) updateMsg(id, v, old); })
    .on("msg-removed", (id) => { if (inRoomView()) document.getElementById("m-" + id)?.remove(); renderPins(); })
    .on("typing", renderTyping)
    .on("qs", renderHeader)
    .on("dm", (other, id, v) => {
      if (r.ui.view === other) { addMsg(id, v, true); markRead(other, v.at); }
      else if (v.by !== backend.uid && v.at > lastRead(other) && !isBlocked(other)) {
        r.ui.unread[other] = (r.ui.unread[other] || 0) + 1;
        if (Date.now() - v.at < FRESH_MS) toast(t("dmToast", { who: r.nameOf(other) }));
        renderHeader();
      }
      noteNew(v, other);
    })
    .on("reports", ({ more }) => { if (more) toast(t("newReport")); renderHeader(); })
    .on("qq", ({ more }) => { if (more) toast(t("qNewWaiting")); renderHeader(); });
}
// the room on screen is done for this device: forget it here
export function leaveDevice(code) { forgetRoom(code); store.set(KEYS.roomKey(code), null); }
// the room went away under us: find out why
export async function checkGone() {
  const r = room;
  if (!r || r.gone) return;
  const why = await r.whyGone();
  if (why) gone(why);
}
export async function gone(why) {
  if (!room || room.gone) return;
  room.gone = true; stopRoom();
  leaveDevice(room.code);
  if (why === "self") return home();
  const text = t({ ended: "goneEnded", kicked: "goneKicked", left: "goneLeft" }[why]);
  $("#composer").classList.add("off");
  for (;;) {
    const a = await sheet(t("goneTitle"), el("p", { class: "muted", text: text + t("goneKeep") }), [["save", t("saveHere"), "primary"], ["export", t("downloadFile")], ["home", t("backHome")]]);
    if (a === "save") { const id = saveRecord(archive()); if (id) return openRecord(null, id); continue; }
    if (a === "export") { await exportSheet(); continue; }
    break;
  }
  home();
}

/* ---------- the header ---------- */
export function renderHeader() {
  if (!room) return;
  const meta = room.meta || {}, ui = room.ui;
  $("#roomTitle").textContent = meta.title || t("room");
  $("#codeBtn").textContent = (meta.enc ? "🔐 " : "") + room.code + (meta.locked ? " · " + t("lockedTag") : "");
  $("#peopleBtn .n").textContent = Object.values(room.members || {}).filter((m) => m.online !== false).length;
  $("#peopleBtn .dot").hidden = !Object.values(ui.unread).some((n) => n > 0);
  $("#chat .bar [data-a=menu] .dot").hidden = !room.reportCount();
  $("#composer").classList.toggle("off", room.gone || room.readOnly);
  const tabs = $("#tabs");
  tabs.hidden = !(meta.qa || room.qs.size) || ui.isDm;
  $("[data-a=qa] .n", tabs).textContent = room.qs.size ? " " + room.qs.size : "";
  $("[data-a=qa] .dot", tabs).hidden = !(room.isStaff() && room.qq.size);
  tabs.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.a === ui.view)));
  if (ui.isDm) $("#dmBar .dmwho").replaceChildren(...tEl("dmBar", { name: el("b", { text: room.nameOf(ui.view) }) }));
  if (!document.hidden || !hiddenUnread()) document.title = meta.title || APP;
}
// everyone's current name on the messages already shown
function refreshNames() {
  document.querySelectorAll("#list .msg").forEach((node) => {
    const p = room.who(node.dataset.by); if (!p) return;
    const av = $(".who .av", node), nm = $(".who .nm", node); if (!nm) return;
    av.textContent = p.avatar; nm.textContent = p.name + room.badge(node.dataset.by);
  });
}

/* ---------- messages ---------- */
// prev: the node it follows (the list's last one by default); show: unfold a blocked person's message
function bubble(id, v, dm, { prev = LIST().lastElementChild, show = false } = {}) {
  const mine = v.by === backend.uid;
  const cont = prev && prev.dataset.by === v.by && v.at - Number(prev.dataset.at) < GROUP_MS;
  const attrs = { id: (dm ? "d-" : "m-") + id, "data-by": v.by, "data-at": v.at, "data-id": id };
  if (!mine && !show && isBlocked(v.by)) {
    const folded = el("div", { class: "msg folded", ...attrs },
      el("button", { type: "button", class: "foldbtn", onclick: () => folded.replaceWith(bubble(id, v, dm, { prev: folded.previousElementSibling, show: true })) }, t("blockedMsg")));
    return folded;
  }
  const atMe = !mine && !dm && mentionsMe(v.text), who = room.author(v, dm);
  const node = el("div", { class: "msg" + (mine ? " mine" : "") + (cont ? " cont" : "") + (atMe ? " atme" : ""), ...attrs },
    cont ? null : el("div", { class: "who" },
      el("span", { class: "av", text: who.avatar }),
      el("span", { class: "nm", text: who.name + room.badge(v.by) }),
      el("time", { text: fmtTime(v.at) })),
    v.rp ? replyQuote(v.rp, dm) : null,
    // the ⋯ beside the bubble opens what can be done with a message; the bubble itself is for reading
    // (and selecting text), a photo opens full size, a poll's options vote
    el("div", { class: "brow" },
      kindOf(v).bubble(id, v, dm),
      el("button", { type: "button", class: "more", "aria-label": t("msgMenu"), text: "⋯", onclick: () => msgActions(id, (dm ? null : room.msgs.get(id)) || v, dm) })),
    v.ed ? el("small", { class: "edited", text: t("edited") }) : null,
    dm ? null : el("div", { class: "re" }));
  if (!dm) fillReacts(node, v);
  return node;
}
const findMsg = (id, dm) => (dm ? room.dms.get(room.ui.view)?.get(id) : room.msgs.get(id));
function replyQuote(rp, dm) {
  const o = findMsg(rp, dm);
  return el("button", { type: "button", class: "rpq", onclick: () => jumpTo(rp, dm) },
    o ? el("b", { text: room.author(o, dm).name + t("colon") }) : null, o ? snippet(o) : t("origDeleted"));
}
export function jumpTo(id, dm) {
  const node = document.getElementById((dm ? "d-" : "m-") + id);
  if (!node) return toast(t("origNotFound"));
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash");
}
function fillReacts(node, v) {
  const row = $(".re", node); if (!row) return;
  const uid = backend.uid;
  row.replaceChildren(...REACTS.map((emo, k) => {
    const who = Object.keys(v.re?.[k] || {});
    if (!who.length) return null;
    return el("button", { type: "button", class: "chip" + (who.includes(uid) ? " on" : ""), title: who.map((id) => room.nameOf(id)).join(t("listSep")), onclick: () => react(node.dataset.id, k, !who.includes(uid)) }, `${emo} ${who.length}`);
  }).filter(Boolean));
}
export const react = (id, k, on) => orToast(room.api.react(id, k, on));

const nearEnd = () => { const l = LIST(); return l.scrollHeight - l.scrollTop - l.clientHeight < 80; };
function addMsg(id, v, dm) {
  const list = LIST(), ui = room.ui;
  const stick = nearEnd() || v.by === backend.uid;
  $(".empty", list)?.remove();
  if (!dm) newLine(list, v);
  list.append(bubble(id, v, dm));
  if (ui.div?.isConnected && !ui.touched && v.at <= room.t0) ui.div.scrollIntoView({ block: "start" }); // history still loading: start where they left off
  else if (stick) list.scrollTop = list.scrollHeight;
  else if (v.by !== backend.uid && v.at > room.t0) ui.below++;
  showJump(); markSeen();
}
// a line above the first message that came since this device last read the room (ui.readMark)
function newLine(list, v) {
  const ui = room.ui;
  if (ui.readMark && !ui.div && v.at > ui.readMark && v.by !== backend.uid) list.append(ui.div = el("div", { class: "newline", text: t("newMsgs") }));
}
function updateMsg(id, v, old) {
  const node = document.getElementById("m-" + id);
  if (!node) return;
  if (old && (old.text !== v.text || old.ed !== v.ed)) { node.replaceWith(bubble(id, v, false, { prev: node.previousElementSibling })); return; } // edited
  fillReacts(node, v);
  kindOf(v).refresh?.(node, id, v);
}
// this device has read the room up to its newest message once the bottom is on screen
export function markSeen() {
  if (!room || room.gone || room.ui.view !== "all" || document.hidden || $("#chat").hidden || !room.lastAt || !nearEnd()) return;
  room.ui.below = 0;
  if (room.lastAt > (+store.get(KEYS.read(room.code)) || 0)) store.set(KEYS.read(room.code), String(room.lastAt));
}
// the ↓ button: back to the newest message, with how many came in while scrolled up
export function showJump() {
  const b = $("#jumpBtn"), l = LIST();
  b.hidden = !room || room.gone || l.scrollHeight - l.scrollTop - l.clientHeight < 300;
  b.textContent = room?.ui.below ? t("jumpNew", { n: room.ui.below }) : "↓";
}
// when this device last read each private chat, so a reload doesn't count old messages as new
const lastRead = (other) => +store.get(KEYS.dmRead(room.code, other)) || 0;
const markRead = (other, at) => { if (typeof at === "number" && at > lastRead(other)) store.set(KEYS.dmRead(room.code, other), String(at)); };

/* ---------- views: the room, its questions, or a private chat ---------- */
export function setView(view) { room.ui.view = view; renderView(); }
export function renderView() {
  closePicker();
  const ui = room.ui, ta = box();
  // each view keeps its own unsent text, so a private message can't slip into the room (or the other way)
  if (ui.shown !== ui.view) {
    if (ui.shown !== undefined) ui.drafts[ui.shown] = ta.value;
    ta.value = ui.drafts[ui.view] || ""; ta.dispatchEvent(new Event("input"));
    ui.shown = ui.view; cancelReply(); typing.stop();
  }
  renderDesc(); renderPins();
  const list = LIST();
  list.replaceChildren();
  $("#dmBar").hidden = !ui.isDm;
  $("#composer [data-a=more]").hidden = ui.view !== "all"; // photos, polls and draws are for the room
  $("#composer [data-a=gif]").hidden = !KLIPY_KEY || ui.view === "qa";
  $("#chat").classList.toggle("indm", ui.isDm);
  $("#chat").classList.toggle("inqa", ui.view === "qa");
  $("#askBar").hidden = ui.view !== "qa";
  ta.maxLength = ui.view === "qa" ? LIMITS.question : LIMITS.text;
  ui.div = null; ui.touched = false;
  if (ui.view === "all") {
    if (!room.msgs.size) list.append(el("p", { class: "empty", text: t("emptyRoom") }));
    ui.readMark = +store.get(KEYS.read(room.code)) || 0; // where this device stopped reading (messages still loading go through addMsg)
    room.msgs.forEach((v, id) => { newLine(list, v); list.append(bubble(id, v)); });
    ta.placeholder = t("textPh");
  } else if (ui.view === "qa") {
    ta.placeholder = t("askPh");
    renderQa(); refreshWait();
  } else {
    const msgs = room.dms.get(ui.view) || new Map();
    if (!msgs.size) list.append(el("p", { class: "empty", text: t("emptyDm") }));
    msgs.forEach((v, id) => { list.append(bubble(id, v, true)); markRead(ui.view, v.at); });
    ui.unread[ui.view] = 0;
    ta.placeholder = t("dmPh", { name: room.nameOf(ui.view) });
  }
  renderHeader(); renderTyping();
  if (ui.view === "qa") list.scrollTop = 0;
  else if (ui.div) ui.div.scrollIntoView({ block: "start" }); else list.scrollTop = list.scrollHeight;
  ui.below = 0; showJump(); markSeen();
}
export function openDm(other) {
  if (other === backend.uid) return;
  room.watchDm(other);
  setView(other); box().focus();
}

/* ---------- the room's description (meta/desc), under its name: one line, and the rest on a tap ---------- */
let descOpen = null; // the code of the room whose description is open
// hidden on this device until the owner writes a new one; the ⋯ menu still shows it
export const descHidden = () => !!room?.meta?.desc && store.get(KEYS.descHidden(room.code)) === room.meta.desc;
export function setDescHidden(on) { store.set(KEYS.descHidden(room.code), on ? room.meta?.desc : null); renderDesc(); }
export function renderDesc() {
  const box = $("#desc");
  if (!room) return;
  const desc = room.meta?.desc || "";
  box.hidden = !desc || room.ui.isDm || descHidden();
  if (box.hidden) return box.replaceChildren();
  const open = descOpen === room.code;
  const toggle = () => { descOpen = open ? null : room.code; renderDesc(); };
  const text = el("div", { class: "dtext" }, linkify(desc));
  const more = el("button", { type: "button", class: "link dmore", "aria-expanded": String(open), text: t(open ? "descLess" : "descMore"), onclick: toggle });
  box.classList.toggle("open", open);
  const hide = el("button", { type: "button", class: "link dhide", text: t("descHide"), onclick: () => { setDescHidden(true); toast(t("descHiddenToast")); } });
  // closed: the first line, with 更多 and 隱藏 at its end; open: all of it, then 收起 (and 編輯 for the owner and
  // co-hosts) with 隱藏 at the far right
  if (!open) box.replaceChildren(text, more, hide);
  else box.replaceChildren(text, el("div", { class: "drow" }, more,
    room.isStaff() ? el("button", { type: "button", class: "link", text: t("editDesc"), onclick: () => editDesc() }) : null, hide));
  // a link in it opens; a tap anywhere else on a closed one opens it
  text.onclick = (e) => { if (!open && !more.hidden && !e.target.closest("a")) toggle(); };
  // short enough to show whole: nothing to open
  if (!open) requestAnimationFrame(() => { more.hidden = !desc.includes("\n") && text.scrollWidth <= text.clientWidth + 1; });
}

/* ---------- winding down (js/app/expiry.js): nobody spoke for almost 24 hours, or the room is read-only ---------- */
let warnedAt = null; // the meta/last the in-page warning was shown for, so it toasts once
export function renderAge() {
  const bar = $("#ageBar");
  if (!room?.meta) return;
  const { state, left } = phase(room.meta.last, backend.now());
  const ro = state === "ro" || state === "gone";
  if (ro !== room.readOnly) { room.readOnly = ro; if (ro) { cancelReply(); typing.stop(); closePicker(); } renderHeader(); }
  bar.hidden = state === "live" || room.gone;
  if (bar.hidden) return bar.replaceChildren();
  const text = ro ? t("roBar", { h: hoursLeft(left) }) : t("soonBar", { m: minutesLeft(left) });
  bar.replaceChildren(...[el("span", { text }), ro ? el("button", { type: "button", class: "btn small", text: t("roSave"), onclick: () => exportSheet() }) : null].filter(Boolean));
  if (state === "soon" && warnedAt !== room.code + room.meta.last) { warnedAt = room.code + room.meta.last; toast(text); }
}

/* ---------- pinned announcements (meta/pins, owner only, at most 3) ---------- */
export const pinIds = () => Object.entries(room?.meta?.pins || {}).sort(([a], [b]) => a - b).map(([, id]) => id);
let pinsOpen = false;
export function renderPins() {
  const bar = $("#pins");
  if (!room) return;
  const ids = pinIds();
  bar.hidden = !ids.length || room.ui.view !== "all";
  if (bar.hidden) return bar.replaceChildren();
  // newest message first; one gone from the room still shows, so the owner can take it down
  const items = ids.map((id) => ({ id, v: room.msgs.get(id) })).sort((a, b) => (b.v?.at || 0) - (a.v?.at || 0));
  const line = (it) => (it.v ? snippet(it.v) : t("pinGone"));
  bar.classList.toggle("open", pinsOpen);
  bar.replaceChildren(...[
    el("button", { type: "button", class: "pinhead", "aria-expanded": String(pinsOpen), onclick: () => { pinsOpen = !pinsOpen; renderPins(); } },
      el("span", { text: "📌" }), el("span", { class: "one", text: pinsOpen ? t("pinsTitle") : line(items[0]) }),
      el("span", { class: "n", text: ids.length > 1 || pinsOpen ? t("pinsN", { n: ids.length }) : "" }), el("span", { class: "chev", text: "▾" })),
    pinsOpen ? el("ul", {}, items.map((it) => el("li", {},
      el("button", { type: "button", class: "go", onclick: () => it.v && jumpTo(it.id) },
        it.v ? el("small", { text: `${room.author(it.v).avatar} ${room.author(it.v).name} · ${fmtTime(it.v.at)}` }) : null,
        (it.v && kindOf(it.v).pinned?.(it.v)) || line(it)),
      room.isOwner() ? el("button", { type: "button", class: "btn small unpin", text: t("unpin"), onclick: () => pin(it.id, false) }) : null))) : null].filter(Boolean));
}
export function pin(id, on) {
  const pins = room.meta?.pins || {};
  const slot = on ? ["0", "1", "2"].find((k) => !pins[k]) : Object.keys(pins).find((k) => pins[k] === id);
  if (slot === undefined) return toast(on ? t("pinMax") : "");
  room.api.pin(slot, on ? id : null).then(() => toast(t(on ? "pinnedToast" : "unpinnedToast")), () => toast(t("tryAgain")));
}
