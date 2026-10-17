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

test("cleanup: photos no marker points at, once they're old enough", async () => {
  const t = Date.now(), old = t - GRACE - 1;
  const objects = [
    { key: "ABCD/bob/f1.jpg", uploaded: old },   // still shown
    { key: "ABCD/bob/f2.jpg", uploaded: old },   // its message was deleted
    { key: "ABCD/eve/f1.jpg", uploaded: old },   // a marker by someone else
    { key: "ABCD/bob/f3.bin", uploaded: t - 1000 }, // being sent right now
    { key: "WXYZ/bob/f1.bin", uploaded: old },   // its room is gone
    { key: "junk", uploaded: old },
  ];
  const markers = async (code) => (code === "ABCD" ? { f1: { by: "bob", at: 1 } } : null);
  assert.deepEqual(await strayPhotos(objects, markers, t), ["ABCD/bob/f2.jpg", "ABCD/eve/f1.jpg", "WXYZ/bob/f1.bin", "junk"]);
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
