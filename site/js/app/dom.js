/* Small helpers for building the page. Everything people wrote goes in as text, never as HTML. */
import { t } from "./text.js?v=dev";
import { ANIMAL_ART } from "./constants.js?v=dev";

export const $ = (s, root = document) => root.querySelector(s);
export const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// an element: attrs class, text, on<event> and plain attributes (true for a bare one; null or false leaves it out)
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
  }
  kids.flat().forEach((c) => c != null && e.append(c));
  return e;
}

// a line icon from icons/icons.svg; cls "sm" makes it 16px
export function icon(name, cls = "") {
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), use = document.createElementNS(ns, "use");
  svg.setAttribute("class", ("st-i " + cls).trim()); svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `icons/icons.svg?v=dev#i-${name}`);
  svg.append(use);
  return svg;
}
// someone's avatar: the drawing of their animal, or the emoji itself when there is none
export const avatar = (emoji, cls = "") => (ANIMAL_ART[emoji]
  ? el("img", { class: cls, src: `avatars/${ANIMAL_ART[emoji]}.svg?v=dev`, alt: "" })
  : el("span", { class: ("emoav " + cls).trim(), "aria-hidden": "true", text: emoji || "🙂" }));

// a label without the emoji it starts with, where an icon stands in for it
export const bare = (label) => String(label).replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");

export function toast(text) {
  if (!text) return;
  const note = el("div", { class: "toast", text: bare(text) });
  $("#toasts").append(note);
  setTimeout(() => note.classList.add("out"), 2600);
  setTimeout(() => note.remove(), 3000);
}
// a write that tells the person when it didn't go through
export const orToast = (promise, key = "tryAgain") => promise.catch(() => toast(t(key)));

// the icon a menu button carries, by its data-a; its label then loses the emoji it starts with
const ACT_ICONS = {
  share: "share", title: "edit", desc: "info", me: "user", mute: "bell-off", notify: "bell", export: "download",
  qaon: "qa", qaoff: "qa", qmodon: "mod", qmodoff: "mod", show: "projector", reports: "report", cap: "people",
  transfer: "owner", lock: "lock", unlock: "key", end: "end", leave: "leave",
  reply: "reply", copy: "copy", edit: "edit", pin: "pin", unpin: "pin", dm: "mail", at: "chat", report: "report",
  block: "block", unblock: "block", del: "delete", remove: "delete", save: "download", voters: "people",
};
const actBtn = ([a, label, cls]) => el("button", { class: "btn " + (cls || ""), type: "button", "data-a": a },
  ACT_ICONS[a] ? [icon(ACT_ICONS[a]), el("span", { text: bare(label) })] : label);

// a break between groups of menu buttons: a small heading, or with no label just more room, so what belongs
// together reads as one group and the destructive ones stand apart
const actGap = (label) => el("div", { class: "agap", role: label ? "heading" : "presentation", "aria-level": label ? "3" : null, text: label || null });

// a bottom sheet; resolves with the data-a of the button pressed (or null when dismissed)
// buttons: [action, label, class] rows, with { group: label } between groups (label "" for a gap with no heading)
// cols: 3 lays a long menu out three to a row; head: a heading element to use instead of the plain title
export function sheet(title, body, buttons = [], { onOpen, cols, head } = {}) {
  return new Promise((res) => {
    const ov = el("div", { class: "overlay" });
    const n = buttons.filter(Array.isArray).length;
    const box = el("div", { class: "sheet", role: "dialog", "aria-label": title },
      head || (title ? el("h2", { text: title }) : null), body,
      n ? el("div", { class: "actions" + (n > 3 ? " many" + (cols === 3 ? " three" : "") : n === 2 ? " pair" : "") },
        buttons.map((b) => (Array.isArray(b) ? actBtn(b) : actGap(b.group)))) : null);
    ov.append(box);
    const done = (v) => { ov.remove(); document.removeEventListener("keydown", esc); res(v); };
    const esc = (e) => { if (e.key === "Escape") done(null); };
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return done(null);
      const b = e.target.closest("button[data-a]");
      if (b && box.contains(b) && b.closest(".actions")) done(b.dataset.a);
    });
    document.addEventListener("keydown", esc);
    ov.close = done;
    document.body.append(ov);
    onOpen?.(ov);
  });
}
// a menu table's rows that show (shows(row)), with each { group } break kept only when something in its group shows
export function grouped(entries, shows) {
  const out = [];
  let brk = null;
  for (const e of entries) {
    if (!Array.isArray(e)) brk = e;
    else if (shows(e)) { if (brk && out.length) out.push(brk); brk = null; out.push(e); }
  }
  return out;
}
export const confirmSheet = (title, text, ok, cls = "danger") => sheet(title, el("p", { class: "muted", text }), [["no", t("cancel")], ["yes", ok, cls]]).then((a) => a === "yes");
// Enter in this field presses the sheet's OK button (never while an IME is composing)
export function enterPressesOk(input) {
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) input.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
  return input;
}
// a sheet whose body is a list of choices: resolves with what the picked element's `pick(el)` says, or null
export function pickSheet(title, body, selector, pick, buttons = [["close", t("close")]], head) {
  let picked = null;
  return sheet(title, body, buttons, { head,
    onOpen: (ov) => body.addEventListener("click", (e) => { const b = e.target.closest(selector); if (b) { picked = pick(b); ov.close("pick"); } }),
  }).then((a) => (a === "pick" ? picked : null));
}

// the spinner while something talks to the server; nested calls count
let busyN = 0;
export function busy(on) { busyN += on ? 1 : -1; document.body.classList.toggle("busy", busyN > 0); }

// a QR Code of url, as an <svg> filling its box
export function qrSvg(url, cellSize) {
  const qr = qrcode(0, "M"); qr.addData(url); qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}
// hand the person a file to keep
export function saveFile(href, name) {
  const link = el("a", { href, download: name });
  document.body.append(link); link.click(); link.remove();
}
