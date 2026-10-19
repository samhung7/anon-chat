/* StoaTalk: anonymous chat rooms. Someone opens a room and gets a 4-character code; others join with the code or
   link. Nobody signs up: each device picks a nickname and an animal, and gets an anonymous Firebase id behind the
   scenes. A room is an Open Stoa (the code is enough) or a Private Salon, which is end-to-end encrypted: its key
   travels only in the invite link (after the #), so the server stores the title, nicknames and messages as
   ciphertext. Private messages are always end-to-end encrypted. The owner can lock the room, cap its size, name
   co-hosts, hand the room over and end it, which deletes everything; the owner and co-hosts remove messages and
   people, and see what people report. A room nobody has written in for 24 hours turns read-only, and 24 hours later
   it's deleted too (expiry.js, tools/cleanup). Anyone can export what they can see before it goes.
   Backend: Firebase Realtime Database + anonymous sign-in; database.rules.json is what actually enforces all of this.

   This file only connects the page's fixed buttons to the modules beside it:
     session.js   the room on screen          room.js     a Room: its data, kept live; api.js its writes
     crypto.js    end-to-end encryption        backend.js  the Firebase connection
     kinds.js     text, GIF, photo, poll, draw (photos.js, polls.js, draws.js)
     chat.js      the chat screen              composer.js the message box    actions.js a message's ⋯ menu
     menu.js      the room's ⋯ menu            people.js   members and owner tools
     qa.js        lecture Q&A                  show.js     the projector screen
     lobby.js     opening and joining          home.js     screens and the home page
     records.js   export, import, saved records (archive.js: the record format)
     identity.js  nickname and animal          notify.js   notifications    pickers.js emoji, GIF, ＋ */
import { KLIPY_KEY, IDLE_MS, params } from "./constants.js?v=dev";
import { $ } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend, asParam } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { showMe } from "./identity.js?v=dev";
import { create, join, cleanCode } from "./lobby.js?v=dev";
import { LIST, setView, markSeen, showJump } from "./chat.js?v=dev";
import { send, cancelReply, typing, renderTyping, mentionBar, box } from "./composer.js?v=dev";
import { ask } from "./qa.js?v=dev";
import { sendPhotos } from "./photos.js?v=dev";
import { menu, share } from "./menu.js?v=dev";
import { people } from "./people.js?v=dev";
import { setNotify, watchVisibility } from "./notify.js?v=dev";
import { openPicker, closePicker, pickerOpen } from "./pickers.js?v=dev";
import { importFile, recordMenu, showRecordTab } from "./records.js?v=dev";
import { home, homeMenu, backdrop, adoptOldRoom, turnResumePage } from "./home.js?v=dev";

I18N.apply();
adoptOldRoom();
showMe();
watchVisibility();
if (!backend.configured) { $("#setupNote").hidden = false; document.body.classList.add("nodb"); }

/* ---------- home ---------- */
$("#meBtn").addEventListener("click", homeMenu);
$("#createBtn").addEventListener("click", create);
$("#logoBtn").addEventListener("click", create);
// the box takes the 4-character code only; a pasted invite link leaves its code there, and joining uses the whole link
// (a Private Salon's key rides in it)
let pastedLink = null;
$("#joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#joinCode").value;
  join(pastedLink && cleanCode(pastedLink) === code ? pastedLink : code);
});
$("#joinCode").addEventListener("input", (e) => { if (!e.isComposing) e.target.value = cleanCode(e.target.value).slice(0, 4); });
// what's pasted is cleaned whole, before the 4-character limit would cut it (a link, or "ab cd")
$("#joinCode").addEventListener("paste", (e) => {
  const text = (e.clipboardData?.getData("text") || "").trim();
  if (!text) return;
  e.preventDefault();
  pastedLink = /[?&]room=/.test(text) ? text : null;
  e.target.value = cleanCode(text).slice(0, 4);
});
$("#resume").addEventListener("click", (e) => {
  const b = e.target.closest("[data-code], [data-a]"); if (!b) return;
  if (b.dataset.code) join(b.dataset.code);
  else turnResumePage(b.dataset.a === "next" ? 1 : -1);
});
$("#importFile").addEventListener("change", (e) => { importFile(e.target.files[0]); e.target.value = ""; });
$("#record").addEventListener("click", (e) => {
  const a = e.target.closest("[data-a]")?.dataset.a, tab = e.target.closest("[data-tab]");
  if (a === "home") home();
  if (a === "menu") recordMenu();
  if (tab) showRecordTab(+tab.dataset.tab);
});

/* ---------- the chat screen ---------- */
$("#codeBtn").addEventListener("click", share);
$("#photoFile").addEventListener("change", (e) => { const files = [...e.target.files]; e.target.value = ""; sendPhotos(files); });
if (!KLIPY_KEY) $("#composer [data-a=gif]").hidden = true;
$("#composer").addEventListener("click", (e) => { const b = e.target.closest(".tool"); if (b) openPicker(b.dataset.a); });
$("#peopleBtn").addEventListener("click", () => people());
$("#askAnon").checked = store.get(KEYS.askAnon) !== "0";
$("#askAnon").addEventListener("change", (e) => store.set(KEYS.askAnon, e.target.checked ? null : "0"));
$("#show").addEventListener("click", (e) => { if (e.target.closest("[data-a=exitShow]") && room) location.href = "?room=" + room.code + asParam("&"); });
// tapping the conversation while the emoji / GIF panel is open just closes the panel
["#list", "#pins"].forEach((s) => $(s).addEventListener("click", (e) => { if (pickerOpen()) { closePicker(); e.stopPropagation(); e.preventDefault(); } }, true));
$("#chat").addEventListener("click", (e) => {
  const a = e.target.closest("[data-a]")?.dataset.a;
  if (a === "home") { if (room?.ui.view !== "all") setView("all"); else home(); }
  if (a === "menu") menu();
  if (a === "all" || a === "qa") setView(a);
  if (a === "notifyYes" || a === "notifyNo") setNotify(a === "notifyYes");
  if (a === "noreply") cancelReply();
});
setInterval(() => room && !room.gone && renderTyping(), 2000);
const ta = box();
const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
ta.addEventListener("input", grow);
ta.addEventListener("input", () => { typing.ping(); mentionBar(); });
$("#mentionBar").addEventListener("mousedown", (e) => e.preventDefault()); // keep the keyboard up while picking a name
LIST().addEventListener("scroll", () => { if (room) { markSeen(); showJump(); } }, { passive: true });
["touchstart", "wheel"].forEach((ev) => LIST().addEventListener(ev, () => { if (room) room.ui.touched = true; }, { passive: true }));
$("#jumpBtn").addEventListener("click", () => { if (room) room.ui.touched = true; const l = LIST(); l.scrollTo({ top: l.scrollHeight, behavior: "smooth" }); });
// a picture pasted into the box is sent as a photo
ta.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length && room && room.ui.view === "all") { e.preventDefault(); sendPhotos(files); }
});
// the keyboard covers the home indicator, so the home-screen app's extra space under the box goes while typing
ta.addEventListener("focus", () => document.body.classList.add("typing"));
ta.addEventListener("blur", () => { document.body.classList.remove("typing"); typing.stop(); });
// iOS doesn't shrink the page for the keyboard: it slides the whole page up behind it, which takes the room's
// header off the top (and in a private chat can leave only blank space above the box). While the keyboard is up,
// the chat is fitted to the part of the screen still showing, so the header stays at the top and the box sits on
// the keyboard. It only ever shrinks the chat, never stretches it past the screen; pinch zoom is left alone.
const vv = window.visualViewport;
const fitChat = () => {
  const chat = $("#chat"), s = chat.style;
  const up = Math.abs(vv.scale - 1) < .01 && innerHeight - vv.height > 1;
  if (!up && !s.height) return;
  const l = LIST(), stick = l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  // the home-screen app can scroll the page itself rather than the visible part, which leaves a fixed chat behind
  // at the top, so the page is put back at the top first; the fitted chat then fits with nothing left to scroll
  if (up && (scrollY || vv.offsetTop)) scrollTo(0, 0);
  s.top = up ? `${vv.offsetTop}px` : ""; s.height = up ? `${vv.height}px` : ""; s.bottom = up ? "auto" : "";
  if (stick) l.scrollTop = l.scrollHeight;
};
// iOS slides the page up in an animation and doesn't always say when it's done, so after the box gains focus or
// the screen moves, the chat keeps following it every frame until it has stood still for a moment
let settling = 0;
const settle = () => {
  const go = !settling; settling = performance.now() + 1500;
  if (!go) return;
  let last = "";
  const step = (now) => {
    const at = `${vv.offsetTop},${vv.height},${vv.scale},${scrollY}`;
    if (at !== last) { last = at; fitChat(); settling = Math.max(settling, now + 300); }
    if (now < settling) requestAnimationFrame(step); else settling = 0;
  };
  requestAnimationFrame(step);
};
if (vv) {
  ["resize", "scroll"].forEach((ev) => vv.addEventListener(ev, () => { fitChat(); settle(); }));
  ["focus", "blur"].forEach((ev) => ta.addEventListener(ev, settle));
  addEventListener("scroll", settle, { passive: true });
}
// Enter sends on a keyboard; on phones Enter is a new line and the button sends. Never while an IME is composing.
ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && matchMedia("(pointer: fine)").matches) { e.preventDefault(); $("#composer").requestSubmit(); }
});
// the box empties at once, so the next message can be typed while this one goes out
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = ta.value;
  if (!text.trim()) return;
  ta.value = ""; grow(); mentionBar();
  if (!(await (room?.ui.view === "qa" ? ask(text) : send(text))) && !ta.value) { ta.value = text; grow(); } // not sent: give the text back
  else if (pickerOpen() === "emoji") closePicker();
  ta.focus();
});

// a page left in the background with no room on screen lets go of its database connection, and takes it back on
// showing again (a room on screen keeps it, for notifications)
let idle;
const roomless = () => !room || room.gone;
document.addEventListener("visibilitychange", () => {
  clearTimeout(idle);
  if (!document.hidden) backend.resume();
  else if (roomless()) idle = setTimeout(() => { if (document.hidden && roomless()) backend.pause(); }, IDLE_MS);
});

/* ---------- start ---------- */
const start = params.get("room");
if (start && backend.configured) { // an encrypted room's key rides after the #
  $("#home").hidden = true; // straight into the room, without the home page showing first: the loading screen until then
  join(start + location.hash).finally(() => { if (!room || room.gone) home(); else if ($("#chat").hidden) backdrop(); });
} else home();
