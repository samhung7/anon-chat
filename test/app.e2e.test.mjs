// End-to-end checks of the page itself, in a real browser against the database emulator: npm test
// Two or three people, each in their own browser context, go through what the app does most: rooms, messages,
// encryption, private messages, Q&A, polls, export and import. They guard refactoring: what passes here has to keep passing.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { startPhotoStub } from "./photo-stub.mjs";
import * as P from "../site/js/app/puzzles.js";

const NS = "demo-anon-chat";
const EMU = "http://127.0.0.1:9000";
const SITE = new URL("../site/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const asOwner = { Authorization: "Bearer owner" };
const dbUrl = (path) => `${EMU}/${path}.json?ns=${NS}`;
const dbGet = (path) => fetch(dbUrl(path), { headers: asOwner }).then((r) => r.json());

let server, base, browser, errors, photos;

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
  photos = await startPhotoStub(); // the page sends photos to :8787 with ?emu
});
after(async () => { await browser?.close(); server?.close(); await photos?.close(); });
beforeEach(async () => {
  errors = [];
  await fetch(dbUrl(""), { method: "DELETE", headers: asOwner });
  photos?.bucket.objects.clear();
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
  await page.locator("#meName").fill(name); // who I am is asked in the new-room sheet itself
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
async function setDesc(page, text) {
  await menuPick(page, "desc");
  await page.locator("#roomDesc").fill(text);
  await press(page, "yes");
}
// the header shows "Room" until the room's details arrive from the database, so wait for the title
const titleIs = (page, title) => page.locator("#roomTitle", { hasText: new RegExp(`^${title}$`) }).waitFor();
const noErrors = () => assert.deepEqual(errors, []);
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((ok) => setTimeout(ok, 100))) if (Date.now() > end) throw new Error("timed out");
}

test("open room: create, join with the code, talk, react, reply, edit, delete", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { title: "Book club" });
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}$/);
  assert.ok(!url.includes("#k="), "an open room's link has no key");
  await titleIs(alice, "Book club");

  // the box keeps only a code's 4 characters; a pasted link leaves its code
  await bob.locator("#joinCode").fill("ab-cdef");
  assert.equal(await bob.locator("#joinCode").inputValue(), "ABC");
  await bob.locator("#joinCode").evaluate((input, link) => {
    const data = new DataTransfer(); data.setData("text/plain", link);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, url);
  assert.equal(await bob.locator("#joinCode").inputValue(), code);
  // the code alone is enough for an open room
  await bob.locator("#joinCode").fill(code.toLowerCase());
  await bob.locator("#joinForm button").click();
  await pickName(bob, "Bob");
  await bob.locator("#chat").waitFor();
  await alice.locator("#peopleBtn .n", { hasText: "2" }).waitFor();

  // the owner describes the room, and everyone sees it under its name
  await setDesc(alice, "What we read this week\nand the rules");
  await bob.locator("#desc .dtext", { hasText: "What we read this week" }).waitFor();
  assert.equal((await dbGet(`rooms/${code}/meta`)).desc, "What we read this week\nand the rules");
  assert.ok(await bob.locator("#desc").getByText("Edit room description").count() === 0, "only the owner and co-hosts edit it");
  // hidden from above the chat on this device, it stays at the top of the ⋯ menu, and comes back from there
  await bob.locator("#desc .dhide").click();
  await bob.locator("#desc").waitFor({ state: "hidden" });
  await bob.locator("#chat .bar [data-a=menu]").click();
  await sheet(bob).locator(".mdesc .dtext", { hasText: "What we read this week" }).waitFor();
  await press(bob, "showdesc");
  await bob.locator("#desc .dtext").waitFor();

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
  await titleIs(bob, "Secret");
  await setDesc(alice, "Salon rules");
  await bob.locator("#desc .dtext", { hasText: "Salon rules" }).waitFor();
  const sealed = await dbGet(`rooms/${code}/meta`);
  assert.ok(sealed.xd && !sealed.desc, "the description is only kept sealed");
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
  await sheet(bob).locator(".st-mrow", { hasText: "Alice" }).locator("[data-dm]").click();
  await bob.locator("#dmBar").waitFor();
  await say(bob, "just for you");
  await alice.locator("#peopleBtn .dot").waitFor();
  await alice.locator("#peopleBtn").click();
  await sheet(alice).locator(".st-mrow", { hasText: "Bob" }).locator("[data-dm]").click();
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

  // a poll too, which the projector shows beside the questions
  await alice.locator("#tabs [data-a=all]").click();
  await alice.locator("#composer [data-a=more]").click();
  await alice.locator("#picker .morebtn").nth(1).click();
  await alice.locator("#pollQ").fill("Tea or coffee?");
  const opts = sheet(alice).locator(".pollopts input");
  await opts.nth(0).fill("Tea"); await opts.nth(1).fill("Coffee");
  await press(alice, "yes");
  await alice.locator(".pollbox", { hasText: "Tea or coffee?" }).waitFor();

  // the projector screen follows the room
  const [show] = await Promise.all([alice.context().waitForEvent("page"), menuPick(alice, "show")]);
  await show.locator("#show .sqr svg").waitFor();
  // on a phone the projector screen scrolls all the way to the last question
  await show.setViewportSize({ width: 390, height: 640 });
  for (let i = 0; i < 4; i++) await say(bob, `Question ${i} ` + "and a long one ".repeat(12));
  await show.locator("#show .slist li", { hasText: "Question 3" }).waitFor();
  await show.locator("#show .spoll .pollbox").waitFor();
  await show.locator("#show").evaluate((e) => e.scrollTo(0, e.scrollHeight));
  const last = await show.locator("#show .smain > :last-child").boundingBox();
  assert.ok(last.y + last.height <= 640, "the bottom of the list can be scrolled into view");
  const poll = await show.locator("#show .spoll").boundingBox(), first = await show.locator("#show .smain > :first-child").boundingBox();
  assert.ok(poll.y + poll.height <= first.y, "the poll sits above the questions, not over them");
  noErrors();
});

test("someone set offline while still connected is back online at once", async () => {
  const alice = await person("a");
  const { code } = await createRoom(alice, "Host");
  const uid = await alice.evaluate(() => localStorage.getItem("chat-emu-uida"));
  await until(async () => (await dbGet(`rooms/${code}/members/${uid}/online`)) === true);
  // what a connection the server notices dropped only late (a phone that slept) does: its leftover goodbye lands
  await fetch(dbUrl(`rooms/${code}/members/${uid}/online`), { method: "PUT", headers: asOwner, body: "false" });
  await until(async () => (await dbGet(`rooms/${code}/members/${uid}/online`)) === true);
  await alice.locator("#peopleBtn .n", { hasText: "1" }).waitFor();
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
    await sheet(alice).locator(".st-mrow", { hasText: name }).locator("[data-pm]").click();
    if (a === "kick") await sheet(alice).locator(".st-agrp .st-arow.danger[data-a=kick]").waitFor(); // the destructive group, in red
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

  assert.equal(photos.bucket.objects.size, 1);

  // Bob blocks Alice: her messages fold away on his device only
  await bob.locator("#list .msg", { hasText: "read the rules" }).locator(".more").click();
  await press(bob, "block");
  await press(bob, "yes");
  await bob.locator("#list .msg.folded").first().waitFor();
  noErrors();
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwHwyBDAYGBgYGAFHkCPuk1IufAAAAAElFTkSuQmCC", "base64");
for (const priv of [false, true]) test(`photos live in R2 (${priv ? "sealed, in a Private Salon" : "as JPEG, in an Open Stoa"}), and go with their message and their room`, async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { priv });
  await joinByLink(bob, url, "Bob");
  const send = () => bob.locator("#photoFile").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });
  await send();
  await alice.locator("#list .imgbub img.photo[src^='blob:']").waitFor(); // fetched from the bucket and, if sealed, opened
  await send();
  await alice.locator("#list .imgbub img.photo[src^='blob:']").nth(1).waitFor();
  const keys = [...photos.bucket.objects.keys()];
  assert.equal(keys.length, 2);
  for (const k of keys) assert.match(k, new RegExp(`^${code}/emu[a-z0-9]+/[A-Za-z0-9_-]+\\.${priv ? "bin" : "jpg"}$`));
  const body = photos.bucket.objects.get(keys[0]).body;
  assert.equal(body[0] === 0xff && body[1] === 0xd8, !priv, "plain photos are JPEG, sealed ones aren't readable");
  const files = await dbGet(`rooms/${code}/files`);
  assert.equal(Object.keys(files).length, 2);
  for (const f of Object.values(files)) assert.ok(!("d" in f), "only a marker in the database");

  // Bob deletes one: its marker and its picture go
  await bob.locator("#list .msg.mine .more").first().click();
  await press(bob, "del");
  await press(bob, "yes");
  await alice.locator("#list .imgbub").nth(1).waitFor({ state: "detached" });
  await waitUntil(() => photos.bucket.objects.size === 1);
  assert.equal(Object.keys(await dbGet(`rooms/${code}/files`)).length, 1);

  // the owner ends the room: the other picture goes too
  await menuPick(alice, "end");
  await press(alice, "yes");
  await alice.locator("#home").waitFor();
  await waitUntil(() => photos.bucket.objects.size === 0);
  noErrors();
});
async function waitUntil(ok, ms = 5000) {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) assert.fail("timed out");
}

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
  await titleIs(bob, "New name");
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

test("a link opened while the database can't be reached says so, instead of spinning on", async () => {
  const bob = await person("b");
  // what a full free plan (every connection taken) or a blocked network looks like: the database never answers
  await bob.context().routeWebSocket(/127\.0\.0\.1:9000/, (ws) => ws.close());
  await bob.context().route(/127\.0\.0\.1:9000/, (r) => r.abort());
  await bob.goto(`${base}/?emu&as=b&room=ABCD`);
  await bob.locator("#splash").waitFor(); // the loading screen, not a blank page
  await bob.locator(".toast", { hasText: "Can't reach the server" }).waitFor({ timeout: 30000 });
  assert.equal(await bob.locator("#splash").isVisible(), false);
  assert.equal(await bob.locator("body.busy").count(), 0, "the spinner stops");
  assert.equal(await bob.locator("#home").isVisible(), true);
  assert.equal(await bob.locator("#joinCode").inputValue(), "ABCD", "the code waits in the box for another try");
  errors = errors.filter((e) => !/timeout/.test(e));
  noErrors();
});

test("reports reach StoaTalk's operator, who takes the message down and bans the sender everywhere", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { priv: true });
  await joinByLink(bob, url, "Bob");
  await say(alice, "buy followers here");
  await bubble(bob, "buy followers here").waitFor();
  await bob.locator("#list .msg .more").first().click();
  await press(bob, "report");
  await press(bob, "r1");
  // the operator gets what Bob saw, though the room is end-to-end encrypted
  await until(async () => await dbGet("ops/reports"));
  const reports = Object.values(await dbGet("ops/reports"))[0];
  assert.equal(reports.code, code);
  assert.equal(reports.t, "buy followers here");
  assert.equal(reports.n, "Alice");
  assert.equal(reports.enc, true);
  const aliceId = reports.who;

  // someone who isn't an admin sees their id and how to become one
  const ctx = await browser.newContext({ locale: "zh-TW" }), op = await ctx.newPage();
  op.on("pageerror", (e) => errors.push(`op: ${e.message}`));
  await op.goto(`${base}/admin.html?emu&as=op`);
  await op.locator("#myUid", { hasText: "op" }).waitFor();
  await fetch(dbUrl("ops/admins/op"), { method: "PUT", headers: asOwner, body: "true" });
  await op.reload();
  const card = op.locator("#reports .card", { hasText: "buy followers here" });
  await card.waitFor();
  op.on("dialog", (d) => d.accept());
  await card.locator("button", { hasText: "刪除並停權" }).click();
  await op.locator("#reports", { hasText: "沒有待處理的檢舉" }).waitFor();
  await op.locator("#bans .card", { hasText: aliceId }).waitFor();
  await bubble(bob, "buy followers here").waitFor({ state: "detached" });
  assert.ok((await dbGet(`bans/${aliceId}`)).at > 0);
  assert.equal(await dbGet(`rooms/${code}/members/${aliceId}`), null);

  // Alice can't open another room anywhere, and is told why
  await alice.goto(`${base}/?emu&as=a`);
  await alice.locator("#createBtn").click();
  await press(alice, "yes");
  await alice.locator(".toast", { hasText: "suspended" }).waitFor();
  noErrors();
});

test("a hidden page counts as offline (a phone stops running it), and online again when it's shown", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  const bobId = Object.entries(await dbGet(`rooms/${code}/members`)).find(([, m]) => m.name === "Bob")[0];
  const show = (hidden) => bob.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await until(async () => (await dbGet(`rooms/${code}/members/${bobId}/online`)) === true);
  await show(true);
  await until(async () => (await dbGet(`rooms/${code}/members/${bobId}/online`)) === false);
  await new Promise((ok) => setTimeout(ok, 1000)); // and it stays that way: no "I'm still connected" back to online
  assert.equal(await dbGet(`rooms/${code}/members/${bobId}/online`), false);
  await show(false);
  await until(async () => (await dbGet(`rooms/${code}/members/${bobId}/online`)) === true);
  noErrors();
});

test("Web Push: a message is announced to a member whose page is closed, a quick next one when the quiet time is over", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  const bobId = Object.entries(await dbGet(`rooms/${code}/members`)).find(([, m]) => m.name === "Bob")[0];
  // Bob's browser subscribed (a made-up subscription: a headless browser has no push service), then he closes the page
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/bob", keys: {
    p256dh: Buffer.from(await crypto.subtle.exportKey("raw", ua.publicKey)).toString("base64url"), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") } };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"), t = Math.floor(Date.now() / 1000);
  const token = b64({ alg: "none" }) + "." + b64({ sub: bobId, aud: NS, iss: "https://securetoken.google.com/" + NS, iat: t, exp: t + 3600, auth_time: t }) + ".";
  const { sealed } = await (await fetch("http://127.0.0.1:8787/push/seal", { method: "POST", body: JSON.stringify(sub), headers: { Authorization: "Bearer " + token } })).json();
  await fetch(dbUrl(`rooms/${code}/push/${bobId}`), { method: "PUT", headers: asOwner, body: JSON.stringify(sealed) });
  await bob.context().close();
  await until(async () => (await dbGet(`rooms/${code}/members/${bobId}/online`)) === false);
  photos.pushed.length = 0;
  await say(alice, "see you at 7");
  await until(() => photos.pushed.length === 1);
  assert.equal(photos.pushed[0].url, sub.endpoint);
  assert.equal(photos.pushed[0].init.headers.Topic, code);
  assert.ok((await dbGet(`rooms/${code}/meta/pa`)) > 0);
  // the next ones, moments later, aren't announced right away, but the newest is once the 20 seconds are over
  await say(alice, "bring the book");
  await say(alice, "and the snacks");
  await bubble(alice, "and the snacks").waitFor();
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.equal(photos.pushed.length, 1);
  await until(() => photos.pushed.length === 2, 30000);
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.equal(photos.pushed.length, 2);
  noErrors();
});

test("a quiet room: a warning in its 24th hour, then read-only with the hours left, on the chat and the home list", async () => {
  const alice = await person("a"), bob = await person("b"), carol = await person("c");
  const { code, url } = await createRoom(alice, "Alice", { title: "Book club" });
  await joinByLink(bob, url, "Bob");
  await say(alice, "see you tomorrow");
  await bubble(bob, "see you tomorrow").waitFor();
  const quiet = (h) => fetch(dbUrl(`rooms/${code}/meta/last`), { method: "PUT", headers: asOwner, body: String(Date.now() - h * 3600000) });
  // nobody spoke for 23½ hours: everyone in the room is told; ✕ hides it, and speaking keeps the room going
  await quiet(23.5);
  await bob.locator("#ageBar", { hasText: "turns read-only in about 30 min" }).waitFor();
  // joining isn't speaking: someone coming in leaves the clock where it was
  const last = await dbGet(`rooms/${code}/meta/last`);
  await joinByLink(await person("d"), url, "Dave");
  assert.equal(await dbGet(`rooms/${code}/meta/last`), last);
  await alice.locator("#ageBar .x").click();
  await alice.locator("#ageBar").waitFor({ state: "hidden" });
  assert.ok(await bob.locator("#roBox").isHidden());
  await say(bob, "still here");
  await bubble(alice, "still here").waitFor();
  await bob.locator("#ageBar").waitFor({ state: "hidden" });
  // 30 hours: read-only, deleted in 18 hours; where the message box was, it says so and offers to save it
  await quiet(30);
  await alice.locator("#roBox", { hasText: "Read-only" }).waitFor();
  await alice.locator("#roBox", { hasText: "deleted in 18 h" }).waitFor();
  assert.ok(await alice.locator("#composer").isHidden());
  assert.ok(await alice.locator("#ageBar").isHidden());
  await alice.locator("#roBox .btn").click();
  await press(alice, "save");
  await alice.locator(".toast", { hasText: "Saved" }).first().waitFor();
  // the home list marks it, with the hours left
  await bob.locator("#chat .bar [data-a=home]").click();
  const row = bob.locator("#resume .roomrow", { hasText: "Book club" });
  await row.locator(".tag.warn", { hasText: "Read-only" }).waitFor();
  await row.locator(".left", { hasText: "deleted in 18 h" }).waitFor();
  // a member still gets back in to read it; nobody new joins
  await row.click();
  await bubble(bob, "still here").waitFor();
  // at once, not on the half-minute look at the clock
  assert.ok(await bob.locator("#composer").isHidden(), "coming back from the home list, the message box stays away");
  assert.ok(await bob.locator("#roBox", { hasText: "Read-only" }).isVisible());
  await carol.locator("#joinCode").fill(code);
  await carol.locator("#joinForm button").click();
  await carol.locator(".toast", { hasText: "read-only" }).waitFor();
  assert.ok(await dbGet(`rooms/${code}/meta`), "still there until its 24 read-only hours are up");
  noErrors();
});

// mini-games: the puzzles are made the same way here as in the page, so the test knows the answers
const SHOTS = process.env.SHOTS; // a folder to save screenshots in, when set
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
async function openGames(page) {
  await page.locator("#composer [data-a=more]").click();
  await page.locator("#picker .morebtn", { hasText: "Games" }).click();
  return sheet(page).locator(".games");
}
// starts game g from the games sheet, past the rules shown the first time
async function startGame(page, g) {
  await (await openGames(page)).locator(`.gmrow[data-g=${g}]`).click();
  await page.locator(".gameov").waitFor();
  await press(page, "ok");
}
async function crack(page, guesses) {
  for (const guess of guesses) {
    for (const k of guess) await page.locator(`.mmkey[data-k="${k}"]`).click();
    await page.locator(".mmkeys [data-a=ok]").click();
  }
}
const gameDone = (page, score) => page.locator(".gmend .gscore b", { hasText: new RegExp(`^${score}$`) }).waitFor();
const closeGame = (page) => page.locator(".gmend .btn", { hasText: /^Close$/ }).click();

test("mini-games: today's puzzle once each, a shared result, the room's leaderboard, and the owner turning games off", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  const day = P.dayOf(Date.now()), seed = (g) => P.seedOf(code, day, g);

  // Code Lock: one wrong try, then the code
  const secret = P.mmSecret(seed("mm")), wrong = secret === "0000" ? "1111" : "0000";
  const games = await openGames(alice);
  await games.locator(".lbbox", { hasText: "Nobody has played yet" }).waitFor();
  await shot(alice, "games-sheet-empty");
  await alice.keyboard.press("Escape");
  await startGame(alice, "mm");
  await crack(alice, [wrong]);
  await alice.locator(".gmstat", { hasText: "7 tries left" }).waitFor();
  await shot(alice, "mm-playing");
  await crack(alice, [secret]);
  await gameDone(alice, 88);
  await shot(alice, "mm-done");
  const mm = Object.values(await dbGet(`rooms/${code}/games/${day}/mm`));
  assert.deepEqual(mm.map((r) => [r.s, r.l]), [[88, `${wrong},${secret}`]]);
  // shared to the room, where Bob plays the same puzzle from the card
  await alice.locator(".gmend .btn", { hasText: "Share to the room" }).click();
  const card = bob.locator(".gamebub", { hasText: "Code Lock" });
  await card.locator(".gscore b", { hasText: "88" }).waitFor();
  await card.locator(".gmmarks span").nth(1).waitFor();
  await shot(bob, "mm-card");
  await card.locator(".gmjoin").click();
  await bob.locator(".gameov").waitFor();
  await press(bob, "ok");
  await crack(bob, [secret]);
  await gameDone(bob, 100);
  await closeGame(bob);
  // played once a day: opening it again shows the score
  await (await openGames(bob)).locator(".gmrow[data-g=mm] .gmst.done", { hasText: "100" }).waitFor();
  await bob.locator(".gmrow[data-g=mm]").click();
  await sheet(bob).locator(".gmresult .gscore b", { hasText: "100" }).waitFor();
  await bob.keyboard.press("Escape");

  // Crowns: one clashing crown (a mistake) and a hint, then the rest
  const qn = P.qnPuzzle(seed("qn")), n = qn.n;
  await startGame(bob, "qn");
  const cell = (i) => bob.locator(`.qncell[data-i="${i}"]`);
  await cell(qn.cols[0]).click(); await cell(qn.cols[0]).click();
  const bad = n + qn.cols[0] + (qn.cols[0] < n - 1 ? 1 : -1); // corner to corner with row one's crown: always a clash
  await cell(bad).click(); await cell(bad).click();
  await bob.locator(".qncell.bad").first().waitFor();
  await shot(bob, "qn-playing");
  await cell(bad).click(); // a third tap clears it
  await bob.locator(".gmhead [aria-label=Hint]").click();
  await press(bob, "yes");
  for (let r = 0; r < n; r++) {
    if (await cell(r * n + qn.cols[r]).evaluate((b) => b.classList.contains("on"))) continue;
    await cell(r * n + qn.cols[r]).click(); await cell(r * n + qn.cols[r]).click();
  }
  await gameDone(bob, 75); // 100 − 20 for the hint − 5 for the mistake
  await closeGame(bob);

  // One Line, drawn in one drag
  const zp = P.zpPuzzle(seed("zp"));
  await startGame(alice, "zp");
  const box = await alice.locator(".zpgrid").boundingBox(), size = box.width / zp.n;
  const at = (i) => [box.x + ((i % zp.n) + 0.5) * size, box.y + (Math.floor(i / zp.n) + 0.5) * size];
  await alice.mouse.move(...at(zp.line[0])); await alice.mouse.down();
  for (const i of zp.line.slice(1, 20)) await alice.mouse.move(...at(i), { steps: 2 });
  await alice.mouse.up();
  await shot(alice, "zp-playing");
  await alice.mouse.move(...at(zp.line[19])); await alice.mouse.down();
  for (const i of zp.line.slice(20)) await alice.mouse.move(...at(i), { steps: 2 });
  await alice.mouse.up();
  await gameDone(alice, 100);
  await shot(alice, "zp-done");
  await closeGame(alice);

  // the leaderboard: today, all games (Bob 175, Alice 188), and one game with its time
  const lb = (await openGames(bob)).locator(".lb li");
  await lb.nth(1).waitFor();
  const who = await lb.locator(".who").allTextContents();
  assert.match(who[0], /Alice$/); assert.match(who[1], /Bob$/);
  assert.deepEqual(await lb.locator(".pts").allTextContents(), ["188", "175"]);
  await sheet(bob).locator(".lbseg [data-v=mm]").click();
  assert.deepEqual(await lb.locator(".pts").allTextContents(), ["100", "88"]);
  await sheet(bob).locator(".lbseg [data-v=week]").click();
  await shot(bob, "leaderboard");
  await bob.keyboard.press("Escape");

  // the owner turns games off: no games in the ＋ panel, and no new scores
  await menuPick(alice, "gamesoff");
  await until(async () => (await dbGet(`rooms/${code}/meta`)).ng === true);
  await bob.locator("#composer [data-a=more]").click();
  await until(async () => (await bob.locator("#picker .morebtn").count()) === 3);
  noErrors();
});

test("mini-games in a Private Salon: scores are sealed, and still make the leaderboard", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { priv: true });
  await joinByLink(bob, url, "Bob");
  const day = P.dayOf(Date.now()), secret = P.mmSecret(P.seedOf(code, day, "mm"));
  await startGame(alice, "mm");
  await crack(alice, [secret]);
  await gameDone(alice, 100);
  const [rec] = Object.values(await dbGet(`rooms/${code}/games/${day}/mm`));
  assert.ok(rec.x && rec.s === undefined && rec.l === undefined, "only sealed");
  await alice.locator(".gmend .btn", { hasText: "Share to the room" }).click();
  await bob.locator(".gamebub .gscore b", { hasText: "100" }).waitFor();
  const lb = (await openGames(bob)).locator(".lb li");
  await lb.first().locator(".pts", { hasText: "100" }).waitFor();
  noErrors();
});

test("on iPhone the keyboard doesn't cover a sheet being typed in", async () => {
  // iOS keeps the page its full height under the keyboard and only the visible part (visualViewport) shrinks,
  // so the phone's keyboard is played by a visualViewport that loses KB pixels at the bottom
  const KB = 340;
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => {
    const vv = new EventTarget();
    Object.assign(vv, { offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(vv, "height", { get: () => innerHeight - (window.kbUp || 0) });
    Object.defineProperty(window, "visualViewport", { value: vv });
    window.keyboard = (h) => { window.kbUp = h; vv.dispatchEvent(new Event("resize")); };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`k: ${e.message}`));
  await page.goto(`${base}/?emu&as=k`);
  await page.locator("#createBtn").waitFor();
  const shown = 844 - KB;
  const above = async (field) => {
    await page.locator(field).focus();
    await page.evaluate((h) => window.keyboard(h), KB);
    await until(async () => (await sheet(page).locator(".sheet").boundingBox()).y + (await sheet(page).locator(".sheet").boundingBox()).height <= shown + 1);
    const f = await page.locator(field).boundingBox();
    assert.ok(f.y >= 0 && f.y + f.height <= shown + 1, `${field} shows above the keyboard`);
    await page.evaluate(() => window.keyboard(0));
  };
  // the new-room sheet is taller than what's left, so the nickname at its foot is scrolled into view
  await page.locator("#createBtn").click();
  await above("#meName");
  await page.locator("#meName").fill("Host");
  await press(page, "yes");
  await sheet(page).locator(".share").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#chat").waitFor();
  await menuPick(page, "desc");
  await above("#roomDesc");
  await page.locator("#roomDesc").fill("Welcome");
  await press(page, "yes");
  // the keyboard down again: the sheet is back at the foot of the screen
  await menuPick(page, "qaon");
  await page.locator("#askBar").waitFor();
  await say(page, "Why?");
  await page.locator(".qcard .qtools .btn.primary").click();
  await above("#ansText");
  const box = await sheet(page).locator(".sheet").boundingBox();
  assert.ok(Math.abs(box.y + box.height - 844) < 2, "the sheet sits at the bottom once the keyboard is gone");
  // and the room's header stays at the top while typing in the box
  await page.keyboard.press("Escape");
  await page.locator("#text").focus();
  await page.evaluate((h) => window.keyboard(h), KB);
  await until(async () => (await page.locator("#composer").boundingBox()).y + (await page.locator("#composer").boundingBox()).height <= shown + 1);
  assert.ok((await page.locator("#chat .bar").boundingBox()).y >= 0);
  await ctx.close();
  noErrors();
});
