/* The quiz library: the question sets a host keeps for quizzes (quiz.js), edited in quizedit.js. They're kept on the
   device, in IndexedDB, where the editor reads and writes them. Signed in with Google (account.js), they're in the
   account too, so they're on every device the host signs in on: each change also goes to the account, and opening the
   library brings the two together (syncPlan, quizset.js), the side that changed a set last winning. A set deleted on
   one device leaves a mark in the account, so the others delete it too.
   In the account: users/{uid}/qz/{id} = { at, t, n } (what the list shows) or { at, gone: true }, and users/{uid}/qzs/{id}
   = the set as JSON, with each picture as { f, w, h }. The picture itself is in R2 at u/{uid}/{f}.jpg (f from its
   SHA-256, so the same picture is kept once), put there through the photo service (worker/) and served from the
   bucket's public address like a photo. Only the account reads its sets, but they aren't end-to-end encrypted, even
   one played in a Private Salon (legal.html says so). The hourly cleanup takes away pictures no set points at. */
import { backend, PHOTOS } from "./backend.js?v=dev";
import { b64u, unb64u } from "./crypto.js?v=dev";
import { QUIZ, LIB, cleanSet, cleanIndex, syncPlan } from "./quizset.js?v=dev";

/* ---------- on the device ---------- */
const DB = "stoatalk", STORE = "quizzes";
let opened = null;
function db() {
  return (opened ||= new Promise((ok, no) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  }).catch((e) => { opened = null; throw e; }));
}
const run = (mode, fn) => db().then((d) => new Promise((ok, no) => {
  const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
  tx.oncomplete = () => ok(req?.result);
  tx.onerror = tx.onabort = () => no(tx.error);
}));
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// a set as kept: { id, at (last changed), t, q }, cleaned on the way out like one from a file
const kept = (x) => { const s = x && typeof x.id === "string" ? cleanSet(x) : null; return s ? { id: x.id, at: +x.at || 0, ...s } : null; };
const here = {
  all: () => run("readonly", (s) => s.getAll()).then((list) => (list || []).map(kept).filter(Boolean)),
  put: (x) => run("readwrite", (s) => s.put({ id: x.id, at: x.at, t: x.t, q: x.q })),
  drop: (id) => run("readwrite", (s) => s.delete(id)),
};
export const library = {
  all: () => here.all().then((list) => list.sort((a, b) => b.at - a.at)),
  put: async (x) => { const y = { id: x.id, at: Date.now(), t: x.t, q: x.q }; await here.put(y); later(y); },
  drop: async (id) => {
    await here.drop(id);
    clearTimeout(timers.get(id));
    if (signedIn()) backend.fb.update(backend.ref(mine()), { [`qz/${id}`]: { at: Date.now(), gone: true }, [`qzs/${id}`]: null }).catch((e) => console.warn("quiz library", e));
  },
  // a new entry for a set from somewhere else (a file, or a quiz played in a room)
  add: async (set) => { const x = { id: newId(), ...cleanSet(set) }; await library.put(x); return x; },
  // true when it changed what's on this device (the list is drawn again)
  sync: () => (syncing ||= bringTogether().catch((e) => { console.warn("quiz library", e); return false; }).finally(() => (syncing = null))),
};
// Signing out, or deleting the account: the sets were the account's, so they go from this device (they stay in the
// account). The database can't be deleted while a page has it open, so it's emptied.
export const forgetLibrary = () => run("readwrite", (s) => s.clear()).catch(() => {});

/* ---------- in the account ---------- */
const signedIn = () => !!(PHOTOS && backend.uid && backend.google);
const mine = () => "users/" + backend.uid;
const sent = new Set(); // pictures already in R2, since the page opened
let syncing = null;
// a set is put in the account a moment after it changes, not at every keystroke in the editor; one that doesn't get
// there (the page closed first, or offline) goes the next time the library opens
const timers = new Map();
function later(x) {
  if (!signedIn()) return;
  clearTimeout(timers.get(x.id));
  timers.set(x.id, setTimeout(() => { timers.delete(x.id); upload(x).catch((e) => console.warn("quiz library", e)); }, 2500));
}
const picId = async (bytes) => b64u(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 22);
async function putPic(f, bytes) {
  if (sent.has(f)) return;
  const res = await fetch(`${PHOTOS.api}/lib/${backend.uid}/${f}.jpg`, {
    method: "PUT", body: bytes, headers: { Authorization: "Bearer " + (await backend.idToken()), "Content-Type": "image/jpeg" },
  });
  if (!res.ok && res.status !== 409) throw new Error("upload " + res.status); // 409: it's there already
  sent.add(f);
}
// a few at a time, so a set with a hundred pictures doesn't open a hundred connections
async function each(list, fn, n = 4) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...(await Promise.all(list.slice(i, i + n).map(fn))));
  return out;
}
async function upload(x) {
  const q = await each(x.q, async ({ img, ...q }) => {
    if (!img) return q;
    const bytes = unb64u(img.d), f = await picId(bytes);
    await putPic(f, bytes);
    return { ...q, img: { f, w: img.w, h: img.h } };
  });
  const body = JSON.stringify({ t: x.t, q });
  if (body.length > LIB.body) throw new Error("set too big for the account");
  await backend.fb.update(backend.ref(mine()), { [`qzs/${x.id}`]: body, [`qz/${x.id}`]: { at: x.at, t: x.t.slice(0, QUIZ.title), n: x.q.length } });
}
// a set from the account, its pictures fetched back into it; null if it can't be had whole (it's tried again next time)
async function download(id, at) {
  const s = await backend.val(backend.ref(`${mine()}/qzs/${id}`), undefined);
  let x;
  try { x = JSON.parse(s); } catch (e) { return null; }
  if (!x || !Array.isArray(x.q)) return null;
  const q = await each(x.q.slice(0, QUIZ.questions), async (q) => {
    if (!q?.img) return q;
    const f = q.img.f;
    if (typeof f !== "string" || !LIB.img.test(f)) return { ...q, img: null };
    const res = await fetch(`${PHOTOS.host}/u/${backend.uid}/${f}.jpg`).catch(() => null);
    if (res?.status === 404) return { ...q, img: null }; // it never got there (the cleanup took it): the question without it
    if (!res?.ok) throw new Error("picture " + (res?.status || "offline"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    sent.add(f);
    return { ...q, img: { d: b64u(bytes), w: q.img.w, h: q.img.h } };
  }).catch((e) => { console.warn("quiz library", e); return null; });
  const set = q && cleanSet({ t: x.t, q });
  return set ? { id, at, ...set } : null;
}
async function bringTogether() {
  if (!signedIn()) return false;
  const got = await backend.val(backend.ref(mine() + "/qz"), undefined);
  if (got === undefined) return false; // offline
  const index = cleanIndex(got), local = await here.all(), byId = new Map(local.map((x) => [x.id, x]));
  const { up, down, drop } = syncPlan(local, index);
  for (const id of drop) await here.drop(id);
  let changed = drop.length > 0;
  for (const id of down) {
    const x = await download(id, index[id].at);
    if (x) { await here.put(x); changed = true; }
  }
  for (const id of up) if (!timers.has(id)) await upload(byId.get(id)).catch((e) => console.warn("quiz library", e));
  return changed;
}
