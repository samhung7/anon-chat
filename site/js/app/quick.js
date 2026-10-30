/* Quick replies: a row of short answers above the message box that go out with one tap, so taking part costs no
   typing. In the row: while replying to a message, a few answers to it; the room's own (the owner or a co-host writes
   them, meta/qr, sealed as xr in an encrypted room; a lecture's "too fast" or "got it"); and my own, kept on this
   device (until I edit them, the presets in my language). A quick reply is an ordinary text message. Tapping a
   message twice gives it a 👍; tapping the send button twice with nothing written flies my animal up. */
import { LIMITS, REACTS, ANIMALS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { $, el, toast, sheet, orToast, icon, avatar } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { send, box } from "./composer.js?v=dev";
import { pickerOpen } from "./pickers.js?v=dev";
import { failed } from "./lobby.js?v=dev";

const COOL_MS = 3000; // a quick reply just sent stays greyed this long, so a second tap doesn't send it twice
const lines = (s) => String(s || "").split("\n").map((l) => l.trim()).filter(Boolean);
const tidy = (list, max, len) => [...new Set(list.map((l) => l.trim().slice(0, len)).filter(Boolean))].slice(0, max);
const presets = () => lines(t("quickSet"));
export const myQuick = () => { const l = store.json(KEYS.quick); return Array.isArray(l) ? tidy(l.map(String), LIMITS.quicks, LIMITS.quick) : presets(); };
export const quickOn = () => store.get(KEYS.quickOff) !== "1";
const roomQuick = () => tidy(lines(room?.meta?.qr), LIMITS.roomQuicks, LIMITS.roomQuick);

let cooling = null, coolTimer = 0; // the quick reply sent last, until when it stays greyed
export function renderQuick() {
  const bar = $("#quickBar"), ui = room?.ui;
  bar.hidden = !room || room.gone || room.readOnly || ui.view === "qa" || !quickOn() || !!box().value.trim() || !!pickerOpen();
  if (bar.hidden) return bar.replaceChildren();
  const seen = new Set(), cool = cooling && cooling.until > Date.now() ? cooling.text : null;
  const chip = (text, cls, title) => (seen.has(text) ? null : (seen.add(text), el("button", { type: "button", class: "chip" + (cls ? " " + cls : ""),
    "data-q": text, title, disabled: text === cool || null, text })));
  bar.replaceChildren(
    ...(ui.reply ? lines(t("quickReplySet")).map((s) => chip(s, "rp")) : []),
    ...(ui.view === "all" ? roomQuick().map((s) => chip(s, "host", t("quickHostTip"))) : []),
    ...myQuick().map((s) => chip(s)),
    el("button", { type: "button", class: "chip edit", "data-a": "quickEdit", "aria-label": t("quickMine"), title: t("quickMine") }, icon("edit", "sm")));
  // a different set of replies (a reply begun, the room's changed) starts from the first one again
  const k = [...seen].join("\n");
  if (bar.dataset.k !== k) { bar.dataset.k = k; bar.scrollLeft = 0; }
}
function quickSend(text) {
  if (!text || (cooling?.text === text && cooling.until > Date.now())) return;
  cooling = { text, until: Date.now() + COOL_MS };
  clearTimeout(coolTimer); coolTimer = setTimeout(() => { cooling = null; renderQuick(); }, COOL_MS);
  send(text);
  renderQuick();
}
export function wireQuick() {
  const bar = $("#quickBar");
  bar.addEventListener("mousedown", (e) => e.preventDefault()); // a tap here leaves the keyboard as it was
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    if (b.dataset.a === "quickEdit") editMine(); else quickSend(b.dataset.q);
  });
}

/* ---------- a list of quick replies to edit: one field per line, moved up, taken out or added ---------- */
function listEditor(items, { max, len, ph }) {
  const rows = el("div", { class: "qlist" });
  const add = el("button", { type: "button", class: "link qadd" }, icon("plus", "sm"), el("span", { text: t("quickAdd") }));
  const sync = () => {
    add.hidden = rows.children.length >= max;
    [...rows.children].forEach((r, i) => { $(".qup", r).disabled = i === 0 || null; });
  };
  const row = (text = "") => {
    const input = el("input", { class: "field", type: "text", maxlength: len, placeholder: ph, "aria-label": t("quickItem") });
    input.value = text;
    const r = el("div", { class: "qrow" }, input,
      el("button", { type: "button", class: "icon small qup", "aria-label": t("quickUp"), title: t("quickUp"),
        onclick: () => { r.previousElementSibling?.before(r); sync(); } }, icon("forward", "sm")),
      el("button", { type: "button", class: "icon small", "aria-label": t("quickDel"), title: t("quickDel"),
        onclick: () => { r.remove(); sync(); } }, icon("close", "sm")));
    return r;
  };
  add.addEventListener("click", () => { const r = row(); rows.append(r); sync(); $("input", r).focus(); });
  const fill = (list) => { rows.replaceChildren(...list.map((s) => row(s))); sync(); };
  fill(items);
  return { node: el("div", {}, rows, add), fill, values: () => tidy([...rows.querySelectorAll("input")].map((i) => i.value), max, len) };
}

// my own quick replies, from the ✎ at the end of the row or the room's ⋯ menu
export async function editMine() {
  const ed = listEditor(myQuick(), { max: LIMITS.quicks, len: LIMITS.quick, ph: t("quickPh") });
  const on = el("input", { type: "checkbox", id: "quickOn" });
  on.checked = quickOn();
  const body = el("div", {}, el("p", { class: "muted small", text: t("quickMineHint", { n: LIMITS.quicks }) }), ed.node,
    el("label", { class: "check qshow" }, on, el("span", { text: t("quickShow") })));
  for (;;) {
    const a = await sheet(t("quickMine"), body, [["no", t("cancel")], ["quickreset", t("quickReset")], ["yes", t("save"), "primary"]]);
    if (a === "quickreset") { ed.fill(presets()); continue; }
    if (a !== "yes") return;
    break;
  }
  const list = ed.values();
  // the presets themselves aren't kept, so they follow the language
  store.set(KEYS.quick, list.join("\n") === presets().join("\n") ? null : JSON.stringify(list));
  store.set(KEYS.quickOff, on.checked ? null : "1");
  toast(t("quickSaved"));
  renderQuick();
}
// the room's own, shown first in everyone's row; the owner and co-hosts write them
export async function editRoomQuick() {
  const ed = listEditor(roomQuick(), { max: LIMITS.roomQuicks, len: LIMITS.roomQuick, ph: t("quickRoomPh") });
  const body = el("div", {}, el("p", { class: "muted small", text: t("quickRoomHint", { n: LIMITS.roomQuicks }) }), ed.node,
    room.cipher ? el("p", { class: "muted small", text: t("quickRoomEnc") }) : null);
  for (;;) {
    const a = await sheet(t("quickRoom"), body, [["no", t("cancel")], ["quicksample", t("quickSample")], ["yes", t("save"), "primary"]]);
    if (a === "quicksample") { ed.fill(lines(t("quickSampleSet"))); continue; }
    if (a !== "yes" || !room) return;
    break;
  }
  const text = ed.values().join("\n");
  if (text === roomQuick().join("\n")) return;
  try {
    // like the description: an encrypted room keeps only the sealed list (xr), a plain one only the readable one
    await room.api.setMeta(room.cipher ? { xr: text ? await room.cipher.seal({ t: text }, "r") : null } : { qr: text || null });
    toast(t(text ? "quickRoomSaved" : "quickRoomCleared"));
  } catch (e) { failed(e); }
}

/* ---------- tapping a message twice gives it a 👍 ----------
   Two taps close together in time and place on the same message, but not on what a tap already does (a link, a
   photo, a poll, a button). It only ever adds the 👍; taking it back is the chip under the message, as before. */
let lastTap = null;
export function wireDoubleTap(list) {
  list.addEventListener("pointerup", (e) => {
    const node = e.target.closest(".msg");
    const off = !node || node.classList.contains("folded") || (e.pointerType === "mouse" && e.button !== 0)
      || !room || room.gone || room.readOnly || room.ui.view !== "all"
      || e.target.closest("a, button, input, textarea, select, label, img, video, canvas, svg, .poll, .rpq, .re");
    if (off) { lastTap = null; return; }
    const id = node.dataset.id, now = e.timeStamp;
    if (lastTap?.id === id && now - lastTap.at < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null;
      getSelection()?.removeAllRanges(); // a double click also picks a word
      like(node, id);
    } else lastTap = { id, at: now, x: e.clientX, y: e.clientY };
  });
}
function like(node, id) {
  const v = room.msgs.get(id);
  if (!v) return;
  const pop = el("span", { class: "likepop", "aria-hidden": "true", text: REACTS[0] });
  $(".brow", node)?.append(pop);
  setTimeout(() => pop.remove(), 800);
  if (!v.re?.[0]?.[backend.uid]) orToast(room.api.react(id, 0, true));
}

/* ---------- a small surprise: two quick taps on the send button with nothing written ----------
   Nothing is sent; my animal flies up off the button and fades into the room, on this screen only. Two more fly a
   random animal each time, until three minutes go by without two taps: then it's my own again. */
const EGG_TAPS = 2, EGG_GAP_MS = 600, EGG_MINE_MS = 3 * 60 * 1000;
let eggTaps = 0, eggTapAt = 0, eggFlewAt = 0, eggShown = null;
export function emptySendTap(btn) {
  const now = Date.now();
  eggTaps = now - eggTapAt < EGG_GAP_MS ? eggTaps + 1 : 1;
  eggTapAt = now;
  if (eggTaps < EGG_TAPS) return;
  eggTaps = 0;
  const mine = room?.members[backend.uid]?.avatar;
  const others = ANIMALS.filter((a) => a !== eggShown);
  const a = now - eggFlewAt > EGG_MINE_MS && mine ? mine : others[(Math.random() * others.length) | 0];
  eggFlewAt = now; eggShown = a;
  const r = btn.getBoundingClientRect(), top = $("#list").getBoundingClientRect().top;
  const fly = el("span", { class: "eggfly", "aria-hidden": "true" }, avatar(a));
  fly.style.left = `${r.left + r.width / 2}px`;
  fly.style.top = `${r.top + r.height / 2}px`;
  fly.style.setProperty("--rise", `${-Math.max(120, (r.top - top) * 0.75)}px`);
  document.body.append(fly);
  setTimeout(() => fly.remove(), 1700);
}
