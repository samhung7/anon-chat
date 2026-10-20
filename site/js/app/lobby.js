/* Opening a room and joining one: with the code, a pasted link, or an encrypted room's invite link. */
import { CODE_CHARS, LIMITS, CONNECT_MS } from "./constants.js?v=dev";
import { phase } from "./expiry.js?v=dev";
import { t } from "./text.js?v=dev";
import { $, el, toast, sheet, busy, enterPressesOk, icon, bare } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend, isDenied, isBusy, within } from "./backend.js?v=dev";
import { RoomCipher, deviceKeys, b64u, KEY_RE, RAW_KEY_RE } from "./crypto.js?v=dev";
import { room } from "./session.js?v=dev";
import { me, ensureMe, askMe, memberRecord, meFields, saveMe } from "./identity.js?v=dev";
import { nameClaim } from "./room.js?v=dev";
import { enter } from "./chat.js?v=dev";
import { share } from "./menu.js?v=dev";
import { roomPath, showChat, backdrop, forgetRoom, showResume } from "./home.js?v=dev";

export function failed(e) {
  console.error(e);
  if (e?.message === "no-config") toast(t("noDb"));
  else if (!navigator.onLine) toast(t("offline"));
  else toast(t(isBusy(e) ? "serverBusy" : "netErr"));
}
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join("");
// my member record as I join or open a room
const joining = async (cipher, m) => memberRecord(cipher, backend.uid, m, { joined: backend.stamp(), online: true, pk: (await deviceKeys()).pub });

/* ---------- opening a room ---------- */
export async function create() {
  const title = el("input", { class: "field", maxlength: LIMITS.roomTitle, placeholder: t("titlePh"), id: "newTitle" });
  // two kinds: public (the 4-character code is enough) or private, which is always end-to-end encrypted. They differ in
  // four ways at once (icon, icon tile, the slate rule along the top, the encryption badge), never by colour alone
  let enc = false;
  const kind = (v, cls, ic, name, sub, on) => el("button", { type: "button", class: "kind " + cls, role: "radio", "aria-checked": String(on), "data-v": v },
    el("span", { class: "kh" }, el("span", { class: "ic" }, icon(ic)), el("span", { class: "mark" }, icon("check", "sm"))),
    el("b", { text: bare(t(name)) }), sub);
  const seg = el("div", { class: "seg kinds", role: "radiogroup", "aria-label": t("roomType") },
    kind("pub", "stoa", "stoa", "openStoa", el("span", { class: "ds", text: t("pubNote") }), true),
    kind("priv", "salon", "salon", "closedSession", el("span", { class: "kbadge" }, icon("secure", "sm"), bare(t("e2ee"))), false));
  const encNote = el("div", { class: "encnote", hidden: true }, icon("secure"), el("span", { text: t("encNote") }));
  // who I am in the room, asked here rather than in a sheet of its own
  const f = meFields();
  const body = el("div", { class: "form" },
    el("div", { class: "grp" }, el("label", { class: "lbl", for: "newTitle", text: t("roomName") }), title),
    el("div", { class: "grp" }, el("span", { class: "lbl", text: t("roomType") }), seg, encNote),
    el("div", { class: "grp" }, el("h3", { text: t("meFirst") }), el("p", { class: "hint", text: t("meHint") }), f.grid,
      el("label", { class: "lbl", for: "meName", text: t("nickname") }), f.input));
  const go = await sheet(t("newRoom"), body, [["no", t("cancel")], ["yes", t("start"), "primary"]], { onOpen: (ov) => {
    const start = ov.querySelector("[data-a=yes]");
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      enc = b.dataset.v === "priv";
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      encNote.hidden = !enc; start.classList.toggle("primary", !enc); start.classList.toggle("salon", enc);
    });
  } });
  if (go !== "yes") return;
  const m = saveMe(f.value());
  busy(true);
  try {
    await within(backend.connect(), CONNECT_MS);
    const raw = enc ? crypto.getRandomValues(new Uint8Array(32)) : null;
    const cipher = raw && (await RoomCipher.fromRaw(raw));
    const name = title.value.trim().slice(0, LIMITS.roomTitle), uid = backend.uid, T = backend.stamp();
    if (await backend.val(backend.ref("bans/" + uid))) { toast(t("bannedAll")); return; }
    for (let i = 0; i < 30; i++) {
      const code = newCode();
      const meta = { owner: uid, created: T, last: T };
      if (cipher) { meta.enc = true; meta.kc = await cipher.keyCheck(); if (name) meta.xt = await cipher.seal({ t: name }, "t"); }
      else if (name) meta.title = name;
      try {
        await within(backend.update({ [`rooms/${code}`]: { meta, members: { [uid]: await joining(cipher, m) }, names: { [await nameClaim(cipher, m.name)]: uid } } }), CONNECT_MS);
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
export const cleanCode = (c) => {
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
    await within(backend.connect(), CONNECT_MS);
    const ref = (path) => backend.roomRef(code, path), uid = backend.uid;
    // the three answers a join needs, asked together rather than one after another
    const [metaSnap, inside, banned, bannedAll] = await within(Promise.all([backend.fb.get(ref("meta")), backend.val(ref("members/" + uid)),
      backend.val(ref("banned/" + uid)), backend.val(backend.ref("bans/" + uid))]), CONNECT_MS);
    const meta = metaSnap.val(), state = meta && phase(meta.last, backend.now()).state;
    if (!meta || state === "gone") {
      toast(t("notFound"));
      if (meta) backend.update({ [`rooms/${code}`]: null }).catch(() => {}); // expired: clear it out
      store.set(KEYS.roomKey(code), null);
      forgetRoom(code); if (!$("#home").hidden) showResume();
      return;
    }
    const cipher = await unlock(code, meta);
    if (cipher === false) return;
    // already inside (coming back)?
    if (inside) { await enter(code, cipher); return; }
    if (state === "ro") { toast(t("roNoJoin")); return; } // read-only: still open to its members, nobody new
    if (bannedAll) { toast(t("bannedAll")); return; }
    if (banned) { toast(t("bannedToast")); return; }
    if (meta.locked) { toast(t("lockedToast")); return; }
    if (meta.cap && (meta.n || 0) >= meta.cap) { toast(t("capFull")); return; }
    let m = await asking(ensureMe, !me());
    if (!m) return;
    for (let tries = 0; ; tries++) {
      const k = await nameClaim(cipher, m.name);
      const holder = await backend.val(ref("names/" + k));
      const at = (path) => `rooms/${code}/${path}`;
      const upd = { [at(`members/${uid}`)]: await joining(cipher, m), [at(`names/${k}`)]: uid, [at("meta/last")]: backend.stamp() };
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
        if (!taken) { toast(t("cantJoin")); return; }
        m = await asking(() => askMe(false, t("nameTakenJoin", { name: m.name }), false));
        if (!m) return;
      }
    }
    await enter(code, cipher);
  } catch (e) {
    failed(e);
    if (isBusy(e)) $("#joinCode").value = code; // one tap to try again, even when they came by a link
  } finally { busy(false); }
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
  return sheet(bare(t("needLinkTitle")), body, [["no", t("cancel")], ["yes", t("join"), "primary"]], { onOpen: () => input.focus() })
    .then((a) => (a === "yes" ? input.value.match(KEY_RE)?.[1] || (RAW_KEY_RE.test(input.value.trim()) ? input.value.trim() : "") : null))
    .then((k) => (k === "" ? askLink(code, t("notFullLink")) : k));
}
