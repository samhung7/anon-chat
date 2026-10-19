/* Notifications: a system notification for each new message while the page is in the background. Each room can
   be muted on this device (chat-mute:{code}). It works while the page is open in a tab or an installed app, even
   hidden. Where Web Push works (push.js) a hidden page leaves it to the push, which also reaches a page the phone has
   stopped running. */
import { APP, FRESH_MS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { $, toast } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { kindOf, snippet } from "./kinds.js?v=dev";
import { mentionsMe } from "./richtext.js?v=dev";
import { isBlocked } from "./blocking.js?v=dev";
import { markSeen } from "./chat.js?v=dev";
import { roomUrl } from "./home.js?v=dev";
import { syncPush, pushCovers } from "./push.js?v=dev";

const CAN_NOTIFY = "Notification" in window;
const granted = () => CAN_NOTIFY && Notification.permission === "granted";
export const notifyOn = (code) => granted() && !store.get(KEYS.mute(code));
// messages that came while the page was hidden, counted in the tab's title
let hidden = 0;
export const hiddenUnread = () => hidden;

// a message arrived (dmWith: in a private chat with them)
export function noteNew(v, dmWith) {
  if (v.by === backend.uid || !room.ready || isBlocked(v.by)) return;
  const fresh = v.at > room.t0 && Date.now() - v.at < FRESH_MS; // not the history that loads on entering
  const atMe = !dmWith && mentionsMe(v.text);
  if (atMe && fresh && !document.hidden && room.ui.view !== "all") toast(t("mentionToast", { who: room.author(v).name }));
  if (!document.hidden) return;
  hidden++;
  document.title = `(${hidden}) ${room.meta?.title || APP}`;
  if (fresh) notify(v, dmWith, atMe);
}
// atMe: someone @mentioned me, which notifies even in a room I muted
async function notify(v, dmWith, atMe) {
  if (!notifyOn(room.code) && !(atMe && granted())) return;
  if (notifyOn(room.code) && pushCovers()) return; // a hidden page is offline, so a push tells about it instead
  const a = room.author(v, dmWith);
  const title = dmWith ? t("dmToast", { who: a.name }) : atMe ? t("mentionToast", { who: `${a.avatar} ${a.name}` }) : `${a.avatar} ${a.name} | ${room.meta?.title || t("roomN", { code: room.code })}`;
  const body = dmWith ? t("openToRead") : kindOf(v).notice?.(v) || snippet(v);
  const opts = { body, tag: "room-" + room.code, renotify: true, icon: "icons/stoa2-192.png", data: { url: roomUrl(room.code) } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts); // phones only show notifications through the service worker
    const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { console.warn(e); }
}
export async function setNotify(on) {
  if (!room) return;
  $("#notifyBar").hidden = true;
  store.set(KEYS.notifyAsked, "1");
  if (!on) { store.set(KEYS.mute(room.code), "1"); syncPush(room.code, false); toast(t("mutedToast")); return; }
  if (!CAN_NOTIFY) { toast(t("noNotify")); return; }
  const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (p !== "granted") { toast(t("notifyBlocked")); return; }
  store.set(KEYS.mute(room.code), null); syncPush(room.code, true); toast(t("notifyOnToast"));
}
// ask once per device, in a bar rather than a pop-up, and only where notifications could work
export const offerNotify = () => { $("#notifyBar").hidden = !(CAN_NOTIFY && Notification.permission === "default" && !store.get(KEYS.notifyAsked)); };
export function watchVisibility() {
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { hidden = 0; document.title = room?.meta?.title || APP; markSeen(); } });
}
