/* Who's in the room, and what can be done with someone: everyone can message, mention and block; the owner names
   co-hosts and hands the room over; the owner and co-hosts remove people. */
import { LIMITS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { el, toast, sheet, confirmSheet, pickSheet } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { isBlocked, setBlocked } from "./blocking.js?v=dev";
import { openDm } from "./chat.js?v=dev";
import { mention } from "./actions.js?v=dev";
import { failed } from "./lobby.js?v=dev";

// the member list; pick: a title, and tapping someone picks them (to hand the room over) instead
export async function people(pick) {
  if (!room) return;
  const uid = backend.uid, owner = room.meta?.owner;
  const rank = (id) => (id === owner ? 0 : room.isMod(id) ? 1 : 2);
  const ids = Object.keys(room.members).filter((id) => !pick || id !== uid)
    .sort((a, b) => rank(a) - rank(b) || (room.members[a].joined || 0) - (room.members[b].joined || 0));
  const list = el("ul", { class: "plist" }, ids.map((id) => {
    const m = room.members[id];
    const tags = [id === uid ? t("you") : null, id === owner ? t("ownerTag") : room.isMod(id) ? t("modTag") : null,
      isBlocked(id) ? t("blockedTag") : null, m.online === false ? t("offlineTag") : null].filter(Boolean).join(" · ");
    return el("li", { class: m.online === false ? "away" : "" },
      el("span", { class: "av", text: m.avatar }),
      el("span", { class: "nm" }, el("b", { text: m.name }), tags ? el("small", { text: tags }) : null),
      pick ? el("button", { type: "button", class: "btn small primary", "data-pick": id, text: t("pickThis") })
        : id !== uid ? [el("button", { type: "button", class: "btn small", "data-dm": id }, t("dm"), room.ui.unread[id] ? el("i", { class: "badge", text: room.ui.unread[id] }) : null),
          el("button", { type: "button", class: "btn small", "data-pm": id, "aria-label": t("more"), text: "⋯" })] : null);
  }));
  const n = Object.keys(room.members).length;
  const title = pick || (room.meta?.cap ? t("membersCap", { n, cap: room.meta.cap }) : t("membersN", { n }));
  const choice = await pickSheet(title, ids.length ? list : el("p", { class: "muted", text: t("noOneElse") }), "button", (b) => ({ ...b.dataset }));
  if (!choice || !room || room.gone) return;
  if (choice.dm) openDm(choice.dm);
  if (choice.pm) memberMenu(choice.pm);
  if (choice.pick) transferOwner(choice.pick);
}
async function memberMenu(id) {
  const m = room.members[id]; if (!m) return;
  const btns = [["dm", t("dm")], ["at", t("mentionName", { name: m.name })], isBlocked(id) ? ["unblock", t("unblockName", { name: m.name })] : ["block", t("blockName", { name: m.name })]];
  if (room.isOwner()) btns.push(room.isMod(id) ? ["unmod", t("unmakeMod")] : ["mod", t("makeMod")], ["owner", t("transfer")]);
  if (room.canManage(id)) btns.push(["kick", t("kick"), "danger"]);
  const a = await sheet(`${m.avatar} ${m.name}`, null, btns);
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
