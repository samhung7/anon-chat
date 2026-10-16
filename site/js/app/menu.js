/* The room's ⋯ menu, as a table: each entry says who sees it and what it does. Also inviting people, renaming,
   leaving and ending the room. */
import { APP, LIMITS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { el, toast, sheet, confirmSheet, qrSvg } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room, setRoom } from "./session.js?v=dev";
import { askMe } from "./identity.js?v=dev";
import { stopRoom, leaveDevice } from "./chat.js?v=dev";
import { reportsSheet } from "./actions.js?v=dev";
import { people, capSheet, ownClaim, countAfterLeaving } from "./people.js?v=dev";
import { setQa } from "./qa.js?v=dev";
import { openShow } from "./show.js?v=dev";
import { notifyOn, setNotify } from "./notify.js?v=dev";
import { exportSheet } from "./records.js?v=dev";
import { roomUrl, home } from "./home.js?v=dev";
import { failed } from "./lobby.js?v=dev";

const owner = () => room.isOwner(), staff = () => room.isStaff(), always = () => true;
// a meta setting the owner flips, with what the toast says after
const flip = (fields, done) => () => room.api.setMeta(fields).then(() => toast(t(done)), () => toast(t("tryAgain")));
// [action, label, who sees it, what it does, class], in the order they show
const ENTRIES = [
  ["share", () => t("invite"), always, () => share()],
  ["title", () => t("renameRoom"), owner, () => renameRoom()],
  ["me", () => t("editMe"), always, () => askMe(false)],
  ["mute", () => t("muteRoom"), () => notifyOn(room.code), () => setNotify(false)],
  ["notify", () => t("notifyRoom"), () => !notifyOn(room.code), () => setNotify(true)],
  ["export", () => t("exportChat"), always, () => exportSheet()],
  ["qaoff", () => t("qaOff"), () => owner() && room.meta?.qa, () => setQa(false)],
  ["qaon", () => t("qaOn"), () => owner() && !room.meta?.qa, () => setQa(true)],
  ["qmodoff", () => t("qModOff"), () => owner() && room.meta?.qa && room.meta.qmod, flip({ qmod: false }, "qModOffToast")],
  ["qmodon", () => t("qModOn"), () => owner() && room.meta?.qa && !room.meta.qmod, flip({ qmod: true }, "qModOnToast")],
  ["show", () => t("showScreen"), staff, () => openShow()],
  ["reports", () => t("reportsMenu", { n: room.reportCount() }), staff, () => reportsSheet()],
  ["cap", () => (room.meta?.cap ? t("capMenuN", { n: room.meta.cap }) : t("cap")), owner, () => capSheet()],
  ["transfer", () => t("transfer"), owner, () => people(t("pickOwner"))],
  ["unlock", () => t("unlockRoom"), () => owner() && room.meta?.locked, flip({ locked: false }, "unlockedDone")],
  ["lock", () => t("lockRoom"), () => owner() && !room.meta?.locked, flip({ locked: true }, "lockedDone")],
  ["end", () => t("endRoom"), owner, () => endRoom(), "danger"],
  ["leave", () => t("leaveRoom"), () => !owner(), () => leaveRoom(), "danger"],
];
export async function menu() {
  if (!room) return;
  const shown = ENTRIES.filter(([, , who]) => who());
  const a = await sheet(room.meta?.title || t("roomN", { code: room.code }), null, shown.map(([act, label, , , cls]) => [act, label(), cls]));
  shown.find(([act]) => act === a)?.[3]();
}

export function share() {
  if (!room) return;
  const url = roomUrl(room.code);
  const qrBox = el("div", { class: "qr", "aria-label": "QR Code" }); qrBox.innerHTML = qrSvg(url, 4);
  const body = el("div", { class: "share" },
    el("div", { class: "bigcode", text: room.code }),
    el("p", { class: "muted", text: t(room.cipher ? "shareEnc" : "shareOpen") + (room.meta?.priv ? t("sharePw") : "") }),
    el("div", { class: "linkrow" }, el("input", { class: "field", readonly: true, value: url, "aria-label": t("linkAriaShort"), onfocus: (e) => e.target.select() })),
    qrBox);
  const btns = [["copy", t("copyLink"), "primary"]];
  if (navigator.share) btns.unshift(["share", t("shareDots")]);
  sheet(t("inviteTitle"), body, btns).then((a) => {
    if (a === "copy") navigator.clipboard?.writeText(url).then(() => toast(t("linkCopied")), () => toast(t("cantCopyLink")));
    if (a === "share") navigator.share({ title: room.meta?.title || APP, text: t("shareText", { code: room.code }), url }).catch(() => {});
  });
}
async function renameRoom() {
  const input = el("input", { class: "field", maxlength: LIMITS.roomTitle, placeholder: t("titlePh"), id: "roomName", value: room.meta?.title || "" });
  const body = el("div", {}, el("label", { class: "lbl", for: "roomName", text: t("roomName") }), input,
    el("p", { class: "muted small", text: t(room.cipher ? "renameEnc" : "renameOpen") }));
  const a = await sheet(t("renameRoom"), body, [["no", t("cancel")], ["yes", t("save"), "primary"]], { onOpen: () => input.select() });
  if (a !== "yes" || !room) return;
  const title = input.value.trim().slice(0, LIMITS.roomTitle);
  if (title === (room.meta?.title || "")) return;
  try {
    // an encrypted room keeps only the sealed title (xt); a plain one only the readable one
    await room.api.setMeta(room.cipher ? { xt: title ? await room.cipher.seal({ t: title }, "t") : null } : { title: title || null });
    toast(title ? t("renamedToast", { t: title }) : t("titleCleared"));
  } catch (e) { failed(e); }
}
// this device is done with the room on screen: stop following it, forget it, go home
function closeRoom(r) { setRoom(null); leaveDevice(r.code); home(); }
async function leaveRoom() {
  if (!(await confirmSheet(t("leaveTitle"), t("leaveBody") + (room.meta?.priv ? t("leavePw") : ""), t("leave")))) return;
  const r = room;
  r.gone = true; stopRoom(r);
  await r.api.leave({ claim: await ownClaim(backend.uid), count: countAfterLeaving() }).catch(() => {}); // same reason as in askMe; a place frees up
  closeRoom(r);
}
async function endRoom() {
  const a = await sheet(t("endTitle"), el("p", { class: "muted", text: t("endBody") }), [["no", t("cancel")], ["export", t("exportFirst")], ["yes", t("endDel"), "danger"]]);
  if (a === "export") { await exportSheet(); return endRoom(); }
  if (a !== "yes") return;
  const r = room;
  r.gone = true; stopRoom(r);
  try { await r.api.end(); toast(t("endedToast")); } catch (e) { failed(e); }
  closeRoom(r);
}
