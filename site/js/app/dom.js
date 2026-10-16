/* Small helpers for building the page. Everything people wrote goes in as text, never as HTML. */
import { t } from "./text.js?v=dev";

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

export function toast(text) {
  if (!text) return;
  const note = el("div", { class: "toast", text });
  $("#toasts").append(note);
  setTimeout(() => note.classList.add("out"), 2600);
  setTimeout(() => note.remove(), 3000);
}
// a write that tells the person when it didn't go through
export const orToast = (promise, key = "tryAgain") => promise.catch(() => toast(t(key)));

// a bottom sheet; resolves with the data-a of the button pressed (or null when dismissed)
export function sheet(title, body, buttons = [], { onOpen } = {}) {
  return new Promise((res) => {
    const ov = el("div", { class: "overlay" });
    const box = el("div", { class: "sheet", role: "dialog", "aria-label": title },
      title ? el("h2", { text: title }) : null, body,
      buttons.length ? el("div", { class: "actions" + (buttons.length > 3 ? " many" : "") }, buttons.map(([a, label, cls]) => el("button", { class: "btn " + (cls || ""), type: "button", "data-a": a, text: label }))) : null);
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
export const confirmSheet = (title, text, ok, cls = "danger") => sheet(title, el("p", { class: "muted", text }), [["no", t("cancel")], ["yes", ok, cls]]).then((a) => a === "yes");
// Enter in this field presses the sheet's OK button (never while an IME is composing)
export function enterPressesOk(input) {
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) input.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
  return input;
}
// a sheet whose body is a list of choices: resolves with what the picked element's `pick(el)` says, or null
export function pickSheet(title, body, selector, pick, buttons = [["close", t("close")]]) {
  let picked = null;
  return sheet(title, body, buttons, {
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
