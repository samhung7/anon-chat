/* Polls: anyone starts one, a question and 2 to 10 options, one vote per person or several. Tapping an option
   votes, tapping it again takes the vote back; votes can change until the poll's author closes it. Who voted
   for what is visible to the room, like reactions. */
import { LIMITS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { el, sheet, orToast } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { post } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";

// a poll as shown, the same shape a saved record keeps: { q, m, closed, total, o: [{ t, n, on, names }] }
export function livePoll(v) {
  const votes = v.votes || {}, ids = Object.keys(votes);
  return { q: v.poll.q, m: v.poll.m, closed: !!v.closed, total: ids.length, o: v.poll.o.map((label, k) => {
    const who = ids.filter((w) => votes[w].includes(k));
    return { t: label, n: who.length, on: who.includes(backend.uid), names: who.map((id) => room.nameOf(id)) };
  }) };
}
// onVote: null for a saved record, which only shows the result
export function pollView(p, onVote) {
  return el("div", { class: "pollbox" + (p.closed ? " closed" : "") },
    el("div", { class: "ph" }, el("span", { text: "📊 " + t("poll") }), el("small", { text: [t(p.m ? "pollMultiTag" : "pollSingleTag"), p.closed ? t("pollClosed") : null].filter(Boolean).join(" · ") })),
    el("b", { class: "pq", text: p.q }),
    p.o.map((o, k) => el("button", {
      type: "button", class: "opt" + (o.on ? " on" : ""), "aria-pressed": String(!!o.on), disabled: !onVote || p.closed || room?.gone,
      title: o.names?.join(t("listSep")) || null, onclick: () => onVote?.(k),
    }, el("span", { class: "bar", style: `width:${p.total ? Math.round((o.n * 100) / p.total) : 0}%` }),
      el("span", { class: "ol", text: (o.on ? "✓ " : "") + o.t }), el("span", { class: "oc", text: o.n }))),
    el("small", { class: "pf", text: t("pollVotes", { n: p.total }) }));
}
// the poll of message id, live: voting goes to the database
export const livePollView = (id, v) => pollView(livePoll(v), (k) => vote(id, k));

// my picks after tapping option k, written as "0" or "0,2" (sealed in an encrypted room)
export async function vote(id, k) {
  const v = room?.msgs.get(id);
  if (!v?.poll || v.closed || room.gone) return;
  const mine = v.votes?.[backend.uid] || [];
  const next = v.poll.m ? (mine.includes(k) ? mine.filter((x) => x !== k) : [...mine, k].sort((a, b) => a - b)) : mine.includes(k) ? [] : [k];
  const picks = next.join(",");
  const val = !picks ? null : room.cipher ? await room.cipher.seal(picks, `v:${id}:${backend.uid}`) : picks;
  orToast(room.api.vote(id, val));
}
export function pollVoters(v) {
  const p = livePoll(v);
  sheet(p.q, el("div", { class: "voters" }, p.o.map((o) => el("div", {},
    el("b", { text: `${o.t} · ${o.n}` }), el("p", { class: "muted small", text: o.names.join(t("listSep")) || "—" })))), [["close", t("close")]]);
}
// the radio-button pair used by the poll and draw sheets
export function choice(opts, value, onPick) {
  const seg = el("div", { class: "seg row", role: "radiogroup" }, opts.map(([v, label]) => el("button", { type: "button", role: "radio", "aria-checked": String(v === value), "data-v": v, text: label })));
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); onPick(b.dataset.v);
  });
  return seg;
}
export async function newPoll() {
  if (!room || room.gone) return;
  const q = el("input", { class: "field", maxlength: LIMITS.pollQ, id: "pollQ", placeholder: t("pollQPh"), autocomplete: "off" });
  const opts = el("div", { class: "pollopts" });
  const addBtn = el("button", { type: "button", class: "btn small", text: t("pollAdd"), onclick: () => { addOpt(); opts.lastElementChild.focus(); } });
  const addOpt = () => {
    const n = opts.children.length + 1;
    if (n <= LIMITS.pollOpts) opts.append(el("input", { class: "field", maxlength: LIMITS.pollOpt, autocomplete: "off", placeholder: t("pollOpt", { n }), "aria-label": t("pollOpt", { n }) }));
    addBtn.hidden = opts.children.length >= LIMITS.pollOpts;
  };
  addOpt(); addOpt();
  let multi = false;
  const warn = el("p", { class: "note warn", hidden: true });
  const body = el("div", {}, warn, el("label", { class: "lbl", for: "pollQ", text: t("pollQ") }), q,
    el("label", { class: "lbl", text: t("pollOpts") }), opts, addBtn,
    el("label", { class: "lbl", text: t("pollHow") }), choice([["1", t("pollSingle")], ["n", t("pollMulti")]], "1", (v) => (multi = v === "n")));
  for (;;) {
    const a = await sheet(t("pollNew"), body, [["no", t("cancel")], ["yes", t("pollStart"), "primary"]], { onOpen: () => q.focus() });
    if (a !== "yes" || !room || room.gone) return;
    const question = q.value.trim().slice(0, LIMITS.pollQ);
    const o = [...opts.querySelectorAll("input")].map((x) => x.value.trim().slice(0, LIMITS.pollOpt)).filter(Boolean);
    if (!question || o.length < 2) { warn.textContent = t("pollNeed"); warn.hidden = false; continue; }
    return post(KIND.poll, { q: question, o, m: multi });
  }
}
