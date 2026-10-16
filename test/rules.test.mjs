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
// a message as the app sends it: the same update stamps when this person last posted (ls) and names the message (lm).
// Tests post faster than the rate limit allows, so the stamp is cleared first unless fast is set.
const post = async (uid, path, body, { more = {}, fast = false, field = "lm" } = {}) => {
  const id = /^(msgs|dm\/[^/]+)$/.test(path) ? push(ref(db(uid), `rooms/${C}/${path}`)).key : path.split("/").pop();
  const coll = /^(msgs|dm\/[^/]+)$/.test(path) ? path : path.split("/").slice(0, -1).join("/");
  if (!fast) await admin((d) => remove(ref(d, `rooms/${C}/members/${uid}/ls`)));
  await update(ref(db(uid), `rooms/${C}`), { [`${coll}/${id}`]: body, [`members/${uid}/ls`]: T, [`members/${uid}/${field}`]: id, ...more });
  return id;
};
const say = (uid, text = "嗨", opts) => post(uid, "msgs", { by: uid, name: "x", avatar: "🦊", text, at: T }, opts);
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
  await assertFails(post("bob", "msgs", { by: "alice", name: "x", avatar: "🦊", text: "hi", at: T }));
  await assertFails(post("bob", "msgs", { by: "bob", name: "x", avatar: "🦊", text: "hi", at: 1 }));
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

test("only the owner renames the room", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(update(ref(db("bob"), `rooms/${C}/meta`), { title: "bob 的房間" }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { title: "週三讀書會" }));
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { title: "x".repeat(41) }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { title: null }));
});

test("pins: the owner pins up to three messages; replies point at a message", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/pins/0`), "-Nabc123"));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/pins/0`), "-Nabc123"));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/pins/2`), "-Nxyz_9"));
  await assertFails(set(ref(db("alice"), `rooms/${C}/meta/pins/3`), "-Nabc123"));
  await assertFails(set(ref(db("alice"), `rooms/${C}/meta/pins/1`), "not/a key"));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/pins/0`), null));
  
  await assertSucceeds(post("bob", "msgs", { by: "bob", name: "bob", avatar: "🦊", text: "同意", rp: "-Nabc123", at: T }));
  await assertFails(post("bob", "msgs", { by: "bob", name: "bob", avatar: "🦊", text: "同意", rp: "a.b", at: T }));
});

test("owner removes someone, who can't come back", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  await assertFails(update(ref(db("carol"), `rooms/${C}`), { "members/bob": null, "banned/bob": true }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}`), { "members/bob": null, "names/bob": null, "banned/bob": true }));
  await assertFails(join("bob"));
  await assertFails(get(ref(db("bob"), `rooms/${C}/msgs`)));
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/banned/bob`)));
});

test("deleting messages: the author, the owner and co-hosts, nobody else", async () => {
  await createRoom("alice"); await join("bob"); await join("carol"); await join("dave");
  const m = await say("bob", "1");
  await assertFails(remove(ref(db("carol"), `rooms/${C}/msgs/${m}`)));
  await assertSucceeds(remove(ref(db("alice"), `rooms/${C}/msgs/${m}`)));
  const n = await say("bob", "2");
  await assertSucceeds(remove(ref(db("bob"), `rooms/${C}/msgs/${n}`)));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/mods/carol`), true));
  const k = await say("dave", "3");
  await assertSucceeds(remove(ref(db("carol"), `rooms/${C}/msgs/${k}`)));
});

test("rate limit: one message per update, not faster than every 800 ms", async () => {
  await createRoom("alice"); await join("bob");
  await assertSucceeds(say("bob", "1"));
  await assertFails(say("bob", "2", { fast: true })); // right after the last one
  await assertFails(update(ref(db("bob"), `rooms/${C}`), { "msgs/a1": { by: "bob", name: "x", avatar: "🦊", text: "no stamp", at: T } }));
  await admin((d) => remove(ref(d, `rooms/${C}/members/bob/ls`)));
  await assertFails(update(ref(db("bob"), `rooms/${C}`), { // two in one write
    "msgs/a2": { by: "bob", name: "x", avatar: "🦊", text: "a", at: T }, "msgs/a3": { by: "bob", name: "x", avatar: "🦊", text: "b", at: T },
    "members/bob/ls": T, "members/bob/lm": "a2" }));
  await new Promise((r) => setTimeout(r, 900));
  await assertSucceeds(say("bob", "3", { fast: true }));
  await assertFails(set(ref(db("bob"), `rooms/${C}/members/bob/ls`), 5)); // only the server time
});

test("editing: the author changes the words, nothing else", async () => {
  await createRoom("alice"); await join("bob");
  const m = await say("bob", "typo");
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}/msgs/${m}`), { text: "fixed", ed: T }));
  await assertFails(update(ref(db("alice"), `rooms/${C}/msgs/${m}`), { text: "not yours" }));
  await assertFails(update(ref(db("bob"), `rooms/${C}/msgs/${m}`), { by: "alice" }));
  await assertFails(update(ref(db("bob"), `rooms/${C}/msgs/${m}`), { text: "" }));
  await assertFails(update(ref(db("bob"), `rooms/${C}/msgs/${m}`), { ed: 5 }));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/msgs/${m}/re/0/alice`), true));
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/${m}/re/0/alice`), null)); // not other people's reactions
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/nope/text`), "new")); // not a message that isn't there
});

test("co-hosts and handing the room over", async () => {
  await createRoom("alice"); await join("bob"); await join("carol"); await join("dave");
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/mods/bob`), true));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/mods/bob`), true));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/mods/carol`), true));
  await assertFails(update(ref(db("bob"), `rooms/${C}`), { "members/alice": null, "banned/alice": true })); // not the owner
  await assertFails(update(ref(db("bob"), `rooms/${C}`), { "members/carol": null, "banned/carol": true })); // not another co-host
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "members/dave": null, "names/dave": null, "banned/dave": true }));
  await assertFails(update(ref(db("bob"), `rooms/${C}/meta`), { locked: true })); // room settings stay the owner's
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { owner: "zed" })); // only to someone in the room
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { owner: "bob" }));
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { owner: "alice" }));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}/meta`), { locked: true }));
});

test("reports: one per person per message, read by the owner and co-hosts", async () => {
  await createRoom("alice"); await join("bob"); await join("carol"); await join("dave");
  const m = await say("bob", "spam");
  const report = (uid, r = 1) => set(ref(db(uid), `rooms/${C}/reports/${m}/${uid}`), { r, at: T });
  await assertSucceeds(report("carol"));
  await assertFails(report("carol")); // already reported
  await assertFails(report("dave", 7));
  await assertFails(set(ref(db("dave"), `rooms/${C}/reports/${m}/carol`), { r: 0, at: T })); // not for someone else
  await assertFails(set(ref(db("dave"), `rooms/${C}/reports/nope/dave`), { r: 0, at: T }));
  await assertFails(get(ref(db("carol"), `rooms/${C}/reports`)));
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/reports`)));
  await set(ref(db("alice"), `rooms/${C}/meta/mods/dave`), true);
  await assertSucceeds(get(ref(db("dave"), `rooms/${C}/reports`)));
  await assertFails(remove(ref(db("bob"), `rooms/${C}/reports/${m}`)));
  await assertSucceeds(remove(ref(db("dave"), `rooms/${C}/reports/${m}`)));
});

test("typing: members say they're typing, only in their own name", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/typing/bob`), T));
  await assertFails(set(ref(db("bob"), `rooms/${C}/typing/alice`), T));
  await assertFails(set(ref(db("bob"), `rooms/${C}/typing/bob`), 5));
  await assertFails(set(ref(db("zed"), `rooms/${C}/typing/zed`), T));
  await assertSucceeds(get(ref(db("carol"), `rooms/${C}/typing`)));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/dmt/alice_bob/bob`), T));
  await assertFails(set(ref(db("bob"), `rooms/${C}/dmt/alice_carol/bob`), T));
  await assertFails(get(ref(db("carol"), `rooms/${C}/dmt/alice_bob`)));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/typing/bob`), null));
});

test("size limit: joining counts up to the limit, leaving counts down", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(update(ref(db("bob"), `rooms/${C}/meta`), { cap: 3, n: 2 }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { cap: 3, n: 2 }));
  const joinN = (uid, n) => update(ref(db(uid)), { [`rooms/${C}/members/${uid}`]: member(uid), [`rooms/${C}/names/${uid}`]: uid, [`rooms/${C}/meta/last`]: T, [`rooms/${C}/meta/n`]: n });
  await assertFails(join("carol")); // without counting itself
  await assertFails(joinN("carol", 4));
  await assertSucceeds(joinN("carol", 3));
  await assertFails(joinN("dave", 4)); // full
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/n`), 1)); // can't count down while staying
  await assertSucceeds(update(ref(db("carol"), `rooms/${C}`), { "members/carol": null, "names/carol": null, "meta/n": 2 }));
  await assertSucceeds(joinN("dave", 3));
});

test("reactions: members toggle their own", async () => {
  await createRoom("alice"); await join("bob");
  const m = { key: await say("alice", "1") };
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
  await assertFails(post("bob", `dm/${pair}`, { by: "bob", to: "alice", text: "悄悄話", at: T })); // never in the clear
  await assertSucceeds(post("bob", `dm/${pair}`, { by: "bob", to: "alice", x: "c2VhbGVk", at: T }));
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/dm/${pair}`)));
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/dm/${pair}`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/dm/${pair}`)));
  await assertFails(post("carol", `dm/${pair}`, { by: "carol", to: "alice", x: "eA", at: T }));
  await assertFails(post("bob", `dm/bob_dave`, { by: "bob", to: "dave", x: "eA", at: T })); // dave isn't here
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
  const gif = (url) => post("bob", "msgs", { by: "bob", name: "x", avatar: "🦊", gif: { url, w: 200, h: 150, title: "cat" }, at: T });
  await assertSucceeds(gif("https://static.klipy.com/ii/abc/cat.gif"));
  await assertFails(gif("https://evil.example.com/track.gif"));
  await assertFails(gif("https://klipy.com.evil.example/x.gif"));
  await assertFails(gif("http://static.klipy.com/x.gif"));
  await assertFails(post("bob", "msgs", { by: "bob", name: "x", avatar: "🦊", at: T })); // neither text nor gif
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
  
  await assertFails(post("bob", "msgs", { by: "bob", name: "x", avatar: "🦊", text: "明文", at: T }));
  await assertFails(post("bob", "msgs", { by: "bob", x: "c2VhbGVk", text: "明文", at: T }));
  await assertFails(post("bob", "msgs", { by: "bob", x: "not base64!", at: T }));
  await assertSucceeds(post("bob", "msgs", { by: "bob", x: "c2VhbGVk", at: T }));
  // the owner can't quietly turn encryption off
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { enc: false }));
  await assertFails(set(ref(db("alice"), `rooms/${C}/meta/enc`), null));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/locked`), true));
  await assertFails(post("bob", "msgs", { by: "bob", x: "c2VhbGVk", rp: "-Nabc123", at: T })); // a reply is sealed inside x
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/pins/0`), "-Nabc123"));
  // renaming keeps the title sealed
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { title: "明文" }));
  await assertFails(update(ref(db("bob"), `rooms/${C}/meta`), { xt: "bmV3" }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { xt: "bmV3" }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { xt: null }));
  // after 24 idle hours the code can become an ordinary room again
  await admin((d) => update(ref(d, `rooms/${C}/meta`), { last: Date.now() - 86400000 - 60000 }));
  await assertSucceeds(createRoom("carol"));
});

test("ciphertext only in encrypted rooms", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(post("bob", "msgs", { by: "bob", x: "c2VhbGVk", at: T }));
  await assertFails(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: encMember(H("c")), [`rooms/${C}/names/${H("c")}`]: "carol" }));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/members/bob/pk`), "cGs")); // publishing a public key
});

test("photos: the picture sits under files/, the message points at it", async () => {
  await createRoom("alice"); await join("bob");
  const pic = (uid, f, d = "_9j_4AAQ") => update(ref(db(uid)), {
    [`rooms/${C}/files/${f}`]: { by: uid, d, at: T },
    [`rooms/${C}/msgs/m${f}`]: { by: uid, name: "x", avatar: "🦊", img: { f, w: 800, h: 600 }, at: T },
    [`rooms/${C}/members/${uid}/ls`]: T, [`rooms/${C}/members/${uid}/lm`]: "m" + f, [`rooms/${C}/members/${uid}/lf`]: f,
  }).finally(() => admin((d) => remove(ref(d, `rooms/${C}/members/${uid}/ls`))));
  await assertSucceeds(pic("bob", "f1"));
  await assertFails(pic("bob", "f2", "a".repeat(450001))); // too big
  await assertFails(post("bob", `msgs/mx`, { by: "bob", name: "x", avatar: "🦊", img: { f: "nothere", w: 1, h: 1 }, at: T }));
  await assertFails(post("alice", `msgs/my`, { by: "alice", name: "x", avatar: "🦊", img: { f: "f1", w: 1, h: 1 }, at: T })); // someone else's picture
  await assertFails(set(ref(db("carol"), `rooms/${C}/files/f1`), null)); // only the author (or the owner) deletes it
  await assertFails(get(ref(db("carol"), `rooms/${C}/files/f1`)));
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/files/f1`)));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "msgs/mf1": null, "files/f1": null }));
  // a new room can't come with pictures already in it
  await assertFails(update(ref(db("dave")), { [`rooms/ABCD`]: { meta: { owner: "dave", created: T, last: T, priv: false }, members: { dave: member("d") }, names: { d: "dave" }, files: { f: { by: "dave", d: "x", at: T } } } }));
});

test("polls: one vote or several, only while open", async () => {
  await createRoom("alice"); await join("bob");
  const poll = (m, o = { 0: "甲", 1: "乙", 2: "丙" }) => post("alice", `msgs/p${+m}`, { by: "alice", name: "x", avatar: "🦊", poll: { q: "吃什麼", o, m }, at: T });
  await assertFails(poll(false, { 0: "只有一個" }));
  await assertSucceeds(poll(false));
  await assertSucceeds(poll(true));
  const vote = (uid, id, v) => set(ref(db(uid), `rooms/${C}/msgs/${id}/votes/${uid}`), v);
  await assertSucceeds(vote("bob", "p0", "1"));
  await assertFails(vote("bob", "p0", "0,1")); // one vote per person
  await assertSucceeds(vote("bob", "p1", "0,2"));
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/p1/votes/alice`), "0")); // not for someone else
  await assertFails(vote("carol", "p1", "0")); // not a member
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/p0/closed`), true)); // only its author closes it
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/msgs/p0/closed`), true));
  await assertFails(vote("bob", "p0", "0"));
  await assertFails(vote("bob", "p0", null));
});

test("draws: who took part and who was drawn", async () => {
  await createRoom("alice"); await join("bob");
  const draw = (d) => post("bob", "msgs", { by: "bob", name: "x", avatar: "🦊", draw: d, at: T });
  await assertSucceeds(draw({ t: "誰請飲料", p: ["alice", "bob"], w: ["alice"] }));
  await assertFails(draw({ t: "x", p: ["alice"] }));
  await assertFails(draw({ p: ["alice"], w: ["alice"], extra: 1 }));
});

test("encrypted room: photos, polls and votes are sealed", async () => {
  await createEnc("alice"); await joinEnc("bob", H("b"));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "files/f1": { by: "bob", d: "c2VhbGVk", at: T }, "msgs/m1": { by: "bob", x: "c2VhbGVk", at: T }, "members/bob/ls": T, "members/bob/lm": "m1", "members/bob/lf": "f1" }));
  await assertFails(post("bob", `msgs/m2`, { by: "bob", x: "c2VhbGVk", poll: { q: "明文", o: ["a", "b"], m: false }, at: T }));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/msgs/m1/votes/alice`), "c2VhbGVk"));
  await assertFails(set(ref(db("alice"), `rooms/${C}/msgs/m1/votes/alice`), "0,1"));
});
