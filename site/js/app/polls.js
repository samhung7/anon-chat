/* Polls: anyone starts one, a question and 2 to 10 options, one vote per person or several. Tapping an option
   votes, tapping it again takes the vote back; votes can change until the poll's author closes it. Who voted
   for what is visible to the room, like reactions, unless the poll is anonymous (an): then each vote goes in as a
   ballot nobody can tie to its voter. A poll can also hide its results until a time its author sets (rv): until then
   each person sees only their own vote, and once it's revealed (or its author closes it early) votes stop.
   The votes of those two kinds are kept apart from the message (room.js followBallots; tools/rules.py pv, ab, av). */
import { LIMITS } from "./constants.js?v=dev";
import { t, fmtWhen } from "./text.js?v=dev";
import { el, sheet, orToast, icon } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { post } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";

// a poll's votes are kept apart from its message (anonymous or hidden)
export const keptApart = (v) => !!(v.an || v.rv);
// its results are out: it never hid them, its time came, or its author closed it
export const revealed = (v) => !v.rv || !!v.closed || backend.now() >= v.rv;
// nobody can vote any more
export const pollShut = (v) => !!v.closed || (!!v.rv && backend.now() >= v.rv);

// a poll as shown, the same shape a saved record keeps: { q, m, an, rv, closed, pending, total, o: [{ t, n, on, names }] }
// (pending: the results are still hidden; then n and total aren't known)
export function livePoll(v) {
  const votes = v.votes || {}, ids = Object.keys(votes).filter((w) => votes[w].length);
  const mine = keptApart(v) ? v.mine || [] : votes[backend.uid] || [], pending = !revealed(v);
  return { q: v.poll.q, m: v.poll.m, an: !!v.an, rv: v.rv || 0, closed: pollShut(v), early: !!v.closed, pending, total: pending ? 0 : ids.length,
    o: v.poll.o.map((label, k) => {
      const who = pending ? [] : ids.filter((w) => votes[w].includes(k));
      return { t: label, n: who.length, on: mine.includes(k), names: v.an ? [] : who.map((id) => room.nameOf(id)) };
    }) };
}
// the tags beside "Poll": one choice or several, anonymous, hidden until when, closed or revealed
export function pollTags(p) {
  return [t(p.m ? "pollMultiTag" : "pollSingleTag"), p.an ? t("pollAnonTag") : null,
    p.rv ? (p.closed ? t("pollRevealed") : t("pollHiddenTag")) : p.closed ? t("pollClosed") : null].filter(Boolean).join(" · ");
}
// the line under the options
export const pollFoot = (p) => (p.pending ? t("pollRevealAt", { when: fmtWhen(p.rv) }) : t("pollVotes", { n: p.total }));
// onVote: null for a saved record, which only shows the result
export function pollView(p, onVote) {
  return el("div", { class: "pollbox" + (p.closed ? " closed" : "") + (p.pending ? " pending" : "") },
    el("div", { class: "ph" }, el("span", {}, icon("poll", "sm"), t("poll")), el("small", { text: pollTags(p) })),
    el("b", { class: "pq", text: p.q }),
    p.o.map((o, k) => el("button", {
      type: "button", class: "opt" + (o.on ? " on" : ""), "aria-pressed": String(!!o.on), disabled: !onVote || p.closed || room?.gone,
      title: o.names?.join(t("listSep")) || null, onclick: () => onVote?.(k),
    }, el("span", { class: "fill", style: `width:${p.total ? Math.round((o.n * 100) / p.total) : 0}%` }),
      o.on ? icon("check", "sm") : null, el("span", { class: "ol", text: o.t }), p.pending ? null : el("span", { class: "oc", text: o.n }))),
    el("small", { class: "pf", text: pollFoot(p) }));
}
// the poll of message id, live: voting goes to the database
export const livePollView = (id, v) => pollView(livePoll(v), (k) => vote(id, k));

// my picks after tapping option k, written as "0" or "0,2" (sealed in an encrypted room): under my id where the room
// reads it, under my id apart for a hidden poll, or as my ballot for an anonymous one
export async function vote(id, k) {
  const v = room?.msgs.get(id);
  if (!v?.poll || pollShut(v) || room.gone) return;
  const kept = keptApart(v), mine = (kept ? v.mine : v.votes?.[backend.uid]) || [];
  if (kept && !v.ready) return; // my vote so far hasn't come in yet
  const next = v.poll.m ? (mine.includes(k) ? mine.filter((x) => x !== k) : [...mine, k].sort((a, b) => a - b)) : mine.includes(k) ? [] : [k];
  const picks = next.join(","), seal = (aad) => (!picks ? null : room.cipher ? room.cipher.seal(picks, aad) : picks);
  if (v.an) {
    const first = !v.key, key = v.key || room.api.ballotKey(id);
    return orToast(room.api.ballot(id, key, (await seal(`b:${id}:${key}`)) ?? "", first));
  }
  const val = await seal(`v:${id}:${backend.uid}`);
  orToast(v.rv ? room.api.hiddenVote(id, val) : room.api.vote(id, val));
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
// when a hidden poll can be revealed: from a few minutes to a week on (the rules allow up to a week)
const REVEAL_MIN = [5, 15, 30, 60, 120, 360, 720, 1440, 4320, 10080];
const WEEK = 7 * 1440 * 60000;
// "in 15 minutes", "3 天後", as the language says it
const inMinutes = (n) => {
  const [v, unit] = n % 1440 === 0 ? [n / 1440, "day"] : n % 60 === 0 ? [n / 60, "hour"] : [n, "minute"];
  return new Intl.RelativeTimeFormat(I18N.lang, { numeric: "always" }).format(v, unit);
};
// a datetime-local field's value for a time
const localValue = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
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
  const anon = el("input", { type: "checkbox", id: "pollAnon" }), hide = el("input", { type: "checkbox", id: "pollHide" });
  const when = el("select", { class: "field", id: "pollWhen", "aria-label": t("pollWhen") },
    REVEAL_MIN.map((n) => el("option", { value: String(n), text: inMinutes(n), selected: n === 60 })), el("option", { value: "at", text: t("pollWhenAt") }));
  const at = el("input", { type: "datetime-local", class: "field", id: "pollAt", "aria-label": t("pollWhenAt"), hidden: true });
  const whenBox = el("div", { class: "pollwhen", hidden: true }, el("label", { class: "lbl", for: "pollWhen", text: t("pollWhen") }), when, at,
    el("p", { class: "muted small", text: t("pollHideHint") }));
  hide.addEventListener("change", () => (whenBox.hidden = !hide.checked));
  when.addEventListener("change", () => {
    at.hidden = when.value !== "at";
    if (!at.hidden) { const now = backend.now(); at.min = localValue(now); at.max = localValue(now + WEEK); if (!at.value) at.value = localValue(now + 3600000); at.focus(); }
  });
  const flag = (box, label, hint) => el("label", { class: "check pollflag" }, box, el("span", {}, el("b", { text: label }), el("small", { class: "muted", text: hint })));
  const body = el("div", {}, warn, el("label", { class: "lbl", for: "pollQ", text: t("pollQ") }), q,
    el("label", { class: "lbl", text: t("pollOpts") }), opts, addBtn,
    el("label", { class: "lbl", text: t("pollHow") }), choice([["1", t("pollSingle")], ["n", t("pollMulti")]], "1", (v) => (multi = v === "n")),
    flag(anon, t("pollAnon"), t("pollAnonHint")), flag(hide, t("pollHide"), t("pollHideNote")), whenBox);
  for (;;) {
    const a = await sheet(t("pollNew"), body, [["no", t("cancel")], ["yes", t("pollStart"), "primary"]], { onOpen: () => q.focus() });
    if (a !== "yes" || !room || room.gone) return;
    const question = q.value.trim().slice(0, LIMITS.pollQ);
    const o = [...opts.querySelectorAll("input")].map((x) => x.value.trim().slice(0, LIMITS.pollOpt)).filter(Boolean);
    if (!question || o.length < 2) { warn.textContent = t("pollNeed"); warn.hidden = false; continue; }
    let rv = 0;
    if (hide.checked) {
      const now = backend.now();
      rv = when.value === "at" ? new Date(at.value).getTime() : now + +when.value * 60000;
      // a minute ahead at least, so it isn't revealed before it's even sent
      if (!Number.isFinite(rv) || rv < now + 60000 || rv > now + WEEK) { warn.textContent = t("pollWhenBad"); warn.hidden = false; continue; }
    }
    return post(KIND.poll, { q: question, o, m: multi, ...(anon.checked ? { an: true } : {}), ...(rv ? { rv: Math.round(rv) } : {}) });
  }
}
