/* The screens (home, chat, projector, record), the address bar, and the home page: the rooms this device is in
   and the ☰ menu (identity, language, theme, saved records). */
import { CODE_RE } from "./constants.js?v=dev";
import { phase, hoursLeft } from "./expiry.js?v=dev";
import { t } from "./text.js?v=dev";
import { $, el, sheet, pickSheet, icon, avatar, bare } from "./dom.js?v=dev";
import { store, StoredList, KEYS } from "./storage.js?v=dev";
import { backend, asParam } from "./backend.js?v=dev";
import { RoomCipher } from "./crypto.js?v=dev";
import { room } from "./session.js?v=dev";
import { me, askMe, showMe } from "./identity.js?v=dev";
import { renderView } from "./chat.js?v=dev";
import { closePicker } from "./pickers.js?v=dev";
import { SHOW, endShow, renderShow } from "./show.js?v=dev";
import { records, openRecord, closeRecord } from "./records.js?v=dev";

/* ---------- the address ---------- */
// a room's invite link: an encrypted room's key rides after the #, which browsers never send to a server
export const roomUrl = (code) => location.origin + location.pathname + "?room=" + code + (room?.cipher && store.get(KEYS.roomKey(code)) ? "#k=" + store.get(KEYS.roomKey(code)) : "");
// the address names the room, so reloading the page comes back to it
export const roomPath = (code) => history.replaceState(null, "", "?room=" + code + (SHOW() ? "&show=1" : "") + asParam("&"));

/* ---------- screens ---------- */
const SCREENS = ["#home", "#chat", "#show", "#record"];
// opening a room's link shows the loading screen (html.opening, set by js/i18n.js) until one of these screens is up
const opened = () => document.documentElement.classList.remove("opening");
const only = (screen) => { SCREENS.forEach((s) => ($(s).hidden = s !== screen)); opened(); };
// opening a room's link starts with no screen showing; a question on the way in (nickname, invite link) shows the home page behind it
export function backdrop() { if ($("#home").hidden && $("#chat").hidden && $("#record").hidden) { $("#home").hidden = false; showResume(); } opened(); }
export function showChat() {
  opened();
  $("#home").hidden = true; $("#record").hidden = true;
  if (SHOW()) { $("#chat").hidden = true; $("#show").hidden = false; renderShow(); return; }
  $("#chat").hidden = false; renderView();
}
export function showRecordScreen() { opened(); $("#home").hidden = true; $("#chat").hidden = true; $("#record").hidden = false; }
export function home() {
  only("#home");
  closeRecord(); closePicker(); endShow();
  $("#composer").classList.remove("off"); $("#composer").hidden = false; $("#roBox").hidden = true;
  document.title = t("docTitle");
  const lang = new URLSearchParams(location.search).get("lang"); // the language a search result linked to stays in the address
  history.replaceState(null, "", location.pathname + (lang ? "?lang=" + encodeURIComponent(lang) + asParam("&") : asParam("?")));
  showResume();
}

/* ---------- the rooms this device is in, most recently entered first ---------- */
const MAX_ROOMS = 30, PAGE = 5;
const myRooms = new StoredList(KEYS.rooms, (c) => typeof c === "string" && CODE_RE.test(c));
export const rememberRoom = (code) => myRooms.save([code, ...myRooms.all().filter((c) => c !== code)].slice(0, MAX_ROOMS));
export const forgetRoom = (code) => myRooms.save(myRooms.all().filter((c) => c !== code));
// before the list there was one room under chat-room
export function adoptOldRoom() {
  const old = store.get(KEYS.oldRoom);
  if (!old) return;
  if (!myRooms.includes(old)) store.set(KEYS.rooms, JSON.stringify([old, ...myRooms.all()]));
  store.set(KEYS.oldRoom, null);
}
// the list as last checked, so the home page shows it at once instead of after signing in and asking the server
const seenRows = new StoredList(KEYS.roomsSeen, () => true);
let resumePage = 0, resumeRows = [], resumeSeq = 0;
export async function showResume() {
  const seq = ++resumeSeq, codes = myRooms.all();
  if (!codes.length || !backend.configured) { $("#resume").hidden = true; return; }
  const seen = seenRows.all().filter((r) => r && codes.includes(r.code));
  if (seen.length) { resumeRows = codes.map((c) => seen.find((r) => r.code === c)).filter(Boolean); renderResume(); }
  try { await backend.connect(); } catch (e) { return; }
  const rows = (await Promise.all(codes.map((code) => resumeRow(code, seen)))).filter(Boolean);
  if (seq !== resumeSeq) return;
  resumeRows = rows;
  seenRows.save(rows);
  renderResume();
}
// how a room shows in the list, or null once it's gone (or this device isn't in it any more)
async function resumeRow(code, seen) {
  const meta = await backend.val(backend.roomRef(code, "meta"), undefined);
  if (meta === undefined) return seen.find((r) => r.code === code) || null; // offline: keep what we last saw
  if (!meta || phase(meta.last, backend.now()).state === "gone") { forgetRoom(code); return null; }
  const inside = await backend.fb.get(backend.roomRef(code, "members/" + backend.uid)).then((s) => s.exists(), () => false);
  if (!inside) { forgetRoom(code); return null; }
  let title = meta.title || "";
  if (meta.enc) { try { title = (await (await RoomCipher.fromLink(store.get(KEYS.roomKey(code)))).unseal(meta.xt, "t"))?.t || ""; } catch (e) { title = ""; } }
  return { code, t: title, enc: !!meta.enc, last: meta.last };
}
function renderResume() {
  const box = $("#resume"), rows = resumeRows, pages = Math.ceil(rows.length / PAGE);
  box.hidden = !rows.length;
  if (!rows.length) return;
  resumePage = Math.min(resumePage, pages - 1);
  $("h2", box).textContent = rows.length === 1 ? t("stillIn") : t("stillInN", { n: rows.length });
  $(".roomlist", box).replaceChildren(...rows.slice(resumePage * PAGE, resumePage * PAGE + PAGE).map((r) => {
    // a read-only room (nobody spoke for 24 hours) says so, and how many hours it has left
    const p = typeof r.last === "number" ? phase(r.last, backend.now()) : null, ro = p?.state === "ro" || p?.state === "gone";
    return el("li", {},
      el("button", { type: "button", class: "roomrow" + (ro ? " ro" : ""), "data-code": r.code },
        // laid out like the room's own header: its name, then its code; a Private Salon's code carries a lock
        el("span", { class: "txt" }, el("b", { text: r.t || t("room") }),
          el("span", { class: "tags" }, el("span", { class: "code" + (r.enc ? " salon" : "") }, r.enc ? icon("salon") : null, r.code),
            ro ? el("span", { class: "tag warn" }, icon("hourglass"), t("roTag")) : null,
            ro ? el("span", { class: "left", text: t("roLeft", { h: hoursLeft(p.left) }) }) : null)),
        el("span", { class: "go" }, el("span", { class: "vh", text: t("backToRoom") }), icon("forward"))));
  }));
  $(".pager", box).hidden = pages < 2;
  $(".pager .pg", box).textContent = `${resumePage + 1} / ${pages}`;
  $(".pager [data-a=prev]", box).disabled = resumePage === 0;
  $(".pager [data-a=next]", box).disabled = resumePage >= pages - 1;
}
export function turnResumePage(step) { resumePage += step; renderResume(); }

/* ---------- the ☰ menu: who I am, language, theme and my saved records ---------- */
const menuRow = (a, lead, title, sub) => el("button", { type: "button", class: "merow", "data-a": a },
  el("span", { class: "av" }, lead), el("span", { class: "txt" }, el("b", { text: title }), el("small", { text: sub })), icon("forward", "chev"));
const languageWord = () => t("language") + (I18N.lang === "en" ? "" : " · Language");
export function homeMenu() {
  const m = me(), list = records();
  const body = el("div", { class: "hmenu" },
    menuRow("me", m ? avatar(m.avatar) : icon("user"), m ? m.name : t("noIdentity"), t("editMeShort")),
    menuRow("lang", icon("language"), languageWord(), I18N.LANGS.find(([c]) => c === I18N.lang)[1]),
    menuRow("theme", icon("theme"), t("theme"), t({ light: "themeLight", dark: "themeDark" }[THEME.get()] || "themeSystem")),
    el("h3", { text: t("myRecords") }),
    list.length ? el("ul", { class: "reclist" }, list.map((r) => el("li", {},
      el("button", { type: "button", class: "rec", "data-open": r.id },
        el("b", { text: r.title }), el("small", { text: [r.code ? t("recCode", { code: r.code }) : null, t("recN", { n: r.n }), new Date(r.exported).toLocaleDateString(I18N.lang)].filter(Boolean).join(" · ") })))))
      : el("p", { class: "muted small", text: t("noRecords") }),
    el("button", { type: "button", class: "btn wide", "data-a": "import" }, icon("download"), bare(t("importRec"))));
  sheet(t("menu"), body, [["close", t("close")]], {
    onOpen: (ov) => body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a], [data-open]"); if (!b) return;
      if (b.dataset.a === "import") $("#importFile").click(); // right inside the tap, or the file picker may not open
      ov.close(b.dataset.open ? "open:" + b.dataset.open : b.dataset.a);
    }),
  }).then((a) => {
    if (a === "me") askMe(false);
    else if (a === "lang") pickLang();
    else if (a === "theme") pickTheme();
    else if (a?.startsWith("open:")) openRecord(null, a.slice(5));
  });
}
// a list of choices, one of them current; resolves with the value picked, or null
const choose = (title, options, current, attr) => pickSheet(title,
  el("div", { class: "langs", role: "radiogroup" }, options.map(([v, n]) => el("button", { type: "button", class: "btn wide", role: "radio", [`data-${attr}`]: v, "aria-checked": String(v === current), text: n }))),
  `[data-${attr}]`, (b) => b.dataset[attr]);
// the languages, each in its own name; the choice stays on this device
async function pickLang() {
  const lang = await choose(languageWord(), [["", t("followDevice")], ...I18N.LANGS], store.get(KEYS.lang) || "", "lang");
  if (lang == null) return;
  I18N.set(lang || null);
  showMe(); home(); homeMenu();
}
// light, dark, or whatever the device uses (the default)
async function pickTheme() {
  const theme = await choose(t("theme"), [["", t("themeSystem")], ["light", t("themeLight")], ["dark", t("themeDark")]], THEME.get() || "", "theme");
  if (theme == null) return;
  THEME.set(theme || null);
  homeMenu();
}
