/* What can be done with a message (its ⋯ menu), and reports.
   The menu is a table: each entry says when it shows and what it does, so adding one is adding a row. A kind of
   message brings its own entries (kinds.js `actions`), shown after the common ones that edit it. */
import { LIMITS, REACTS } from "./constants.js?v=dev";
import { t, fmtWhen } from "./text.js?v=dev";
import { el, toast, sheet, confirmSheet, orToast, pickSheet, grouped } from "./dom.js?v=dev";
import { backend, isDenied } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { kindOf, snippet } from "./kinds.js?v=dev";
import { isBlocked, setBlocked } from "./blocking.js?v=dev";
import { startReply, insertAtCursor, box } from "./composer.js?v=dev";
import { openDm, pin, pinIds, react, jumpTo, setView } from "./chat.js?v=dev";

// [action, label, when(c), run(c), class]; c = { id, v, dm, mine, name }. Three groups set apart by a gap: the
// message itself, its author, and keeping the room in order (blocking, reports, taking it down)
const BEFORE = [
  ["reply", () => t("reply"), (c) => !c.v.bad, (c) => startReply(c.id, c.v, c.dm)],
  ["copy", () => t("copyText"), (c) => c.v.text && !c.v.bad, (c) => navigator.clipboard?.writeText(c.v.text).then(() => toast(t("copied")), () => toast(t("cantCopy")))],
  ["edit", () => t("edit"), (c) => !c.dm && c.mine && kindOf(c.v).editable && typeof c.v.text === "string" && c.v.text && !c.v.bad, (c) => editMsg(c.id, c.v)],
];
const AFTER = [
  ["pin", () => t("pinAsNotice"), (c) => !c.dm && !c.v.bad && room.isOwner() && !pinIds().includes(c.id), (c) => pin(c.id, true)],
  ["unpin", () => t("unpin"), (c) => !c.dm && !c.v.bad && room.isOwner() && pinIds().includes(c.id), (c) => pin(c.id, false)],
  { group: "" },
  ["dm", (c) => t("dmTo", { name: c.name }), (c) => !c.dm && !c.mine && room.members[c.v.by], (c) => openDm(c.v.by)],
  ["at", (c) => t("mentionName", { name: c.name }), (c) => !c.dm && !c.mine && room.members[c.v.by], (c) => mention(c.name)],
  { group: "" },
  ["report", () => t("report"), (c) => !c.dm && !c.mine && !room.isStaff(), (c) => reportMsg(c.id)],
  ["unblock", (c) => t("unblockName", { name: c.name }), (c) => !c.mine && isBlocked(c.v.by), (c) => setBlocked(c.v.by, false)],
  ["block", (c) => t("blockName", { name: c.name }), (c) => !c.mine && !isBlocked(c.v.by), (c) => setBlocked(c.v.by, true)],
  ["del", () => t("delMsg"), (c) => !c.dm && c.mine, async (c) => { if (await confirmSheet(t("delMsgTitle"), t("delMsgBody"), t("del"))) removeMsg(c.id, c.v); }, "danger"],
  ["remove", () => t("removeMsg"), (c) => !c.dm && !c.mine && room.isStaff(), async (c) => { if (await confirmSheet(t("removeTitle"), t("delMsgBody"), t("removeMsg"))) removeMsg(c.id, c.v); }, "danger"],
];
const kindEntries = (kind) => (kind.actions || []).map(([a, label, when, run]) => [a, () => t(label), (c) => when(c.v), (c) => run(c.id, c.v)]);

export async function msgActions(id, v, dm) {
  if (!room || room.gone) return;
  const uid = backend.uid, kind = kindOf(v);
  const c = { id, v, dm, mine: v.by === uid, name: room.author(v, dm).name };
  const entries = grouped([...BEFORE, ...kindEntries(kind), ...AFTER], ([, , when]) => when(c));
  const reacts = dm ? null : el("div", { class: "reactrow" }, REACTS.map((emo, k) =>
    el("button", { type: "button", class: "chip big" + (v.re?.[k]?.[uid] ? " on" : ""), "data-a": "re" + k, text: emo })));
  let picked = null;
  const a = await sheet("", el("div", {}, el("time", { class: "mwhen", text: fmtWhen(v.at) }), kind.preview(v), reacts),
    entries.map((e) => (Array.isArray(e) ? [e[0], e[1](c), e[4]] : e)),
    { onOpen: (ov) => reacts?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { picked = +b.dataset.a.slice(2); ov.close("react"); } }) });
  if (a === "react") return react(id, picked, !v.re?.[picked]?.[uid]);
  entries.find((e) => e[0] === a)?.[3](c);
}
// the author deletes a message, or the owner or a co-host takes it down (with any reports on it)
export function removeMsg(id, v) {
  const more = { ...(kindOf(v).removes?.(v) || {}), ...(room.isStaff() ? { ["reports/" + id]: null } : {}) };
  return room.api.remove(id, more).then(() => { kindOf(v).removed?.(v); if (v.by !== backend.uid) toast(t("removedToast")); }, () => toast(t("delFail")));
}
async function editMsg(id, v) {
  const input = el("textarea", { class: "field", maxlength: LIMITS.text, rows: 4, id: "editText", "aria-label": t("msgAria") });
  input.value = v.text;
  const a = await sheet(t("editTitle"), input, [["no", t("cancel")], ["yes", t("save"), "primary"]], { onOpen: () => input.focus() });
  if (a !== "yes" || !room || room.gone) return;
  const text = input.value.trim().slice(0, LIMITS.text);
  if (!text || text === v.text) return;
  // an encrypted room seals the new words with everything else the message carried
  const T = backend.stamp();
  const fields = room.cipher ? { x: await room.cipher.seal({ t: text, n: v.name, a: v.avatar, ...(v.rp ? { r: v.rp } : {}) }, "m:" + backend.uid), ed: T } : { text, ed: T };
  orToast(room.api.edit(id, fields));
}
export function mention(name) {
  if (!room || room.gone) return;
  if (room.ui.view !== "all") setView("all");
  insertAtCursor("@" + name + " ");
  box().focus();
}

/* ---------- reports ----------
   Anyone can report a message to the room's owner and co-hosts, with a reason; they see how many reported it and
   why, never who. Reports go with the message, and with the room. Each report also goes to StoaTalk's operator
   (site/admin.html) with the message as the reporter sees it, so it can be acted on in an encrypted room too. */
const REASONS = [0, 1, 2, 3];
// what the operator gets of a message: its words (or what kind it is), the name it came under, a plain room's photo
function seenOf(v) {
  const seen = { who: v.by, t: String(typeof v.text === "string" && v.text ? v.text : snippet(v)).slice(0, LIMITS.text), n: String(room.author(v).name || "").slice(0, LIMITS.shownName) };
  if (room.cipher) seen.enc = true;
  else if (v.img?.f) seen.f = v.img.f;
  if (!seen.t) delete seen.t;
  return seen;
}
async function reportMsg(id) {
  const a = await sheet(t("reportTitle"), el("p", { class: "muted", text: t("reportBody") }), REASONS.map((k) => ["r" + k, t("why" + k)]).concat([["no", t("cancel")]]));
  if (!a?.startsWith("r") || !room || room.gone) return;
  const v = room.msgs.get(id);
  if (!v) return;
  room.api.report(id, +a.slice(1), seenOf(v)).then(() => toast(t("reportedToast")), (e) => toast(t(isDenied(e) ? "reportedAlready" : "tryAgain")));
}
export async function reportsSheet() {
  const items = Object.entries(room.reports || {}).map(([id, by]) => ({ id, v: room.msgs.get(id), n: Object.keys(by || {}).length, why: [...new Set(Object.values(by || {}).map((x) => x?.r))] }));
  const stale = items.filter((it) => !it.v); // the message is already gone
  if (stale.length) room.api.dropReports(stale.map((it) => it.id)).catch(() => {});
  const live = items.filter((it) => it.v);
  const body = live.length ? el("ul", { class: "replist" }, live.map((it) => el("li", {},
    el("button", { type: "button", class: "go", "data-go": it.id },
      el("small", { text: `${room.author(it.v).avatar} ${room.author(it.v).name} · ${t("reportN", { n: it.n })} · ${it.why.filter((k) => REASONS.includes(k)).map((k) => t("why" + k)).join(t("listSep"))}` }),
      snippet(it.v)),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn small danger", "data-rm": it.id, text: t("removeMsg") }),
      el("button", { type: "button", class: "btn small", "data-ok": it.id, text: t("dismiss") })))))
    : el("p", { class: "muted", text: t("noReports") });
  const pick = await pickSheet(t("reportsTitle"), body, "button", (b) => ({ ...b.dataset }));
  if (!pick || !room || room.gone) return;
  if (pick.go) jumpTo(pick.go);
  if (pick.rm && room.msgs.get(pick.rm)) removeMsg(pick.rm, room.msgs.get(pick.rm));
  if (pick.ok) orToast(room.api.dismissReport(pick.ok));
}
