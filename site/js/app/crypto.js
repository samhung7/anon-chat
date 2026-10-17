/* End-to-end encryption, with the browser's Web Crypto API.
   Encrypted room: a random 256-bit key K, shared only through the link (#k=...), and kept on each device under
   chat-key:{code}. From K come an AES-GCM key for content and an HMAC key for nickname claims and the key check.
   Private messages: each device has an ECDH P-256 key pair (chat-dh); its public key sits on the member record,
   and two people derive the same AES-GCM key. Every sealed value is bound to who it belongs to (AES-GCM
   additional data), so the server can't move a message or a nickname onto someone else. */
import { store, KEYS } from "./storage.js?v=dev";

const SUB = crypto.subtle, TE = new TextEncoder(), TD = new TextDecoder();
const EC = { name: "ECDH", namedCurve: "P-256" };
const AES = { name: "AES-GCM", length: 256 };

export const b64u = (buf) => { let s = ""; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
// a room key in an invite link (after #k=), or typed on its own
export const KEY_RE = /#k=([A-Za-z0-9_-]{43})/;
export const RAW_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const hkdf = async (bits, info, alg, use) => SUB.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: TE.encode(info) },
  await SUB.importKey("raw", bits, "HKDF", false, ["deriveKey"]), alg, false, use);

// sealed: base64url of a 12-byte IV followed by the AES-GCM ciphertext; null when it doesn't open
export async function sealBytes(key, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await SUB.encrypt({ name: "AES-GCM", iv, additionalData: TE.encode(aad) }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64u(out);
}
export async function unsealBytes(key, s, aad) {
  try { const b = unb64u(s); return new Uint8Array(await SUB.decrypt({ name: "AES-GCM", iv: b.slice(0, 12), additionalData: TE.encode(aad) }, key, b.slice(12))); }
  catch (e) { return null; }
}
export const seal = (key, obj, aad) => sealBytes(key, TE.encode(JSON.stringify(obj)), aad);
export async function unseal(key, s, aad) {
  const b = await unsealBytes(key, s, aad);
  try { return b && JSON.parse(TD.decode(b)); } catch (e) { return null; }
}

// an encrypted room's keys, made from the raw key in its link
export class RoomCipher {
  static async fromRaw(raw) {
    const c = new RoomCipher();
    c.aes = await hkdf(raw, "anon-chat room aes", AES, ["encrypt", "decrypt"]);
    c.macKey = await hkdf(raw, "anon-chat room mac", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
    return c;
  }
  static fromLink(b64) { return RoomCipher.fromRaw(unb64u(b64)); }
  seal(obj, aad) { return seal(this.aes, obj, aad); }
  unseal(s, aad) { return unseal(this.aes, s, aad); }
  sealBytes(bytes, aad) { return sealBytes(this.aes, bytes, aad); }
  unsealBytes(s, aad) { return unsealBytes(this.aes, s, aad); }
  async mac(s) { return hex(await SUB.sign("HMAC", this.macKey, TE.encode(s))).slice(0, 24); }
  // lets a joiner tell a wrong link from a right one without the server learning the key
  async keyCheck() { return (await this.mac("key-check")).slice(0, 16); }
}

// this device's key pair for private messages, made once and kept
let device = null;
export async function deviceKeys() {
  if (device) return device;
  try {
    const s = JSON.parse(store.get(KEYS.dh));
    if (s?.priv && s?.pub) return (device = { priv: await SUB.importKey("jwk", s.priv, EC, false, ["deriveBits"]), pub: s.pub });
  } catch (e) {}
  const kp = await SUB.generateKey(EC, true, ["deriveBits"]);
  const pub = b64u(await SUB.exportKey("raw", kp.publicKey));
  store.set(KEYS.dh, JSON.stringify({ priv: await SUB.exportKey("jwk", kp.privateKey), pub }));
  return (device = { priv: kp.privateKey, pub });
}
// the AES-GCM key shared with whoever has this public key; info names the conversation
export async function sharedKey(theirPub, info) {
  const theirs = await SUB.importKey("raw", unb64u(theirPub), EC, false, []);
  const bits = await SUB.deriveBits({ name: "ECDH", public: theirs }, (await deviceKeys()).priv, 256);
  return hkdf(bits, info, AES, ["encrypt", "decrypt"]);
}

