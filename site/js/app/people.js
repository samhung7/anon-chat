/* Who's in the room, and what can be done with someone: everyone can message, mention and block; the owner names
   co-hosts and hands the room over; the owner and co-hosts remove people. */
import { LIMITS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { el, toast, sheet, confirmSheet, pickSheet, icon, avatar, bare } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { isBlocked, setBlocked } from "./blocking.js?v=dev";
import { openDm } from "./chat.js?v=dev";
import { mention } from "./actions.js?v=dev";
import { failed } from "./lobby.js?v=dev";

// the member list, grouped: owner, co-hosts, everyone else; pick: a title, and tapping someone picks them (to hand
// the room over) instead
export async function people(pick) {
  if (!room) return;
  const uid = backend.uid, owner = room.meta?.owner;
  const rank = (id) => (id === owner ? 0 : room.isMod(id) ? 1 : 2);
  const ids = Object.keys(room.members).filter((id) => !pick || id !== uid)
    .sort((a, b) => rank(a) - rank(b) || (room.members[a].joined || 0) - (room.members[b].joined || 0));
  const row = (id) => {
    const m = room.members[id], away = m.online === false, blocked = isBlocked(id);
    const tags = [id === uid ? t("you") : null, id === owner ? t("ownerTag") : room.isMod(id) ? t("modTag") : null,
      blocked ? t("blockedTag") : null, away ? t("offlineTag") : null].filter(Boolean).join(" · ");
    const n = room.ui.unread[id];
    return el("li", { class: "st-mrow" + (away ? " away" : "") + (blocked ? " blk" : "") },
      el("span", { class: "st-mav" }, avatar(m.avatar), away ? null : el("i", { class: "on", "aria-hidden": "true" })),
      el("span", { class: "nm" }, el("b", { text: m.name }), tags ? el("small", {}, blocked ? icon("block", "sm") : null, tags) : null),
      pick ? el("span", { class: "acts" }, el("button", { type: "button", class: "btn small primary", "data-pick": id, text: t("pickThis") }))
        : id !== uid ? el("span", { class: "acts" },
          el("button", { type: "button", class: "btn small", "data-dm": id }, t("dm"), n ? el("i", { class: "st-count", text: n }) : null),
          el("button", { type: "button", class: "btn small bd", "data-pm": id, "aria-label": t("more") }, icon("more"))) : null);
  };
  const groups = [[0, "owner", t("ownerTag")], [1, "cohost", t("modTag")], [2, "people", t("members")]].map(([r, ic, label]) => {
    const mine = ids.filter((id) => rank(id) === r);
    return mine.length ? el("section", { class: "st-mgrp" },
      el("h3", {}, icon(ic, "sm"), label, el("span", { class: "c", text: mine.length })), el("ul", {}, mine.map(row))) : null;
  });
  const n = Object.keys(room.members).length;
  const title = pick || (room.meta?.cap ? t("membersCap", { n, cap: room.meta.cap }) : t("membersN", { n }));
  const choice = await pickSheet(title, ids.length ? el("div", {}, groups) : el("p", { class: "muted", text: t("noOneElse") }), "button", (b) => ({ ...b.dataset }));
  if (!choice || !room || room.gone) return;
  if (choice.dm) openDm(choice.dm);
  if (choice.pm) memberMenu(choice.pm);
  if (choice.pick) transferOwner(choice.pick);
}
// what can be done with someone, in three groups: talk to them, the owner's powers, and the destructive ones
async function memberMenu(id) {
  const m = room.members[id]; if (!m) return;
  const blocked = isBlocked(id);
  const talk = [["dm", "mail", t("dm")], ["at", "chat", t("mentionName", { name: m.name })]];
  if (blocked) talk.push(["unblock", "block", t("unblockName", { name: m.name })]);
  const powers = room.isOwner() ? [room.isMod(id) ? ["unmod", "cohost", t("unmakeMod")] : ["mod", "cohost", t("makeMod")], ["owner", "owner", t("transfer")]] : [];
  const harm = [blocked ? null : ["block", "block", t("blockName", { name: m.name })], room.canManage(id) ? ["kick", "kick", t("kick")] : null].filter(Boolean);
  // the row's line icon replaces any emoji the label starts with (menus elsewhere still use them)
  const grp = (rows, danger) => (rows.length ? el("div", { class: "st-agrp" }, rows.map(([a, ic, label]) =>
    el("button", { type: "button", class: "st-arow" + (danger ? " danger" : ""), "data-a": a }, icon(ic),
      el("span", { text: bare(label) })))) : null);
  const head = el("h2", { class: "withav" }, avatar(m.avatar, "st-tav"), m.name);
  const a = await pickSheet(m.name, el("div", {}, grp(talk), grp(powers), grp(harm, true)), "button[data-a]", (b) => b.dataset.a, [], head);
  if (!room || room.gone) return;
  if (a === "dm") openDm(id);
  if (a === "at") mention(m.name);
  if (a === "block" || a === "unblock") setBlocked(id, a === "block");
  if (a === "mod" || a === "unmod") room.api.setMod(id, a === "mod")
    .then(() => toast(t(a === "mod" ? "modDone" : "unmodDone", { name: m.name })), () => toast(t("tryAgain")));
  if (a === "owner") transferOwner(id);
  if (a === "kick") kick(id);
}
// what's left of a size count once someone goes (null when the room keeps none)
export const countAfterLeaving = () => (room.meta?.cap && room.meta.n > 0 ? room.meta.n - 1 : null);
// someone's nickname claim, if it's still theirs: don't free a name someone else uses now
export async function ownClaim(id) {
  const k = room.claimOf(id);
  return k && (await room.api.holderOf(k)) === id ? k : null;
}
async function kick(id) {
  const m = room.members[id];
  if (!m || !(await confirmSheet(t("kickTitle", { who: `${m.avatar} ${m.name}` }), t("kickBody"), t("kick")))) return;
  room.api.kick(id, { claim: await ownClaim(id), count: countAfterLeaving(), unmod: room.isOwner() && room.isMod(id) })
    .then(() => toast(t("kickedToast", { name: m.name })), () => toast(t("kickFail")));
}
async function transferOwner(id) {
  const m = room.members[id];
  if (!m || !room.isOwner() || !(await confirmSheet(t("transferTitle", { who: `${m.avatar} ${m.name}` }), t("transferBody"), t("transfer"), "primary"))) return;
  room.api.transfer(id).then(() => toast(t("transferDone", { name: m.name })), () => toast(t("tryAgain")));
}
// the most people the room takes (empty: no limit)
export async function capSheet() {
  const n = Object.keys(room.members).length;
  const input = el("input", { class: "field num", type: "number", inputmode: "numeric", min: Math.max(2, n), max: LIMITS.cap, id: "capN", placeholder: t("capPh"), value: room.meta?.cap || "" });
  const warn = el("p", { class: "note warn", hidden: true });
  const say = (text) => { warn.textContent = text; warn.hidden = false; };
  const body = el("div", {}, warn, el("p", { class: "muted", text: t("capBody", { n }) }), el("label", { class: "lbl", for: "capN", text: t("cap") }), input);
  for (;;) {
    const a = await sheet(t("cap"), body, [["no", t("cancel")], ["yes", t("save"), "primary"]], { onOpen: () => input.focus() });
    if (a !== "yes" || !room || room.gone) return;
    const raw = input.value.trim(), cap = Math.floor(+raw);
    if (!raw) return room.api.setMeta({ cap: null, n: null }).then(() => toast(t("capOff")), failed);
    if (!(cap >= 2 && cap <= LIMITS.cap)) { say(t("capBad")); continue; }
    if (cap < n) { say(t("capTooLow", { n })); continue; }
    return room.api.setMeta({ cap, n }).then(() => toast(t("capSet", { n: cap })), failed);
  }
}
