// Security-rule tests against the Realtime Database emulator: npm test
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { ref, set, update, get, remove, push, serverTimestamp } from "firebase/database";

let env;
const C = "K7QM";
const T = serverTimestamp();
const member = (name) => ({ name, avatar: "🦊", joined: T, online: true });
const db = (uid) => env.authenticatedContext(uid).database();
const createRoom = (uid, { priv = false, secret = null, code = C } = {}) =>
  update(ref(db(uid)), {
    [`rooms/${code}`]: { meta: { owner: uid, created: T, last: T, priv }, members: { [uid]: member("房主") }, names: { "房主": uid } },
    [`secrets/${code}`]: secret,
  });
const join = (uid, key, name = uid) => update(ref(db(uid)), {
  [`rooms/${C}/members/${uid}`]: member(name),
  [`rooms/${C}/names/${name.toLowerCase()}`]: uid,
  [`rooms/${C}/meta/last`]: T,
  ...(key != null ? { [`rooms/${C}/keys/${uid}`]: key } : {}),
});
const say = (uid, text = "嗨") => set(push(ref(db(uid), `rooms/${C}/msgs`)), { by: uid, name: "x", avatar: "🦊", text, at: T });
const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.database()));

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-anon-chat",
    database: { host: "127.0.0.1", port: 9000, rules: readFileSync(new URL("../database.rules.json", import.meta.url), "utf8") },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearDatabase());

test("creating a room, and not over someone else's live room", async () => {
  await assertFails(createRoom("alice", { code: "K7Q0" })); // 0 is not a code character
  await assertSucceeds(createRoom("alice"));
  await assertFails(createRoom("bob"));
  await assertFails(update(ref(db("bob")), { [`rooms/${C}/meta/owner`]: "bob" }));
});

test("a room idle for 24 hours can be taken over or cleared by anyone", async () => {
  await createRoom("alice");
  await admin((d) => update(ref(d, `rooms/${C}/meta`), { last: Date.now() - 86400000 - 60000 }));
  await assertFails(join("bob")); // can't join an expired room
  await assertSucceeds(createRoom("bob"));
  await admin((d) => update(ref(d, `rooms/${C}/meta`), { last: Date.now() - 86400000 - 60000 }));
  await assertSucceeds(update(ref(db("carol")), { [`rooms/${C}`]: null, [`secrets/${C}`]: null }));
});

test("public room: anyone with the code joins, reads and talks; outsiders read nothing", async () => {
  await createRoom("alice");
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/meta`)));
  await assertFails(get(ref(db("bob"), `rooms/${C}/msgs`)));
  await assertSucceeds(join("bob"));
  await assertSucceeds(say("bob"));
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/msgs`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/msgs`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/members`)));
  await assertFails(say("carol"));
  await assertFails(get(ref(env.unauthenticatedContext().database(), `rooms/${C}/meta`)));
});

test("messages: no impersonation, length limit, server time", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(set(push(ref(db("bob"), `rooms/${C}/msgs`)), { by: "alice", name: "x", avatar: "🦊", text: "hi", at: T }));
  await assertFails(set(push(ref(db("bob"), `rooms/${C}/msgs`)), { by: "bob", name: "x", avatar: "🦊", text: "hi", at: 1 }));
  await assertFails(say("bob", "a".repeat(1001)));
  await assertFails(say("bob", ""));
  await assertSucceeds(say("bob", "a".repeat(1000)));
});

test("private room needs the password", async () => {
  await createRoom("alice", { priv: true, secret: "hash-of-pw" });
  await assertFails(join("bob"));
  await assertFails(join("bob", "wrong"));
  await assertSucceeds(join("bob", "hash-of-pw"));
  await assertFails(get(ref(db("bob"), `secrets/${C}`)));
  await assertFails(get(ref(db("bob"), `rooms/${C}/keys/alice`)));
  await assertFails(set(ref(db("bob"), `secrets/${C}`), "mine"));
});

test("locked room lets nobody new in, but members stay", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(update(ref(db("bob"), `rooms/${C}/meta`), { locked: true }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { locked: true }));
  await assertFails(join("carol"));
  await assertSucceeds(say("bob"));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}/members/bob`), { online: false }));
});

test("owner removes someone, who can't come back", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  await assertFails(update(ref(db("carol"), `rooms/${C}`), { "members/bob": null, "banned/bob": true }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}`), { "members/bob": null, "names/bob": null, "banned/bob": true }));
  await assertFails(join("bob"));
  await assertFails(get(ref(db("bob"), `rooms/${C}/msgs`)));
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/banned/bob`)));
});

test("deleting messages: only the author (not even the owner)", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  const m = push(ref(db("bob"), `rooms/${C}/msgs`));
  await set(m, { by: "bob", name: "x", avatar: "🦊", text: "1", at: T });
  await assertFails(remove(ref(db("carol"), `rooms/${C}/msgs/${m.key}`)));
  await assertFails(update(ref(db("carol"), `rooms/${C}/msgs/${m.key}`), { text: "edited" }));
  await assertFails(remove(ref(db("alice"), `rooms/${C}/msgs/${m.key}`)));
  const n = push(ref(db("bob"), `rooms/${C}/msgs`));
  await set(n, { by: "bob", name: "x", avatar: "🦊", text: "2", at: T });
  await assertSucceeds(remove(ref(db("bob"), `rooms/${C}/msgs/${n.key}`)));
});

test("reactions: members toggle their own", async () => {
  await createRoom("alice"); await join("bob");
  const m = push(ref(db("alice"), `rooms/${C}/msgs`));
  await set(m, { by: "alice", name: "x", avatar: "🦊", text: "1", at: T });
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/msgs/${m.key}/re/0/bob`), true));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/msgs/${m.key}/re/0/bob`), null));
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/${m.key}/re/0/alice`), true));
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/${m.key}/re/9/bob`), true));
  await assertFails(set(ref(db("carol"), `rooms/${C}/msgs/${m.key}/re/0/carol`), true));
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/nope/re/0/bob`), true)); // no reacting to a deleted message
});

test("private messages: only the two people read them", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  const pair = "alice_bob";
  await assertFails(set(push(ref(db("bob"), `rooms/${C}/dm/${pair}`)), { by: "bob", to: "alice", text: "悄悄話", at: T })); // never in the clear
  await assertSucceeds(set(push(ref(db("bob"), `rooms/${C}/dm/${pair}`)), { by: "bob", to: "alice", x: "c2VhbGVk", at: T }));
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/dm/${pair}`)));
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/dm/${pair}`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/dm/${pair}`)));
  await assertFails(set(push(ref(db("carol"), `rooms/${C}/dm/${pair}`)), { by: "carol", to: "alice", x: "eA", at: T }));
  await assertFails(set(push(ref(db("bob"), `rooms/${C}/dm/bob_dave`)), { by: "bob", to: "dave", x: "eA", at: T })); // dave isn't here
  await assertFails(get(ref(db("alice"), `rooms/${C}/dm`)));
});

test("ending: only the owner deletes the room and its password", async () => {
  await createRoom("alice", { priv: true, secret: "h" }); await join("bob", "h");
  await assertFails(update(ref(db("bob")), { [`rooms/${C}`]: null, [`secrets/${C}`]: null }));
  await assertSucceeds(update(ref(db("alice")), { [`rooms/${C}`]: null, [`secrets/${C}`]: null }));
  await admin(async (d) => { if ((await get(ref(d, `secrets/${C}`))).exists()) throw new Error("password left behind"); });
});

test("members leave on their own", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(remove(ref(db("bob"), `rooms/${C}/members/alice`)));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "members/bob": null, "names/bob": null }));
  await assertFails(say("bob"));
});

test("nicknames are unique in a room, ignoring case", async () => {
  await createRoom("alice"); await join("bob", null, "Sam");
  await assertFails(join("carol", null, "Sam"));
  await assertFails(join("carol", null, "SAM"));
  await assertFails(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: member("Sam"), [`rooms/${C}/names/sam-2`]: "carol" })); // name must match its claim
  await assertFails(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: member("a/b"), [`rooms/${C}/names/ab`]: "carol" })); // characters a key can't hold
  await assertSucceeds(join("carol", null, "Ray"));
  // renaming: claim the new name and give back the old one
  await assertFails(update(ref(db("carol"), `rooms/${C}`), { "members/carol/name": "Sam" }));
  await assertSucceeds(update(ref(db("carol"), `rooms/${C}`), { "members/carol/name": "Ray2", "names/ray2": "carol", "names/ray": null }));
  await assertFails(set(ref(db("carol"), `rooms/${C}/names/sam`), null)); // can't free someone else's name
  // when the holder has left, the name is free again
  await admin((d) => remove(ref(d, `rooms/${C}/members/bob`)));
  await assertSucceeds(join("dave", null, "Sam"));
});

test("GIFs: only images hosted by KLIPY", async () => {
  await createRoom("alice"); await join("bob");
  const gif = (url) => set(push(ref(db("bob"), `rooms/${C}/msgs`)), { by: "bob", name: "x", avatar: "🦊", gif: { url, w: 200, h: 150, title: "cat" }, at: T });
  await assertSucceeds(gif("https://static.klipy.com/ii/abc/cat.gif"));
  await assertFails(gif("https://evil.example.com/track.gif"));
  await assertFails(gif("https://klipy.com.evil.example/x.gif"));
  await assertFails(gif("http://static.klipy.com/x.gif"));
  await assertFails(set(push(ref(db("bob"), `rooms/${C}/msgs`)), { by: "bob", name: "x", avatar: "🦊", at: T })); // neither text nor gif
});

// an encrypted room: the server only ever holds ciphertext (x, xt) and keyed hashes of nicknames (h)
const H = (n) => n.repeat(24).slice(0, 24);
const encMember = (h) => ({ x: "c2VhbGVk", h, joined: T, online: true, pk: "cGs" });
const createEnc = (uid) => update(ref(db(uid)), {
  [`rooms/${C}`]: { meta: { owner: uid, created: T, last: T, priv: false, enc: true, kc: "0123456789abcdef", xt: "dGl0bGU" }, members: { [uid]: encMember(H("a")) }, names: { [H("a")]: uid } },
});
const joinEnc = (uid, h) => update(ref(db(uid)), { [`rooms/${C}/members/${uid}`]: encMember(h), [`rooms/${C}/names/${h}`]: uid, [`rooms/${C}/meta/last`]: T });

test("encrypted room: only ciphertext and hashed nicknames", async () => {
  await assertFails(update(ref(db("alice")), { [`rooms/${C}`]: { meta: { owner: "alice", created: T, last: T, priv: false, enc: true, title: "明文" }, members: { alice: encMember(H("a")) }, names: { [H("a")]: "alice" } } }));
  await assertFails(update(ref(db("alice")), { [`rooms/${C}`]: { meta: { owner: "alice", created: T, last: T, priv: false, enc: true }, members: { alice: member("房主") }, names: { "房主": "alice" } } }));
  await assertSucceeds(createEnc("alice"));
  await assertFails(joinEnc("bob", H("a"))); // that nickname is taken
  await assertFails(update(ref(db("bob")), { [`rooms/${C}/members/bob`]: member("bob"), [`rooms/${C}/names/bob`]: "bob" })); // plain nickname
  await assertFails(joinEnc("bob", "not-a-hash"));
  await assertSucceeds(joinEnc("bob", H("b")));
  const msgs = ref(db("bob"), `rooms/${C}/msgs`);
  await assertFails(set(push(msgs), { by: "bob", name: "x", avatar: "🦊", text: "明文", at: T }));
  await assertFails(set(push(msgs), { by: "bob", x: "c2VhbGVk", text: "明文", at: T }));
  await assertFails(set(push(msgs), { by: "bob", x: "not base64!", at: T }));
  await assertSucceeds(set(push(msgs), { by: "bob", x: "c2VhbGVk", at: T }));
  // the owner can't quietly turn encryption off
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { enc: false }));
  await assertFails(set(ref(db("alice"), `rooms/${C}/meta/enc`), null));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/locked`), true));
  // after 24 idle hours the code can become an ordinary room again
  await admin((d) => update(ref(d, `rooms/${C}/meta`), { last: Date.now() - 86400000 - 60000 }));
  await assertSucceeds(createRoom("carol"));
});

test("ciphertext only in encrypted rooms", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(set(push(ref(db("bob"), `rooms/${C}/msgs`)), { by: "bob", x: "c2VhbGVk", at: T }));
  await assertFails(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: encMember(H("c")), [`rooms/${C}/names/${H("c")}`]: "carol" }));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/members/bob/pk`), "cGs")); // publishing a public key
});
