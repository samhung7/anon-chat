/* Question sets for quizzes (quiz.js), made and kept on the host's own device: there are no accounts, so "my
   library" is this browser's IndexedDB. A set can go out as a file (.stoaquiz, JSON) to keep, move to another
   device or hand to someone else, and come back in from one, into any room. Sets are saved as they're edited.
   The ＋ panel opens the library for the owner and co-hosts; a set is started from there or from its editor. */
import { t } from "./text.js?v=dev";
import { el, toast, icon, sheet, confirmSheet, saveFile } from "./dom.js?v=dev";
import { room } from "./session.js?v=dev";
import { page, bar } from "./posts.js?v=dev";
import { QUIZ, SHAPES, blankQuestion, cleanSet, setProblem, toFile, fromFile } from "./quizset.js?v=dev";
import { startQuiz, openQuiz } from "./quiz.js?v=dev";

/* ---------- the library ---------- */
const DB = "stoatalk", STORE = "quizzes";
let opened = null;
function db() {
  return (opened ||= new Promise((ok, no) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  }).catch((e) => { opened = null; throw e; }));
}
const run = (mode, fn) => db().then((d) => new Promise((ok, no) => {
  const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
  tx.oncomplete = () => ok(req?.result);
  tx.onerror = tx.onabort = () => no(tx.error);
}));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// a set as kept: { id, at (last changed), t, q }, cleaned on the way out like one from a file
const kept = (x) => { const s = x && typeof x.id === "string" ? cleanSet(x) : null; return s ? { id: x.id, at: +x.at || 0, ...s } : null; };
export const library = {
  all: () => run("readonly", (s) => s.getAll()).then((list) => (list || []).map(kept).filter(Boolean).sort((a, b) => b.at - a.at)),
  put: (x) => run("readwrite", (s) => s.put({ id: x.id, at: Date.now(), t: x.t, q: x.q })),
  drop: (id) => run("readwrite", (s) => s.delete(id)),
  // a new entry for a set from somewhere else (a file, or a quiz played in a room)
  add: async (set) => { const x = { id: newId(), ...cleanSet(set) }; await library.put(x); return x; },
};
const day = (at) => new Date(at).toLocaleDateString(I18N.lang, { year: "numeric", month: "numeric", day: "numeric" });
const titleOf = (x) => x.t || t("qzUntitled");

/* ---------- from the ＋ panel ---------- */
export async function quizSheet() {
  if (!room) return;
  const list = el("div", { class: "qzlib" }, el("p", { class: "muted small", text: t("loading") }));
  const file = el("input", { type: "file", accept: ".stoaquiz,.json,application/json", hidden: true });
  const on = [...room.quizzes.entries()].find(([, e]) => e.live && e.live.ph !== "end");
  const onRow = on ? el("button", { type: "button", class: "gmrow qznow", "data-z": on[0] },
    el("span", { class: "gmic" }, icon("trophy")),
    el("span", { class: "gmtx" }, el("b", { text: room.msgs.get(on[0])?.quiz.t || t("quiz") }), el("small", { class: "muted", text: t("qzOn") })),
    el("span", { class: "gmst", text: t("qzHost") })) : null;
  // the file picker opens right inside the tap, or a phone may refuse to open it
  const importBtn = el("button", { type: "button", class: "link", onclick: () => file.click() }, icon("download", "sm"), el("span", { text: t("qzImport") }));
  let sets = [];
  const fill = () => library.all().then((all) => {
    sets = all;
    list.replaceChildren(...(all.length ? all.map((x) => el("button", { type: "button", class: "gmrow", "data-id": x.id },
      el("span", { class: "gmic" }, icon("qa")),
      el("span", { class: "gmtx" }, el("b", { text: titleOf(x) }), el("small", { class: "muted", text: t("qzCount", { n: x.q.length, date: day(x.at) }) })),
      icon("forward", "sm")))
      : [el("p", { class: "muted small lbnone", text: t("qzLibNone") })]));
  }, (e) => { console.error(e); list.replaceChildren(el("p", { class: "note warn", text: t("qzLibFail") })); });
  fill();
  const body = el("div", { class: "games" }, onRow, list, importBtn, el("p", { class: "muted small", text: t("qzLibNote") }), file);
  let picked = null;
  const a = await sheet(t("qzLib"), body, [["close", t("close")], ["new", t("qzNewSet"), "primary"]], { onOpen: (ov) => {
    body.addEventListener("click", (e) => {
      const b = e.target.closest(".gmrow");
      if (!b) return;
      picked = b.dataset.z ? { z: b.dataset.z } : sets.find((x) => x.id === b.dataset.id);
      if (picked) ov.close("pick");
    });
    file.addEventListener("change", async () => {
      const f = file.files[0]; file.value = "";
      if (!f) return;
      const set = f.size < 2e6 ? fromFile(await f.text().catch(() => "")) : null;
      if (!set) return toast(t("qzBadFile"));
      try { await library.add(set); toast(t("qzImported", { t: titleOf(set) })); fill(); }
      catch (e) { console.error(e); toast(t("qzLibFail")); }
    });
  } });
  if (a === "new") return editSet(null);
  if (a !== "pick") return;
  if (picked.z) return openQuiz(picked.z);
  setMenu(picked);
}
async function setMenu(x) {
  const a = await sheet(titleOf(x), el("p", { class: "muted", text: t("qzCount", { n: x.q.length, date: day(x.at) }) }),
    [["start", t("qzStartThis"), "primary"], ["edit", t("qzEdit")], ["export", t("qzExport")], { group: "" }, ["drop", t("qzDelete"), "danger"]]);
  if (a === "start") return start(x, (i) => editSet(x, i));
  if (a === "edit") return editSet(x);
  if (a === "export") return exportSet(x);
  if (a === "drop" && (await confirmSheet(t("qzDelete"), t("qzDeleteBody", { t: titleOf(x) }), t("qzDelete")))) {
    library.drop(x.id).then(() => toast(t("qzDeleted")), () => toast(t("qzLibFail")));
  }
}
// a set that's ready goes to the room; one that isn't says what to fix (fix: open it to do so)
function start(x, fix) {
  const set = cleanSet(x), bad = setProblem(set);
  if (bad) { toast(t(bad.why, { n: bad.i + 1 })); fix?.(bad.i); return false; }
  return startQuiz(set);
}
function exportSet(x) {
  const url = URL.createObjectURL(new Blob([toFile(cleanSet(x))], { type: "application/json" }));
  saveFile(url, `${titleOf(x).replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40)}.stoaquiz`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- the editor ---------- */
// a page for one set: its title and questions, saved to the library a moment after each change
export function editSet(x, focusAt = -1) {
  const set = x ? { id: x.id, t: x.t, q: x.q.map((q) => ({ ...q, o: [...q.o], c: [...q.c] })) } : { id: newId(), t: "", q: [blankQuestion()] };
  const title = el("input", { class: "field qzetitle", maxlength: QUIZ.title, placeholder: t("qzTitlePh"), "aria-label": t("qzTitlePh"), value: set.t });
  const qs = el("div", { class: "qzeqs" });
  const note = el("span", { class: "muted small" });
  const add = el("button", { type: "button", class: "btn qzeadd", onclick: () => {
    if (set.q.length >= QUIZ.questions) return toast(t("qzMax", { n: QUIZ.questions }));
    set.q.push(blankQuestion()); draw(); changed();
    qs.lastElementChild?.querySelector("textarea").focus();
  } }, icon("plus"), el("span", { text: t("qzAddQ") }));
  const go = el("button", { type: "button", class: "btn small primary", text: t("qzStartThis"), onclick: async () => {
    await save();
    if (!room || !room.isStaff()) return toast(t("qzHostsOnly"));
    const bad = setProblem(cleanSet(set));
    if (bad) {
      toast(t(bad.why, { n: bad.i + 1 }));
      return bad.i >= 0 ? qs.children[bad.i]?.scrollIntoView({ block: "center" }) : title.focus();
    }
    ov.close();
    startQuiz(cleanSet(set));
  } });
  let touched = !!x, timer = 0;
  const save = () => { clearTimeout(timer); if (!touched) return Promise.resolve(); return library.put(set).then(() => (note.textContent = t("qzSaved")), (e) => { console.error(e); note.textContent = t("qzLibFail"); }); };
  function changed() { touched = true; clearTimeout(timer); timer = setTimeout(save, 600); }
  title.addEventListener("input", () => { set.t = title.value; changed(); });

  const select = (label, value, list, text, pick) => el("label", { class: "qzesel" }, el("span", { class: "muted small", text: label }),
    el("select", { class: "field", onchange: (e) => { pick(+e.target.value); changed(); } }, list.map((v) => el("option", { value: String(v), text: text(v), selected: v === value }))));
  const tool = (name, label, fn, disabled) => el("button", { type: "button", class: "icon small", "aria-label": label, title: label, disabled: disabled || null, onclick: fn },
    name === "up" ? el("span", { text: "↑" }) : name === "down" ? el("span", { text: "↓" }) : icon(name, "sm"));
  const move = (i, by) => { const [q] = set.q.splice(i, 1); set.q.splice(i + by, 0, q); draw(); changed(); };
  function card(q, i) {
    const text = el("textarea", { class: "field", rows: 2, maxlength: QUIZ.question, placeholder: t("qzQPh"), "aria-label": t("qzQn", { n: i + 1 }) });
    text.value = q.t;
    text.addEventListener("input", () => { q.t = text.value; changed(); });
    const opts = q.o.map((o, k) => {
      const input = el("input", { class: "field", maxlength: QUIZ.option, placeholder: t("qzOptPh", { n: k + 1 }), "aria-label": t("qzOptPh", { n: k + 1 }), value: o });
      input.addEventListener("input", () => { q.o[k] = input.value; changed(); });
      const right = el("button", { type: "button", class: "qzeright", "aria-pressed": String(q.c.includes(k)), "aria-label": t("qzMarkRight"), title: t("qzMarkRight"), onclick: () => {
        q.c = q.c.includes(k) ? q.c.filter((c) => c !== k) : [...q.c, k].sort();
        right.setAttribute("aria-pressed", String(q.c.includes(k))); changed();
      } }, icon("check", "sm"));
      return el("div", { class: `qzeo qz${k}` }, el("span", { class: "shape", "aria-hidden": "true", text: SHAPES[k] }), input, right);
    });
    return el("section", { class: "qzeq" },
      el("div", { class: "qzeh" }, el("b", { text: t("qzQn", { n: i + 1 }) }), el("span", { class: "grow" }),
        tool("up", t("qzUp"), () => move(i, -1), i === 0), tool("down", t("qzDown"), () => move(i, 1), i === set.q.length - 1),
        tool("delete", t("qzDelQ"), () => { set.q.splice(i, 1); if (!set.q.length) set.q.push(blankQuestion()); draw(); changed(); })),
      text, el("div", { class: "qzeopts" }, opts),
      el("div", { class: "qzemeta" },
        select(t("qzTime"), q.d, QUIZ.times, (n) => t("qzSec", { n }), (v) => (q.d = v)),
        select(t("qzPointsLbl"), q.p, QUIZ.points, (n) => t("qzPoints" + n), (v) => (q.p = v))));
  }
  function draw() { qs.replaceChildren(...set.q.map(card)); add.hidden = set.q.length >= QUIZ.questions; }
  draw();
  const ov = page("writer qzedit", bar(t("qzEditor"), go, () => close()),
    el("div", { class: "pagebody" }, title, qs, add, el("div", { class: "pfoot" }, note)));
  ov.onEsc = () => close();
  function close() { save(); ov.close(); }
  setTimeout(() => (focusAt >= 0 ? qs.children[focusAt]?.querySelector("textarea") : title).focus(), 50);
}
