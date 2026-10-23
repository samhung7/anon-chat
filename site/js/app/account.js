/* Signing in with Google, which nobody has to do: it keeps the same anonymous id on every device someone signs in
   on, so the rooms they host and are in follow them from computer to tablet to phone. Nobody in a room sees the
   Google account; rooms know the id, a nickname and an animal, as before. StoaTalk's operator can tie the id to the
   account (Firebase Authentication keeps its email, name and picture), and the privacy policy says so.
   Signing in ties the Google account to this device's id, which stays the same (the rooms it's in carry on), unless
   the account already has an id from another device: then this device takes that one, and is no longer in the rooms
   it was in under the old one.
   What the account keeps, in users/{uid}: the rooms it's in, and the public key its private messages are sealed to
   (the first device's: crypto.js). Never a Private Salon's key or the private half of that key, which stay on
   devices: the server mustn't be able to read what's end-to-end encrypted.
   With the emulator, a made-up Google account (KEYS.emuPick, else someone@example.com) stands in, and its id is kept
   where Google would keep it, in the emulator's database (emu-accounts/). */
import { t } from "./text.js?v=dev";
import { $, el, toast, sheet, confirmSheet, icon } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend, EMU } from "./backend.js?v=dev";
import { params } from "./constants.js?v=dev";
import { deviceKeys, setAccountPub } from "./crypto.js?v=dev";
import { deviceId } from "./push.js?v=dev";

// the Google account this device is signed in with ({ email, name }), or null; known before connecting from what the
// device kept, and for sure once connected
export function account() {
  if (backend.uid) return backend.google;
  const kept = store.json(KEYS.account);
  return kept?.e ? { email: kept.e, name: "" } : null;
}
let cloudRooms = {};   // users/{uid}/rooms as it was on signing in: code → when last entered
export const accountRooms = () => cloudRooms;

/* ---------- once signed in ---------- */
backend.signedIn.push(async () => {
  const kept = store.json(KEYS.account);
  if (!backend.google) { // signed out, or the account deleted, on another device: this one isn't theirs any more
    setAccountPub(null);
    if (kept) await forgetDevice(false);
    return;
  }
  setAccountPub(kept?.u === backend.uid ? kept.pk : null); // what was known last time, until the server says
  const u = await backend.val(backend.ref("users/" + backend.uid), undefined);
  if (u === undefined) return; // offline
  let pk = typeof u?.dh === "string" ? u.dh : null;
  if (!pk) { // the account's first device: its key pair is the account's
    pk = (await deviceKeys()).pub;
    await backend.fb.set(backend.ref(`users/${backend.uid}/dh`), pk).catch(() => {});
  }
  setAccountPub(pk);
  cloudRooms = u?.rooms && typeof u.rooms === "object" ? u.rooms : {};
  store.set(KEYS.account, JSON.stringify({ e: backend.google.email, u: backend.uid, pk }));
});
// the rooms list follows the account: home.js calls these as rooms come and go
export function keepRoom(code) {
  if (!backend.google) return;
  cloudRooms[code] = Date.now();
  backend.fb.set(backend.ref(`users/${backend.uid}/rooms/${code}`), backend.stamp()).catch(() => {});
}
export function dropRoom(code) {
  if (!backend.google || !(code in cloudRooms)) return;
  delete cloudRooms[code];
  backend.fb.set(backend.ref(`users/${backend.uid}/rooms/${code}`), null).catch(() => {});
}

/* ---------- this device stops being theirs ----------
   Signing out or deleting the account: what this device kept for the person goes (the rooms they're in, Private
   Salons' keys, their private messages' key pair, where they read up to, their push subscription), so the next person
   at this device finds none of it. Nickname, language, theme, quick replies and saved records stay. */
// stillIn: still signed in as them, so this device's subscriptions can come out of their rooms
async function forgetDevice(stillIn = true) {
  const codes = store.json(KEYS.rooms) || [];
  if (stillIn) await Promise.all(codes.map((c) => backend.fb.set(backend.roomRef(c, `push/${backend.uid}/${deviceId()}`), null).catch(() => {})));
  try { await (await (await navigator.serviceWorker?.getRegistration())?.pushManager.getSubscription())?.unsubscribe(); } catch (e) {}
  [KEYS.rooms, KEYS.roomsSeen, KEYS.push, KEYS.dh, KEYS.account, KEYS.blocked].forEach((k) => store.set(k, null));
  store.drop(["chat-key:", "chat-read:", "chat-dmread:", "chat-myq:", "chat-mute:", "chat-desc-hidden:", "chat-post-draft:", "chat-game:"]);
}
const emuKey = (email) => "emu-accounts/" + email.replace(/[.#$[\]/]/g, "_");
// the page starts over under its new id
const restart = () => location.reload();

/* ---------- signing in ---------- */
// Called straight from the tap, so the browser lets the pop-up open
function signIn() {
  return (EMU ? emuSignIn() : googleSignIn()).catch((e) => {
    console.warn("sign-in", e);
    toast(t(e?.code === "auth/popup-blocked" ? "acctPopup" : "acctFail"));
  });
}
async function googleSignIn() {
  const { fb } = backend, provider = new fb.GoogleAuthProvider();
  try {
    signedAs((await fb.linkWithPopup(backend.user, provider, fb.browserPopupRedirectResolver)).user.email);
    await backend.user.getIdToken(true); // the rules want the account's email in the token
  } catch (e) {
    if (e?.code === "auth/popup-closed-by-user" || e?.code === "auth/cancelled-popup-request") return;
    if (e?.code !== "auth/credential-already-in-use") throw e;
    const cred = fb.GoogleAuthProvider.credentialFromError(e);
    if (!cred || !(await switchOk())) return;
    await forgetDevice();
    signedAs((await fb.signInWithCredential(backend.auth, cred)).user.email);
  }
  restart();
}
async function emuSignIn() {
  const email = store.get(KEYS.emuPick) || "someone@example.com", as = params.get("as");
  const theirs = await backend.emuOwner(emuKey(email));
  if (theirs && theirs !== backend.uid) {
    if (!(await switchOk())) return;
    await forgetDevice();
    store.set(KEYS.emuUid(as), theirs);
  } else await backend.emuOwner(emuKey(email), "PUT", backend.uid);
  store.set(KEYS.emuGoogle(as), email);
  signedAs(email);
  restart();
}
// so the home page, before it connects, knows to look for the account's rooms
const signedAs = (email) => store.set(KEYS.account, JSON.stringify({ e: email || "" }));
const switchOk = () => confirmSheet(t("acctSwitchTitle"), t("acctSwitchBody"), t("acctSwitch"), "primary");

/* ---------- signing out, and deleting the account ---------- */
async function signOut() {
  if (!(await confirmSheet(t("acctOutTitle"), t("acctOutBody"), t("acctSignOut")))) return;
  await forgetDevice();
  if (EMU) { const as = params.get("as"); store.set(KEYS.emuGoogle(as), null); store.set(KEYS.emuUid(as), null); }
  else await backend.fb.signOut(backend.auth);
  restart();
}
// The account and what it keeps go at once: users/{uid}, then the account itself (Firebase wants a recent sign-in
// for that, so it may ask for Google once more). A banned account's hash stays a year (tools/cleanup/accounts.mjs).
async function deleteAccount() {
  if (!(await confirmSheet(t("acctDelTitle"), t("acctDelBody"), t("acctDelete")))) return;
  try {
    await backend.fb.set(backend.ref("users/" + backend.uid), null);
    if (EMU) await backend.emuOwner(emuKey(backend.google.email), "DELETE");
    else {
      try { await backend.fb.deleteUser(backend.user); }
      catch (e) {
        if (e?.code !== "auth/requires-recent-login") throw e;
        if (!(await reauth())) return;
        await backend.fb.deleteUser(backend.user);
      }
    }
  } catch (e) { console.warn("delete account", e); toast(t("tryAgain")); return; }
  await forgetDevice();
  if (EMU) { const as = params.get("as"); store.set(KEYS.emuGoogle(as), null); store.set(KEYS.emuUid(as), null); }
  else await backend.fb.signOut(backend.auth).catch(() => {});
  toast(t("acctDeleted"));
  setTimeout(restart, 1500);
}
// Google once more, from a tap of its own (a pop-up needs one); true once done
function reauth() {
  return new Promise((done) => {
    const btn = el("button", { type: "button", class: "btn primary wide" }, icon("user"), el("span", { text: t("acctSignIn") }));
    sheet(t("acctAgainTitle"), el("div", {}, el("p", { class: "muted", text: t("acctAgainBody") }), btn), [["no", t("cancel")]], {
      onOpen: (ov) => btn.addEventListener("click", () => {
        backend.fb.reauthenticateWithPopup(backend.user, new backend.fb.GoogleAuthProvider(), backend.fb.browserPopupRedirectResolver)
          .then(() => { ov.close("ok"); done(true); }, (e) => { console.warn("reauth", e); ov.close("no"); done(false); });
      }),
    }).then((a) => a !== "ok" && done(false));
  });
}

/* ---------- the sheet, from the home page's ☰ menu ---------- */
export async function accountSheet() {
  try { await backend.connect(); } catch (e) { toast(t("tryAgain")); return; }
  const g = backend.google;
  const legal = el("a", { href: "legal.html#account", target: "_blank", rel: "noopener", text: t("acctTerms") });
  if (g) {
    const body = el("div", { class: "acct" },
      el("p", {}, el("b", { text: t("acctSignedAs", { e: g.email }) })),
      el("p", { class: "muted", text: t("acctSyncs") }),
      el("p", { class: "muted small", text: t("acctKeys") }),
      el("p", { class: "small" }, legal));
    const a = await sheet(t("acctTitleIn"), body, [["close", t("close")], ["out", t("acctSignOut")], ["del", t("acctDelete"), "danger"]]);
    if (a === "out") signOut();
    else if (a === "del") deleteAccount();
    return;
  }
  const btn = el("button", { type: "button", class: "btn primary wide", "data-signin": "" }, icon("user"), el("span", { text: t("acctSignIn") }));
  const body = el("div", { class: "acct" },
    el("p", { text: t("acctWhy") }),
    el("p", { class: "muted", text: t("acctPrivacy") }),
    el("p", { class: "muted small", text: t("acctKeys") }),
    el("p", { class: "small" }, legal),
    btn);
  sheet(t("acctTitle"), body, [["close", t("close")]], {
    onOpen: (ov) => btn.addEventListener("click", () => { ov.close(null); signIn(); }),
  });
}
