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
const createRoom = (uid, { code = C } = {}) =>
  update(ref(db(uid)), {
    [`rooms/${code}`]: { meta: { owner: uid, created: T, last: T }, members: { [uid]: member("房主") }, names: { "房主": uid } },
  });
const join = (uid, name = uid) => update(ref(db(uid)), {
  [`rooms/${C}/members/${uid}`]: member(name),
  [`rooms/${C}/names/${name.toLowerCase()}`]: uid,
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

const idle = (ms) => admin((d) => update(ref(d, `rooms/${C}/meta`), { last: Date.now() - ms }));
const HOUR = 3600000;

test("a room idle for 48 hours can be taken over or cleared by anyone", async () => {
  await createRoom("alice");
  await idle(48 * HOUR + 60000);
  await assertFails(join("bob")); // can't join an expired room
  await assertSucceeds(createRoom("bob"));
  await idle(48 * HOUR + 60000);
  await assertSucceeds(update(ref(db("carol")), { [`rooms/${C}`]: null }));
});

test("after 24 quiet hours a room is read-only: members read it, nothing new goes in, and it can't be taken over yet", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  const m = await say("alice", "早安");
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/qa`), true));
  await idle(23.5 * HOUR); // the warning hour: still open, and speaking keeps it going
  await assertSucceeds(say("bob", "還在"));
  await idle(24 * HOUR + 60000);
  // reading, and keeping the record, still work
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/msgs`)));
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/members`)));
  // nothing new: no message, private message, edit, reaction, typing, or a fresh meta/last to keep it going
  await assertFails(say("bob", "再說一句"));
  await assertFails(post("bob", "dm/alice_bob", { by: "bob", to: "alice", x: "c2VhbGVk", at: T }));
  await assertFails(set(ref(db("alice"), `rooms/${C}/msgs/${m}/text`), "改字"));
  await assertFails(set(ref(db("bob"), `rooms/${C}/msgs/${m}/re/0/bob`), true));
  await assertFails(set(ref(db("bob"), `rooms/${C}/typing/bob`), T));
  await assertFails(ask("bob", "q1", { text: "還能問嗎" }));
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/last`), T));
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { title: "新名字", last: T }));
  await assertFails(set(ref(db("alice"), `rooms/${C}/meta/desc`), "說明"));
  await assertFails(join("dave")); // nobody new
  // nobody takes the code over, or clears it, before its 24 read-only hours are up; the owner can still end it
  await assertFails(createRoom("dave"));
  await assertFails(update(ref(db("dave")), { [`rooms/${C}`]: null }));
  // members can still take messages down, report, and leave
  await assertSucceeds(update(ref(db("carol"), `rooms/${C}/reports/${m}/carol`), { r: 1, at: T }));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/msgs/${m}`), null));
  await assertSucceeds(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: null, [`rooms/${C}/names/carol`]: null }));
  await assertSucceeds(update(ref(db("alice")), { [`rooms/${C}`]: null }));
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

test("password rooms are gone: none can be made, an old one lets nobody new in, and its leftovers can only be cleared", async () => {
  await assertFails(update(ref(db("alice")), { [`rooms/${C}`]: { meta: { owner: "alice", created: T, last: T, priv: true }, members: { alice: member("房主") }, names: { "房主": "alice" } } }));
  await createRoom("alice");
  await assertFails(set(ref(db("alice"), `secrets/${C}`), "hash"));
  await assertFails(set(ref(db("alice"), `rooms/${C}/keys/alice`), "hash"));
  // an old password room from before, with its password and a member's hash
  await admin((d) => update(ref(d), { [`rooms/${C}/meta/priv`]: true, [`secrets/${C}`]: "h", [`rooms/${C}/keys/alice`]: "h" }));
  await assertFails(join("bob"));
  await assertFails(get(ref(db("bob"), `secrets/${C}`)));
  await assertFails(update(ref(db("bob")), { [`secrets/${C}`]: null }));
  await assertSucceeds(update(ref(db("alice")), { [`rooms/${C}/keys/alice`]: null }));
  await assertSucceeds(update(ref(db("alice")), { [`secrets/${C}`]: null }));
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

test("the room's description: the owner and co-hosts write it, in plain text up to 500 characters", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  await assertFails(update(ref(db("bob"), `rooms/${C}/meta`), { desc: "bob 寫的" }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { desc: "每週三晚上的讀書會\n請先讀第一章" }));
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { desc: "x".repeat(501) }));
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { desc: 42 }));
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { xd: "c2VhbGVk" })); // sealed only in a Private Salon
  await set(ref(db("alice"), `rooms/${C}/meta/mods/carol`), true);
  await assertSucceeds(update(ref(db("carol"), `rooms/${C}/meta`), { desc: "x".repeat(500) }));
  await assertFails(update(ref(db("carol"), `rooms/${C}/meta`), { title: "co-hosts don't rename" }));
  await assertSucceeds(update(ref(db("carol"), `rooms/${C}/meta`), { desc: null }));
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
  const joinN = (uid, n) => update(ref(db(uid)), { [`rooms/${C}/members/${uid}`]: member(uid), [`rooms/${C}/names/${uid}`]: uid, [`rooms/${C}/meta/n`]: n });
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

test("ending: only the owner deletes the room (and an old password with it)", async () => {
  await createRoom("alice"); await join("bob");
  await admin((d) => set(ref(d, `secrets/${C}`), "h"));
  await assertFails(update(ref(db("bob")), { [`rooms/${C}`]: null }));
  await assertFails(update(ref(db("bob")), { [`rooms/${C}`]: null, [`secrets/${C}`]: null }));
  await assertSucceeds(update(ref(db("alice")), { [`rooms/${C}`]: null, [`secrets/${C}`]: null }));
});

test("members leave on their own", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(remove(ref(db("bob"), `rooms/${C}/members/alice`)));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "members/bob": null, "names/bob": null }));
  await assertFails(say("bob"));
});

test("nicknames are unique in a room, ignoring case", async () => {
  await createRoom("alice"); await join("bob", "Sam");
  await assertFails(join("carol", "Sam"));
  await assertFails(join("carol", "SAM"));
  await assertFails(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: member("Sam"), [`rooms/${C}/names/sam-2`]: "carol" })); // name must match its claim
  await assertFails(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: member("a/b"), [`rooms/${C}/names/ab`]: "carol" })); // characters a key can't hold
  await assertSucceeds(join("carol", "Ray"));
  // renaming: claim the new name and give back the old one
  await assertFails(update(ref(db("carol"), `rooms/${C}`), { "members/carol/name": "Sam" }));
  await assertSucceeds(update(ref(db("carol"), `rooms/${C}`), { "members/carol/name": "Ray2", "names/ray2": "carol", "names/ray": null }));
  await assertFails(set(ref(db("carol"), `rooms/${C}/names/sam`), null)); // can't free someone else's name
  // when the holder has left, the name is free again
  await admin((d) => remove(ref(d, `rooms/${C}/members/bob`)));
  await assertSucceeds(join("dave", "Sam"));
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
const joinEnc = (uid, h) => update(ref(db(uid)), { [`rooms/${C}/members/${uid}`]: encMember(h), [`rooms/${C}/names/${h}`]: uid });

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
  // and so does the description
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { desc: "明文" }));
  await assertFails(update(ref(db("bob"), `rooms/${C}/meta`), { xd: "c2VhbGVk" }));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { xd: "c2VhbGVk" }));
  await assertFails(update(ref(db("alice"), `rooms/${C}/meta`), { xd: "not base64!" }));
  // after 48 idle hours the code can become an ordinary room again
  await idle(48 * HOUR + 60000);
  await assertSucceeds(createRoom("carol"));
});

test("ciphertext only in encrypted rooms", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(post("bob", "msgs", { by: "bob", x: "c2VhbGVk", at: T }));
  await assertFails(update(ref(db("carol")), { [`rooms/${C}/members/carol`]: encMember(H("c")), [`rooms/${C}/names/${H("c")}`]: "carol" }));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/members/bob/pk`), "cGs")); // publishing a public key
});

test("photos: a marker sits under files/, the message points at it", async () => {
  await createRoom("alice"); await join("bob");
  const pic = (uid, f, extra = {}) => update(ref(db(uid)), {
    [`rooms/${C}/files/${f}`]: { by: uid, at: T, ...extra },
    [`rooms/${C}/msgs/m${f}`]: { by: uid, name: "x", avatar: "🦊", img: { f, w: 800, h: 600 }, at: T },
    [`rooms/${C}/members/${uid}/ls`]: T, [`rooms/${C}/members/${uid}/lm`]: "m" + f, [`rooms/${C}/members/${uid}/lf`]: f,
  }).finally(() => admin((d) => remove(ref(d, `rooms/${C}/members/${uid}/ls`))));
  await assertSucceeds(pic("bob", "f1"));
  await assertFails(pic("bob", "f2", { d: "_9j_4AAQ" })); // the picture itself goes to R2, not into the database
  await assertFails(post("bob", `msgs/mx`, { by: "bob", name: "x", avatar: "🦊", img: { f: "nothere", w: 1, h: 1 }, at: T }));
  await assertFails(post("alice", `msgs/my`, { by: "alice", name: "x", avatar: "🦊", img: { f: "f1", w: 1, h: 1 }, at: T })); // someone else's picture
  await assertFails(set(ref(db("carol"), `rooms/${C}/files/f1`), null)); // only the author (or the owner) deletes it
  await assertFails(get(ref(db("carol"), `rooms/${C}/files/f1`)));
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/files/f1`)));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "msgs/mf1": null, "files/f1": null }));
  // a new room can't come with pictures already in it
  await assertFails(update(ref(db("dave")), { [`rooms/ABCD`]: { meta: { owner: "dave", created: T, last: T, priv: false }, members: { dave: member("d") }, names: { d: "dave" }, files: { f: { by: "dave", at: T } } } }));
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
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "files/f1": { by: "bob", at: T }, "msgs/m1": { by: "bob", x: "c2VhbGVk", at: T }, "members/bob/ls": T, "members/bob/lm": "m1", "members/bob/lf": "f1" }));
  await assertFails(post("bob", `msgs/m2`, { by: "bob", x: "c2VhbGVk", poll: { q: "明文", o: ["a", "b"], m: false }, at: T }));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/msgs/m1/votes/alice`), "c2VhbGVk"));
  await assertFails(set(ref(db("alice"), `rooms/${C}/msgs/m1/votes/alice`), "0,1"));
});

// a question as the app asks it: who asked goes in qby (only they can read it), and asking is rate-limited like posting
const ask = async (uid, id, body, { queued = false, by = uid } = {}) => {
  await admin((d) => remove(ref(d, `rooms/${C}/members/${uid}/ls`)));
  return update(ref(db(uid), `rooms/${C}`), { [`${queued ? "qq" : "qs"}/${id}`]: { at: T, ...body }, [`qby/${id}`]: by, [`members/${uid}/ls`]: T, [`members/${uid}/lq`]: id });
};

test("Q&A: members ask (anonymously too) once the owner turns it on; others upvote; staff mark answered", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  await assertFails(ask("bob", "q1", { text: "還沒開" }));
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/qa`), true)); // only the owner turns it on
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/qa`), true));
  await assertFails(ask("bob", "q1", { text: "冒名" }, { by: "carol" }));
  await assertFails(ask("bob", "q1", { text: "a".repeat(301) }));
  await assertFails(ask("bob", "q1", { text: "x", by: "bob" })); // no author on the question itself
  await assertSucceeds(ask("bob", "q1", { text: "匿名的問題" }));
  await assertSucceeds(ask("carol", "q2", { text: "具名的問題", name: "carol", avatar: "🦊" }));
  await assertFails(ask("carol", "q1", { text: "蓋掉別人的" }));
  await assertFails(update(ref(db("dave")), { [`rooms/${C}/qs/q3`]: { at: T, text: "外人" }, [`rooms/${C}/qby/q3`]: "dave" }));
  // who asked stays with the asker
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/qby/q1`)));
  await assertFails(get(ref(db("alice"), `rooms/${C}/qby/q1`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/qby`)));
  // upvotes: one each, not on your own
  await assertSucceeds(set(ref(db("carol"), `rooms/${C}/qs/q1/up/carol`), true));
  await assertFails(set(ref(db("carol"), `rooms/${C}/qs/q1/up/alice`), true));
  await assertFails(set(ref(db("bob"), `rooms/${C}/qs/q1/up/bob`), true));
  await assertFails(set(ref(db("bob"), `rooms/${C}/qs/nope/up/bob`), true));
  await assertSucceeds(set(ref(db("carol"), `rooms/${C}/qs/q1/up/carol`), null));
  // answered, and the one being answered now: the owner and co-hosts only
  await assertFails(set(ref(db("bob"), `rooms/${C}/qs/q2/done`), T));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/qs/q2/done`), T));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/mods/carol`), true));
  await assertSucceeds(set(ref(db("carol"), `rooms/${C}/meta/qnow`), "q1"));
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/qnow`), "q2"));
  await assertFails(set(ref(db("carol"), `rooms/${C}/qs/q1/text`), "改字"));
  // a written answer: the owner and co-hosts only, in their own name
  const ans = (by, extra = {}) => ({ by, name: "x", avatar: "🦊", text: "回答", at: T, ...extra });
  await assertFails(set(ref(db("bob"), `rooms/${C}/qs/q1/ans`), ans("bob")));
  await assertFails(set(ref(db("alice"), `rooms/${C}/qs/q1/ans`), ans("carol")));
  await assertFails(set(ref(db("alice"), `rooms/${C}/qs/q1/ans`), ans("alice", { text: "a".repeat(2001) })));
  await assertFails(set(ref(db("alice"), `rooms/${C}/qs/nope/ans`), ans("alice")));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/qs/q1/ans`), ans("alice")));
  await assertSucceeds(set(ref(db("carol"), `rooms/${C}/qs/q1/ans`), ans("carol", { text: "改寫" })));
  await assertSucceeds(set(ref(db("carol"), `rooms/${C}/qs/q1/ans`), null));
  // taking a question down: the asker or staff
  await assertFails(remove(ref(db("bob"), `rooms/${C}/qs/q2`)));
  await assertSucceeds(remove(ref(db("bob"), `rooms/${C}/qs/q1`)));
  await assertSucceeds(remove(ref(db("alice"), `rooms/${C}/qs/q2`)));
  // the owner turns it off: no more asking
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/qa`), false));
  await assertFails(ask("bob", "q4", { text: "關了" }));
});

test("Q&A with review: questions wait until the owner or a co-host lets them through", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}/meta`), { qa: true, qmod: true }));
  await assertFails(ask("bob", "q1", { text: "跳過審核" }));
  await assertSucceeds(ask("alice", "q0", { text: "房主的不用審核" })); // the owner's own question
  await assertSucceeds(ask("bob", "q1", { text: "等審核", name: "bob", avatar: "🐻" }, { queued: true }));
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/qq/q1`))); // the asker sees theirs is waiting
  await assertFails(get(ref(db("carol"), `rooms/${C}/qq/q1`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/qq`)));
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/qq`)));
  // letting it through moves it word for word
  await assertFails(update(ref(db("carol"), `rooms/${C}`), { "qs/q1": { at: T, text: "等審核", name: "bob", avatar: "🐻" }, "qq/q1": null }));
  await assertFails(update(ref(db("alice"), `rooms/${C}`), { "qs/q1": { at: T, text: "改過", name: "bob", avatar: "🐻" }, "qq/q1": null }));
  let at; await admin(async (d) => { at = (await get(ref(d, `rooms/${C}/qq/q1/at`))).val(); });
  await assertFails(update(ref(db("alice"), `rooms/${C}`), { "qs/q1": { at, text: "等審核" }, "qq/q1": null })); // dropping the name
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}`), { "qs/q1": { at, text: "等審核", name: "bob", avatar: "🐻" }, "qq/q1": null }));
  // turning one away
  await assertSucceeds(ask("bob", "q2", { text: "不妥" }, { queued: true }));
  await assertFails(remove(ref(db("carol"), `rooms/${C}/qq/q2`)));
  await assertSucceeds(remove(ref(db("alice"), `rooms/${C}/qq/q2`)));
  // the asker takes theirs back while it waits
  await assertSucceeds(ask("bob", "q3", { text: "算了" }, { queued: true }));
  await assertSucceeds(remove(ref(db("bob"), `rooms/${C}/qq/q3`)));
});

test("Q&A in an encrypted room is sealed", async () => {
  await createEnc("alice"); await joinEnc("bob", H("b"));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/qa`), true));
  await assertFails(ask("bob", "q1", { text: "明文" }));
  await assertFails(ask("bob", "q1", { x: "c2VhbGVk", name: "bob" }));
  await assertSucceeds(ask("bob", "q1", { x: "c2VhbGVk" }));
  await assertFails(set(ref(db("alice"), `rooms/${C}/qs/q1/ans`), { by: "alice", name: "x", avatar: "🦊", text: "明文", at: T }));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/qs/q1/ans`), { by: "alice", x: "c2VhbGVk", at: T }));
});

test("usage stats: anonymous daily counts that only go up by one", async () => {
  const s = (uid) => ref(db(uid), "stats/2026-10-16/msgs");
  await assertFails(set(ref(env.unauthenticatedContext().database(), "stats/2026-10-16/msgs"), 1));
  await assertFails(set(s("bob"), 5));
  await assertSucceeds(set(s("bob"), 1));
  await assertSucceeds(set(s("carol"), 2));
  await assertFails(set(s("carol"), 1));
  await assertFails(set(s("carol"), null));
  await assertFails(set(ref(db("bob"), "stats/2026-10-16/whatever"), 1));
  await assertFails(set(ref(db("bob"), "stats/today/msgs"), 1));
  await assertFails(get(ref(db("bob"), "stats")));
});

/* ---------- StoaTalk's operator: reports from every room, bans, push subscriptions ---------- */
const opsReport = (uid, msg, extra = {}) => ({ code: C, msg, by: uid, who: "alice", r: 1, at: T, t: "買粉絲", n: "房主", ...extra });
const makeAdmin = (uid) => admin((d) => set(ref(d, `ops/admins/${uid}`), true));
// the operator signs in with Google on admin.html; "op" below is that account
const opDb = (uid = "op") => env.authenticatedContext(uid, { firebase: { sign_in_provider: "google.com", identities: {} } }).database();

test("operator reports: a member reports someone else's message once; only the operator reads or clears them", async () => {
  await createRoom("alice"); await join("bob");
  const id = await say("alice", "買粉絲");
  const key = `${C}_${id}_bob`;
  await assertFails(set(ref(db("bob"), `ops/reports/${C}_${id}_carol`), opsReport("bob", id)));   // the key names the reporter
  await assertFails(set(ref(db("bob"), `ops/reports/${key}`), opsReport("bob", id, { who: "bob" }))); // must name the real author
  await assertFails(set(ref(db("carol"), `ops/reports/${C}_${id}_carol`), opsReport("carol", id))); // not in the room
  await assertFails(set(ref(db("bob"), `ops/reports/${key}`), opsReport("bob", id, { t: "a".repeat(1001) })));
  // the room's own report and the operator's go in one write, as the page sends them
  await assertSucceeds(update(ref(db("bob")), { [`rooms/${C}/reports/${id}/bob`]: { r: 1, at: T }, [`ops/reports/${key}`]: opsReport("bob", id) }));
  await assertFails(set(ref(db("bob"), `ops/reports/${key}`), opsReport("bob", id, { r: 2 })));   // once
  await assertFails(get(ref(db("bob"), "ops/reports")));
  await assertFails(get(ref(db("alice"), "ops/reports")));
  await assertFails(remove(ref(db("bob"), `ops/reports/${key}`)));
  await makeAdmin("op");
  await assertSucceeds(get(ref(opDb(), "ops/reports")));
  await assertSucceeds(get(ref(opDb(), "ops/admins/op")));
  await assertFails(get(ref(db("bob"), "ops/admins/op")));
  await assertFails(set(ref(opDb(), "ops/admins/bob"), true));   // only by hand, in the console
  await assertSucceeds(remove(ref(opDb(), `ops/reports/${key}`)));
});

test("operator: only a Google sign-in counts; an anonymous id on the list is no admin", async () => {
  await createRoom("alice"); await join("bob"); await makeAdmin("op");
  const id = await say("bob");
  await assertFails(get(ref(db("op"), "ops/reports")));
  await assertFails(get(ref(db("op"), "bans")));
  await assertFails(set(ref(db("op"), "bans/bob"), { at: T }));
  await assertFails(remove(ref(db("op"), `rooms/${C}/msgs/${id}`)));
  await assertFails(remove(ref(db("op"), `rooms/${C}`)));
  await assertFails(get(ref(opDb("mallory"), "ops/reports")));   // a Google account that isn't on the list
  await assertSucceeds(get(ref(opDb(), "ops/reports")));
});

test("operator: takes a message or a photo marker down, removes someone, ends a room", async () => {
  await createRoom("alice"); await join("bob"); await makeAdmin("op");
  const id = await say("bob");
  await assertFails(remove(ref(db("carol"), `rooms/${C}/msgs/${id}`)));
  await assertSucceeds(update(ref(opDb(), `rooms/${C}`), { [`msgs/${id}`]: null, [`reports/${id}`]: null }));
  await assertFails(set(ref(opDb(), `rooms/${C}/msgs/x1`), { by: "op", name: "x", avatar: "🦊", text: "hi", at: T }));   // can't post
  await assertSucceeds(update(ref(opDb(), `rooms/${C}`), { "members/bob": null, "banned/bob": true }));
  await assertFails(join("bob"));
  await assertSucceeds(remove(ref(opDb(), `rooms/${C}`)));
});

test("bans: a banned person can't open, join or write anywhere, can still leave, and can see the ban", async () => {
  await createRoom("alice"); await join("bob"); await makeAdmin("op");
  await assertFails(set(ref(db("bob"), "bans/bob"), { at: T }));
  await assertFails(set(ref(db("alice"), "bans/bob"), { at: T }));
  await assertSucceeds(set(ref(opDb(), "bans/bob"), { at: T, why: "spam" }));
  await assertSucceeds(get(ref(db("bob"), "bans/bob")));
  await assertFails(get(ref(db("carol"), "bans/bob")));
  await assertFails(say("bob"));
  await assertFails(createRoom("bob", { code: "K7QN" }));
  await assertFails(update(ref(db("bob")), { [`rooms/${C}/members/bob/name`]: "bobby", [`rooms/${C}/names/bobby`]: "bob" }));
  await assertSucceeds(remove(ref(db("bob"), `rooms/${C}/members/bob`)));   // leaving
  await assertFails(join("bob"));
  await assertSucceeds(remove(ref(opDb(), "bans/bob")));
  await assertSucceeds(join("bob"));
  await assertSucceeds(say("bob"));
});

test("push subscriptions: each member leaves their own (sealed), members read them, gone with the member", async () => {
  await createRoom("alice"); await join("bob");
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/push/bob`), "abc_DEF-123"));
  await assertFails(set(ref(db("bob"), `rooms/${C}/push/alice`), "abc"));
  await assertFails(set(ref(db("bob"), `rooms/${C}/push/bob`), "not sealed!"));
  await assertFails(set(ref(db("bob"), `rooms/${C}/push/bob`), "a".repeat(2001)));
  await assertFails(set(ref(db("carol"), `rooms/${C}/push/carol`), "abc"));   // not in the room
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/push`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/push`)));
  // leaving takes it away in the same write
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "members/bob": null, "names/bob": null, "push/bob": null }));
  await assertFails(update(ref(db("bob")), { [`rooms/${C}`]: { meta: { owner: "bob", created: T, last: T }, members: { bob: member("b") }, push: { bob: "x" } } }));
});

test("push announcements: a member stamps meta/pa, at most every 20 seconds", async () => {
  await createRoom("alice"); await join("bob");
  await assertFails(set(ref(db("carol"), `rooms/${C}/meta/pa`), T));
  await join("carol");
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/pa`), 5));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/meta/pa`), T));
  await assertFails(set(ref(db("carol"), `rooms/${C}/meta/pa`), T));   // too soon (the owner, who writes meta, isn't held to it)
  await admin((d) => set(ref(d, `rooms/${C}/meta/pa`), Date.now() - 21000));
  await assertSucceeds(set(ref(db("carol"), `rooms/${C}/meta/pa`), T));
});

test("mini-games: each member writes their own score of the day once; members read them; the owner can turn games off", async () => {
  await createRoom("alice"); await join("bob");
  const D = "2026-10-22", score = (extra = {}) => ({ s: 76, t: 92, l: "0123,4512,1234", at: T, ...extra });
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/games/${D}/mm/bob`), score()));
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/mm/bob`), score({ s: 100 })));   // once, never changed
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/mm/bob`), null));
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/qn/alice`), score({ l: "3150624" })));   // only your own
  await assertFails(set(ref(db("carol"), `rooms/${C}/games/${D}/qn/carol`), score({ l: "3150624" })));   // not in the room
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/xx/bob`), score()));   // no such game
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/22-10-2026/qn/bob`), score({ l: "3150624" })));
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/qn/bob`), score({ s: 101, l: "3150624" })));
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/qn/bob`), score({ l: "<script>" })));
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/qn/bob`), score({ x: "sealed" })));   // sealed only in a Private Salon
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/qn/bob`), { s: 90, t: 30, at: T }));   // no record to check it by
  await assertSucceeds(get(ref(db("alice"), `rooms/${C}/games/${D}`)));
  await assertFails(get(ref(db("carol"), `rooms/${C}/games/${D}`)));
  // games off: no new scores
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/ng`), true));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/ng`), true));
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/qn/bob`), score({ s: 90, l: "3150624" })));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/ng`), false));
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/games/${D}/qn/bob`), score({ s: 90, h: 0, m: 2, l: "3150624" })));
  // a read-only room takes no new scores either; a new room starts with none
  await idle(25 * 3600e3);
  await assertFails(set(ref(db("bob"), `rooms/${C}/games/${D}/zp/bob`), score({ l: "0123456789abcdefghijklmnopqrstuvwxyz" })));
  await assertFails(update(ref(db("dave")), { [`rooms/ABCD`]: { meta: { owner: "dave", created: T, last: T }, members: { dave: member("d") }, games: { [D]: { mm: { dave: score() } } } } }));
});

test("mini-games: a shared result carries the score its player has for that puzzle", async () => {
  await createRoom("alice"); await join("bob");
  const D = "2026-10-22", card = (extra = {}) => ({ by: "bob", name: "b", avatar: "🦊", at: T, game: { g: "mm", d: D, s: 76, t: 92, n: 3, r: "12,22,40", ...extra } });
  await assertFails(post("bob", "msgs", card()));   // no score yet
  await assertSucceeds(set(ref(db("bob"), `rooms/${C}/games/${D}/mm/bob`), { s: 76, t: 92, l: "0123,4512,1234", at: T }));
  await assertSucceeds(post("bob", "msgs", card()));
  await assertFails(post("bob", "msgs", card({ s: 100 })));   // not the score on record
  await assertFails(post("bob", "msgs", card({ g: "qn" })));
  await assertFails(post("bob", "msgs", card({ r: "<b>" })));
  await assertFails(post("bob", "msgs", card({ extra: 1 })));
});

test("mini-games in a Private Salon: the score is sealed", async () => {
  await createEnc("alice");
  const D = "2026-10-22";
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/games/${D}/zp/alice`), { x: "c2VhbGVk", at: T }));
  await assertFails(set(ref(db("alice"), `rooms/${C}/games/${D}/mm/alice`), { s: 76, t: 92, l: "0123", at: T }));
  await assertFails(set(ref(db("alice"), `rooms/${C}/games/${D}/qn/alice`), { x: "not sealed!", at: T }));
});

// a long post as the app sends it: the card in msgs/ (marked pt) and the whole text in posts/, in one update
const longPost = (uid, id, { card = { t: "標題", s: "開頭", n: 120 }, body = { b: "# 標題\n內文" }, sealed = false, more = {} } = {}) =>
  post(uid, `msgs/${id}`, sealed ? { by: uid, x: "c2VhbGVk", pt: true, at: T } : { by: uid, name: "x", avatar: "🦊", pt: true, post: card, at: T },
    { more: { [`posts/${id}`]: { by: uid, at: T, ...body }, ...more } });

test("long posts: hosts post them, members once the owner allows it; the text sits apart, written with its card", async () => {
  await createRoom("alice"); await join("bob"); await join("carol");
  await assertSucceeds(longPost("alice", "p1"));
  await assertFails(longPost("bob", "p2")); // members only once the owner opens it up
  await assertFails(set(ref(db("bob"), `rooms/${C}/meta/po`), true));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/mods/bob`), true));
  await assertSucceeds(longPost("bob", "p2")); // a co-host may
  await assertFails(longPost("carol", "p3"));
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/po`), true));
  await assertSucceeds(longPost("carol", "p3"));
  // card and text belong together, and to their author
  await assertFails(post("carol", "msgs/p4", { by: "carol", name: "x", avatar: "🦊", pt: true, post: { t: "t", s: "", n: 1 }, at: T })); // no text
  await assertFails(post("carol", "msgs/p5", { by: "carol", name: "x", avatar: "🦊", post: { t: "t", s: "", n: 1 }, at: T }, { more: { "posts/p5": { by: "carol", at: T, b: "x" } } })); // not marked
  await assertFails(post("carol", "msgs/p6", { by: "carol", name: "x", avatar: "🦊", text: "嗨", at: T }, { more: { "posts/p6": { by: "carol", at: T, b: "x" } } })); // a text with no post
  await assertFails(longPost("carol", "p7", { body: { b: "x".repeat(20001) } }));
  await assertSucceeds(longPost("carol", "p8", { body: { b: "x".repeat(20000) }, card: { t: "長", s: "x".repeat(200), n: 20000 } }));
  await assertFails(longPost("carol", "p9", { card: { t: "", s: "", n: 1 } }));
  await assertFails(longPost("carol", "p9", { card: { t: "t", s: "", n: 1 }, body: { b: "x", x: "c2VhbGVk" } })); // no ciphertext in an open room
  await assertFails(set(ref(db("bob"), `rooms/${C}/posts/p3`), { by: "bob", at: T, b: "換掉" })); // nobody writes over someone's post
  // members read the text; the author edits it (card and text), nobody else
  await assertSucceeds(get(ref(db("bob"), `rooms/${C}/posts/p1`)));
  await assertFails(get(ref(db("dave"), `rooms/${C}/posts/p1`)));
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}`), { "msgs/p1/post": { t: "新標題", s: "新", n: 3 }, "msgs/p1/ed": T, "posts/p1/b": "新內文", "posts/p1/ed": T }));
  await assertFails(update(ref(db("bob"), `rooms/${C}`), { "posts/p1/b": "亂改" }));
  await assertFails(update(ref(db("bob"), `rooms/${C}`), { "msgs/p1/post": { t: "亂改", s: "", n: 1 } }));
  // reactions as on any message
  await assertSucceeds(set(ref(db("carol"), `rooms/${C}/msgs/p1/re/0/carol`), true));
  // taken down with its card: the author, or the owner and co-hosts
  await assertFails(update(ref(db("carol"), `rooms/${C}`), { "msgs/p1": null, "posts/p1": null }));
  await assertSucceeds(update(ref(db("bob"), `rooms/${C}`), { "msgs/p1": null, "posts/p1": null }));
  await assertSucceeds(update(ref(db("carol"), `rooms/${C}`), { "msgs/p3": null, "posts/p3": null }));
  // the owner closes it again: members can't post new ones
  await assertSucceeds(set(ref(db("alice"), `rooms/${C}/meta/po`), false));
  await assertFails(longPost("carol", "p10"));
  // a new room can't come with posts already in it
  await assertFails(update(ref(db("dave")), { [`rooms/ABCD`]: { meta: { owner: "dave", created: T, last: T, priv: false }, members: { dave: member("d") }, names: { d: "dave" }, posts: { p: { by: "dave", at: T, b: "x" } } } }));
  // a read-only room takes no new post or edit
  await idle(24 * HOUR + 60000);
  await assertFails(longPost("alice", "p11"));
  await assertFails(update(ref(db("carol"), `rooms/${C}`), { "posts/p8/b": "晚了" }));
});

test("long posts: pictures are the author's own, already under files/", async () => {
  await createRoom("alice"); await join("bob");
  await admin((d) => update(ref(d, `rooms/${C}/files`), { f1: { by: "alice", at: Date.now() }, f2: { by: "bob", at: Date.now() } }));
  await assertSucceeds(longPost("alice", "p1", { card: { t: "t", s: "", n: 9, p: { 0: { f: "f1", w: 800, h: 600 } } } }));
  await assertFails(longPost("alice", "p2", { card: { t: "t", s: "", n: 9, p: { 0: { f: "f2", w: 800, h: 600 } } } }));
  await assertFails(longPost("alice", "p3", { card: { t: "t", s: "", n: 9, p: { 0: { f: "nope", w: 800, h: 600 } } } }));
  await assertFails(longPost("alice", "p4", { card: { t: "t", s: "", n: 9, p: { 9: { f: "f1", w: 800, h: 600 } } } })); // nine at most
});

test("long posts in a Private Salon: card and text are sealed", async () => {
  await createEnc("alice"); await joinEnc("bob", H("b"));
  await assertSucceeds(longPost("alice", "p1", { sealed: true, body: { x: "c2VhbGVk" } }));
  await assertFails(longPost("alice", "p2", { sealed: true, body: { b: "明文" } }));
  await assertFails(longPost("alice", "p3", { body: { x: "c2VhbGVk" } })); // a plain card
  await assertFails(longPost("bob", "p4", { sealed: true, body: { x: "c2VhbGVk" } })); // members only once allowed
  await assertSucceeds(update(ref(db("alice"), `rooms/${C}`), { "msgs/p1/x": "bmV3", "msgs/p1/ed": T, "posts/p1/x": "bmV3", "posts/p1/ed": T }));
  await assertFails(update(ref(db("alice"), `rooms/${C}`), { "posts/p1/x": "not base64!" }));
});
