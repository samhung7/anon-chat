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

test("a made-up nickname (a colour on an animal) fits a nickname in every language, and no two are the same", async () => {
  const { colourNick, COLOURS } = await import(new URL("text.js?v=dev", APP));
  const { ANIMALS, LIMITS } = await import(new URL("constants.js?v=dev", APP));
  const t = I18N.t;
  try {
    for (const [lang, d] of Object.entries(dicts)) {
      I18N.t = (k, vars) => d[k].replace(/\{(\w+)\}/g, (m, v) => (vars && v in vars ? vars[v] : m));
      assert.match(d.avg, new RegExp(`^(|[mfn]{${ANIMALS.length}})$`), lang + " avg");
      const all = new Set();
      for (let c = 0; c < COLOURS; c++) {
        assert.ok(d["col" + c].split("|").length <= 3, `${lang} col${c}`);
        if (d["col" + c].includes("|")) assert.ok(d.avg, `${lang} col${c} has a form for each gender, but there are no genders`);
        for (let i = 0; i < ANIMALS.length; i++) {
          const n = colourNick(c, i);
          assert.ok(n.length <= LIMITS.name && !/[|{}]/.test(n), `${lang}: ${n}`);
          all.add(n.toLowerCase());
        }
      }
      assert.equal(all.size, COLOURS * ANIMALS.length, lang);
    }
    I18N.t = (k, vars) => dicts.fr[k].replace(/\{(\w+)\}/g, (m, v) => vars[v]);
    assert.equal(colourNick(3, 5), "Grenouille verte");
    I18N.t = (k, vars) => dicts.de[k].replace(/\{(\w+)\}/g, (m, v) => vars[v]);
    assert.deepEqual([colourNick(0, 1), colourNick(0, 8), colourNick(0, 10)], ["Roter Fuchs", "Rote Eule", "Rotes Einhorn"]);
  } finally { I18N.t = t; }
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

test("the side panel extension frames stoatalk.app, may reach its storage, and only extension pages may frame the site", () => {
  const EXT = new URL("../extension/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", EXT), "utf8"));
  const panel = readFileSync(new URL(manifest.side_panel.default_path, EXT), "utf8");
  const [, script] = panel.match(/<script src="([^"]+)"><\/script>/);
  assert.match(readFileSync(new URL(script, EXT), "utf8"), /^const SITE = "https:\/\/stoatalk\.app\/";$/m);
  // without host permission Chrome may give the frame a storage of its own, and the panel would be someone else
  assert.deepEqual(manifest.host_permissions, ["https://stoatalk.app/*"]);
  for (const f of [manifest.background.service_worker, ...Object.values(manifest.icons)]) readFileSync(new URL(f, EXT));
  const locales = readdirSync(new URL("_locales/", EXT));
  for (const l of locales) {
    const m = JSON.parse(readFileSync(new URL(`_locales/${l}/messages.json`, EXT), "utf8"));
    for (const k of ["name", "description", "open", "loading", "openTab"]) assert.ok(m[k]?.message, `${l} has ${k}`);
    assert.ok(m.description.message.length <= 132, `${l} description fits the store's 132 characters`);
  }
  assert.ok(locales.includes(manifest.default_locale));
  const headers = readFileSync(new URL("_headers", SITE), "utf8");
  assert.match(headers, /^\/\*\n(?:  .+\n)*  Content-Security-Policy: frame-ancestors 'self' chrome-extension:\n/m);
  assert.doesNotMatch(headers, /X-Frame-Options/); // it would refuse the panel too, whatever frame-ancestors says
  assert.match(headers, /^\/admin\n  Content-Security-Policy: frame-ancestors 'none'$/m);
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
  assert.deepEqual(KIND.poll.pack({ q: "Q", o: ["a", "b"], m: false }), [{ poll: { q: "Q", o: ["a", "b"], m: false } }, { p: { q: "Q", o: ["a", "b"], m: false } }, {}]);
  // anonymous and hidden polls are marked beside the poll, and beside its sealed body too
  assert.deepEqual(KIND.poll.pack({ q: "Q", o: ["a", "b"], m: true, an: true, rv: 5 }),
    [{ poll: { q: "Q", o: ["a", "b"], m: true }, an: true, rv: 5 }, { p: { q: "Q", o: ["a", "b"], m: true } }, { an: true, rv: 5 }]);
  assert.equal(KIND.poll.unsealed({ p: { q: "Q", o: ["a", "b"] } }, true), null, "no polls in private chats");
  assert.deepEqual(KIND.poll.unsealed({ p: { q: "Q", o: { 0: "a", 1: "b" }, m: "yes" } }, false), { poll: { q: "Q", o: ["a", "b"], m: false } });
});

test("a message's time gains the month and day from yesterday back, and the year before this year", async () => {
  const { fmtTime, fmtWhen } = await import(new URL("text.js?v=dev", APP));
  const now = new Date(2026, 9, 19, 15, 0);
  assert.equal(fmtTime(new Date(2026, 9, 19, 10, 26), now), "10:26");
  assert.equal(fmtTime(new Date(2026, 9, 18, 23, 5), now), "10/18, 23:05");
  assert.equal(fmtTime(new Date(2025, 2, 5, 10, 26), now), "3/5/2025, 10:26");
  assert.match(fmtWhen(new Date(2026, 9, 18, 23, 5)), /October 18, 2026.*23:05/);
});

test("quiz: a set is cleaned, asked without its answers, scored by speed, ranked, and kept in a file", async () => {
  const Q = await import(new URL("quizset.js?v=dev", APP));
  const set = Q.cleanSet({ t: " 期中 ", q: [
    { t: "2+2?", o: ["3", "", "4", "5"], c: [2], d: 20, p: 1 },
    { t: "雙倍", o: ["a", "b"], c: [0, 1], d: 7, p: 2 },   // 7 isn't a time on offer: 20
    { t: "", o: ["x"], c: [9] },
    "not a question",
  ] });
  assert.equal(set.t, "期中");
  assert.equal(set.q.length, 3);
  assert.deepEqual(set.q[1].o, ["a", "b", "", ""]);
  assert.equal(set.q[1].d, 20);
  assert.deepEqual(set.q[2].c, []);
  assert.deepEqual(Q.setProblem(set), { i: 2, why: "qzNeedQ" });
  assert.equal(Q.problem({ ...set.q[2], t: "?", o: ["a", "b", "", ""] }), "qzNeedRight");
  assert.equal(Q.problem({ ...set.q[2], t: "?" }), "qzNeedOpts");
  assert.deepEqual(Q.setProblem({ t: "", q: set.q }), { i: -1, why: "qzNeedTitle" });
  // asked: the empty option goes, and the right answer follows it
  const [pub, key] = Q.asked(set.q[0]);
  assert.deepEqual(pub, { t: "2+2?", o: ["3", "4", "5"], d: 20, p: 1 });
  assert.deepEqual(key, [1]);
  // points: all of them at once, half at the last moment, double on a double question
  assert.equal(Q.points(pub, 0), 1000);
  assert.equal(Q.points(pub, 10000), 750);
  assert.equal(Q.points(pub, 99999), 500);
  assert.equal(Q.points({ ...pub, p: 2 }, 0), 2000);
  assert.equal(Q.points({ ...pub, p: 0 }, 0), 0);
  // scores: only players count; a wrong answer or none gets nothing; totals carry on; ties go to the faster
  const at = 1e12, players = { a: {}, b: {}, c: {}, d: {} };
  const s1 = Q.settle(pub, key, { a: { c: 1, at: at + 2000 }, b: { c: 1, at: at + 10000 }, c: { c: 0, at: at + 1000 }, x: { c: 1, at } }, players, null, at);
  assert.deepEqual(s1.n, [1, 2, 0]);
  assert.deepEqual(s1.g, { a: 950, b: 750, c: 0, d: 0 });
  const s2 = Q.settle(pub, key, { b: { c: 1, at: at + 2000 }, c: { c: 1, at } }, players, s1, at);
  assert.deepEqual(s2.sc, { a: 950, b: 1700, c: 1000, d: 0 });
  assert.deepEqual(s2.r, { a: 1, b: 2, c: 1, d: 0 });
  assert.deepEqual(Q.ranking(s2).map((r) => [r.uid, r.rank]), [["b", 1], ["c", 2], ["a", 3], ["d", 4]]);
  assert.deepEqual(Q.ranking({ sc: { a: 5, b: 5 }, ms: { a: 1, b: 1 }, r: {} }).map((r) => r.rank), [1, 1]);
  assert.deepEqual(Q.cleanScores(JSON.parse(JSON.stringify(s2))), s2);
  // read from the room, untrusted
  assert.equal(Q.cleanAsked({ t: "x", o: ["only one"] }), null);
  assert.deepEqual(Q.cleanKey([1, 1, 7, "2", -1]), [1]);
  assert.equal(Q.cleanLive({ ph: "q", i: "3", at: 1 }), null);
  assert.equal(Q.cleanChoice(4), null);
  // a file: what goes out comes back; anything else is refused
  assert.deepEqual(Q.fromFile(Q.toFile(set)), set);
  assert.equal(Q.fromFile("{}"), null);
  assert.equal(Q.fromFile("not json"), null);
  assert.equal(Q.fromFile(JSON.stringify({ kind: "stoatalk-quiz", v: 1, t: "x", q: [] })), null);
  assert.match(Q.scoresCsv([[1, 'A "b", c', 900, 1]], ["Rank", "Name", "Points", "Right"]), /^﻿Rank,Name,Points,Right\r\n1,"A ""b"", c",900,1\r\n$/);
  // a picture: kept in a set and a file as the JPEG itself; in the room only where it is, and that goes out with the question
  const img = { d: "_9j_4AAQ", w: 640, h: 480 }, f = "-Nquiz0000000000000Aabc123XYZ0";
  const withPic = Q.cleanSet({ t: "p", q: [{ ...set.q[0], img, im: { f, w: 640, h: 480 } }] }).q[0];
  assert.deepEqual([withPic.img, withPic.im], [img, { f, w: 640, h: 480 }]);
  assert.equal(Q.cleanQuestion({ ...set.q[0], img: { d: "not base64!", w: 1, h: 1 } }).img, undefined);
  assert.equal(Q.cleanQuestion({ ...set.q[0], img: { d: "x".repeat(Q.QUIZ.imgChars + 1), w: 1, h: 1 } }).img, undefined);
  assert.equal(Q.cleanQuestion({ ...set.q[0], img: { ...img, w: 0 } }).img, undefined);
  assert.equal(Q.cleanQuestion({ ...set.q[0], im: { f: "../x", w: 1, h: 1 } }).im, undefined);
  assert.deepEqual(Q.asked(withPic)[0].im, { f, w: 640, h: 480 });
  assert.deepEqual(Q.cleanAsked(Q.asked(withPic)[0]).im, { f, w: 640, h: 480 });
  const back = Q.fromFile(Q.toFile({ t: "p", q: [withPic] })).q[0];
  assert.deepEqual([back.img, back.im], [img, undefined]);
});

test("a scanned QR Code joins only when it's a StoaTalk invite link, and keeps a Private Salon's key", async () => {
  const { roomLink } = await import(new URL("scan.js?v=dev", APP));
  const key = "A".repeat(43);
  assert.equal(roomLink("https://stoatalk.app/?room=K7QM"), "?room=K7QM");
  assert.equal(roomLink(` https://www.stoatalk.app/?room=k7qm#k=${key}\n`), `?room=k7qm#k=${key}`);
  assert.equal(roomLink("https://stoatalk.app/index.html?lang=ja&room=K7QM&show=1"), "?room=K7QM");
  for (const no of ["https://evil.example/?room=K7QM", "http://stoatalk.app/?room=K7QM", "https://stoatalk.app.evil.example/?room=K7QM",
    "https://stoatalk.app/?room=K7Q", "https://stoatalk.app/", "K7QM", "javascript:alert(1)", "", null]) assert.equal(roomLink(no), null, String(no));
});
