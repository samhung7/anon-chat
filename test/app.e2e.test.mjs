// End-to-end checks of the page itself, in a real browser against the database emulator: npm test
// Two or three people, each in their own browser context, go through what the app does most: rooms, messages,
// encryption, private messages, Q&A, polls, export and import. They guard refactoring: what passes here has to keep passing.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const NS = "demo-anon-chat";
const EMU = "http://127.0.0.1:9000";
const SITE = new URL("../site/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const asOwner = { Authorization: "Bearer owner" };
const dbUrl = (path) => `${EMU}/${path}.json?ns=${NS}`;
const dbGet = (path) => fetch(dbUrl(path), { headers: asOwner }).then((r) => r.json());

let server, base, browser, errors;

before(async () => {
  // the rules the live database runs, so the page meets the same refusals it would in production
  const rules = readFileSync(new URL("../database.rules.json", import.meta.url), "utf8");
  const res = await fetch(`${EMU}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: asOwner, body: rules });
  assert.ok(res.ok, "the database emulator is running and took the rules");
  server = createServer((req, out) => {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    readFile(join(SITE, path), (err, body) => {
      if (err) { out.writeHead(404); return out.end(); }
      out.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" }); out.end(body);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });
beforeEach(async () => {
  errors = [];
  await fetch(dbUrl(""), { method: "DELETE", headers: asOwner });
});

// someone with their own browser (their own device storage and anonymous id)
async function person(as) {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${as}: ${e.message}`));
  await page.goto(`${base}/?emu&as=${as}`);
  await page.locator("#createBtn").waitFor();
  return page;
}
const sheet = (page) => page.locator(".overlay").last();
const press = (page, a) => sheet(page).locator(`[data-a="${a}"]`).click();
async function pickName(page, name) {
  await page.locator("#meName").fill(name);
  await press(page, "yes");
}
// opens a room and closes the invite sheet that follows; gives its code and invite link
async function createRoom(page, name, { priv = false, title = "" } = {}) {
  await page.locator("#createBtn").click();
  await pickName(page, name);
  if (title) await page.locator("#newTitle").fill(title);
  if (priv) await sheet(page).locator(".seg [data-v=priv]").click();
  await press(page, "yes");
  const share = sheet(page).locator(".share");
  await share.waitFor();
  const code = (await share.locator(".bigcode").textContent()).trim();
  const url = await share.locator(".linkrow input").inputValue();
  await page.keyboard.press("Escape");
  await page.locator("#chat").waitFor();
  return { code, url };
}
async function joinByLink(page, url, name) {
  await page.goto(url);
  await pickName(page, name);
  await page.locator("#chat").waitFor();
}
async function say(page, text) {
  await page.locator("#text").fill(text);
  await page.locator("#composer .send").click();
}
const bubble = (page, text) => page.locator("#list .msg .bub", { hasText: text });
async function menuPick(page, a) {
  await page.locator("#chat .bar [data-a=menu]").click();
  await press(page, a);
}
const noErrors = () => assert.deepEqual(errors, []);
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((ok) => setTimeout(ok, 100))) if (Date.now() > end) throw new Error("timed out");
}

test("open room: create, join with the code, talk, react, reply, edit, delete", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { title: "Book club" });
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}$/);
  assert.ok(!url.includes("#k="), "an open room's link has no key");
  assert.equal(await alice.locator("#roomTitle").textContent(), "Book club");

  // the code alone is enough for an open room
  await bob.locator("#joinCode").fill(code.toLowerCase());
  await bob.locator("#joinForm button").click();
  await pickName(bob, "Bob");
  await bob.locator("#chat").waitFor();
  await alice.locator("#peopleBtn .n", { hasText: "2" }).waitFor();

  await say(alice, "hello @Bob");
  await bubble(bob, "hello @Bob").waitFor();
  await bob.locator("#list .msg.atme").waitFor(); // a mention of me stands out
  const stored = Object.values(await dbGet(`rooms/${code}/msgs`));
  assert.equal(stored[0].text, "hello @Bob");
  assert.equal(stored[0].name, "Alice");

  // react from the message's ⋯
  await bob.locator("#list .msg .more").first().click();
  await sheet(bob).locator(".reactrow [data-a=re0]").click();
  await alice.locator("#list .msg .re .chip", { hasText: "1" }).waitFor();

  // reply quotes the original
  await bob.locator("#list .msg .more").first().click();
  await press(bob, "reply");
  await bob.locator("#replyBar").waitFor();
  await say(bob, "hi Alice");
  await alice.locator("#list .msg .rpq", { hasText: "hello" }).waitFor();

  // edit my own message
  await alice.locator("#list .msg.mine .more").first().click();
  await press(alice, "edit");
  await alice.locator("#editText").fill("hello everyone");
  await press(alice, "yes");
  await bubble(bob, "hello everyone").waitFor();
  await bob.locator("#list .msg .edited").first().waitFor();

  // delete my own message
  await bob.locator("#list .msg.mine .more").last().click();
  await press(bob, "del");
  await press(bob, "yes");
  await bubble(alice, "hi Alice").waitFor({ state: "detached" });
  noErrors();
});

test("private salon: only ciphertext on the server, the link is needed, private messages are sealed", async () => {
  const alice = await person("a"), bob = await person("b"), carol = await person("c");
  const { code, url } = await createRoom(alice, "Alice", { priv: true, title: "Secret" });
  assert.match(url, /#k=[A-Za-z0-9_-]{43}$/);
  const meta = await dbGet(`rooms/${code}/meta`);
  assert.equal(meta.enc, true);
  assert.equal(meta.title, undefined, "the title is only kept sealed");

  await joinByLink(bob, url, "Bob");
  assert.equal(await bob.locator("#roomTitle").textContent(), "Secret");
  await say(alice, "top secret words");
  await bubble(bob, "top secret words").waitFor();
  const msgs = Object.values(await dbGet(`rooms/${code}/msgs`));
  assert.ok(msgs[0].x && !msgs[0].text && !msgs[0].name, "messages are stored sealed");
  const members = await dbGet(`rooms/${code}/members`);
  assert.ok(Object.values(members).every((m) => m.x && m.h && !m.name), "nicknames are stored sealed");

  // the code alone asks for the full link
  await carol.locator("#joinCode").fill(code);
  await carol.locator("#joinForm button").click();
  await carol.locator("#joinLink").waitFor();
  await carol.locator("#joinLink").fill(url);
  await press(carol, "yes");
  await pickName(carol, "Carol");
  await bubble(carol, "top secret words").waitFor();

  // a private message between Bob and Alice
  await bob.locator("#peopleBtn").click();
  await sheet(bob).locator(".plist li", { hasText: "Alice" }).locator("[data-dm]").click();
  await bob.locator("#dmBar").waitFor();
  await say(bob, "just for you");
  await alice.locator("#peopleBtn .dot").waitFor();
  await alice.locator("#peopleBtn").click();
  await sheet(alice).locator(".plist li", { hasText: "Bob" }).locator("[data-dm]").click();
  await bubble(alice, "just for you").waitFor();
  const dms = await dbGet(`rooms/${code}/dm`);
  const dm = Object.values(Object.values(dms)[0])[0];
  assert.ok(dm.x && !dm.text, "private messages are stored sealed");
  noErrors();
});

test("lecture Q&A: ask anonymously, upvote, answer, projector screen", async () => {
  const alice = await person("a"), bob = await person("b");
  const { url } = await createRoom(alice, "Host");
  await joinByLink(bob, url, "Bob");
  await menuPick(alice, "qaon");
  await alice.locator("#askBar").waitFor();
  await bob.locator("#tabs [data-a=qa]").click();
  await bob.locator("#askBar").waitFor();
  assert.equal(await bob.locator("#askAnon").isChecked(), true);
  await say(bob, "What is a stoa?");
  const card = alice.locator(".qcard", { hasText: "What is a stoa?" });
  await card.waitFor();
  assert.ok(!(await card.locator(".qwho").textContent()).includes("Bob"), "the asker stays anonymous");
  await card.locator(".upvote").click();
  await card.locator(".upvote b", { hasText: "1" }).waitFor();
  await card.locator(".qtools .btn.primary").click(); // write an answer
  await alice.locator("#ansText").fill("A covered walkway.");
  await press(alice, "yes");
  await bob.locator(".qcard .qans", { hasText: "A covered walkway." }).waitFor({ state: "attached" }); // answered: folded under "answered"

  // the projector screen follows the room
  const [show] = await Promise.all([alice.context().waitForEvent("page"), menuPick(alice, "show")]);
  await show.locator("#show .sqr svg").waitFor();
  noErrors();
});

test("polls and draws", async () => {
  const alice = await person("a"), bob = await person("b");
  const { url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");

  await alice.locator("#composer [data-a=more]").click();
  await alice.locator("#picker .morebtn").nth(1).click();
  await alice.locator("#pollQ").fill("Tea or coffee?");
  const opts = sheet(alice).locator(".pollopts input");
  await opts.nth(0).fill("Tea"); await opts.nth(1).fill("Coffee");
  await press(alice, "yes");
  const poll = bob.locator(".pollbox", { hasText: "Tea or coffee?" });
  await poll.waitFor();
  await poll.locator(".opt").nth(1).click();
  await alice.locator(".pollbox .opt.on, .pollbox .opt").nth(1).locator(".oc", { hasText: "1" }).waitFor();

  await alice.locator("#composer [data-a=more]").click();
  await alice.locator("#picker .morebtn").nth(2).click();
  await alice.locator("#drawWhat").fill("Who brings snacks");
  await press(alice, "yes");
  await bob.locator(".drawbox .win").first().waitFor();
  noErrors();
});

test("export to a file, import it back read-only, and end the room", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { title: "Keep me" });
  await joinByLink(bob, url, "Bob");
  await say(bob, "remember this");
  await bubble(alice, "remember this").waitFor();

  await menuPick(alice, "export");
  const [file] = await Promise.all([alice.waitForEvent("download"), press(alice, "json")]);
  const a = JSON.parse(readFileSync(await file.path(), "utf8"));
  assert.equal(a.format, "anon-chat-archive");
  assert.equal(a.title, "Keep me");
  assert.deepEqual(a.messages.map((m) => [m.name, m.text]), [["Bob", "remember this"]]);

  // the owner ends the room: it is gone for everyone
  await menuPick(alice, "end");
  await press(alice, "yes");
  await alice.locator("#home").waitFor();
  assert.equal(await dbGet(`rooms/${code}`), null);
  await sheet(bob).locator("[data-a=home]").waitFor(); // Bob is told, and can keep a copy
  await press(bob, "save");
  await bob.locator("#record").waitFor();
  await bob.locator("#recList .bub", { hasText: "remember this" }).waitFor();

  // importing the exported file opens it read-only
  await alice.locator("#importFile").setInputFiles(await file.path());
  await alice.locator("#record").waitFor();
  assert.equal(await alice.locator("#recTitle").textContent(), "Keep me");
  await alice.locator("#recList .bub", { hasText: "remember this" }).waitFor();
  noErrors();
});

test("owner tools: co-host, remove someone, lock; a member leaves", async () => {
  const alice = await person("a"), bob = await person("b"), carol = await person("c");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  await joinByLink(carol, url, "Carol");

  const memberMenu = async (name, a) => {
    await alice.locator("#peopleBtn").click();
    await sheet(alice).locator(".plist li", { hasText: name }).locator("[data-pm]").click();
    await press(alice, a);
  };
  await memberMenu("Bob", "mod");
  await alice.locator(".toast").first().waitFor();
  assert.equal((await dbGet(`rooms/${code}/meta/mods`))[Object.keys(await dbGet(`rooms/${code}/meta/mods`))[0]], true);

  await memberMenu("Carol", "kick");
  await press(alice, "yes");
  await sheet(carol).locator("[data-a=home]").waitFor();
  assert.equal(Object.keys(await dbGet(`rooms/${code}/banned`)).length, 1);

  await menuPick(alice, "lock");
  await alice.locator("#codeBtn", { hasText: "·" }).waitFor();

  await menuPick(bob, "leave");
  await press(bob, "yes");
  await bob.locator("#home").waitFor();
  await alice.locator("#peopleBtn .n", { hasText: "1" }).waitFor();
  noErrors();
});

test("pins, reports, typing, mentions, photos, blocking", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  await say(alice, "read the rules");
  await bubble(bob, "read the rules").waitFor();

  // the owner pins it as an announcement
  await alice.locator("#list .msg.mine .more").first().click();
  await press(alice, "pin");
  await bob.locator("#pins .pinhead", { hasText: "read the rules" }).waitFor();

  // Bob reports it; the owner sees how many and why
  await bob.locator("#list .msg .more").first().click();
  await press(bob, "report");
  await press(bob, "r1");
  await alice.locator("#chat .bar [data-a=menu] .dot").waitFor();
  await menuPick(alice, "reports");
  await sheet(alice).locator(".replist li").first().waitFor();
  await alice.keyboard.press("Escape");

  // someone is typing; typing @ offers names
  await bob.locator("#text").pressSequentially("hmm");
  await alice.locator("#typingBar", { hasText: "Bob" }).waitFor();
  await alice.locator("#text").pressSequentially("@B");
  await alice.locator("#mentionBar .chip", { hasText: "Bob" }).click();
  assert.equal(await alice.locator("#text").inputValue(), "@Bob ");
  await bob.locator("#text").fill("");

  // a photo is shrunk, stored apart from the message, and shown to the room
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwHwyBDAYGBgYGAFHkCPuk1IufAAAAAElFTkSuQmCC", "base64");
  await bob.locator("#photoFile").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  await alice.locator("#list .imgbub img.photo[src^='blob:']").waitFor();
  assert.equal(Object.keys(await dbGet(`rooms/${code}/files`)).length, 1);

  // Bob blocks Alice: her messages fold away on his device only
  await bob.locator("#list .msg", { hasText: "read the rules" }).locator(".more").click();
  await press(bob, "block");
  await press(bob, "yes");
  await bob.locator("#list .msg.folded").first().waitFor();
  noErrors();
});

test("owner settings: rename, size limit, hand over; coming back after a reload; language", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { title: "Old name" });
  await joinByLink(bob, url, "Bob");

  await menuPick(alice, "title");
  await alice.locator("#roomName").fill("New name");
  await press(alice, "yes");
  await bob.locator("#roomTitle", { hasText: "New name" }).waitFor();

  await menuPick(alice, "cap");
  await alice.locator("#capN").fill("5");
  await press(alice, "yes");
  await alice.locator("#peopleBtn").click();
  await sheet(alice).locator("h2", { hasText: "5" }).waitFor();
  await alice.keyboard.press("Escape");
  assert.equal((await dbGet(`rooms/${code}/meta`)).cap, 5);

  const first = (await dbGet(`rooms/${code}/meta`)).owner;
  await menuPick(alice, "transfer");
  await sheet(alice).locator("[data-pick]").click();
  await press(alice, "yes");
  await until(async () => (await dbGet(`rooms/${code}/meta`)).owner !== first);
  assert.equal((await dbGet(`rooms/${code}/meta/mods`))[first], true, "the old owner stays on as a co-host");

  // a reload comes back into the room; home lists it
  await bob.reload();
  await bob.locator("#chat").waitFor();
  assert.equal(await bob.locator("#roomTitle").textContent(), "New name");
  await bob.locator("#chat .bar [data-a=home]").click();
  await bob.locator("#resume .roomrow", { hasText: "New name" }).waitFor();

  // the language can be picked in the home menu
  await bob.locator("#meBtn").click();
  await press(bob, "lang");
  await sheet(bob).locator("[data-lang=ja]").click();
  await bob.waitForFunction(() => document.documentElement.lang === "ja");
  noErrors();
});

test("Q&A review, and a record with private chats and questions as .txt and .html", async () => {
  const alice = await person("a"), bob = await person("b");
  const { url } = await createRoom(alice, "Host", { priv: true, title: "Lecture" });
  await joinByLink(bob, url, "Bob");
  await menuPick(alice, "qaon");
  await menuPick(alice, "qmodon");
  await bob.locator("#tabs [data-a=qa]").click();
  await bob.locator("#askAnon").uncheck();
  await say(bob, "Is it recorded?");
  await bob.locator(".qcard.waiting, .note.qnote").first().waitFor();
  const waiting = alice.locator(".qcard.waiting", { hasText: "Is it recorded?" });
  await waiting.waitFor();
  await waiting.locator(".btn.primary").click(); // let it through
  await bob.locator(".qcard:not(.waiting)", { hasText: "Is it recorded?" }).waitFor();

  // a private message, so the record has a private chat too
  await bob.locator("#tabs [data-a=all]").click();
  await bob.locator("#peopleBtn").click();
  await sheet(bob).locator("[data-dm]").click();
  await say(bob, "psst");
  await bubble(bob, "psst").waitFor();

  await menuPick(bob, "export");
  const [txt] = await Promise.all([bob.waitForEvent("download"), press(bob, "txt")]);
  const text = readFileSync(await txt.path(), "utf8");
  assert.match(text, /psst/);
  assert.match(text, /Is it recorded\?/);
  assert.match(text, /Bob/);
  await menuPick(bob, "export");
  const [html] = await Promise.all([bob.waitForEvent("download"), press(bob, "html")]);
  const page = readFileSync(await html.path(), "utf8");
  assert.match(page, /<script type="application\/json" id="anon-chat-archive">/);
  assert.ok(!page.includes("<script>"), "no live script in the file");

  // the .html file imports back, with a tab for the private chat and one for the questions
  await bob.locator("#chat .bar [data-a=home]").click(); // back to the room view
  await bob.locator("#chat .bar [data-a=home]").click(); // home
  await bob.locator("#importFile").setInputFiles(await html.path());
  await bob.locator("#record").waitFor();
  assert.equal(await bob.locator("#recTabs .tab").count(), 3);
  await bob.locator("#recTabs .tab").nth(1).click();
  await bob.locator("#recList .bub", { hasText: "psst" }).waitFor();
  await bob.locator("#recTabs .tab").nth(2).click();
  await bob.locator("#recList .qcard", { hasText: "Is it recorded?" }).waitFor();
  noErrors();
});

test("theme, and a code that doesn't exist", async () => {
  const alice = await person("a");
  await alice.locator("#meBtn").click();
  await press(alice, "theme");
  await sheet(alice).locator("[data-theme=dark]").click();
  await alice.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await alice.keyboard.press("Escape");
  await alice.locator("#joinCode").fill("ZZZZ");
  await alice.locator("#joinForm button").click();
  await alice.locator(".toast").first().waitFor();
  assert.equal(await alice.locator("#home").isVisible(), true);
  noErrors();
});
