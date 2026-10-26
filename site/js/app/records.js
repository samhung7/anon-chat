/* Exporting a room to a file, keeping records in this browser (nothing is uploaded), importing them back, and
   reading one, read-only. */
import { t, fmtFull } from "./text.js?v=dev";
import { $, el, toast, sheet, confirmSheet, icon, bare } from "./dom.js?v=dev";
import { store, StoredList, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { me } from "./identity.js?v=dev";
import { savedKindOf } from "./kinds.js?v=dev";
import { linkify } from "./richtext.js?v=dev";
import { photoUrl } from "./photos.js?v=dev";
import { loadBodies } from "./posts.js?v=dev";
import { ansBox, qWho } from "./qa.js?v=dev";
import { ARCHIVE, buildArchive, readArchive, countOf, toText, toHtml, personLabel } from "./archive.js?v=dev";
import { home, showRecordScreen } from "./home.js?v=dev";
import { GROUP_MS } from "./constants.js?v=dev";

export const archive = () => buildArchive(room, backend.uid, room.members[backend.uid] || room.seen[backend.uid] || me());

// the .html file carries the photos themselves, so it shows them after the room is gone
async function photoSrcs(a) {
  const out = new Map();
  if (!a.pics?.length || !room) return out;
  toast(t("photosPacking"));
  const dataUrl = (b) => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(null); fr.readAsDataURL(b); });
  for (const [m, v] of a.pics) {
    const u = await photoUrl(v.img.f, v.by);
    if (u) out.set(m, await fetch(u).then((r) => r.blob()).then(dataUrl).catch(() => null));
  }
  return out;
}
async function download(a, kind) {
  const stamp = new Date(a.exported || Date.now()).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const name = `chat-${a.code || "record"}-${stamp}.${kind}`; // ASCII: some browsers drop non-ASCII download names
  const body = kind === "txt" ? toText(a) : kind === "html" ? toHtml(a, await photoSrcs(a)) : JSON.stringify(a, null, 1);
  const type = { txt: "text/plain", html: "text/html", json: "application/json" }[kind] + ";charset=utf-8";
  const link = el("a", { href: URL.createObjectURL(new Blob([body], { type })), download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  toast(t("downloaded", { name }));
}
export async function exportSheet() {
  if (!room) return;
  await loadBodies(); // a long post's whole text goes in the file, not only its card
  const a = archive();
  const pick = await sheet(t("exportChat"), el("div", {},
    el("p", { class: "muted", text: t("exportCount", { n: countOf(a) }) }),
    el("p", { class: "muted small", text: t("exportHint") })),
    [["save", t("saveHere"), "primary"], ["json", t("jsonImp")], ["html", t("htmlImp")], ["txt", t("txtFile")]]);
  if (pick) backend.stat("exports");
  if (pick === "save") saveRecord(a);
  else if (pick) download(a, pick);
}

/* ---------- records kept in this browser ---------- */
const recordList = new StoredList(KEYS.records, () => true);
export const records = () => recordList.all();
// the record's id, or null when the browser's storage is full
export function saveRecord(a, quiet) {
  const id = `${a.code || "x"}-${a.exported || Date.now()}`;
  try {
    store.setOrThrow(KEYS.record(id), JSON.stringify(a));
    store.setOrThrow(KEYS.records, JSON.stringify([{ id, title: a.title, code: a.code, exported: a.exported, n: countOf(a) }, ...records().filter((r) => r.id !== id)]));
  } catch (e) { toast(t("noSpace")); return null; }
  if (!quiet) toast(t("savedRec"));
  return id;
}
function deleteRecord(id) {
  store.set(KEYS.record(id), null);
  recordList.save(records().filter((r) => r.id !== id));
}
export async function importFile(file) {
  if (!file) return;
  if (file.size > 8e6) { toast(t("tooBig")); return; }
  let a;
  try {
    const text = await file.text();
    let raw;
    if (/^\s*</.test(text)) { // an exported .html: the archive rides along inside it
      const tag = new DOMParser().parseFromString(text, "text/html").getElementById(ARCHIVE);
      raw = tag && JSON.parse(tag.textContent);
    } else raw = JSON.parse(text);
    a = readArchive(raw);
  } catch (e) { toast(t("notArchive")); return; }
  const id = saveRecord(a, true);
  openRecord(id ? null : a, id);
}

/* ---------- reading a record (read-only) ---------- */
let view = null; // { a, id, tab }: tab -1 everyone, -2 the questions, or a private chat's index
export const closeRecord = () => { view = null; };
export function openRecord(a, id) {
  if (!a) { try { a = readArchive(store.json(KEYS.record(id))); } catch (e) { toast(t("recBroken")); deleteRecord(id); return; } }
  view = { a, id, tab: -1 };
  showRecordScreen();
  $("#recTitle").textContent = a.title;
  $("#recSub").replaceChildren(icon("records", "sm"), bare(t("recSub", { t: fmtFull(a.exported) })));
  const tabs = $("#recTabs");
  tabs.replaceChildren(el("button", { type: "button", class: "tab", "data-tab": -1, text: t("everyoneN", { n: a.messages.length }) }),
    ...a.dms.map((d, i) => el("button", { type: "button", class: "tab", "data-tab": i, text: `🔒 ${personLabel(d.with)}` })),
    ...(a.questions ? [el("button", { type: "button", class: "tab", "data-tab": -2, text: `❓ ${t("qaTab")} ${a.questions.length}` })] : []));
  tabs.hidden = !a.dms.length && !a.questions;
  renderRecord();
}
export function showRecordTab(tab) { view.tab = tab; renderRecord(); }
function renderRecord() {
  const { a, tab } = view;
  $("#recTabs").querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(+b.dataset.tab === tab)));
  const box = $("#recList");
  if (tab === -2) { // the questions, read-only
    box.replaceChildren(...a.questions.map((q) => el("div", { class: "qcard" + (q.done ? " done" : "") },
      el("div", { class: "upvote", "aria-hidden": "true" }, icon("upvote", "sm"), el("b", { text: q.votes })),
      el("div", { class: "qbody" }, qWho(q.name, q.avatar, el("time", { text: fmtFull(q.at) })),
        el("p", { class: "qtext" }, linkify(q.text)), q.answer ? ansBox(q.answer, fmtFull) : null, q.done ? el("small", { class: "muted", text: t("qAnswered") }) : null))));
    box.scrollTop = 0; return;
  }
  const list = tab < 0 ? a.messages : a.dms[tab].messages;
  let prev = null;
  box.replaceChildren(...(list.length ? list.map((m) => {
    const cont = prev && prev.name === m.name && !!prev.mine === !!m.mine && m.at - prev.at < GROUP_MS;
    prev = m;
    return el("div", { class: "msg" + (m.mine ? " mine" : "") + (cont ? " cont" : "") },
      cont ? null : el("div", { class: "who" }, el("span", { class: "av", text: m.avatar }), el("span", { class: "nm", text: m.name + (m.owner ? " 👑" : "") }), el("time", { text: fmtFull(m.at) })),
      savedKindOf(m).savedBubble(m),
      m.reactions ? el("div", { class: "re" }, Object.entries(m.reactions).map(([e, n]) => el("span", { class: "chip", text: `${e} ${n}` }))) : null);
  }) : [el("p", { class: "empty", text: t("empty") })]));
  box.scrollTop = 0;
}
export async function recordMenu() {
  const { a, id } = view;
  const pick = await sheet(a.title, el("p", { class: "muted", text: t("recInfo") }),
    [["json", t("dlJson")], ["html", t("dlHtml")], ["txt", t("dlTxt")], ...(id ? [["del", t("delLocal"), "danger"]] : [])]);
  if (pick === "del" && (await confirmSheet(t("delRecTitle"), t("delRecBody"), t("del")))) { deleteRecord(id); home(); }
  else if (pick && pick !== "del") download(a, pick);
}
