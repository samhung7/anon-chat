/* The projector screen (?show). For a lecture hall: how to join (QR Code, address and code) beside the question
   being answered and the most upvoted ones, or the latest poll. While a quiz is on (quiz.js) it shows the quiz instead,
   across the whole screen once the questions start. It opens in its own tab, as the same person, and follows the room live. */
import { APP, params } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { $, el, qrSvg, icon, avatar, bare } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { asParam } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { pollView, livePoll } from "./polls.js?v=dev";
import { byVotes } from "./qa.js?v=dev";
import { roomUrl } from "./home.js?v=dev";
import { shownQuiz, quizScreen, quizStage, quizClock } from "./quiz.js?v=dev";

let showing = params.has("show");
export const SHOW = () => showing;
export const endShow = () => { showing = false; };

export function watchShow(r) {
  const ifPoll = (id, v) => { if (v.poll) renderShow(); };
  r.on("meta", renderShow).on("members", renderShow).on("qs", renderShow)
    .on("msg", ifPoll).on("msg-changed", ifPoll).on("msg-removed", renderShow).on("quiz", renderShow);
  // a quiz moves on with the clock too: drawn again when it does, its countdown kept up in between
  const tick = setInterval(() => {
    if (!showing || !r.current) return;
    const z = shownQuiz(), at = z ? z + quizStage(z) : "";
    if (at !== shownAt) renderShow(); else if (z) quizClock($("#show"), z);
  }, 200);
  r.off.push(() => clearInterval(tick));
}
let shownAt = "";
export function openShow() {
  const k = room.cipher && store.get(KEYS.roomKey(room.code));
  const url = location.pathname + "?room=" + room.code + "&show=1" + asParam("&") + (k ? "#k=" + k : "");
  if (!window.open(url, "_blank")) location.href = url;
}
let raf = 0, wake = null;
// at most once a frame
export function renderShow() { if (showing && !raf) raf = requestAnimationFrame(() => { raf = 0; drawShow(); }); }
function drawShow() {
  const box = $("#show");
  if (!showing || !room || room.gone || box.hidden) return;
  if (!wake && navigator.wakeLock) navigator.wakeLock.request("screen").then((w) => { wake = w; w.addEventListener("release", () => (wake = null)); }, () => {}); // keep the projector awake
  const meta = room.meta || {}, url = roomUrl(room.code), qs = [...room.qs.values()];
  if (box.dataset.url !== url) { $(".sqr", box).innerHTML = qrSvg(url, 8); box.dataset.url = url; }
  $(".stitle", box).textContent = meta.title || APP;
  $(".sjoin", box).textContent = t(room.cipher ? "showJoinEnc" : "showJoin");
  $(".shost", box).textContent = room.cipher ? "" : location.host + location.pathname.replace(/index\.html$/, "");
  $(".scode", box).textContent = room.cipher ? "" : room.code;
  $(".sppl", box).replaceChildren(icon("people"), t("showPeople", { n: Object.values(room.members).filter((m) => m.online !== false).length }));
  const z = shownQuiz();
  shownAt = z ? z + quizStage(z) : "";
  box.classList.toggle("quizon", !!z && !shownAt.startsWith(z + "lobby"));
  if (z) {
    $(".smain", box).replaceChildren(quizScreen(z) || "");
    $(".spoll", box).replaceChildren();
    return quizClock(box, z);
  }
  const poll = [...room.msgs.values()].reverse().find((v) => v.poll);
  const pollBox = poll ? el("div", { class: "spollbox" }, pollView(livePoll(poll), null)) : null;
  const live = meta.qnow && room.qs.get(meta.qnow), showLive = live && (!live.done || live.ans);
  const open = qs.filter((q) => !q.done && q !== live).sort(byVotes).slice(0, showLive ? (live.ans ? 3 : 4) : 6);
  // who asked: their animal and name, or a dashed disc for anonymous
  const sav = (q) => (q.name ? avatar(q.avatar, "sav") : el("span", { class: "sav anon" }, icon("anonymous")));
  const who = (q) => [sav(q), q.name || bare(t("anonAsker"))];
  const hasQa = meta.qa || room.qs.size, main = [];
  if (hasQa) {
    if (showLive) main.push(el("div", { class: "snow" }, el("span", { class: "qlive", text: t("qLive") }), el("p", { text: live.text }),
      el("small", {}, ...who(live), el("span", { "aria-hidden": "true", text: "·" }), el("span", { class: "v" }, icon("upvote"), live.up.length)),
      live.ans && !live.ans.bad ? el("div", { class: "sans" }, el("small", {}, icon("chat"), live.ans.name ? avatar(live.ans.avatar, "sav") : null, live.ans.name || t("qAnsLabel")), el("p", { text: live.ans.text })) : null));
    main.push(el("h2", { text: t("showQs", { n: qs.filter((q) => !q.done).length }) }));
    main.push(open.length ? el("ol", { class: "slist" }, open.map((q) => el("li", {}, el("span", { class: "sv" }, icon("upvote"), el("b", { text: q.up.length })),
      el("span", { class: "st" }, el("span", { class: "stx", text: q.text }), el("small", {}, ...who(q))))))
      : el("p", { class: "shint", text: showLive ? "" : t("showNoQs") }));
  } else main.push(pollBox || el("p", { class: "shint big", text: t("showHint") }));
  $(".smain", box).replaceChildren(...main);
  $(".spoll", box).replaceChildren(...(hasQa && pollBox ? [pollBox] : []));
}
