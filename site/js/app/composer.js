/* The message box: sending (rate-limited), replying, "someone is typing", and @ suggestions. */
import { LIMITS, POST_GAP_MS } from "./constants.js?v=dev";
import { t, tEl } from "./text.js?v=dev";
import { $, el, toast, pause } from "./dom.js?v=dev";
import { backend, isDenied } from "./backend.js?v=dev";
import { seal } from "./crypto.js?v=dev";
import { room } from "./session.js?v=dev";
import { me } from "./identity.js?v=dev";
import { pairKey } from "./room.js?v=dev";
import { KIND, snippet } from "./kinds.js?v=dev";
import { isBlocked } from "./blocking.js?v=dev";
import { announce } from "./push.js?v=dev";
import { renderQuick } from "./quick.js?v=dev";

export const box = () => $("#text");

/* ---------- sending ----------
   The rules let one person post at most every 800 ms, one message per write. Messages written faster than that
   wait their turn, a second apart, in the order they were written; one that still lands too soon tries once more. */
class PostQueue {
  #last = 0;
  // one update, written in its turn; what: the usage count it adds one to once it's in
  write(upd, what) {
    const wait = this.#last + POST_GAP_MS - Date.now();
    this.#last = Math.max(Date.now(), this.#last + POST_GAP_MS);
    const go = (again) => backend.update(upd).then(() => { backend.stat(what); return true; }, (e) => {
      if (again && isDenied(e)) { this.#last = Math.max(this.#last, Date.now()) + POST_GAP_MS; return pause(POST_GAP_MS).then(() => go(false)); }
      console.error(e); toast(t("sendFail")); return false;
    });
    return wait > 0 ? pause(wait).then(() => go(true)) : go(true);
  }
}
export const posts = new PostQueue();

export function send(text) {
  text = (text || "").trim().slice(0, LIMITS.text);
  return text ? post(KIND.text, text) : false;
}
export const sendGif = (gif) => post(KIND.gif, gif);
// one message of a kind to the room or the private chat on view; more: other paths written in the same update (a photo's
// picture), or a function that makes them from the message's id (a long post's text). wait: resolve once it's written
export async function post(kind, value, more = {}, { wait } = {}) {
  if (!room || room.gone) return false;
  if (room.readOnly) { toast(t("roNoPost")); return false; }
  const [body, sealed] = kind.pack(value), ui = room.ui, uid = backend.uid, T = backend.stamp();
  const rp = ui.reply && !!ui.reply.dm === (ui.view !== "all") ? ui.reply.id : null;
  if (rp) { sealed.r = rp; if (!room.cipher) body.rp = rp; }
  const m = room.members[uid] || me(); // the name this room knows me by
  const at = (path) => room.api.root(path);
  const upd = { [at("meta/last")]: T, [at(`members/${uid}/ls`)]: T };
  const to = ui.view === "all" ? null : ui.view, code = room.code;
  let id;
  if (!to) {
    id = backend.pushKey(room.api.ref("msgs"));
    upd[at(`members/${uid}/lm`)] = id;
    upd[at(`msgs/${id}`)] = room.cipher ? { by: uid, x: await room.cipher.seal({ ...sealed, n: m.name, a: m.avatar }, "m:" + uid), at: T, ...kind.mark }
      : { by: uid, name: m.name, avatar: m.avatar, ...body, at: T };
  } else {
    if (!room.members[ui.view]) { toast(t("peerLeft")); return false; }
    const key = await room.dmKey(ui.view);
    if (!key) { toast(t("peerOld")); return false; }
    const path = `dm/${pairKey(uid, ui.view)}`;
    id = backend.pushKey(room.api.ref(path));
    upd[at(`${path}/${id}`)] = { by: uid, to: ui.view, x: await seal(key, sealed, "d:" + uid), at: T };
    upd[at(`members/${uid}/lm`)] = id;
  }
  Object.assign(upd, typeof more === "function" ? await more(id) : more);
  $("#list .empty")?.remove(); cancelReply(); typing.stop();
  const sent = posts.write(upd, to ? "dms" : kind.stat).then((ok) => { if (ok) announce(code, id, to); return ok; });
  return wait ? sent : true;
}
/* ---------- someone went ----------
   A line in the room saying someone left (ev "l", written by them in the update that takes them out) or was removed
   (ev "k", written by the host who removes them, naming them). In a Private Salon the names are sealed like a message's.
   Returns the paths, from the root, to write along with the leaving. */
export async function goneNote(r, ev, them) {
  const uid = backend.uid, T = backend.stamp(), id = backend.pushKey(r.api.ref("msgs"));
  const m = r.members[uid] || me(), at = (path) => r.api.root(path);
  const named = ev === "k" ? { tn: them.name, ta: them.avatar } : {};
  const msg = r.cipher ? { by: uid, ev, x: await r.cipher.seal({ e: ev, ...named, n: m.name, a: m.avatar }, "m:" + uid), at: T }
    : { by: uid, name: m.name, avatar: m.avatar, ev, ...named, at: T };
  if (ev === "k") msg.tg = them.id;
  const upd = { [at("msgs/" + id)]: msg };
  // a host stays in the room, so it counts as their message: stamped like one
  if (ev === "k") Object.assign(upd, { [at(`members/${uid}/ls`)]: T, [at(`members/${uid}/lm`)]: id });
  return upd;
}
// write(note): the leaving with its line, tried again once a moment later (the rate limit); without it if it still won't go
// (the room is read-only, say), since leaving matters more than the line
export async function withNote(write, note) {
  try { return await write(note); } catch {}
  await pause(POST_GAP_MS);
  try { return await write(note); } catch { return write({}); }
}

/* ---------- replying ---------- */
export function startReply(id, v, dm) {
  room.ui.reply = { id, dm };
  const bar = $("#replyBar");
  $(".rtxt", bar).replaceChildren(...tEl("replyingTo", { name: el("b", { text: room.author(v, dm).name }), text: snippet(v) }));
  bar.hidden = false; box().focus(); renderQuick();
}
export function cancelReply() { if (room) room.ui.reply = null; $("#replyBar").hidden = true; renderQuick(); }

export function insertAtCursor(s) {
  const ta = box();
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = (ta.value.slice(0, a) + s + ta.value.slice(b)).slice(0, LIMITS.text);
  ta.selectionStart = ta.selectionEnd = Math.min(a + s.length, ta.value.length);
  ta.dispatchEvent(new Event("input"));
}

/* ---------- "someone is typing" ----------
   While the box has text, this device stamps typing/{me} (dmt/{pair}/{me} in a private chat) every few seconds;
   it goes when the text is sent or cleared, after 5 quiet seconds, or when the connection drops. */
const TYPING_IDLE = 5000, TYPING_EVERY = 3000, TYPING_SHOWN = 8000;
export const typing = {
  ref: null, at: 0, timer: 0,
  ping() {
    if (!room || room.gone || room.ui.view === "qa" || !box().value.trim()) return this.stop();
    const ref = room.api.typingRef(room.ui.view === "all" ? null : pairKey(backend.uid, room.ui.view));
    if (this.ref && this.ref.toString() !== ref.toString()) this.stop();
    clearTimeout(this.timer); this.timer = setTimeout(() => this.stop(), TYPING_IDLE);
    if (this.ref && Date.now() - this.at < TYPING_EVERY) return;
    this.ref = ref; this.at = Date.now();
    backend.fb.onDisconnect(ref).remove().catch(() => {});
    backend.fb.set(ref, backend.stamp()).catch(() => {});
  },
  stop() {
    clearTimeout(this.timer);
    const ref = this.ref; this.ref = null;
    if (!ref) return;
    backend.fb.set(ref, null).catch(() => {}); backend.fb.onDisconnect(ref).cancel().catch(() => {});
  },
};
export function renderTyping() {
  const bar = $("#typingBar");
  if (!room || room.gone) { bar.hidden = true; return; }
  const view = room.ui.view, uid = backend.uid;
  const fresh = (at) => typeof at === "number" && backend.now() - at < TYPING_SHOWN;
  const ids = view === "qa" ? [] : view === "all"
    ? Object.entries(room.typing || {}).filter(([id, at]) => id !== uid && room.members[id] && !isBlocked(id) && fresh(at)).map(([id]) => id)
    : fresh(room.dmTyping[view]) && !isBlocked(view) ? [view] : [];
  const names = ids.map((id) => room.members[id]?.name || "");
  bar.replaceChildren(el("span", { class: "dots", "aria-hidden": "true" }, el("i"), el("i"), el("i")),
    ids.length === 1 ? t("typing1", { a: names[0] }) : ids.length === 2 ? t("typing2", { a: names[0], b: names[1] }) : ids.length ? t("typingN") : "");
  bar.hidden = !ids.length;
}

// typing @ offers the people in the room whose names start with what follows it
export function mentionBar() {
  const bar = $("#mentionBar"), ta = box();
  const pos = ta.selectionStart ?? ta.value.length;
  const m = room && !room.gone && room.ui.view === "all" ? ta.value.slice(0, pos).match(/(?:^|[^A-Za-z0-9_@])@([^\s@]{0,12})$/) : null;
  const q = m ? m[1].toLowerCase() : null;
  const hits = q == null ? [] : Object.entries(room.members).filter(([id, p]) => id !== backend.uid && (p.name || "").toLowerCase().startsWith(q)).slice(0, 8);
  bar.hidden = !hits.length;
  bar.replaceChildren(...hits.map(([, p]) => el("button", { type: "button", class: "chip", onclick: () => {
    const start = pos - q.length - 1;
    ta.value = (ta.value.slice(0, start) + "@" + p.name + " " + ta.value.slice(pos)).slice(0, LIMITS.text);
    ta.selectionStart = ta.selectionEnd = Math.min(start + p.name.length + 2, ta.value.length);
    ta.dispatchEvent(new Event("input")); ta.focus();
  } }, `${p.avatar} ${p.name}`)));
}
