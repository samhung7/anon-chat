/* Web Push: notifications for people whose page is closed. Standard Web Push (RFC 8030), with VAPID (RFC 8292) to
   say the messages come from us and the payload encrypted to each browser (RFC 8291, aes128gcm), all with Web Crypto.
   The one secret, VAPID_KEY, is a P-256 private key as a JWK (site/admin.html makes one). From it come the public
   key browsers subscribe with, and the key that seals each subscription before it's stored in the room
   (rooms/{code}/push/{uid}), so the other members who can read it can't use it. */
import { unb64u } from "./token.js";

export const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const hkdf = async (ikm, salt, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits(
  { name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bytes * 8));

// the push services browsers use; anything else isn't a subscription, and we never send a request elsewhere
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
export function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname) && s.endpoint.length <= 1000 &&
      unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length === 16;
  } catch (e) { return false; }
}

// VAPID_KEY → what signs, what's handed to browsers, and what seals subscriptions; null when it isn't set
const cache = new Map();
export function vapid(env) {
  if (!env.VAPID_KEY) return null;
  if (!cache.has(env.VAPID_KEY)) cache.set(env.VAPID_KEY, (async () => {
    const jwk = JSON.parse(env.VAPID_KEY);
    const sign = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const pub = b64u(concat([4], unb64u(jwk.x), unb64u(jwk.y)));
    const seal = await crypto.subtle.importKey("raw", await hkdf(unb64u(jwk.d), new Uint8Array(0), utf8("StoaTalk push subscription"), 32), "AES-GCM", false, ["encrypt", "decrypt"]);
    return { sign, pub, seal };
  })());
  return cache.get(env.VAPID_KEY);
}

// a subscription sealed for one person: only this service can open it, and only as theirs
export async function sealSub(keys, uid, s) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = utf8(JSON.stringify({ u: uid, e: s.endpoint, p: s.keys.p256dh, a: s.keys.auth }));
  return b64u(concat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.seal, data))));
}
export async function openSub(keys, uid, sealed) {
  try {
    const b = unb64u(sealed);
    const o = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, keys.seal, b.slice(12))));
    return o.u === uid ? { endpoint: o.e, keys: { p256dh: o.p, auth: o.a } } : null; // copied into someone else's place: ignored
  } catch (e) { return null; }
}

// the payload, encrypted to the browser that subscribed (RFC 8291): one aes128gcm record
export async function encrypt(sub, payload) {
  const ua = unb64u(sub.keys.p256dh), secret = unb64u(sub.keys.auth);
  const mine = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", mine.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, mine.privateKey, 256));
  const ikm = await hkdf(shared, secret, concat(utf8("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await crypto.subtle.importKey("raw", await hkdf(ikm, salt, utf8("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["encrypt"]);
  const iv = await hkdf(ikm, salt, utf8("Content-Encoding: nonce\0"), 12);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cek, concat(utf8(payload), [2]))); // 2: the last record
  return concat(salt, [0, 0, 16, 0], [asPub.length], asPub, body); // record size 4096
}

// "this comes from StoaTalk" for the push service (RFC 8292), good for 12 hours
async function vapidAuth(keys, endpoint) {
  const head = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 43200, sub: "mailto:hello@stoatalk.app" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.sign, utf8(head + "." + claims));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.pub}`;
}

// one push; topic: a newer push with the same topic replaces this one if it hasn't arrived yet. Gives the HTTP status.
export async function send(keys, sub, payload, { topic, ttl = 3600, fetcher = fetch } = {}) {
  const res = await fetcher(sub.endpoint, { method: "POST", body: await encrypt(sub, payload), headers: {
    Authorization: await vapidAuth(keys, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
    TTL: String(ttl), Urgency: "normal", ...(topic ? { Topic: topic } : {}) } });
  return res.status;
}
