// Unit tests of the page's own modules that need no browser: the record format, encryption, the kinds of message,
// and the files the page is made of. npm test (they don't need the emulator, but run with the rest).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SITE = new URL("../site/", import.meta.url);
const APP = new URL("js/app/", SITE);
const MODULES = readdirSync(APP).filter((f) => f.endsWith(".js"));
const dicts = {};
let archive, crypto, kinds;

before(async () => {
  // just enough of a browser for the modules to load: no DOM is touched until something is drawn
  globalThis.window = globalThis;
  globalThis.location = new URL("https://stoatalk.app/");
  globalThis.I18N = { add: (lang, d) => (dicts[lang] = d), lang: "en", t: (k, vars) => (dicts.en[k] ?? k).replace(/\{(\w+)\}/g, (m, v) => (vars && v in vars ? vars[v] : m)) };
  for (const f of readdirSync(new URL("js/i18n/", SITE))) new Function(readFileSync(new URL("js/i18n/" + f, SITE), "utf8"))();
  archive = await import(new URL("archive.js?v=dev", APP));
  crypto = await import(new URL("crypto.js?v=dev", APP));
  kinds = await import(new URL("kinds.js?v=dev", APP));
});

test("every language has the same keys, and every t(\"key\") the page uses exists", () => {
  const keys = Object.keys(dicts.en).sort();
  assert.equal(Object.keys(dicts).length, 9);
  for (const [lang, d] of Object.entries(dicts)) assert.deepEqual(Object.keys(d).sort(), keys, lang);
  for (const f of MODULES) {
    const src = readFileSync(new URL(f, APP), "utf8");
    for (const [, k] of src.matchAll(/\bt\("(\w+)"[,)]/g)) assert.ok(k in dicts.en, `${f}: t("${k}") has no text`);
  }
});

test("each module is imported with ?v=dev, preloaded by the page and kept by the service worker", () => {
  const sw = readFileSync(new URL("sw.js", SITE), "utf8"), page = readFileSync(new URL("index.html", SITE), "utf8");
  for (const f of MODULES) {
    const src = readFileSync(new URL(f, APP), "utf8");
    for (const [, spec] of src.matchAll(/\bfrom "([^"]+)"/g)) assert.match(spec, /^\.\/[\w-]+\.js\?v=dev$/, `${f} imports ${spec}`);
    assert.ok(sw.includes(`"js/app/${f}"`), `sw.js keeps js/app/${f}`);
    assert.ok(page.includes(`<link rel="modulepreload" href="js/app/${f}?v=dev">`), `index.html preloads js/app/${f}`);
  }
  assert.match(page, /<script type="module" src="js\/app\/main\.js\?v=dev"><\/script>/);
});

test("a record read back from a file keeps only what it knows, within the limits", () => {
  const { readArchive, countOf } = archive;
  assert.throws(() => readArchive({ format: "something else", version: 1, messages: [] }));
  assert.throws(() => readArchive(null));
  const a = readArchive({
    format: "anon-chat-archive", version: 1, title: "x".repeat(100), code: "K7QMZZ", exported: "12", extra: "dropped",
    me: { name: "Me", avatar: "🦊" },
    messages: [
      { name: "A", avatar: "🐻", at: 1, text: "hi", reactions: { "👍": 2, "💩": 5 }, evil: "<script>" },
      { name: "B", at: 2, gif: { url: "https://evil.example/x.gif", w: 1, h: 1 } }, // not from KLIPY: dropped, and nothing else is left
      { name: "C", at: 3, gif: { url: "https://static.klipy.com/a.gif", w: 10, h: 20 } },
      { name: "D", at: 4, poll: { q: "Tea?", o: [{ t: "yes", n: 1 }, { t: "no", n: "x" }], total: 1 } },
      { name: "E", at: 5, poll: { q: "One option", o: [{ t: "only" }] } }, // a poll needs two
      { name: "F", at: 6, text: "a".repeat(2000) },
    ],
    dms: [{ with: { name: "Z" }, messages: [{ name: "Z", at: 1, text: "psst" }] }, { with: { name: "Y" }, messages: [] }],
    questions: [{ text: "Why?", votes: 99999, answer: { text: "Because" } }, { text: "" }],
  });
  assert.equal(a.title.length, 60);
  assert.equal(a.code, "K7QM");
  assert.equal(a.exported, 12);
  assert.equal(a.extra, undefined);
  assert.deepEqual(a.messages.map((m) => m.name), ["A", "C", "D", "F"]);
  assert.deepEqual(a.messages[0].reactions, { "👍": 2 });
  assert.equal(a.messages[0].evil, undefined);
  assert.equal(a.messages[1].gif.url, "https://static.klipy.com/a.gif");
  assert.deepEqual(a.messages[2].poll.o, [{ t: "yes", n: 1 }, { t: "no", n: 0 }]);
  assert.equal(a.messages[3].text.length, 1000);
  assert.equal(a.dms.length, 1);
  assert.equal(a.questions.length, 1);
  assert.equal(a.questions[0].votes, 9999);
  assert.equal(a.questions[0].answer.text, "Because");
  assert.equal(countOf(a), 4 + 1 + 1);
  // reading it again changes nothing
  assert.deepEqual(readArchive(JSON.parse(JSON.stringify(a))), a);
});

test("a record as text and as a web page", () => {
  const a = archive.readArchive({
    format: "anon-chat-archive", version: 1, title: "Club <b>", code: "K7QM", exported: 0, me: { name: "Me" },
    messages: [{ name: "A", avatar: "🐻", at: 0, text: "line one\nline two <i>" }, { name: "B", avatar: "🦊", at: 0, mine: true, photo: { w: 4, h: 3 } },
      { name: "C", avatar: "🐼", at: 0, draw: { t: "Snacks", p: ["A", "B"], w: ["B"] } }],
    dms: [], questions: [{ text: "Q?", votes: 2, done: true }],
  });
  const text = archive.toText(a);
  assert.match(text, /🐻 A: line one\n {4}line two <i>/);
  assert.match(text, /🦊 B \(me\): 📷 Photo/);
  assert.match(text, /🎲 Snacks\n/);
  assert.match(text, /\[▲ 2 · .*Anonymous · .*· Answered\]\n {4}Q\?/);
  const html = archive.toHtml(a);
  assert.ok(html.includes("<title>Club &lt;b&gt;</title>"));
  assert.ok(html.includes("line two &lt;i&gt;"));
  assert.ok(!html.includes("<i>"));
  // the record rides along inside, and reads back the same
  const data = html.match(/<script type="application\/json" id="anon-chat-archive">(.*)<\/script>/s)[1];
  assert.deepEqual(archive.readArchive(JSON.parse(data)), a);
});

test("sealing: only the right key and the right author open it", async () => {
  const { RoomCipher, seal, unseal, b64u, unb64u } = crypto;
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const c = await RoomCipher.fromRaw(raw), same = await RoomCipher.fromLink(b64u(raw));
  const other = await RoomCipher.fromRaw(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  assert.deepEqual(unb64u(b64u(raw)), raw);
  const x = await c.seal({ t: "secret" }, "m:alice");
  assert.deepEqual(await same.unseal(x, "m:alice"), { t: "secret" });
  assert.equal(await same.unseal(x, "m:bob"), null, "moved onto someone else");
  assert.equal(await other.unseal(x, "m:alice"), null, "another room's key");
  assert.equal(await c.unseal("not sealed", "m:alice"), null);
  assert.equal(await c.keyCheck(), await same.keyCheck());
  assert.notEqual(await c.keyCheck(), await other.keyCheck());
  assert.match(await c.mac("name:bob"), /^[0-9a-f]{24}$/);
  assert.deepEqual(await unseal(c.aes, await seal(c.aes, "0,2", "v"), "v"), "0,2");
});

test("kinds of message: each message is exactly one, and says itself in a line", () => {
  const { kindOf, savedKindOf, snippet, KIND } = kinds;
  assert.equal(kindOf({ text: "hi" }), KIND.text);
  assert.equal(kindOf({ gif: { url: "u" } }), KIND.gif);
  assert.equal(kindOf({ img: { f: "a" } }), KIND.photo);
  assert.equal(kindOf({ poll: { q: "Q", o: ["a", "b"] } }), KIND.poll);
  assert.equal(kindOf({ draw: { p: [], w: [] } }), KIND.draw);
  assert.equal(savedKindOf({ photo: { w: 1, h: 1 } }), KIND.photo);
  assert.equal(snippet({ text: "a\n\n b" }), "a b");
  assert.equal(snippet({ text: "x".repeat(200) }).length, 80);
  assert.equal(snippet({ poll: { q: "Tea?" } }), "📊 Tea?");
  assert.equal(snippet({ gif: {} }), "GIF");
  // what each kind stores, plain and sealed
  assert.deepEqual(KIND.text.pack("hi"), [{ text: "hi" }, { t: "hi" }]);
  assert.deepEqual(KIND.poll.pack({ q: "Q" }), [{ poll: { q: "Q" } }, { p: { q: "Q" } }]);
  assert.equal(KIND.poll.unsealed({ p: { q: "Q", o: ["a", "b"] } }, true), null, "no polls in private chats");
  assert.deepEqual(KIND.poll.unsealed({ p: { q: "Q", o: { 0: "a", 1: "b" }, m: "yes" } }, false), { poll: { q: "Q", o: ["a", "b"], m: false } });
});
