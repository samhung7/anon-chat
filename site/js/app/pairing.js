/* Pairing a device: someone signed in with Google on a second device brings over, from the first, what end-to-end
   encryption keeps off the server: their private messages' key pair (crypto.js) and their Private Salons' keys.
   The new device makes a one-off key pair, puts its public half in users/{uid}/pair/{id}, and shows it as a QR Code.
   The paired device scans that (scan.js), or opens it as a link with the phone's camera (?pair=), checks the account
   is waiting for that very key, and seals its keys to it (ECDH with a one-off pair of its own, then AES-GCM) in
   pair/{id}/box. The new device opens the box, keeps the keys, and deletes the lot. The server only ever holds public
   keys and ciphertext; what makes the box the right device's is the code itself, read off its screen. */
import { t } from "./text.js?v=dev";
import { el, toast, sheet, confirmSheet, qrSvg } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { b64u, seal, unseal, oneOff, deviceKeysKept, adoptDeviceKeys, publicKey, paired, RAW_KEY_RE } from "./crypto.js?v=dev";
import { scanFor } from "./scan.js?v=dev";

const CODE = /^[2-9A-HJKMNP-Z]{4}$/;
const info = (id) => "stoatalk pair " + id;
const path = (id) => `users/${backend.uid}/pair/${id}`;
// what the code says: this site with ?pair={id}.{the new device's one-off public key}
const pairLink = (id, pub) => `${location.origin}${location.pathname}?pair=${id}.${pub}`;
export function readPair(text) {
  let u;
  try { u = new URL(String(text || "").trim()); } catch { return null; }
  const m = /^([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{87})$/.exec(u.searchParams.get("pair") || "");
  return m ? { id: m[1], pub: m[2] } : null;
}

/* ---------- on the new device ---------- */
export async function showPairCode() {
  const me = await oneOff(), id = b64u(crypto.getRandomValues(new Uint8Array(9))), ref = backend.ref(path(id));
  try { await backend.fb.set(ref, { pk: me.pub, at: backend.stamp() }); } catch (e) { toast(t("tryAgain")); return; }
  const qr = el("div", { class: "qr pairqr", "aria-label": "QR Code", "data-pair": pairLink(id, me.pub) });
  qr.innerHTML = qrSvg(pairLink(id, me.pub), 4);
  const note = el("p", { class: "muted small", text: t("acctPairWait") });
  let off = null, busy = false;
  const a = await sheet(t("acctPairTitle"), el("div", { class: "acct" }, el("p", { text: t("acctPairHow") }), qr, note), [["close", t("close")]], {
    onOpen: (ov) => (off = backend.fb.onValue(backend.ref(path(id) + "/box"), async (s) => {
      const box = s.val();
      if (!box || busy) return;
      busy = true;
      try { await take(id, me, box); ov.close("ok"); } catch (e) { console.warn("pairing", e); note.textContent = t("acctPairFail"); }
    })),
  });
  off?.();
  backend.fb.set(ref, null).catch(() => {});
  if (a === "ok") { toast(t("acctPairDone")); setTimeout(() => location.reload(), 1200); }
}
// the box's keys, kept here: the key pair only if it's the account's, a Salon's key only where this device has none
async function take(id, me, box) {
  const got = await unseal(await me.shared(box.pk, info(id)), box.x, info(id));
  if (!got?.dh || got.dh.pub !== (await publicKey())) throw new Error("not the account's key pair");
  await adoptDeviceKeys(got.dh);
  for (const [code, k] of Object.entries(got.keys || {}))
    if (CODE.test(code) && typeof k === "string" && RAW_KEY_RE.test(k) && !store.get(KEYS.roomKey(code))) store.set(KEYS.roomKey(code), k);
}

/* ---------- on the paired device ---------- */
export async function scanPairCode() {
  const got = await scanFor(readPair, { title: "acctScanPair", hint: "acctPairScanHint", wrong: "acctPairBad" });
  if (got) await sendKeys(got);
}
// also from a pairing code opened as a link (main.js)
export async function sendKeys({ id, pub }) {
  if (!backend.google) return toast(t("acctPairBad"));
  if (!(await paired())) return toast(t("acctPairUnpaired"));
  const waiting = await backend.val(backend.ref(path(id)), undefined);
  if (waiting === undefined) return toast(t("tryAgain"));
  if (waiting?.pk !== pub || waiting.box) return toast(t("acctPairBad")); // not this account's, or done already
  const keys = Object.fromEntries(Object.entries(store.under(KEYS.roomKey(""))).filter(([c, k]) => CODE.test(c) && RAW_KEY_RE.test(k || "")));
  if (!(await confirmSheet(t("acctPairSendTitle"), t("acctPairSendBody", { n: Object.keys(keys).length }), t("acctPairSend"), "primary"))) return;
  try {
    const me = await oneOff();
    const x = await seal(await me.shared(pub, info(id)), { dh: await deviceKeysKept(), keys }, info(id));
    await backend.fb.set(backend.ref(path(id) + "/box"), { pk: me.pub, x });
    toast(t("acctPairSent"));
  } catch (e) { console.warn("pairing", e); toast(t("tryAgain")); }
}
