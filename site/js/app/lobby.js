/* Opening a room and joining one: with the code, a pasted link, or an encrypted room's invite link. */
import { CODE_CHARS, DAY, LIMITS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { $, el, toast, sheet, busy, enterPressesOk } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend, isDenied } from "./backend.js?v=dev";
import { RoomCipher, deviceKeys, b64u, hashPw, KEY_RE, RAW_KEY_RE } from "./crypto.js?v=dev";
import { room } from "./session.js?v=dev";
import { me, ensureMe, askMe, memberRecord } from "./identity.js?v=dev";
import { nameClaim } from "./room.js?v=dev";
import { enter } from "./chat.js?v=dev";
import { share } from "./menu.js?v=dev";
import { roomPath, showChat, backdrop, forgetRoom, showResume } from "./home.js?v=dev";

export function failed(e) {
  console.error(e);
  if (e?.message === "no-config") toast(t("noDb"));
  else toast(t(navigator.onLine ? "netErr" : "offline"));
}
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join("");
// my member record as I join or open a room
const joining = async (cipher, m) => memberRecord(cipher, backend.uid, m, { joined: backend.stamp(), online: true, pk: (await deviceKeys()).pub });

/* ---------- opening a room ---------- */
export async function create() {
  const m = await ensureMe(); if (!m) return;
  const title = el("input", { class: "field", maxlength: LIMITS.roomTitle, placeholder: t("titlePh"), id: "newTitle" });
  // two kinds: public (the 4-character code is enough) or private, which is always end-to-end encrypted
  let enc = false;
  const seg = el("div", { class: "seg", role: "radiogroup", "aria-label": t("roomType") },
    el("button", { type: "button", role: "radio", "aria-checked": "true", "data-v": "pub", text: t("openStoa") }),
    el("button", { type: "button", role: "radio", "aria-checked": "false", "data-v": "priv", text: t("closedSession") }));
  const pubNote = el("p", { class: "muted small", text: t("pubNote") });
  const encNote = el("div", { class: "encnote", hidden: true }, el("b", { text: t("e2ee") }), el("p", { class: "muted small", text: t("encNote") }));
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    enc = b.dataset.v === "priv";
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pubNote.hidden = enc; encNote.hidden = !enc;
  });
  const body = el("div", {}, el("label", { class: "lbl", for: "newTitle", text: t("roomName") }), title, el("label", { class: "lbl", text: t("roomType") }), seg, pubNote, encNote);
  if (await sheet(t("newRoom"), body, [["no", t("cancel")], ["yes", t("start"), "primary"]]) !== "yes") return;
  busy(true);
  try {
    await backend.connect();
    const raw = enc ? crypto.getRandomValues(new Uint8Array(32)) : null;
    const cipher = raw && (await RoomCipher.fromRaw(raw));
    const name = title.value.trim().slice(0, LIMITS.roomTitle), uid = backend.uid, T = backend.stamp();
    for (let i = 0; i < 30; i++) {
      const code = newCode();
      const meta = { owner: uid, created: T, last: T, priv: false };
      if (cipher) { meta.enc = true; meta.kc = await cipher.keyCheck(); if (name) meta.xt = await cipher.seal({ t: name }, "t"); }
      else if (name) meta.title = name;
      try {
        await backend.update({ [`rooms/${code}`]: { meta, members: { [uid]: await joining(cipher, m) }, names: { [await nameClaim(cipher, m.name)]: uid } } });
      } catch (e) { if (isDenied(e)) continue; throw e; } // code in use: draw another
      if (raw) store.set(KEYS.roomKey(code), b64u(raw));
      backend.stat(cipher ? "salons" : "rooms");
      await enter(code, cipher);
      share();
      return;
    }
    toast(t("createFail"));
  } catch (e) { failed(e); } finally { busy(false); }
}

/* ---------- joining ---------- */
// a pasted link works as well as the code
const cleanCode = (c) => {
  c = String(c || "");
  c = c.match(/[?&]room=([0-9A-Za-z]{4})/)?.[1] || c.replace(/#.*/, "");
  return c.toUpperCase().replace(/[^0-9A-Z]/g, "");
};
// a question on the way in: the spinner steps aside while it's asked
async function asking(fn, withBackdrop = true) {
  busy(false); if (withBackdrop) backdrop();
  try { return await fn(); } finally { busy(true); }
}
export async function join(raw) {
  const code = cleanCode(raw);
  if (code.length !== 4) { toast(t("code4")); return; }
  const linkKey = String(raw || "").match(KEY_RE)?.[1];
  if (linkKey) store.set(KEYS.roomKey(code), linkKey); // a pasted invite link of an encrypted room
  if (room?.code === code && !room.gone) { roomPath(code); showChat(); return; }
  busy(true);
  try {
    await backend.connect();
    const ref = (path) => backend.roomRef(code, path), uid = backend.uid;
    const meta = (await backend.fb.get(ref("meta"))).val();
    if (!meta || meta.last < backend.now() - DAY) {
      toast(t("notFound"));
      if (meta) backend.update({ [`rooms/${code}`]: null, [`secrets/${code}`]: null }).catch(() => {}); // expired: clear it out
      store.set(KEYS.roomKey(code), null);
      forgetRoom(code); if (!$("#home").hidden) showResume();
      return;
    }
    const cipher = await unlock(code, meta);
    if (cipher === false) return;
    // already inside (coming back)?
    if (await backend.val(ref("members/" + uid))) { await enter(code, cipher); return; }
    if (await backend.val(ref("banned/" + uid))) { toast(t("bannedToast")); return; }
    if (meta.locked) { toast(t("lockedToast")); return; }
    if (meta.cap && (meta.n || 0) >= meta.cap) { toast(t("capFull")); return; }
    let m = await asking(ensureMe, !me());
    if (!m) return;
    let key = null;
    if (meta.priv) { // an old password room
      const pw = await asking(() => askPassword(meta, code));
      if (pw == null) return;
      key = await hashPw(code, pw);
    }
    for (let tries = 0; ; tries++) {
      const k = await nameClaim(cipher, m.name);
      const holder = await backend.val(ref("names/" + k));
      const at = (path) => `rooms/${code}/${path}`;
      const upd = { [at(`members/${uid}`)]: await joining(cipher, m), [at(`names/${k}`)]: uid, [at("meta/last")]: backend.stamp() };
      if (key) upd[at(`keys/${uid}`)] = key;
      // a room with a size limit counts its members: joining adds one (and fails, to try again, if someone got in first)
      if (meta.cap) {
        const counted = await backend.val(ref("meta/n"));
        if (typeof counted === "number" && counted >= meta.cap) { toast(t("capFull")); return; }
        upd[at("meta/n")] = (counted || 0) + 1;
      }
      try { await backend.update(upd); backend.stat("joins"); break; }
      catch (e) {
        if (!isDenied(e)) throw e;
        const taken = holder && holder !== uid; // someone here already goes by this name
        if (meta.cap && tries < 3 && !taken) continue;
        if (!taken) { toast(t(meta.priv ? "wrongPw" : "cantJoin")); return; }
        m = await asking(() => askMe(false, t("nameTakenJoin", { name: m.name }), false));
        if (!m) return;
      }
    }
    await enter(code, cipher);
  } catch (e) { failed(e); } finally { busy(false); }
}
function askPassword(meta, code) {
  const input = enterPressesOk(el("input", { class: "field", maxlength: 40, type: "password", id: "joinPw", autocomplete: "off", "aria-label": t("pwAria") }));
  const body = el("div", {}, el("p", { class: "muted", text: t("pwBody", { title: meta.title || code }) }), input);
  return sheet(t("pwTitle"), body, [["no", t("cancel")], ["yes", t("join"), "primary"]], { onOpen: () => input.focus() }).then((a) => (a === "yes" && input.value.trim() ? input.value.trim() : null));
}
// the room's key if this device has the right one, asking for the invite link when it doesn't; false if they give up
async function unlock(code, meta) {
  if (!meta.enc) return null;
  let note = "";
  for (;;) {
    const raw = store.get(KEYS.roomKey(code));
    if (raw) {
      try { const c = await RoomCipher.fromLink(raw); if ((await c.keyCheck()) === meta.kc) return c; } catch (e) {}
      store.set(KEYS.roomKey(code), null);
      note = t("badLink");
    }
    const k = await asking(() => askLink(code, note));
    if (!k) return false;
    store.set(KEYS.roomKey(code), k);
  }
}
function askLink(code, note) {
  const input = enterPressesOk(el("input", { class: "field", id: "joinLink", autocomplete: "off", placeholder: t("linkPh"), "aria-label": t("linkAria") }));
  const body = el("div", {}, el("p", { class: "note warn", hidden: !note, text: note }), el("p", { class: "muted", text: t("needLink", { code }) }), input);
  return sheet(t("needLinkTitle"), body, [["no", t("cancel")], ["yes", t("join"), "primary"]], { onOpen: () => input.focus() })
    .then((a) => (a === "yes" ? input.value.match(KEY_RE)?.[1] || (RAW_KEY_RE.test(input.value.trim()) ? input.value.trim() : "") : null))
    .then((k) => (k === "" ? askLink(code, t("notFullLink")) : k));
}
