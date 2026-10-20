/* Draws: pick who takes part (everyone here, to start with) and how many to draw. The drawing happens on this
   device, with the browser's cryptographic random numbers, and the result goes to the room as a message. */
import { LIMITS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { el, sheet, icon } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { post } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";

const REVEAL_MS = 15000; // a draw this new is revealed slowly
const randBelow = (n) => { const a = new Uint32Array(1), lim = Math.floor(2 ** 32 / n) * n; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n; };
// k of list, in random order (Fisher–Yates)
const drawOf = (list, k) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = randBelow(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };

// a draw as shown, the same shape a saved record keeps: { t, p: [names], w: [names] }
export const liveDraw = (v) => ({ t: v.draw.t, p: v.draw.p.map((id) => room.nameOf(id)), w: v.draw.w.map((id) => room.nameOf(id)),
  fresh: v.at > room.t0 && backend.now() - v.at < REVEAL_MS });
export function drawView(d) {
  return el("div", { class: "drawbox" + (d.fresh ? " fresh" : "") },
    el("div", { class: "ph" }, el("span", {}, icon("draw", "sm"), t("draw"))),
    d.t ? el("b", { class: "pq", text: d.t }) : null,
    el("small", { class: "pf", text: t("drawFrom", { n: d.p.length, k: d.w.length }) }),
    el("div", { class: "winners" }, d.w.map((n, i) => el("span", { class: "win", style: `--i:${i}`, text: "🏆 " + n }))),
    el("details", {}, el("summary", { text: t("drawWhoIn") }), el("p", { class: "small", text: d.p.join(t("listSep")) })));
}
export async function newDraw() {
  if (!room || room.gone) return;
  const members = room.members, uid = backend.uid;
  const ids = Object.keys(members).sort((a, b) => (members[a].joined || 0) - (members[b].joined || 0));
  const what = el("input", { class: "field", maxlength: LIMITS.drawTitle, id: "drawWhat", placeholder: t("drawWhatPh"), autocomplete: "off" });
  const boxes = el("div", { class: "picklist" }, ids.map((id) => el("label", { class: "pick" },
    el("input", { type: "checkbox", value: id, checked: true }),
    el("span", { class: "av", text: members[id].avatar }),
    el("span", { class: "nm", text: members[id].name + (id === uid ? t("meTag") : "") }))));
  const count = el("input", { class: "field num", type: "number", min: 1, max: ids.length, value: 1, id: "drawN", inputmode: "numeric" });
  const picked = () => [...boxes.querySelectorAll("input:checked")].map((x) => x.value);
  const allBtn = el("button", { type: "button", class: "btn small", text: t("drawNone"), onclick: () => {
    const on = !picked().length; boxes.querySelectorAll("input").forEach((x) => (x.checked = on)); sync();
  } });
  const sync = () => { const n = picked().length; allBtn.textContent = t(n ? "drawNone" : "drawAll"); count.max = Math.max(1, n); };
  boxes.addEventListener("change", sync);
  const warn = el("p", { class: "note warn", hidden: true });
  const say = (text) => { warn.textContent = text; warn.hidden = false; };
  const body = el("div", {}, warn, el("label", { class: "lbl", for: "drawWhat", text: t("drawWhat") }), what,
    el("div", { class: "lblrow" }, el("label", { class: "lbl", text: t("drawWho") }), allBtn), boxes,
    el("label", { class: "lbl", for: "drawN", text: t("drawCount") }), count);
  for (;;) {
    const a = await sheet(t("drawNew"), body, [["no", t("cancel")], ["yes", t("drawGo"), "primary"]]);
    if (a !== "yes" || !room || room.gone) return;
    const p = picked().filter((id) => room.members[id]), k = Math.floor(+count.value);
    if (!p.length) { say(t("drawNeed")); continue; }
    if (!(k >= 1 && k <= p.length)) { say(t("drawCountBad", { n: p.length })); continue; }
    const title = what.value.trim().slice(0, LIMITS.drawTitle);
    return post(KIND.draw, { ...(title ? { t: title } : {}), p, w: drawOf(p, k) });
  }
}
