/* Web Push: notifications while the page is closed (notify.js covers a page that's open, even hidden).
   With notifications allowed, this browser subscribes with the push service (worker/), which seals the subscription
   for this device's id; it's kept in each room this device wants to hear from (rooms/{code}/push/{uid}) and taken out
   when the room is muted or left. After posting, the author's page stamps meta/pa (the rules allow that at most every
   20 seconds) and asks the service to announce the message; a private message is announced only to the person it's
   for. Until the service has its key (VAPID_KEY), none of this does anything. iPhones get pushes only in the app
   added to the home screen. */
import { store, KEYS } from "./storage.js?v=dev";
import { backend, PHOTOS } from "./backend.js?v=dev";
import { unb64u } from "./crypto.js?v=dev";

const API = PHOTOS?.api;
const PAIR_QUIET = 20000;    // a private chat is announced at most this often from this page
const MAX_PAGES = 25;        // the service sends 40 pushes a call: up to 1,000 people
const supported = () => !!API && "PushManager" in window && "serviceWorker" in navigator && "Notification" in window;
export const pushOn = () => supported() && Notification.permission === "granted";

// the service's public key, or null while it has none (asked once per page)
let serviceKey = null;
const keyOf = () => (serviceKey ??= fetch(API + "/push/key").then((r) => (r.ok ? r.json() : null)).then((o) => o?.key || null, () => null));
async function call(path, body) {
  const res = await fetch(API + path, { method: "POST", body: JSON.stringify(body),
    headers: { Authorization: "Bearer " + (await backend.idToken()), "Content-Type": "application/json" } });
  if (!res.ok) throw new Error("push " + res.status);
  return res.json();
}

// this browser's subscription, sealed for this device; kept on the device so entering a room costs no extra call
async function sealedSub() {
  const key = await keyOf();
  if (!key) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) }));
  const kept = store.json(KEYS.push);
  if (kept?.e === sub.endpoint && kept.u === backend.uid && typeof kept.s === "string") return kept.s;
  const { sealed } = await call("/push/seal", sub.toJSON());
  store.set(KEYS.push, JSON.stringify({ e: sub.endpoint, u: backend.uid, s: sealed }));
  return sealed;
}

// on: this device wants pushes from the room (notifications allowed and not muted); off takes its subscription out
export async function syncPush(code, on) {
  const ref = backend.roomRef(code, "push/" + backend.uid);
  try {
    if (!on) return await backend.fb.set(ref, null);
    if (!pushOn()) return;
    const s = await sealedSub();
    if (s) await backend.fb.set(ref, s);
  } catch (e) { console.warn("push", e); }
}

// a message of mine just went out: ask the service to announce it (to: the person a private message is for)
const pairLast = new Map();
export async function announce(code, id, to) {
  if (!API || !(await keyOf())) return;
  try {
    if (to) {
      if (pairLast.get(code + to) > Date.now() - PAIR_QUIET) return;
      pairLast.set(code + to, Date.now());
    } else {
      // denied: someone announced this room moments ago, and that push already says there's something new
      try { await backend.fb.set(backend.roomRef(code, "meta/pa"), backend.stamp()); } catch (e) { return; }
    }
    let from = 0;
    for (let n = 0; n < MAX_PAGES && from != null; n++) ({ next: from } = await call("/push/notify/" + code, { id, ...(to ? { to } : {}), ...(from ? { from } : {}) }));
  } catch (e) { console.warn("push", e); }
}
