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
  await bob.locator("#joinForm [type=submit]").click();
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

test("a made-up nickname: 🎲 picks a colour and an animal, and one that is taken in the room is made up again", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Red Fox");
  // 🎲 in the sheet: a colour on an animal, with that animal picked; picking another animal keeps the colour
  await bob.goto(url);
  await bob.locator(".nickrow .roll").click();
  const made = await bob.locator("#meName").inputValue();
  const [, colour, animal] = made.match(/^(Red|Orange|Yellow|Green|Blue|Purple|Pink|Golden|Silver|White) (.+)$/);
  assert.equal(await sheet(bob).locator(".avpick [aria-pressed=true]").getAttribute("aria-label"), animal);
  await sheet(bob).locator('.avpick [aria-label="Owl"]').click();
  assert.equal(await bob.locator("#meName").inputValue(), colour + " Owl");
  await press(bob, "yes");
  await bob.locator("#chat").waitFor();
  assert.ok(await dbGet(`rooms/${code}/names/${(colour + " owl").toLowerCase()}`), "joined under the name made up");
  // someone whose made-up name is already taken in the room joins under another made-up one, without being asked
  const carol = await person("c");
  await carol.evaluate(() => localStorage.setItem("chat-me", JSON.stringify({ avatar: "🦊", name: "Red Fox", col: 0, auto: true })));
  await carol.goto(url);
  await carol.locator("#chat").waitFor();
  const names = Object.keys(await dbGet(`rooms/${code}/names`));
  assert.equal(names.length, 3);
  assert.ok(names.includes("red fox"));
  const mine = JSON.parse(await carol.evaluate(() => localStorage.getItem("chat-me")));
  assert.notEqual(mine.name, "Red Fox");
  assert.ok(names.includes(mine.name.toLowerCase()));
  noErrors();
});

test("quick replies: one tap sends, answers while replying, my own and the room's; a double tap gives a 👍", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  await say(alice, "Welcome, everyone");
  await bubble(bob, "Welcome, everyone").waitFor();

  // the presets, in my language, above the empty box; one tap sends, and the chip rests a moment so it isn't sent twice
  const bar = bob.locator("#quickBar");
  await bar.locator(".chip", { hasText: "Agreed" }).click();
  await bubble(alice, "👍 Agreed").waitFor();
  assert.ok(await bar.locator(".chip", { hasText: "Agreed" }).isDisabled());
  // it gives way while something is being typed
  await bob.locator("#text").fill("typing…");
  await bar.waitFor({ state: "hidden" });
  await bob.locator("#text").fill("");
  await bar.waitFor();

  // while replying, answers to that message come first, and go out as a reply
  await bob.locator("#list .msg:not(.mine) .more").first().click();
  await press(bob, "reply");
  await bar.locator(".chip.rp", { hasText: "I see it differently" }).click();
  await alice.locator("#list .msg .rpq", { hasText: "Welcome" }).waitFor();
  await bubble(alice, "🤔 I see it differently").waitFor();
  assert.equal(await bar.locator(".chip.rp").count(), 0, "the reply is done");

  // a double tap on a message gives it a 👍, and a second one doesn't take it back
  await bubble(bob, "Welcome, everyone").dblclick();
  await alice.locator("#list .msg .re .chip", { hasText: "👍 1" }).waitFor();
  await bubble(bob, "Welcome, everyone").dblclick();
  await bob.waitForTimeout(500);
  const re = Object.values(await dbGet(`rooms/${code}/msgs`)).find((m) => m.text === "Welcome, everyone").re;
  assert.equal(Object.keys(re[0]).length, 1);

  // my own, from the ✎ at the end of the row: kept on this device only
  await bar.locator("[data-a=quickEdit]").click();
  await sheet(bob).locator(".qrow input").first().fill("Count me in");
  await sheet(bob).locator(".qadd").click();
  await sheet(bob).locator(".qrow input").last().fill("Brb");
  await press(bob, "yes");
  await bar.locator(".chip", { hasText: "Count me in" }).waitFor();
  await bar.locator(".chip", { hasText: "Brb" }).waitFor();
  assert.equal(await bar.locator(".chip", { hasText: "Agreed" }).count(), 0);
  const kept = JSON.parse(await bob.evaluate(() => localStorage.getItem("chat-quick")));
  assert.equal(kept[0], "Count me in");
  assert.equal(kept.length, 7);
  // turned off, the row goes; the ⋯ menu brings it back
  await menuPick(bob, "quick");
  await sheet(bob).locator("#quickOn").uncheck();
  await press(bob, "yes");
  await bar.waitFor({ state: "hidden" });
  await menuPick(bob, "quick");
  await press(bob, "quickreset");
  await sheet(bob).locator("#quickOn").check();
  await press(bob, "yes");
  await bar.locator(".chip", { hasText: "Agreed" }).waitFor();
  assert.equal(await bob.evaluate(() => localStorage.getItem("chat-quick")), null, "the presets aren't kept, so they follow the language");

  // the room's own, from the host: first in everyone's row; members can't write them
  await bob.locator("#chat .bar [data-a=menu]").click();
  assert.equal(await sheet(bob).locator("[data-a=roomquick]").count(), 0);
  await bob.keyboard.press("Escape");
  await menuPick(alice, "roomquick");
  await press(alice, "quicksample");
  await press(alice, "yes");
  await bar.locator(".chip.host", { hasText: "Got it" }).waitFor();
  assert.equal((await bar.locator(".chip").first().textContent()), "✅ Got it");
  assert.equal((await dbGet(`rooms/${code}/meta`)).qr, "✅ Got it\n🐢 Too fast\n🔁 Say that again?\n🔊 Can't hear");
  await bar.locator(".chip.host", { hasText: "Too fast" }).click();
  await bubble(alice, "🐢 Too fast").waitFor();
  // a host who clears the list takes it out of everyone's row
  await menuPick(alice, "roomquick");
  for (let n = await sheet(alice).locator(".qrow").count(); n > 0; n--) await sheet(alice).locator(".qrow button").last().click();
  await press(alice, "yes");
  await bar.locator(".chip.host").first().waitFor({ state: "detached" });
  assert.equal((await dbGet(`rooms/${code}/meta`)).qr, undefined);
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
  // so are the room's quick replies
  await menuPick(alice, "roomquick");
  await press(alice, "quicksample");
  await press(alice, "yes");
  await bob.locator("#quickBar .chip.host", { hasText: "Too fast" }).waitFor();
  const sealedQ = await dbGet(`rooms/${code}/meta`);
  assert.ok(sealedQ.xr && !sealedQ.qr, "the room's quick replies are only kept sealed");
  await say(alice, "top secret words");
  await bubble(bob, "top secret words").waitFor();
  const msgs = Object.values(await dbGet(`rooms/${code}/msgs`));
  assert.ok(msgs[0].x && !msgs[0].text && !msgs[0].name, "messages are stored sealed");
  const members = await dbGet(`rooms/${code}/members`);
  assert.ok(Object.values(members).every((m) => m.x && m.h && !m.name), "nicknames are stored sealed");

  // the code alone asks for the full link
  await carol.locator("#joinCode").fill(code);
  await carol.locator("#joinForm [type=submit]").click();
  await carol.locator("#joinLink").waitFor();
  await carol.locator("#joinLink").fill(url);
  await press(carol, "yes");
  await pickName(carol, "Carol");
  await bubble(carol, "top secret words").waitFor();

  // Carol leaves: a line says so, under her sealed name
  await menuPick(carol, "leave");
  await press(carol, "yes");
  await carol.locator("#home").waitFor();
  await bob.locator("#list .sysline", { hasText: "Carol left the room" }).waitFor();
  const line = Object.values(await dbGet(`rooms/${code}/msgs`)).find((m) => m.ev === "l");
  assert.ok(line.x && !line.name, "the line's name is stored sealed");

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
  // the host's ⋯ on an answered question: two steps, one under the other, not pushed to either side
  await alice.locator("details.qdone summary").click();
  await alice.locator(".qdone .qcard .qtools .more").click();
  const [undo, remove] = await Promise.all(["done", "remove"].map((a) => sheet(alice).locator(`[data-a=${a}]`).boundingBox()));
  assert.ok(remove.y >= undo.y + undo.height && Math.abs(undo.width - remove.width) < 2, "the two buttons are stacked, full width");
  await alice.keyboard.press("Escape");

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

for (const priv of [false, true]) test(`anonymous and hidden polls${priv ? " (encrypted)" : ""}`, async () => {
  const alice = await person("a"), bob = await person("b"), carol = await person("c");
  const { code, url } = await createRoom(alice, "Alice", { priv });
  await joinByLink(bob, url, "Bob"); await joinByLink(carol, url, "Carol");
  const newPoll = async (q, { anon = false, hide = false } = {}) => {
    await alice.locator("#composer [data-a=more]").click();
    await alice.locator("#picker .morebtn").nth(1).click();
    await alice.locator("#pollQ").fill(q);
    const opts = sheet(alice).locator(".pollopts input");
    await opts.nth(0).fill("Tea"); await opts.nth(1).fill("Coffee");
    if (anon) await alice.locator("#pollAnon").check();
    if (hide) { await alice.locator("#pollHide").check(); await alice.locator("#pollWhen").selectOption("60"); }
    await press(alice, "yes");
  };
  const box = (page, q) => page.locator("#list .pollbox", { hasText: q });
  const counts = (page, q) => box(page, q).locator(".oc").allTextContents();

  // anonymous and hidden: each sees only their own vote until it's revealed
  await newPoll("Lunch?", { anon: true, hide: true });
  await box(bob, "Lunch?").locator(".opt").nth(1).click();
  await box(bob, "Lunch?").locator(".opt.on", { hasText: "Coffee" }).waitFor();
  await box(carol, "Lunch?").locator(".opt").nth(0).click();
  await box(carol, "Lunch?").locator(".opt.on", { hasText: "Tea" }).waitFor();
  await box(bob, "Lunch?").locator(".pf", { hasText: "Results at" }).waitFor();
  assert.deepEqual(await counts(bob, "Lunch?"), [], "no counts before it's revealed");
  assert.equal(await box(alice, "Lunch?").locator(".opt.on").count(), 0);
  const msgs = await dbGet(`rooms/${code}/msgs`), [id] = Object.keys(msgs).filter((k) => msgs[k].an);
  assert.ok(msgs[id].rv > Date.now() + 50 * 60000 && !msgs[id].votes, "marked, and no votes on the message");
  const keys = await dbGet(`rooms/${code}/av/${id}`), ballots = await dbGet(`rooms/${code}/ab/${id}`);
  assert.equal(Object.keys(ballots).length, 2);
  assert.ok(!Object.keys(ballots).some((k) => k.startsWith("emu")), "ballots aren't under anyone's id");
  assert.deepEqual(Object.keys(keys).length, 2);
  // Alice reveals it early: everyone sees the counts, nobody can vote, and nobody sees who voted how
  await box(alice, "Lunch?").locator("xpath=ancestor::*[contains(@class,'msg')][1]").locator(".more").click();
  assert.equal(await sheet(alice).locator('[data-a="voters"]').count(), 0, "no list of voters");
  await press(alice, "close"); await press(alice, "yes");
  for (const page of [alice, bob, carol]) await box(page, "Lunch?").locator(".ph small", { hasText: "Results out" }).waitFor();
  await until(async () => (await counts(carol, "Lunch?")).join() === "1,1");
  assert.ok(await box(bob, "Lunch?").locator(".opt").nth(0).isDisabled());

  // hidden only, revealed when its time comes: then votes are locked, and who voted is shown
  await newPoll("Dinner?", { hide: true });
  await box(bob, "Dinner?").locator(".opt").nth(0).click();
  await box(bob, "Dinner?").locator(".opt.on", { hasText: "Tea" }).waitFor();
  assert.deepEqual(await counts(carol, "Dinner?"), []);
  const m2 = await dbGet(`rooms/${code}/msgs`), [id2] = Object.keys(m2).filter((k) => m2[k].rv && !m2[k].an);
  await fetch(dbUrl(`rooms/${code}/msgs/${id2}/rv`), { method: "PUT", headers: asOwner, body: JSON.stringify(Date.now() + 2000) });
  await until(async () => (await counts(carol, "Dinner?")).join() === "1,0");
  await box(carol, "Dinner?").locator(".ph small", { hasText: "Results out" }).waitFor();
  assert.ok(await box(carol, "Dinner?").locator(".opt").nth(1).isDisabled(), "locked once revealed");
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
  // everyone still in the room sees a line saying so
  await alice.locator("#list .sysline", { hasText: "Carol was removed from the room" }).waitFor();
  await bob.locator("#list .sysline", { hasText: "Carol was removed from the room" }).waitFor();

  await menuPick(alice, "lock");
  await alice.locator("#codeBtn", { hasText: "·" }).waitFor();

  await menuPick(bob, "leave");
  await press(bob, "yes");
  await bob.locator("#home").waitFor();
  await alice.locator("#peopleBtn .n", { hasText: "1" }).waitFor();
  await alice.locator("#list .sysline", { hasText: "Bob left the room" }).waitFor();
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
  await alice.locator("#joinForm [type=submit]").click();
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
  await carol.locator("#joinForm [type=submit]").click();
  await carol.locator(".toast", { hasText: "read-only" }).waitFor();
  assert.ok(await dbGet(`rooms/${code}/meta`), "still there until its 24 read-only hours are up");
  noErrors();
});

test("the home list counts each room's new messages, and 99+ from 100", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { title: "Book club" });
  await joinByLink(bob, url, "Bob");
  await say(alice, "welcome");
  await bubble(bob, "welcome").waitFor();
  await bob.locator("#chat .bar [data-a=home]").click();
  const row = bob.locator("#resume .roomrow", { hasText: "Book club" });
  await row.waitFor();
  assert.equal(await row.locator(".unread").count(), 0, "read up to the newest: no count");
  await say(alice, "one"); await say(alice, "two"); await say(alice, "three");
  await bubble(alice, "three").waitFor();
  await bob.reload();
  await row.locator(".unread", { hasText: /^3/ }).waitFor();
  await shot(bob, "unread-3");
  // read: the count goes, at once
  await row.click();
  await bubble(bob, "three").waitFor();
  await bob.locator("#chat .bar [data-a=home]").click();
  await row.waitFor();
  assert.equal(await row.locator(".unread").count(), 0);
  // 100 or more say 99+
  const at = Date.now(), msgs = {};
  for (let i = 0; i < 120; i++) msgs["zz" + String(i).padStart(3, "0")] = { by: "someone", name: "Zed", avatar: "🦊", text: "m" + i, at: at + i };
  await fetch(dbUrl(`rooms/${code}/msgs`), { method: "PATCH", headers: asOwner, body: JSON.stringify(msgs) });
  await fetch(dbUrl(`rooms/${code}/meta/last`), { method: "PUT", headers: asOwner, body: String(at + 119) }); // as every message does
  await bob.reload();
  await row.locator(".unread", { hasText: /^99\+/ }).waitFor();
  await shot(bob, "unread-99-light");
  await bob.emulateMedia({ colorScheme: "dark" });
  await shot(bob, "unread-99-dark");
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

// opens the ＋ panel's long-post page and writes one; publish: send it, or leave it as a draft
async function writePost(page, title, body, { publish = true } = {}) {
  await page.locator("#composer [data-a=more]").click();
  await page.locator("#picker .morebtn", { hasText: "Long post" }).click();
  // the page puts the cursor in the title a moment after it opens; typing before then can land in the wrong field
  await page.locator(".writer .ptitlein:focus").waitFor();
  await page.locator(".writer .ptitlein").fill(title);
  await page.locator(".writer .pbody").fill(body);
  if (publish) { await page.locator(".writer .bar .btn.primary").click(); await page.locator(".writer").waitFor({ state: "detached" }); }
}

test("long posts: hosts write one on its own page, the chat shows a card, the text opens whole; owners open it up to members", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  // members don't get the tile until the owner allows it
  await bob.locator("#composer [data-a=more]").click();
  await bob.locator("#picker .morebtn", { hasText: "Poll" }).waitFor();
  assert.equal(await bob.locator("#picker .morebtn", { hasText: "Long post" }).count(), 0);
  await bob.locator("#composer [data-a=more]").click();

  // what's being written stays on the device when the page is closed, and comes back
  await writePost(alice, "Weekly notes", "draft only", { publish: false });
  await alice.locator(".writer .bar [data-a=back]").click();
  await alice.locator(".writer").waitFor({ state: "detached" });
  await alice.locator("#composer [data-a=more]").click();
  await alice.locator("#picker .morebtn", { hasText: "Long post" }).click();
  assert.equal(await alice.locator(".writer .ptitlein").inputValue(), "Weekly notes");
  assert.equal(await alice.locator(".writer .pbody").inputValue(), "draft only");
  const text = "# Plan\n**Ship** it this week\n- one\n- two\n\n> a quote\nsee https://example.com";
  await alice.locator(".writer .pbody").fill(text);
  await alice.locator(".writer .bar .btn.primary").click();
  await alice.locator(".writer").waitFor({ state: "detached" });

  // the chat holds the card; the text sits apart
  const card = bob.locator("#list .postbub", { hasText: "Weekly notes" });
  await card.waitFor();
  assert.match(await card.locator(".ps").textContent(), /^Plan Ship it this week one two a quote see https:\/\/example\.com$/);
  const msgs = await dbGet(`rooms/${code}/msgs`), [id] = Object.keys(msgs);
  assert.equal(msgs[id].pt, true);
  assert.equal(msgs[id].post.t, "Weekly notes");
  assert.equal(JSON.stringify(msgs[id]).includes("**Ship**"), false);
  assert.equal((await dbGet(`rooms/${code}/posts/${id}`)).b, text);

  // reading it whole: headings, bold, lists, quotes and links, and reacting as to any message
  await card.click();
  const reader = bob.locator(".reader");
  await reader.locator(".md h3", { hasText: "Plan" }).waitFor();
  assert.equal(await reader.locator(".md b").textContent(), "Ship");
  assert.equal(await reader.locator(".md li").count(), 2);
  await reader.locator(".md blockquote", { hasText: "a quote" }).waitFor();
  await reader.locator(".md a[href='https://example.com']").waitFor();
  await reader.locator(".re.big .chip").first().click();
  await alice.locator("#list .re .chip", { hasText: "👍 1" }).waitFor();

  // the author edits it; the open page follows
  await alice.locator("#list .msg.mine .more").first().click();
  await press(alice, "editpost");
  await alice.locator(".writer .pbody").fill("# Plan B\nnew words");
  await alice.locator(".writer .bar .btn.primary").click();
  await reader.locator(".md h3", { hasText: "Plan B" }).waitFor();
  await bob.locator("#list .msg .edited").waitFor();
  await reader.locator(".bar [data-a=back]").click();
  await reader.waitFor({ state: "detached" });

  // the owner lets everyone write them; the owner can take one down, its text with it
  await menuPick(alice, "postsopen");
  await until(async () => (await dbGet(`rooms/${code}/meta/po`)) === true);
  await writePost(bob, "", "no title needed");
  await alice.locator("#list .postbub .ps.lead", { hasText: "no title needed" }).waitFor();
  await alice.locator("#list .postbub", { hasText: "no title needed" }).click();
  await alice.locator(".reader .md", { hasText: "no title needed" }).waitFor();
  assert.equal((await alice.locator(".reader .pagebody > div").first().textContent()).includes("null"), false);
  await alice.locator(".reader .bar [data-a=back]").click();
  await alice.locator(".reader").waitFor({ state: "detached" });
  await writePost(bob, "From Bob", "hello from a member");
  await alice.locator("#list .postbub", { hasText: "From Bob" }).waitFor();
  const bobs = Object.entries(await dbGet(`rooms/${code}/msgs`)).find(([, v]) => v.by !== msgs[id].by && v.post.t)[0];
  assert.ok(await dbGet(`rooms/${code}/posts/${bobs}`));

  // an export carries the whole text, not only the card
  await menuPick(alice, "export");
  const [file] = await Promise.all([alice.waitForEvent("download"), press(alice, "json")]);
  const a = JSON.parse(readFileSync(await file.path(), "utf8"));
  assert.deepEqual(a.messages.map((m) => [m.post.t, m.post.b]), [["Weekly notes", "# Plan B\nnew words"], ["", "no title needed"], ["From Bob", "hello from a member"]]);

  await alice.locator("#list .msg:not(.mine)", { hasText: "From Bob" }).locator(".more").click();
  await press(alice, "remove");
  await press(alice, "yes");
  await until(async () => (await dbGet(`rooms/${code}/posts/${bobs}`)) === null);
  await bob.locator("#list .postbub", { hasText: "From Bob" }).waitFor({ state: "detached" });
  noErrors();
});

test("long posts in a Private Salon: the card and the text are sealed, and members read them", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { priv: true });
  await joinByLink(bob, url, "Bob");
  await writePost(alice, "Secret plan", "**only** for us");
  await bob.locator("#list .postbub", { hasText: "Secret plan" }).click();
  await bob.locator(".reader .md b", { hasText: "only" }).waitFor();
  const msgs = await dbGet(`rooms/${code}/msgs`), [id] = Object.keys(msgs);
  assert.equal(msgs[id].pt, true);
  assert.equal(msgs[id].post, undefined);
  const body = await dbGet(`rooms/${code}/posts/${id}`);
  assert.equal(body.b, undefined);
  assert.ok(body.x && !JSON.stringify(body).includes("only") && !JSON.stringify(msgs).includes("Secret"));
  noErrors();
});

// writes a comment on the open post's page
async function comment(page, text) {
  await page.locator(".reader .cin").fill(text);
  await page.locator(".reader .cfoot .btn.primary").click();
  await page.locator(".reader .cmt .ctext", { hasText: text }).waitFor();
}

test("comments under a long post: on its page only, counted on the card, the author told; replies, reactions, reports, deleting, exports", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  await writePost(alice, "Ideas", "what do you think?");
  const card = bob.locator("#list .postbub", { hasText: "Ideas" });
  await card.click();
  await bob.locator(".reader .cnone").waitFor();
  await comment(bob, "love it");
  // not in the chat; the card counts it, and the post's author hears of it
  await alice.locator(".toast", { hasText: "Bob commented on your long post" }).waitFor();
  await alice.locator("#list .postbub .pcc", { hasText: "1" }).waitFor();
  assert.equal(await alice.locator("#list .bub", { hasText: "love it" }).count(), 0);
  const [id] = Object.keys(await dbGet(`rooms/${code}/msgs`));
  const [cid] = Object.keys(await dbGet(`rooms/${code}/pc/${id}`));
  assert.equal((await dbGet(`rooms/${code}/msgs/${id}/cc`))[cid], true);

  // Bob closes the page; Alice answers him by name, and he's told
  await bob.locator(".reader .bar [data-a=back]").click();
  await bob.locator(".reader").waitFor({ state: "detached" });
  await alice.locator("#list .postbub", { hasText: "Ideas" }).click();
  await alice.locator(".reader .cmt", { hasText: "love it" }).locator(".icon").click();
  await press(alice, "reply");
  await alice.locator(".reader .creply", { hasText: "Bob" }).waitFor();
  await comment(alice, "thanks @Bob");
  await bob.locator(".toast", { hasText: "Alice mentioned you" }).waitFor();
  await alice.locator(".reader .cmt", { hasText: "thanks" }).locator(".cquote", { hasText: "love it" }).waitFor();

  // reactions, as on a message
  await card.click();
  await bob.locator(".reader .cmt", { hasText: "thanks" }).locator(".icon").click();
  await sheet(bob).locator("[data-a=re1]").click();
  await alice.locator(".reader .cmt", { hasText: "thanks" }).locator(".chip", { hasText: "1" }).waitFor();

  // an export keeps the comments with the post
  await alice.locator(".reader .bar [data-a=back]").click();
  await menuPick(alice, "export");
  const [file] = await Promise.all([alice.waitForEvent("download"), press(alice, "json")]);
  const a = JSON.parse(readFileSync(await file.path(), "utf8"));
  assert.deepEqual(a.messages[0].post.c.map((c) => [c.n, c.t]), [["Bob", "love it"], ["Alice", "thanks @Bob"]]);

  // Bob reports Alice's comment... to Alice, the owner, who sees it among the reports; then Bob deletes his own
  await bob.locator(".reader .cmt", { hasText: "thanks" }).locator(".icon").click();
  await press(bob, "report");
  await press(bob, "r1");
  await alice.locator("#chat .bar [data-a=menu] .dot").waitFor();
  await menuPick(alice, "reports");
  await sheet(alice).locator(".replist li", { hasText: "thanks @Bob" }).waitFor();
  await alice.keyboard.press("Escape");
  await bob.locator(".reader .cmt.mine").locator(".icon").click();
  await press(bob, "del");
  await press(bob, "yes");
  await bob.locator(".reader .cmt", { hasText: "love it" }).waitFor({ state: "detached" });
  await until(async () => !(await dbGet(`rooms/${code}/msgs/${id}/cc/${cid}`)));
  await bob.locator(".reader .chead", { hasText: "Comments · 1" }).waitFor();

  // the post goes with its comments
  await bob.locator(".reader .bar [data-a=back]").click();
  await alice.locator("#list .msg.mine .more").first().click();
  await press(alice, "del");
  await press(alice, "yes");
  await until(async () => (await dbGet(`rooms/${code}/pc/${id}`)) === null);
  noErrors();
});

test("comments in a Private Salon are sealed", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { priv: true });
  await joinByLink(bob, url, "Bob");
  await writePost(alice, "Secret plan", "for us");
  await bob.locator("#list .postbub", { hasText: "Secret plan" }).click();
  await comment(bob, "count me in");
  await alice.locator("#list .postbub", { hasText: "Secret plan" }).click();
  await alice.locator(".reader .cmt .ctext", { hasText: "count me in" }).waitFor();
  const [id] = Object.keys(await dbGet(`rooms/${code}/msgs`));
  const pc = await dbGet(`rooms/${code}/pc/${id}`);
  const [c] = Object.values(pc);
  assert.ok(c.x && c.text === undefined && !JSON.stringify(pc).includes("count me") && !JSON.stringify(pc).includes("Bob"));
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

// quizzes: the host writes a set on its own page; questions are filled in by number (0 the first)
async function writeQuiz(page, title, questions) {
  await page.locator("#composer [data-a=more]").click();
  await page.locator("#picker .morebtn", { hasText: "Quiz" }).click();
  await press(page, "new");
  const ed = page.locator(".qzedit");
  await ed.locator(".qzetitle:focus").waitFor();
  await ed.locator(".qzetitle").fill(title);
  for (const [n, q] of questions.entries()) {
    if (n) await ed.locator(".qzeadd").click();
    const card = ed.locator(".qzeq").nth(n);
    await card.locator("textarea").fill(q.t);
    for (const [k, o] of q.o.entries()) await card.locator(".qzeo input").nth(k).fill(o);
    if (q.right !== 0) { await card.locator(".qzeright").nth(0).click(); await card.locator(".qzeright").nth(q.right).click(); }
    await card.locator("select").first().selectOption(String(q.d || 5));
  }
  return ed;
}
const quizPage = (page) => page.locator(".quizov");
const quizBtn = (page, text) => quizPage(page).locator(".actions .btn", { hasText: text });

test("quiz: the host writes a set and runs it; players join from the card, answer against the clock, and see the scores", async () => {
  const alice = await person("a"), bob = await person("b"), carol = await person("c");
  const { code, url } = await createRoom(alice, "Alice");
  await joinByLink(bob, url, "Bob");
  await joinByLink(carol, url, "Carol");
  // members don't get the quiz in the ＋ panel; the host does
  await bob.locator("#composer [data-a=more]").click();
  await bob.locator("#picker .morebtn").first().waitFor();
  assert.equal(await bob.locator("#picker .morebtn", { hasText: "Quiz" }).count(), 0);
  await bob.locator("#composer [data-a=more]").click();

  const ed = await writeQuiz(alice, "Maths", [{ t: "2 + 2 = ?", o: ["3", "4", "5"], right: 1 }, { t: "Which is even?", o: ["7", "8"], right: 1 }]);
  await ed.locator(".pfoot", { hasText: "Saved on this device" }).waitFor();
  assert.deepEqual(await ed.locator(".qzeq").first().locator(".qzeo input").evaluateAll((l) => l.map((i) => i.placeholder)),
    ["Option 1", "Option 2", "Option 3 (optional)", "Option 4 (optional)"], "two options are enough");
  await shot(alice, "quiz-editor");
  await ed.locator(".bar .btn.primary").click();   // Start quiz
  await quizPage(alice).locator(".qzplayers, .muted", { hasText: "Nobody has joined yet" }).first().waitFor();
  const [z] = Object.keys(await dbGet(`rooms/${code}/qz`));
  const quiz = await dbGet(`rooms/${code}/qz/${z}`);
  assert.equal(quiz.live.ph, "lobby");
  assert.equal(JSON.parse(quiz.src).q[0].c[0], 1, "the whole set, answers and all, sits where only the hosts read it");
  assert.equal(quiz.q, undefined, "no question is out yet");

  // players come in from the card in the chat
  const card = bob.locator(".quizbub", { hasText: "Maths" });
  await card.locator(".btn", { hasText: "Play" }).click();
  await quizPage(bob).locator(".qzjoin .btn", { hasText: "Play as" }).click();
  await quizPage(bob).locator(".qzwait", { hasText: "You're in" }).waitFor();
  await carol.locator(".quizbub .btn", { hasText: "Play" }).click();
  await quizPage(carol).locator(".qzjoin .btn").click();
  await quizPage(alice).locator(".qzplayers .chip").nth(1).waitFor();
  await shot(alice, "quiz-lobby-host");
  await shot(bob, "quiz-lobby-player");

  // question 1: out first, answering a few seconds on; nobody else's answer can be seen while it's open
  await quizBtn(alice, "Start").click();
  await quizPage(bob).locator(".qzcount").waitFor();
  await shot(bob, "quiz-get-ready");
  const four = quizPage(bob).locator("button.qzopt", { hasText: "4" });
  await bob.locator("button.qzopt:not([disabled])").first().waitFor({ timeout: 8000 });
  await shot(bob, "quiz-answering");
  await four.click();
  await quizPage(bob).locator(".qzwait", { hasText: "Waiting for the others" }).waitFor();
  assert.equal((await dbGet(`rooms/${code}/qz/${z}/k`)), null, "the right answer isn't out while answering");
  await quizPage(carol).locator("button.qzopt", { hasText: "5" }).click();
  // everyone has answered: the host's device closes it and works out the points
  await quizPage(bob).locator(".qzme.ok", { hasText: "Right!" }).waitFor();
  await quizPage(carol).locator(".qzme.no", { hasText: "Wrong" }).waitFor();
  await quizPage(alice).locator(".lb li").nth(1).waitFor();
  await shot(bob, "quiz-right");
  await shot(alice, "quiz-reveal-host");
  const s0 = JSON.parse(await dbGet(`rooms/${code}/qz/${z}/s/00`));
  assert.deepEqual(s0.n, [0, 1, 1]);
  assert.ok(s0.g[Object.keys(s0.g).find((uid) => s0.g[uid] > 0)] > 500, "a fast right answer gets more than half");

  // question 2: Carol is right, Bob lets the time run out
  await quizBtn(alice, "Next question").click();
  await carol.locator("button.qzopt:not([disabled])").first().waitFor({ timeout: 8000 });
  await quizPage(carol).locator("button.qzopt", { hasText: "8" }).click();
  await quizPage(bob).locator(".qzme.no", { hasText: "No answer" }).waitFor({ timeout: 12000 });
  // the end: the podium, in the quiz and on the card
  await quizBtn(alice, "Final results").click();
  await quizPage(bob).locator(".qzpodium li").nth(1).waitFor();
  await shot(bob, "quiz-results");
  await quizPage(bob).locator(".gmhead [aria-label=Close]").click();
  await card.locator(".qzpodium li").nth(1).waitFor();
  assert.match(await card.locator(".qzpodium li").first().textContent(), /Bob|Carol/);
  await shot(bob, "quiz-card-done");
  assert.equal((await dbGet(`rooms/${code}/qz/${z}/live`)).ph, "end");
  // the host saves the scores and keeps the set
  const [csv] = await Promise.all([alice.waitForEvent("download"), quizBtn(alice, "Export scores").click()]);
  assert.match(csv.suggestedFilename(), /^quiz-.*\.csv$/);
  noErrors();
});

test("quiz: a set goes out as a file and comes back in; in a Private Salon everything is sealed", async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { priv: true });
  await joinByLink(bob, url, "Bob");
  const ed = await writeQuiz(alice, "Salon quiz", [{ t: "Capital of France?", o: ["Paris", "Rome"], right: 0, d: 10 }]);
  await ed.locator(".pfoot", { hasText: "Saved on this device" }).waitFor();
  await alice.keyboard.press("Escape");
  await ed.waitFor({ state: "detached" });
  // export, delete, import
  await alice.locator("#composer [data-a=more]").click();
  await alice.locator("#picker .morebtn", { hasText: "Quiz" }).click();
  await sheet(alice).locator(".gmrow", { hasText: "Salon quiz" }).click();
  const [file] = await Promise.all([alice.waitForEvent("download"), press(alice, "export")]);
  assert.match(file.suggestedFilename(), /\.stoaquiz$/);
  const path = await file.path();
  await alice.locator("#composer [data-a=more]").click();
  await alice.locator("#picker .morebtn", { hasText: "Quiz" }).click();
  await sheet(alice).locator(".gmrow", { hasText: "Salon quiz" }).click();
  await press(alice, "drop");
  await press(alice, "yes");
  await alice.locator("#composer [data-a=more]").click();
  await alice.locator("#picker .morebtn", { hasText: "Quiz" }).click();
  await sheet(alice).locator(".lbnone").waitFor();
  await sheet(alice).locator("input[type=file]").setInputFiles(path);
  await sheet(alice).locator(".gmrow", { hasText: "Salon quiz" }).click();
  await press(alice, "start");
  await quizPage(alice).waitFor();
  // in the Salon: the card, the set, the players, the question, the answer, the key and the scores are sealed
  await bob.locator(".quizbub .btn", { hasText: "Play" }).click();
  await quizPage(bob).locator(".qzjoin .btn").click();
  await quizPage(alice).locator(".qzplayers .chip").waitFor();
  await quizBtn(alice, "Start").click();
  await bob.locator("button.qzopt:not([disabled])").first().waitFor({ timeout: 8000 });
  await quizPage(bob).locator("button.qzopt", { hasText: "Paris" }).click();
  await quizPage(bob).locator(".qzme.ok", { hasText: "Right!" }).waitFor();
  const [z] = Object.keys(await dbGet(`rooms/${code}/qz`));
  const q = await dbGet(`rooms/${code}/qz/${z}`), m = await dbGet(`rooms/${code}/msgs/${z}`);
  assert.ok(m.x && m.qm === true && !m.quiz, "the card is sealed");
  for (const v of [q.src, q.q["00"], q.k["00"], q.s["00"], ...Object.values(q.p).map((p) => p.x), ...Object.values(q.a["00"]).map((a) => a.x)]) {
    assert.match(v, /^[A-Za-z0-9_-]+$/);
    assert.ok(!/Paris|France|Bob/.test(v));
  }
  await quizBtn(alice, "Final results").click();
  await bob.locator(".quizbub .qzpodium li", { hasText: "Bob" }).waitFor();
  noErrors();
});

for (const priv of [false, true]) test(`quiz pictures go to R2 with the quiz (${priv ? "sealed" : "as JPEG"}), show on the phones and the projector, and go with the card`, async () => {
  const alice = await person("a"), bob = await person("b");
  const { code, url } = await createRoom(alice, "Alice", { priv });
  await joinByLink(bob, url, "Bob");
  const ed = await writeQuiz(alice, "Pictures", [{ t: "What colour is it?", o: ["Red", "Black"], right: 1, d: 10 }]);
  await ed.locator(".qzeq .qzeimg input[type=file]").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });
  await ed.locator(".qzeq .qzeimg img[src^='data:image/jpeg']").waitFor();
  await ed.locator(".bar .btn.primary").click();
  await quizPage(alice).locator(".qzplayers, .muted", { hasText: "Nobody has joined yet" }).first().waitFor();
  // the picture is in R2 under an id that starts with the quiz's; the room's copy of the set only says where
  const [z] = Object.keys(await dbGet(`rooms/${code}/qz`));
  const keys = [...photos.bucket.objects.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], new RegExp(`^${code}/emu[a-z0-9]+/${z.replace(/[-]/g, "\\-")}[A-Za-z0-9]{10}\\.${priv ? "bin" : "jpg"}$`));
  const body = photos.bucket.objects.get(keys[0]).body;
  assert.equal(body[0] === 0xff && body[1] === 0xd8, !priv, "sealed in a Salon");
  if (!priv) {
    const src = JSON.parse((await dbGet(`rooms/${code}/qz/${z}/src`)));
    assert.ok(src.q[0].im && !src.q[0].img, "the set in the room points at the picture");
  }
  // the projector screen, from the quiz's page
  const [show] = await Promise.all([alice.context().waitForEvent("page"), quizPage(alice).locator(".gmhead [aria-label='Show on the projector screen']").click()]);
  await show.setViewportSize({ width: 1280, height: 720 });
  await show.locator("#show .sqz.lobby").waitFor();
  await bob.locator(".quizbub .btn", { hasText: "Play" }).click();
  await quizPage(bob).locator(".qzjoin .btn").click();
  await show.locator("#show .sqz.lobby .chip", { hasText: "Bob" }).waitFor();
  await shot(show, "quiz-projector-lobby");
  await quizBtn(alice, "Start").click();
  // the picture comes with the question, on the phone and the projector, before answering opens
  await quizPage(bob).locator(".qzpre img.qzimg[src^='blob:']").waitFor();
  await show.locator("#show.quizon .sqz.pre img.qzimg[src^='blob:']").waitFor();
  await bob.locator("button.qzopt:not([disabled])").first().waitFor({ timeout: 8000 });
  await quizPage(bob).locator(".qzlive img.qzimg[src^='blob:']").waitFor();
  await show.locator("#show .sqz.q .qzopt", { hasText: "Black" }).waitFor();
  await show.locator("#show .sqz.q .sqzn", { hasText: "Answered 0 of 1" }).waitFor();
  await shot(show, "quiz-projector-question");
  await shot(bob, "quiz-picture");
  await quizPage(bob).locator("button.qzopt", { hasText: "Black" }).click();
  await show.locator("#show .sqz.rev .qzopt.right", { hasText: "Black" }).waitFor();
  await show.locator("#show .sqz.rev .lb li", { hasText: "Bob" }).waitFor();
  await shot(show, "quiz-projector-reveal");
  await quizBtn(alice, "Final results").click();
  await show.locator("#show .sqz.end .qzpodium li", { hasText: "Bob" }).waitFor();
  await shot(show, "quiz-projector-results");
  await show.close();
  // the host keeps the set, picture and all, from the room
  await quizBtn(alice, "Save to my sets").click();
  await alice.locator(".toast", { hasText: "Saved to your question sets" }).waitFor();
  const kept = await alice.evaluate(() => new Promise((ok) => {
    const req = indexedDB.open("stoatalk");
    req.onsuccess = () => { const all = req.result.transaction("quizzes").objectStore("quizzes").getAll(); all.onsuccess = () => ok(all.result.map((s) => !!s.q[0].img)); };
  }));
  assert.deepEqual(kept.sort(), [true, true]);
  // the card goes, and the picture with it
  await quizPage(alice).locator(".gmhead [aria-label=Close]").click();
  await alice.locator("#list .msg.mine .more").first().click();
  await press(alice, "del");
  await press(alice, "yes");
  await waitUntil(() => photos.bucket.objects.size === 0);
  noErrors();
});

// the camera plays a canvas showing a QR Code of window.qrText (none until it's set); deny: the camera is refused
async function withCamera(as, { deny = false } = {}) {
  const ctx = await browser.newContext({ locale: "en-US" });
  await ctx.addInitScript((deny) => {
    navigator.mediaDevices.getUserMedia = async () => {
      if (deny) throw new DOMException("no", "NotAllowedError");
      const c = Object.assign(document.createElement("canvas"), { width: 480, height: 480 }), g = c.getContext("2d");
      // painted afresh every frame, as a camera keeps sending them
      setInterval(() => {
        const drawn = window.qrText;
        g.fillStyle = "#fff"; g.fillRect(0, 0, 480, 480);
        if (drawn) { const q = qrcode(0, "M"); q.addData(drawn); q.make(); const n = q.getModuleCount(), s = Math.floor(360 / n);
          g.fillStyle = "#000"; for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect(60 + k * s, 60 + r * s, s, s); }
      }, 50);
      return c.captureStream(10);
    };
  }, deny);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${as}: ${e.message}`));
  await page.goto(`${base}/?emu&as=${as}`);
  await page.locator("#createBtn").waitFor();
  return page;
}

test("joining by the room's QR Code: the camera reads it (only a StoaTalk link counts), or a photo of it when the camera is refused", async () => {
  const alice = await person("a");
  const { code, url } = await createRoom(alice, "Alice", { priv: true });
  assert.match(url, /#k=/);

  const bob = await withCamera("b");
  await bob.locator("#scanBtn").click();
  await sheet(bob).locator(".scanview video").waitFor();
  await bob.evaluate(() => (window.qrText = "https://example.com/?room=ABCD"));
  await bob.locator(".toast", { hasText: "isn't a StoaTalk room" }).waitFor();
  assert.ok(await sheet(bob).locator(".scan").isVisible(), "the camera keeps looking");
  await bob.evaluate((u) => (window.qrText = u), url);
  await pickName(bob, "Bob");
  await bob.locator("#chat").waitFor();
  assert.match(new URL(bob.url()).search, new RegExp(`room=${code}`));
  assert.equal(await bob.locator(".scan").count(), 0, "the scanner is gone, and its camera with it");
  await say(bob, "scanned in");
  await bubble(alice, "scanned in").waitFor();

  const carol = await withCamera("c", { deny: true });
  await carol.locator("#scanBtn").click();
  await sheet(carol).locator(".scannote", { hasText: "isn't allowed" }).waitFor();
  assert.ok(await sheet(carol).locator(".scanview").isHidden());
  // a photo of the QR Code, chosen from the device
  await carol.evaluate(async (u) => {
    const q = qrcode(0, "M"); q.addData(u); q.make();
    const img = new Image(); img.src = q.createDataURL(8, 16); await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    c.getContext("2d").drawImage(img, 0, 0);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/png")), dt = new DataTransfer();
    dt.items.add(new File([blob], "qr.png", { type: "image/png" }));
    const input = document.querySelector(".scan input[type=file]"); input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  }, url);
  await pickName(carol, "Carol");
  await carol.locator("#chat").waitFor();
  await bubble(carol, "scanned in").waitFor();
  noErrors();
});
