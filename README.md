# StoaTalk

Open a room, get a 4-character code, and share the code or link. Anyone with it joins straight from the browser: no sign-up, no LINE, FB or IG. When the talk is over the room is deleted, and anyone who wants a copy exports it first.
Made for lecture Q&A, anonymous reading groups, workshops and team projects. Interface: 繁體中文, 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Português. It follows the device's language (English when the site doesn't have it), and the ☰ menu on the home page can change it. Text lives in `site/js/i18n/<lang>.js`; add a key to every file when you add text.

- **Rooms**: Open Stoa / 公開議廊 (the code is enough) or Private Salon / 私人沙龍, which is always end-to-end encrypted (only the full link or QR code gets in).
- **End-to-end encryption**: private messages are always end-to-end encrypted. A room can also be opened as encrypted: its key travels only in the invite link and QR code (after the `#`, which browsers never send to a server), so the database holds the title, nicknames and messages only as ciphertext. People need the full link to join; the 4-character code alone isn't enough. See below.
- **Identity**: a nickname and an animal, kept on the device. Nicknames are unique within a room (ignoring case). Behind the scenes each device gets an anonymous Firebase id.
- **Chat**: live messages, replies that quote and jump to the original, links, @mentions (typing @ offers names; a mention notifies even a muted room), editing your own messages (marked 已編輯), "someone is typing", a line above the messages that came since you last read and a ↓ button back to the newest, an emoji picker, GIF search (KLIPY), six reactions, who's here and who's online, private messages between two people (the owner can't read those either).
- **Owner**: rename the room, describe what it's for (owner and co-hosts; up to 500 characters, shown under the room's name: two lines, the rest on a tap), pin up to three messages as announcements (one line at the top, tap to open), cap how many people can be in it, lock it to newcomers, name co-hosts, hand the room to someone else (and stay on as a co-host), end the room. The owner and co-hosts remove anyone's message and remove people (co-hosts can't remove the owner or each other); removed people can't come back from that device.
- **Safety**: anyone can report a message to the owner and co-hosts with a reason (they see why and how many, never who), and block someone on their own device, which folds that person's messages away. Every report also goes to StoaTalk's operator with the message as the reporter saw it (decrypted by the reporter in a Private Salon). The operator works them on `site/admin.html`: take the message down, end the room, or ban the device everywhere (`bans/{uid}`: it can't open, join or post in any room). The hourly cleanup opens a GitHub issue when new reports come in, so GitHub emails the owner; it says only how many. The rules let each person post at most every 800 ms, one message per write. Terms and privacy policy: `site/legal.html` (Chinese and English).
- **Lecture Q&A**: the owner opens a ❓ tab where people ask, by name or anonymously, and upvote each other's questions, which sort by votes. The owner and co-hosts mark the one being answered now and the ones answered, write a text answer under any question (shown on the projector and kept in exports), take any down, and can turn on review so new questions wait until they publish them. Anonymous means anonymous to the owner too: who asked is kept where only the asker can read it.
- **Projector screen** (`?room={code}&show=1`, from the owner's ⋯ menu): the QR Code and code to join beside the question being answered, the most upvoted ones and the latest poll, live and in large type.
- **Usage stats**: anonymous daily counts (rooms opened, joins, messages, questions, ...) in `stats/{day}`, with no content or ids. `.github/workflows/stats.yml` shows the last 30 days in its run summary every Monday, or when run by hand.
- **Notifications**: a system notification for each new message while the page is open in the background (a tab, or the installed app). Each room can be muted from its ⋯ menu; the setting stays on the device. With the page closed, Web Push: the browser's subscription, sealed by the push service, sits in each room it wants to hear from (`push/{uid}`), and after posting, the author's page asks the service (`worker/`) to announce the message to members who aren't online, at most once every 20 seconds per room (`meta/pa`). A Private Salon's or a private message's push says only that there's something new. On iPhone, only from the app added to the home screen. Push stays off until the service has its key: make one on `site/admin.html` and save it as the `VAPID_KEY` repository secret.
- **Deleting**: ending a room deletes every message and private message right away. A room nobody has written in for 24 hours is deleted by an hourly job (`tools/cleanup`), and its code can be reused.
- **Export and records**: everyone can download what they can see, including their own private messages, as `.json`, `.html` or `.txt`, or keep it in this browser under 「我的聊天記錄」. The `.json` and `.html` files can be imported back and read here, read-only (the `.html` carries the same JSON inside it). Records stay on the device; nothing is uploaded. An imported file is checked field by field, but a file is only as trustworthy as whoever sent it: nothing proves it wasn't edited by hand.

## Layout

```
site/                       the whole app, served as-is by Cloudflare Pages
  index.html, css/app.css
  js/app/                   the page itself, as ES modules served as they are (no build step); main.js starts it.
                            room.js keeps one room live (Room, its data and events), api.js is every write to it,
                            kinds.js is each kind of message (text, GIF, photo, poll, draw), crypto.js the encryption;
                            the screens (chat.js, qa.js, show.js, home.js, ...) draw what a Room tells them
  js/i18n.js, js/theme.js   the language and light/dark, loaded in <head> before anything paints
  js/config.js              Firebase web config (public by design)
  js/vendor/                Firebase SDK bundle and qrcode-generator (npm run vendor rebuilds them)
  sw.js, manifest.webmanifest, icons/
database.rules.json         who may read and write what; generated from tools/rules.py
tools/rules.py              the rules, written readably (npm run rules)
tools/cleanup/              hourly job that deletes rooms idle for 24 hours, and photos no room points at;
                            stats.mjs prints the usage counts
worker/                     a Cloudflare Worker at api.stoatalk.app: puts photos into R2 and deletes them, and sends Web Push
site/admin.html             the operator's page: reports from every room, bans, and making the Web Push key
test/rules.test.mjs         rule tests against the Firebase emulator
test/app.e2e.test.mjs       the page in a real browser (Playwright), two or three people at once, against the emulator
test/unit.test.mjs          the record format, encryption, kinds of message, translations and module wiring
test/worker.test.mjs        the photo service and the cleanup's choice of stray photos (photo-stub.mjs runs it locally)
```

Data in the Realtime Database:

```
rooms/{code}/meta           owner, title, desc, created, last (last activity), locked,  readable by any signed-in device
                            mods/{uid} (co-hosts), cap and n (size limit, members counted),
                            qa (Q&A open), qmod (review questions first), qnow (the question being answered),
                            pa (when a message here was last announced by Web Push)
                            encrypted room: enc, kc (key check), xt, xd (sealed title, description) instead of title, desc
rooms/{code}/members/{uid}  name, avatar, joined, online, pk (public key for private messages),   members only
                            ls (when they last posted), lm/lf/lq (the message/photo/question that post wrote)
                            encrypted room: x (sealed name and avatar), h (keyed hash of the name) instead of name, avatar
rooms/{code}/names/{key}    uid holding that nickname: the lowercased name, or h in an encrypted room   any signed-in device
rooms/{code}/msgs/{id}      by, name, avatar, text or gif{url,w,h,title}, at, re/{0-5}/{uid}  members only
                            encrypted room: by, x (sealed text or gif, name, avatar), at, re
rooms/{code}/files/{id}     by, at: the marker of a photo; the picture is in R2      members only
rooms/{code}/dm/{uidA_uidB}/{id}  by, to, x (sealed text or gif), at                    those two only
rooms/{code}/banned/{uid}   people the owner or a co-host removed
rooms/{code}/reports/{msg}/{uid}  r (reason 0-3), at                                   owner and co-hosts only
rooms/{code}/push/{uid}    this member's push subscription, sealed by the push service      members read, self writes
rooms/{code}/qs/{id}        text, name?, avatar? (left out when anonymous), at, up/{uid}, done   members only
                            encrypted room: x (sealed text, name, avatar), at, up, done
rooms/{code}/qs/{id}/ans    by, at, text, name, avatar (the owner's or a co-host's answer)  members read, staff write
                            encrypted room: by, at, x (sealed text, name, avatar)
rooms/{code}/qq/{id}        a question waiting for review, same fields                 owner, co-hosts and the asker
rooms/{code}/qby/{id}       who asked                                                 only the asker reads it
rooms/{code}/typing/{uid}   server time while typing; dmt/{uidA_uidB}/{uid} the same in a private chat
stats/{YYYY-MM-DD}/{what}   anonymous daily counts, each write adds one              nobody reads it but the admin
ops/admins/{uid}            true for StoaTalk's operator, set by hand in the Firebase console   each reads only their own
ops/reports/{code}_{msg}_{uid}  code, msg, by, who, r, at, t (the words as the reporter saw them), n, f?, enc?   operator only
bans/{uid}                  at, why: banned from every room by the operator                    operator; self reads own
```

## Encryption

All of it uses the browser's Web Crypto API; nothing extra is loaded.

- **Encrypted room**: the creator's browser makes a random 256-bit key and puts it in the invite link as `#k=…`. From it come an AES-GCM key (title, nicknames, messages) and an HMAC key (nickname claims, and `kc`, which lets a joiner tell a wrong link from a right one). Each device keeps the key under `chat-key:{code}` until it leaves or the room ends.
- **Private messages**: each device has an ECDH P-256 key pair (`chat-dh`); the public half is on its member record, and two people derive the same AES-GCM key for their conversation in that room.
- Every sealed value is bound to its author (AES-GCM additional data), so the server can't move a message or a nickname onto someone else. The rules refuse plaintext in an encrypted room, refuse private messages without ciphertext, and don't let the owner switch encryption off.
- What the server still sees: who is in a room, when they write, how long a message is, who has private messages with whom, and reactions. There is no safety-number check yet, so a compromised server could swap public keys; and like any web app, whoever controls the page's code could read keys.

## Develop

```sh
npm install
npm test                                   # starts the database emulator and runs test/ (needs Java)
python3 -m http.server -d site 8000        # then open http://localhost:8000/?emu with the emulator running:
npx firebase emulators:start --only database --project demo-anon-chat
```

`?emu` points the page at the local emulator (remembered until `?emu=0`). Open a second browser profile or a private window to be a second person.
The page tests need Chromium: `npx playwright install chromium` once.
A module in `site/js/app/` imports the others as `./name.js?v=dev`; the deploy stamps the commit there too, and `site/sw.js` lists each module (the unit tests check both).
After editing `tools/rules.py`, run `npm run rules` and commit the new `database.rules.json` (CI checks they match).

Live at https://stoatalk.app. Pushing to `main` deploys `site/` to Cloudflare Pages (`.github/workflows/cloudflare-pages.yml`, project `stoatalk`, also at `stoatalk.pages.dev`), after `tools/stamp.sh` ties the page to the commit; `site/_headers` sets the response headers there.

The domain is connected under Workers & Pages > `stoatalk` > Custom domains (it replaced the apex records that pointed at GitHub Pages, which served the site until 2026-10-18). `www.stoatalk.app` is a proxied `CNAME` to the apex with a Redirect Rule: Hostname equals `www.stoatalk.app` → `concat("https://stoatalk.app", http.request.uri.path)`, 301, query string kept. Match on the hostname only: a rule on all requests redirects the whole zone, the photo service included, in a loop. The deploy token needs Account > Cloudflare Pages > Edit besides the Workers permissions.

## Setting up Firebase

1. Create a project at https://console.firebase.google.com (a separate one from the scoreboard: the free plan allows 100 simultaneous connections per project).
2. **Authentication** > Sign-in method: enable **Anonymous**.
3. **Realtime Database** > Create database (Singapore, `asia-southeast1`, is closest to Taiwan), start in locked mode, then paste `database.rules.json` into the **Rules** tab and publish. Or: `npx firebase deploy --only database --project <project-id>`.
4. Project settings > Your apps > add a **Web app**, and copy its config (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`) into `site/js/config.js`.
5. Authentication > Settings > Authorized domains: add your site's domain (`stoatalk.app`, and `stoatalk.pages.dev` for trying a deploy).
6. For the 24-hour cleanup and for publishing rule changes automatically: Project settings > Service accounts > Generate new private key, then in the GitHub repository add the secrets `FIREBASE_SERVICE_ACCOUNT` (the whole JSON file) and `FIREBASE_DATABASE_URL`. Without them the cleanup job skips itself, and idle rooms stay until someone tries to open them or their code is reused. With them, `deploy-rules.yml` publishes `database.rules.json` whenever it changes on `main`.
7. GIF search: create a key at https://klipy.com/developers and put it in `site/js/config.js` as `klipyKey`. Without one the GIF button is hidden. GIFs are only accepted from `*.klipy.com` (checked in the rules too).

## Photos (Cloudflare R2)

A photo is compressed on the device, sealed with the room key in a Private Salon, and sent to the photo service
(`worker/`), which checks the person's Firebase ID token and that they're in the room, then stores it in the R2
bucket `stoatalk-photos` at `{code}/{uid}/{id}.jpg` (`.bin` when sealed). Everyone downloads it from
`https://files.stoatalk.app/...`, the bucket's public domain, through Cloudflare's cache: R2 charges nothing for
downloads, where the database charges for every copy. Deleting the message, or ending the room, asks the service to
delete the picture; the hourly cleanup removes any the page missed.

Setup, once: in Cloudflare create the bucket `stoatalk-photos`, connect the custom domain `files.stoatalk.app`, and
give it a CORS policy allowing `GET`/`HEAD` from `https://stoatalk.app`. In GitHub add the secrets
`CLOUDFLARE_API_TOKEN` (an "Edit Cloudflare Workers" token) and `CLOUDFLARE_ACCOUNT_ID`, which `worker.yml` uses to
deploy the service to `api.stoatalk.app`, and `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (an R2 token with object read
and write on the bucket), which the cleanup uses.

Capacity on the free (Spark) plan: 100 people online at once across all rooms, 1 GB stored, 10 GB downloaded a month. A lecture with more than 100 people needs the pay-as-you-go (Blaze) plan; chat text is small, so the cost is usually tiny. When all 100 connections are taken, the database turns new ones away without an error; the page then gives up after 20 seconds and says the server can't be reached, and a page left in the background with no room on screen lets go of its connection after a minute.
