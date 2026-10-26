// The photo service (worker/): checking Firebase ID tokens, and what it lets people put in R2 and take out,
// against the database emulator's rules. Also the hourly cleanup's choice of stray photos. npm test
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifier } from "../worker/src/token.js";
import { MemoryBucket, handler, env } from "./photo-stub.mjs";
import { strayPhotos, s3Bucket, GRACE } from "../tools/cleanup/photos.mjs";

const EMU = "http://127.0.0.1:9000", NS = "demo-anon-chat", asOwner = { Authorization: "Bearer owner" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const unsigned = (sub) => b64({ alg: "none" }) + "." + b64({ sub, aud: NS, iss: "https://securetoken.google.com/" + NS, iat: now(), exp: now() + 3600, auth_time: now() }) + ".";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

before(async () => {
  const res = await fetch(`${EMU}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: asOwner, body: readFileSync(new URL("../database.rules.json", import.meta.url), "utf8") });
  assert.ok(res.ok, "the database emulator is running and took the rules");
});

test("ID tokens: only Google-signed, for this project, unexpired", async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
  const sign = async (claims, head = { alg: "RS256", kid: "k1" }) => {
    const data = b64(head) + "." + b64(claims);
    return data + "." + Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(data))).toString("base64url");
  };
  const verify = verifier(async () => [jwk]), E = { PROJECT_ID: "p1" };
  const ok = { sub: "abc123", aud: "p1", iss: "https://securetoken.google.com/p1", iat: now() - 10, exp: now() + 3600, auth_time: now() - 10 };
  assert.equal(await verify(await sign(ok), E), "abc123");
  assert.equal(await verify(await sign({ ...ok, aud: "other" }), E), null);
  assert.equal(await verify(await sign({ ...ok, iss: "https://securetoken.google.com/other" }), E), null);
  assert.equal(await verify(await sign({ ...ok, exp: now() - 1 }), E), null);
  assert.equal(await verify(await sign({ ...ok, sub: "../x" }), E), null);
  assert.equal(await verify(await sign(ok, { alg: "RS256", kid: "nope" }), E), null);
  const good = await sign(ok);
  assert.equal(await verify(good.slice(0, good.lastIndexOf(".")) + "." + b64({ x: 1 }), E), null); // a forged signature
  assert.equal(await verify(unsigned("abc123"), E), null); // the emulator's unsigned kind
  assert.equal(await verify("", E), null);
});

let bucket;
const call = (method, path, uid, body, headers = {}) =>
  handler(new Request("https://api.stoatalk.app" + path, { method, body, headers: { ...(uid ? { Authorization: "Bearer " + unsigned(uid) } : {}), ...headers } }), env(bucket)).then((r) => r.status);
const db = (path, value) => fetch(`${EMU}/${path}.json?ns=${NS}`, { method: value === null ? "DELETE" : "PUT", headers: asOwner, body: value === null ? undefined : JSON.stringify(value) });
beforeEach(async () => {
  bucket = new MemoryBucket();
  await db("", null);
  await db("rooms/ABCD", { meta: { owner: "alice", created: 1, last: Date.now() }, members: { alice: { joined: 1, name: "a", avatar: "🦊" }, bob: { joined: 1, name: "b", avatar: "🐻" } } });
});

test("photo service: a member puts in their own JPEG, once", async () => {
  assert.equal(await call("PUT", "/photo/ABCD/bob/f1.jpg", "bob", JPEG), 201);
  const o = bucket.objects.get("ABCD/bob/f1.jpg");
  assert.deepEqual([...o.body], [...JPEG]);
  assert.equal(o.httpMetadata.contentType, "image/jpeg");
  assert.equal(await call("PUT", "/photo/ABCD/bob/f1.jpg", "bob", JPEG), 409); // never replaced
  assert.equal(await call("PUT", "/photo/ABCD/bob/f2.bin", "bob", new Uint8Array([9, 9, 9])), 201); // sealed: any bytes
  assert.equal(bucket.objects.get("ABCD/bob/f2.bin").httpMetadata.contentType, "application/octet-stream");
  assert.equal(await call("PUT", "/photo/ABCD/bob/f3.jpg", null, JPEG), 401); // not signed in
  assert.equal(await call("PUT", "/photo/ABCD/alice/f3.jpg", "bob", JPEG), 400); // not under someone else's name
  assert.equal(await call("PUT", "/photo/ABCD/carol/f3.jpg", "carol", JPEG), 403); // not a member
  assert.equal(await call("PUT", "/photo/WXYZ/bob/f3.jpg", "bob", JPEG), 403); // no such room
  assert.equal(await call("PUT", "/photo/ABCD/bob/f3.jpg", "bob", new TextEncoder().encode("<html>")), 415); // a .jpg is a JPEG
  assert.equal(await call("PUT", "/photo/ABCD/bob/f3.png", "bob", JPEG), 400);
  assert.equal(await call("PUT", "/photo/ABCD/bob/f3.jpg", "bob", new Uint8Array(330029).fill(0xff)), 413); // too big
  assert.equal(await call("PUT", "/photo/abcd/bob/f3.jpg", "bob", JPEG), 400);
  assert.equal(bucket.objects.size, 2);
});

test("photo service: a photo goes once its marker is gone, a room's once the room is", async () => {
  await call("PUT", "/photo/ABCD/bob/f1.jpg", "bob", JPEG);
  await call("PUT", "/photo/ABCD/bob/f2.jpg", "bob", JPEG);
  await db("rooms/ABCD/files/f1", { by: "bob", at: 1 });
  assert.equal(await call("DELETE", "/photo/ABCD/bob/f1", "alice"), 409); // its message is still there
  assert.equal(await call("DELETE", "/photo/ABCD/bob/f2", "carol"), 403); // only a member asks
  assert.equal(await call("DELETE", "/photo/ABCD/bob/f2", "alice"), 204);
  assert.deepEqual([...bucket.objects.keys()], ["ABCD/bob/f1.jpg"]);
  assert.equal(await call("DELETE", "/room/ABCD", "carol"), 409); // the room is still there
  await db("rooms/ABCD", null);
  assert.equal(await call("DELETE", "/room/ABCD", "carol"), 204);
  assert.equal(bucket.objects.size, 0);
  assert.equal(await call("OPTIONS", "/photo/ABCD/bob/f1.jpg", null), 204);
});

test("photo service: a quiz's picture goes once its quiz is gone", async () => {
  const z = "-Nquiz0000000000000A", f = z + "abc123XYZ0";
  assert.equal(await call("PUT", `/photo/ABCD/alice/${f}.jpg`, "alice", JPEG), 201);
  await db("rooms/ABCD/qz/" + z, { by: "alice" });
  assert.equal(await call("DELETE", `/photo/ABCD/alice/${f}`, "bob"), 409); // its quiz is still there
  await db("rooms/ABCD/qz/" + z, null);
  assert.equal(await call("DELETE", `/photo/ABCD/alice/${f}`, "bob"), 204);
  assert.equal(bucket.objects.size, 0);
});

test("photo service: a Google account's quiz library puts in its own pictures, named by their SHA-256", async () => {
  const id = Buffer.from(await crypto.subtle.digest("SHA-256", JPEG)).toString("base64url").slice(0, 22);
  assert.equal(await call("PUT", `/lib/ann/${id}.jpg`, "ann", JPEG), 403); // not signed in with Google: no users/ann/dh
  await db("users/ann/dh", "BPub_key-123");
  assert.equal(await call("PUT", `/lib/ann/${id}.jpg`, "ann", JPEG), 201);
  assert.equal(bucket.objects.get(`u/ann/${id}.jpg`).httpMetadata.contentType, "image/jpeg");
  assert.equal(await call("PUT", `/lib/ann/${id}.jpg`, "ann", JPEG), 409); // there already: the same picture
  assert.equal(await call("PUT", `/lib/ann/${"A".repeat(22)}.jpg`, "ann", JPEG), 400); // not its hash
  assert.equal(await call("PUT", `/lib/bob/${id}.jpg`, "ann", JPEG), 400); // someone else's library
  assert.equal(await call("PUT", `/lib/ann/${id}.jpg`, null, JPEG), 401);
  const html = new TextEncoder().encode("<html>"), hid = Buffer.from(await crypto.subtle.digest("SHA-256", html)).toString("base64url").slice(0, 22);
  assert.equal(await call("PUT", `/lib/ann/${hid}.jpg`, "ann", html), 415);
  assert.equal(await call("PUT", `/lib/ann/${id}.jpg`, "ann", new Uint8Array(165001).fill(0xff)), 413);
  assert.equal(bucket.objects.size, 1);
});

test("cleanup: photos no marker points at, once they're old enough", async () => {
  const t = Date.now(), old = t - GRACE - 1;
  const objects = [
    { key: "ABCD/bob/f1.jpg", uploaded: old },   // still shown
    { key: "ABCD/bob/f2.jpg", uploaded: old },   // its message was deleted
    { key: "ABCD/eve/f1.jpg", uploaded: old },   // a marker by someone else
    { key: "ABCD/bob/f3.bin", uploaded: t - 1000 }, // being sent right now
    { key: "WXYZ/bob/f1.bin", uploaded: old },   // its room is gone
    { key: "junk", uploaded: old },
    { key: "ABCD/bob/-Nquiz0000000000000Aabc123XYZ0.jpg", uploaded: old },  // its quiz is on
    { key: "ABCD/bob/-Nquiz0000000000000Babc123XYZ0.jpg", uploaded: old },  // its quiz is gone
    { key: "ABCD/eve/-Nquiz0000000000000Aabc123XYZ1.bin", uploaded: old },  // not the quiz's host's
  ];
  const markers = async (code) => (code === "ABCD" ? { f1: { by: "bob", at: 1 } } : null);
  const quizBy = async (code, z) => (code === "ABCD" && z === "-Nquiz0000000000000A" ? "bob" : null);
  assert.deepEqual(await strayPhotos(objects, markers, t, quizBy), ["ABCD/bob/f2.jpg", "ABCD/eve/f1.jpg", "WXYZ/bob/f1.bin", "junk",
    "ABCD/bob/-Nquiz0000000000000Babc123XYZ0.jpg", "ABCD/eve/-Nquiz0000000000000Aabc123XYZ1.bin"]);
});

test("cleanup: a quiz library's pictures go once no set in the account points at them", async () => {
  const t = Date.now(), old = t - GRACE - 1, A = "A".repeat(22), B = "B".repeat(22), C = "C".repeat(22);
  const objects = [
    { key: `u/ann/${A}.jpg`, uploaded: old },     // a set has it
    { key: `u/ann/${B}.jpg`, uploaded: old },     // none does any more
    { key: `u/ann/${C}.jpg`, uploaded: t - 1000 }, // just put in, its set on the way
    { key: `u/gone/${A}.jpg`, uploaded: old },    // the account was deleted
  ];
  const library = async (uid) => (uid === "ann" ? { s1: JSON.stringify({ t: "x", q: [{ t: "q", img: { f: A, w: 1, h: 1 } }, { t: "r" }] }), s2: "not JSON" } : null);
  assert.deepEqual(await strayPhotos(objects, async () => null, t, async () => null, library), [`u/ann/${B}.jpg`, `u/gone/${A}.jpg`]);
});

test("cleanup: the bucket listed page by page over R2's S3 API", async () => {
  const pages = {
    "": "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>ABCD/bob/f1.jpg</Key><LastModified>2026-10-17T10:00:00.000Z</LastModified></Contents><NextContinuationToken>t/2</NextContinuationToken></ListBucketResult>",
    "t/2": "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>ABCD/bob/f2.bin</Key><LastModified>2026-10-17T11:00:00.000Z</LastModified></Contents></ListBucketResult>",
  };
  const asked = [];
  const send = async (url, init) => {
    asked.push([init?.method || "GET", url]);
    const token = new URL(url).searchParams.get("continuation-token") || "";
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(pages[token]);
  };
  const bucket = s3Bucket(send, "https://acct.r2.cloudflarestorage.com/stoatalk-photos");
  assert.deepEqual(await bucket.list(), [
    { key: "ABCD/bob/f1.jpg", uploaded: Date.parse("2026-10-17T10:00:00.000Z") },
    { key: "ABCD/bob/f2.bin", uploaded: Date.parse("2026-10-17T11:00:00.000Z") },
  ]);
  await bucket.remove("ABCD/bob/f2.bin");
  assert.deepEqual(asked.at(-1), ["DELETE", "https://acct.r2.cloudflarestorage.com/stoatalk-photos/ABCD/bob/f2.bin"]);
});

/* ---------- Web Push ---------- */
import { encrypt, vapid, sealSub, openSub, b64u, validSubscription } from "../worker/src/push.js";
import { makeHandler, readDb, allowedOrigin, makeScheduled } from "../worker/src/index.js";
import { unsignedUid } from "./photo-stub.mjs";

const hkdfBits = async (ikm, salt, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info },
  await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
// a browser: its subscription keys, and how it opens what arrives (RFC 8291, the receiving side)
async function browser() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)), secret = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/" + Math.random().toString(36).slice(2), keys: { p256dh: b64u(pub), auth: b64u(secret) } };
  const open = async (body) => {
    const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, kp.privateKey, 256));
    const ikm = await hkdfBits(shared, secret, cat(Buffer.from("WebPush: info\0"), pub, asPub), 32);
    const cek = await crypto.subtle.importKey("raw", await hkdfBits(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdfBits(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12) }, cek, ct));
    assert.equal(plain.at(-1), 2);
    return new TextDecoder().decode(plain.slice(0, -1));
  };
  return { sub, open };
}
const vapidKey = async () => {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  return JSON.stringify(await crypto.subtle.exportKey("jwk", k.privateKey));
};

test("push: the payload opens in the browser it was sealed to, and nowhere else", async () => {
  const a = await browser(), b = await browser();
  const body = await encrypt(a.sub, '{"c":"ABCD"}');
  assert.equal(await a.open(body), '{"c":"ABCD"}');
  await assert.rejects(b.open(body));
  assert.ok(validSubscription(a.sub));
  assert.ok(!validSubscription({ ...a.sub, endpoint: "https://evil.example/x" }));
  assert.ok(!validSubscription({ ...a.sub, endpoint: "http://fcm.googleapis.com/x" }));
  assert.ok(!validSubscription({ endpoint: a.sub.endpoint, keys: { p256dh: "abc", auth: a.sub.keys.auth } }));
});

test("push: a sealed subscription opens only as its owner's", async () => {
  const keys = await vapid({ VAPID_KEY: await vapidKey() }), { sub } = await browser();
  const sealed = await sealSub(keys, "bob", sub);
  assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  assert.ok(sealed.length < 2000);
  assert.deepEqual(await openSub(keys, "bob", sealed), sub);
  assert.equal(await openSub(keys, "eve", sealed), null);
  assert.equal(await openSub(await vapid({ VAPID_KEY: await vapidKey() }), "bob", sealed), null);
  assert.equal(await vapid({}), null);
});

test("push service: announces a message to members with a subscription who aren't online, on each of their devices", async () => {
  const E = { ...env(new MemoryBucket()), VAPID_KEY: await vapidKey() };
  const pushed = [];
  const fetcher = async (url, init) => { pushed.push({ url, init }); return new Response(null, { status: 201 }); };
  const h = makeHandler({ verify: unsignedUid, read: readDb, fetcher });
  const go = (method, path, uid, body) => h(new Request("https://api.stoatalk.app" + path, { method, body: body && JSON.stringify(body),
    headers: uid ? { Authorization: "Bearer " + unsigned(uid) } : {} }), E);
  const key = await (await go("GET", "/push/key")).json();
  assert.match(key.key, /^B[A-Za-z0-9_-]{86}$/); // an uncompressed P-256 point
  const alice = await browser(), alice2 = await browser(), carol = await browser(), dave = await browser();
  assert.equal((await go("POST", "/push/seal", "alice", { endpoint: "https://evil.example/x", keys: alice.sub.keys })).status, 400);
  assert.equal((await go("POST", "/push/seal", null, alice.sub)).status, 401);
  const seal = async (uid, b) => (await (await go("POST", "/push/seal", uid, b.sub)).json()).sealed;
  const t = Date.now();
  await db("rooms/ABCD", {
    meta: { owner: "alice", created: 1, last: t, title: "讀書會", pa: t },
    members: { alice: { joined: 1, name: "a", avatar: "🦊", online: false }, bob: { joined: 1, name: "b", avatar: "🐻", online: true },
               carol: { joined: 1, name: "c", avatar: "🐼", online: true }, dave: { joined: 1, name: "d", avatar: "🐯" } },
    // alice on her phone and her laptop; dave's place, in the one-string way from before devices, holds alice's
    push: { alice: { devPhone0001: await seal("alice", alice), devLaptop001: await seal("alice", alice2) }, carol: { devCarol0001: await seal("carol", carol) },
            dave: await seal("alice", dave) },
    msgs: { m1: { by: "bob", name: "b", avatar: "🐻", text: "大家好\n今天讀第三章", at: t }, m0: { by: "bob", name: "b", avatar: "🐻", text: "old", at: t - 600000 },
            m2: { by: "alice", name: "a", avatar: "🦊", text: "hi", at: t } },
  });
  assert.equal((await go("POST", "/push/notify/ABCD", "bob", { id: "m2" })).status, 409); // not bob's
  assert.equal((await go("POST", "/push/notify/ABCD", "bob", { id: "m0" })).status, 409); // not new
  assert.equal((await go("POST", "/push/notify/ABCD", "eve", { id: "m1" })).status, 403); // not in the room
  const res = await go("POST", "/push/notify/ABCD", "bob", { id: "m1" });
  assert.deepEqual(await res.json(), { sent: 2, next: null });
  assert.equal(pushed.length, 2); // carol is online; dave's place holds someone else's subscription
  assert.deepEqual(pushed.map((p) => p.url).sort(), [alice.sub.endpoint, alice2.sub.endpoint].sort());
  if (pushed[0].url !== alice.sub.endpoint) pushed.reverse();
  assert.equal(pushed[0].init.headers.Topic, "ABCD");
  assert.match(pushed[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B/);
  assert.deepEqual(JSON.parse(await alice.open(pushed[0].init.body)), { c: "ABCD", k: "m", n: "b", a: "🐻", r: "讀書會", s: "大家好 今天讀第三章" });
  // the room was just announced: the next message waits, and is told for how long
  const soon = await (await go("POST", "/push/notify/ABCD", "bob", { id: "m1" })).json();
  assert.equal(soon.sent, 0);
  assert.ok(soon.wait > 0 && soon.wait <= 20000);
  assert.equal(pushed.length, 2);
  // a private message: only to the one it's for, and it says nothing of what's in it
  await db("rooms/ABCD/dm/alice_bob/d1", { by: "bob", to: "alice", x: "sealed", at: Date.now() });
  assert.equal((await go("POST", "/push/notify/ABCD", "bob", { id: "d1", to: "carol" })).status, 409);
  assert.deepEqual(await (await go("POST", "/push/notify/ABCD", "bob", { id: "d1", to: "alice" })).json(), { sent: 2, next: null });
  const dm = pushed.slice(2).find((p) => p.url === alice.sub.endpoint);
  assert.deepEqual(JSON.parse(await alice.open(dm.init.body)), { c: "ABCD", k: "d" });
});

test("service: only the listed pages may call it (staging lets every preview under *.stoatalk.pages.dev in)", () => {
  const list = "https://stoatalk.app,https://*.stoatalk.pages.dev";
  for (const o of ["https://stoatalk.app", "https://staging.stoatalk.pages.dev", "https://claude-x.stoatalk.pages.dev"]) assert.ok(allowedOrigin(o, list), o);
  for (const o of [null, "", "https://stoatalk.pages.dev", "https://evilstoatalk.pages.dev", "http://staging.stoatalk.pages.dev",
    "https://staging.stoatalk.pages.dev.evil.com", "https://stoatalk.app.evil.com"]) assert.ok(!allowedOrigin(o, list), o);
  assert.ok(!allowedOrigin("https://stoatalk.app", ""));
});

test("service: its hourly cron starts the cleanup on GitHub, with a token, and does nothing without one", async () => {
  const asked = [];
  const fetcher = async (url, init) => { asked.push({ url, init }); return new Response(null, { status: 204 }); };
  const run = makeScheduled({ fetcher });
  await run({}, { GITHUB_REPO: "samhung7/anon-chat" });
  assert.equal(asked.length, 0);
  await run({}, { GITHUB_REPO: "samhung7/anon-chat", CLEANUP_DISPATCH_TOKEN: "ghp_x" });
  assert.equal(asked[0].url, "https://api.github.com/repos/samhung7/anon-chat/actions/workflows/cleanup.yml/dispatches");
  assert.equal(asked[0].init.method, "POST");
  assert.equal(asked[0].init.headers.Authorization, "Bearer ghp_x");
  assert.ok(asked[0].init.headers["User-Agent"]); // GitHub refuses a request without one
  assert.deepEqual(JSON.parse(asked[0].init.body), { ref: "main" });
});
