/* Who I am: a nickname and an animal, kept on this device. Nicknames are unique per room, compared without case. */
import { LIMITS, ANIMALS } from "./constants.js?v=dev";
import { t, avatars, colourNick, COLOURS } from "./text.js?v=dev";
import { $, el, sheet, enterPressesOk, avatar, icon } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { nameClaim, nameKey } from "./room.js?v=dev";

export const me = () => { const m = store.json(KEYS.me); return m && m.name ? m : null; };
// Firebase keys can't hold . # $ [ ] /
export const cleanName = (n) => String(n || "").replace(/[.#$[\]/]/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.name);
// a member record as stored: plain, or sealed in an encrypted room
export async function memberRecord(cipher, id, m, extra) {
  return cipher ? { x: await cipher.seal({ n: m.name, a: m.avatar }, "u:" + id), h: await nameClaim(cipher, m.name), ...extra } : { name: m.name, avatar: m.avatar, ...extra };
}
// a nickname made up on the spot: a random colour on a random animal, one nobody in the room on screen goes by
export function rollMe() {
  const others = new Set(room && !room.gone ? Object.entries(room.members).filter(([id]) => id !== backend.uid).map(([, x]) => nameKey(String(x.name))) : []);
  for (let tries = 0; ; tries++) {
    const i = (Math.random() * ANIMALS.length) | 0, col = (Math.random() * COLOURS) | 0, name = colourNick(col, i);
    if (!others.has(nameKey(name)) || tries > 30) return { avatar: ANIMALS[i], name, col, auto: true };
  }
}

// the animals to pick from and the nickname, as in the identity sheet and the new-room sheet; until the person types a
// nickname of their own, it follows the animal they pick (with the same colour, for a made-up one). 🎲 makes one up.
export function meFields() {
  const cur = me() || rollMe();
  let pick = cur.avatar, col = cur.col ?? null, auto = !!cur.auto || col !== null;
  const named = () => { const i = ANIMALS.indexOf(pick); return i < 0 ? avatars()[0][1] : col === null ? t("av" + i) : colourNick(col, i); };
  const input = enterPressesOk(el("input", { class: "field", maxlength: LIMITS.name, autocomplete: "off", id: "meName", "aria-label": t("nickname") }));
  input.value = cur.name;
  input.addEventListener("input", () => (auto = false));
  const mark = () => grid.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.a === pick)));
  const grid = el("div", { class: "avpick" }, avatars().map(([a, n]) => el("button", {
    type: "button", "aria-label": n, "aria-pressed": String(a === pick), "data-a": a,
    onclick: () => { pick = a; mark(); if (auto) input.value = named(); },
  }, avatar(a))));
  const roll = el("button", { type: "button", class: "btn roll", "aria-label": t("rollNickAria"), title: t("rollNickAria"),
    onclick: () => { const r = rollMe(); pick = r.avatar; col = r.col; auto = true; input.value = r.name; mark(); } },
  icon("dice"), el("span", { text: t("rollNick") }));
  const row = el("div", { class: "nickrow" }, input, roll);
  return { grid, input, row, value: () => ({ avatar: pick, name: cleanName(input.value) || named(), ...(auto && col !== null ? { col } : {}) }) };
}
export function saveMe(m) { store.set(KEYS.me, JSON.stringify(m)); showMe(); return m; }
// inRoom: also rename in the room we're in (fails, and asks again, if someone there has that name)
export async function askMe(firstTime, note = "", inRoom = !firstTime) {
  const f = meFields(), input = f.input;
  const warn = el("p", { class: "note warn", hidden: !note, text: note });
  const body = el("div", {}, warn, el("p", { class: "muted", text: t("meHint") }), f.grid, el("label", { class: "lbl", for: "meName", text: t("nickname") }), f.row);
  for (;;) {
    const a = await sheet(t(firstTime ? "meFirst" : note ? "meRetry" : "meEdit"), body, [["no", t("cancel")], ["yes", t("ok"), "primary"]], { onOpen: () => (firstTime || note) && input.select() });
    if (a !== "yes") return null;
    const m = f.value();
    if (inRoom && room && !room.gone && room.members[backend.uid]) {
      const err = await renameInRoom(m);
      if (err) { warn.textContent = err; warn.hidden = false; input.value = m.name; continue; }
    }
    return saveMe(m);
  }
}
// take the new name in the room on screen; the reason it failed, or null
async function renameInRoom(m) {
  const uid = backend.uid, api = room.api;
  const oldK = room.claimOf(uid), newK = await nameClaim(room.cipher, m.name);
  // give the old name back only if it's ours: in a room from before unique names, or with a
  // duplicate left over from then, someone else may hold it, and releasing it would fail the whole rename
  const release = oldK && oldK !== newK && (await api.holderOf(oldK)) === uid;
  try { await api.rename(await memberRecord(room.cipher, uid, m, {}), newK, release ? oldK : null); return null; }
  catch (e) {
    const holder = await api.holderOf(newK);
    return holder && holder !== uid ? t("nameTaken", { name: m.name }) : t("renameFail");
  }
}
export const ensureMe = async () => me() || (await askMe(true));
export function showMe() {
  const m = me();
  $("#meBtn .av").replaceChildren(m ? avatar(m.avatar) : icon("user"));
}
