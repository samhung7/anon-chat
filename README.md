# StoaTalk

Open a room, get a 4-character code, and share the code or link. Anyone with it joins straight from the browser: no sign-up, no LINE, FB or IG. When the talk is over the room is deleted, and anyone who wants a copy exports it first.
Made for lecture Q&A, anonymous reading groups, workshops and team projects. Interface: 繁體中文, 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Português. It follows the device's language (English when the site doesn't have it), and the ☰ menu on the home page can change it. Text lives in `site/js/i18n/<lang>.js`; add a key to every file when you add text.

- **Rooms**: Open Stoa / 公開議廊 (the code is enough) or Private Salon / 私人沙龍, which is always end-to-end encrypted (only the full link or QR code gets in). The home page's QR button opens the camera (or a photo) and joins by a room's QR Code, read on the device: the browser's BarcodeDetector where it has one, else jsQR (`js/vendor/jsqr.js`, loaded on first use); only a StoaTalk invite link joins.
- **End-to-end encryption**: private messages are always end-to-end encrypted. A room can also be opened as encrypted: its key travels only in the invite link and QR code (after the `#`, which browsers never send to a server), so the database holds the title, nicknames and messages only as ciphertext. People need the full link to join; the 4-character code alone isn't enough. See below.
- **Identity**: a nickname and an animal, kept on the device. Nicknames are unique within a room (ignoring case). Behind the scenes each device gets an anonymous Firebase id.
- **Chat**: live messages, replies that quote and jump to the original, links, @mentions (typing @ offers names; a mention notifies even a muted room), editing your own messages (marked 已編輯), "someone is typing", a line above the messages that came since you last read and a ↓ button back to the newest, an emoji picker, GIF search (KLIPY), six reactions, who's here and who's online, private messages between two people (the owner can't read those either).
- **Quick replies**: a row above the empty message box that sends a short answer with one tap (👍 Agreed, 🙏 Thanks for sharing, ❓ Could you say more?, ...), so taking part costs no typing. While replying to a message, answers to it come first (+1, I agree, I see it differently) and go out as a reply. Each person edits their own (up to 8, kept on the device; until edited, the presets in their language) or turns the row off from the ✎ at its end or the ⋯ menu. The owner and co-hosts can add up to 6 of the room's own, shown first in everyone's row (a lecture's "Got it", "Too fast": `meta/qr`, sealed as `xr` in a Private Salon). A quick reply is an ordinary message. Tapping a message twice gives it a 👍.
- **Polls** (＋ → 投票): a question and 2 to 10 options, one choice or several; votes change until the author closes the poll. Normally the room sees who voted for what. **Anonymous** polls (`an` on the message) take each vote as a ballot under a key the voter picks (`ab/{poll}/{key}`), and which key is whose sits where only its owner can read it (`av/{poll}/{uid}`), so nobody in the room, the author included, can tell who voted how. A poll can also **hide its results** until a time its author sets, from 5 minutes to a week ahead (`rv`): until then each person reads only their own vote (`pv/{poll}/{uid}`, or their own ballot), and from then, or once the author reveals it early, everyone reads the votes and nobody can change them. The rules enforce all of it, and in a Private Salon `an` and `rv` sit plain beside the sealed poll so they can. (StoaTalk's operator, with the whole database, could still tie a ballot to its voter.)
- **Owner**: rename the room, describe what it's for (owner and co-hosts; up to 500 characters, shown under the room's name: two lines, the rest on a tap), pin up to three messages as announcements (one line at the top, tap to open), cap how many people can be in it, lock it to newcomers, name co-hosts, hand the room to someone else (and stay on as a co-host), end the room. The owner and co-hosts remove anyone's message and remove people (co-hosts can't remove the owner or each other); removed people can't come back from that device.
- **Safety**: anyone can report a message to the owner and co-hosts with a reason (they see why and how many, never who), and block someone on their own device, which folds that person's messages away. Every report also goes to StoaTalk's operator with the message as the reporter saw it (decrypted by the reporter in a Private Salon). The operator works them on `site/admin.html`: take the message down, end the room, or ban the device everywhere (`bans/{uid}`: it can't open, join or post in any room). The hourly cleanup opens a GitHub issue when new reports come in, so GitHub emails the owner; it says only how many. The rules let each person post at most every 800 ms, one message per write. Terms and privacy policy: `site/legal.html` (Chinese and English).
- **Lecture Q&A**: the owner opens a ❓ tab where people ask, by name or anonymously, and upvote each other's questions, which sort by votes. The owner and co-hosts mark the one being answered now and the ones answered, write a text answer under any question (shown on the projector and kept in exports), take any down, and can turn on review so new questions wait until they publish them. Anonymous means anonymous to the owner too: who asked is kept where only the asker can read it.
- **Mini-games** (＋ → 小遊戲): three short puzzles with no clock, for the minutes before a meeting: Code Lock / 密碼鎖 (a 4-colour code in 8 tries), Crowns / 皇后格 (one crown per row, column and coloured area) and One Line / 一筆連 (one line through every square, numbers in order). Everyone in a room gets the same puzzle of each game each day (made on the device from the room code and the day, changing at midnight UTC+8), plays it once for 0 to 100 points, and can share the result to the chat as a card without spoilers. The room's leaderboard shows today and the week; every device checks a score by playing its record back against the puzzle. The owner can turn games off from the ⋯ menu.
- **Long posts** (＋ → 長文): a title and up to 20,000 characters, written on a page of their own with a few marks of Markdown (# headings, **bold**, - and 1. lists, > quotes, links) and up to 9 photos, with a preview. The chat shows a card (title, the first lines, how long it is); tapping it opens the whole text, with reactions as on any message, and replies, pins, reports, editing and taking it down work as for any message. The text sits apart from the chat (`posts/{id}`), so it's downloaded only when opened, and exports carry it whole. The owner and co-hosts write them; the owner can open them to everyone from the ⋯ menu. What's being written is kept on the device as it's typed until it's published, so a closed page or a room turning read-only doesn't lose it. Anyone in the room can comment under a post, on its page only (never in the chat): words, a reply to another comment, and reactions. The card counts them; the post's author and anyone @mentioned are told of a new one; comments keep the room going like messages, can be reported to the hosts and StoaTalk's operator, go with their post, and are kept in exports.
- **Quizzes** (＋ → 競答, owner and co-hosts): a Kahoot-style contest. The host writes a question set on a page of its own (a title and up to 100 questions, each with 2 to 4 options marked ▲◆●■, one or more right, 5 to 120 seconds, standard, double or no points); sets are kept on the host's device (IndexedDB, "my question sets") and go out as `.stoaquiz` files to keep or bring into another room. Starting one posts a card; people tap it to play. Each question is out a few seconds before answering opens, answering runs on the server's clock (the rules only take an answer while it's open, once, stamped with the server's time), and right answers score 500 to 1,000 points, more for faster ones. When time is up or everyone has answered, the host's device shows the right answers, how many picked each option and the leaderboard; after the last question the card shows the top three, and the host can export the scores as CSV. A question can have a picture: it's shrunk on the device, kept in the set and its file, and put in R2 when the quiz starts (sealed in a Private Salon), under an id that starts with the quiz's and that nobody can guess before the question is out; it goes when the quiz's card does. While a quiz is on, the projector screen shows it instead of the questions and polls: the players joining, each question large with its picture, the clock and the options, then the answers and the leaderboard. Nobody but the hosts can read the right answers before they're shown, a question before it's asked, or anyone else's answer while answering is open; in a Private Salon all of it is sealed.
- **Sticky notes** (＋ → 便利貼, owner and co-hosts open one): a board where everyone puts ideas up to talk them over. The host names it, picks its columns (one, pros/cons, Keep/Problem/Try, a retro, or their own, up to 6), whether notes are anonymous or carry their author's room name, how many votes each person gets (1, 3 or 5) and how many notes each may put up. It posts a card; tapping it opens the board on a page of its own: columns side by side on a wide screen, one under another (with tabs to jump between them) on a phone. The host can open it hidden: until they reveal the notes (or start the vote), everyone sees only their own notes' words, hosts included, and the rest lie face down. A note is up to 200 characters in one of six colours. Its author changes it or takes it back while notes go up; the hosts move any note between and within columns (dragged, held a moment on a phone, or with "move to") and take any down. Then the host calls the vote: everyone spreads their votes over the notes, several on one if they like, without seeing anyone else's; closing it puts each column in order of votes, the card shows the top three, and anyone can save the board as CSV or Markdown. Anonymous means anonymous to the hosts too: who wrote a note is kept where only its author reads it, and votes go in under a key only their voter knows. Anyone can report someone else's note to the hosts and StoaTalk's operator, without its author being named. The projector screen shows the board beside how to join while it's on, face down while hidden. In a Private Salon the columns, the notes and the votes are sealed.
- **Projector screen** (`?room={code}&show=1`, from the owner's ⋯ menu): the QR Code and code to join beside the question being answered, the most upvoted ones and the latest poll, live and in large type.
- **Usage stats**: anonymous daily counts (rooms opened, joins, messages, questions, ...) in `stats/{day}`, with no content or ids. `.github/workflows/stats.yml` shows the last 30 days in its run summary every Monday, or when run by hand.
- **Notifications**: a system notification for each new message while the page is open in the background (a tab, or the installed app). Each room can be muted from its ⋯ menu; the setting stays on the device. With the page closed, Web Push: the browser's subscription, sealed by the push service, sits in each room it wants to hear from (`push/{uid}`), and after posting, the author's page asks the service (`worker/`) to announce the message to members who aren't online, at most once every 20 seconds per room (`meta/pa`). A Private Salon's or a private message's push says only that there's something new. On iPhone, only from the app added to the home screen. Push stays off until the service has its key: make one on `site/admin.html` and save it as the `VAPID_KEY` repository secret.
- **Deleting**: ending a room deletes every message and private message right away. A room nobody has written in for 24 hours turns read-only (its members can still read, save and export it, but nothing new goes in), and 24 hours later the hourly job (`tools/cleanup`) deletes it and its code can be reused. The job warns members who allowed notifications by Web Push an hour before each step; an open page shows the same warning and the countdown, and the home page's room list marks read-only rooms with the hours left.
- **Export and records**: everyone can download what they can see, including their own private messages, as `.json`, `.html` or `.txt`, or keep it in this browser under 「我的聊天記錄」. The `.json` and `.html` files can be imported back and read here, read-only (the `.html` carries the same JSON inside it). Records stay on the device; nothing is uploaded. An imported file is checked field by field, but a file is only as trustworthy as whoever sent it: nothing proves it wasn't edited by hand.

## Layout

```
site/                       the whole app, served as-is by Cloudflare Pages
  index.html, css/app.css
  js/app/                   the page itself, as ES modules served as they are (no build step); main.js starts it.
                            room.js keeps one room live (Room, its data and events), api.js is every write to it,
                            kinds.js is each kind of message (text, GIF, photo, poll, draw, game, long post), crypto.js the encryption;
                            the screens (chat.js, qa.js, show.js, home.js, ...) draw what a Room tells them
  js/i18n.js, js/theme.js   the language and light/dark, loaded in <head> before anything paints
  js/config.js              Firebase web config (public by design)
  js/vendor/                Firebase SDK bundle, qrcode-generator and jsQR (npm run vendor rebuilds them)
  sw.js, manifest.webmanifest, icons/
database.rules.json         who may read and write what; generated from tools/rules.py
extension/                  the Chrome side panel: stoatalk.app in a frame (see Chrome extension below)
tools/rules.py              the rules, written readably (npm run rules)
tools/cleanup/              hourly job that deletes rooms idle for 48 hours (read-only after 24) and warns before, and photos no room points at;
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
                            pa (when a message here was last announced by Web Push), qr (the room's quick replies, one per line)
                            encrypted room: enc, kc (key check), xt, xd, xr (sealed title, description, quick replies) instead of title, desc, qr
rooms/{code}/members/{uid}  name, avatar, joined, online, pk (public key for private messages),   members only
                            ls (when they last posted), lm/lf/lq/lc (the message/photo/question/comment that post wrote)
                            encrypted room: x (sealed name and avatar), h (keyed hash of the name) instead of name, avatar
rooms/{code}/names/{key}    uid holding that nickname: the lowercased name, or h in an encrypted room   any signed-in device
rooms/{code}/msgs/{id}      by, name, avatar, text or gif{url,w,h,title}, at, re/{0-5}/{uid}  members only
                            encrypted room: by, x (sealed text or gif, name, avatar), at, re
rooms/{code}/msgs/{id}/post  a long post's card: t, s (the first lines), n (length), p (photos); pt: true marks it
                            encrypted room: the card sealed inside x as ps; pt stays plain
rooms/{code}/posts/{id}     by, at, ed?, b (the whole text); encrypted room: x (sealed, bound to the id and author)   members only
rooms/{code}/pc/{post}/{id} by, at, name, avatar, text, rp?, re; encrypted room: by, at, x, re (a comment; msgs/{post}/cc/{id} = true counts it)   members only
rooms/{code}/files/{id}     by, at: the marker of a photo; the picture is in R2      members only
rooms/{code}/dm/{uidA_uidB}/{id}  by, to, x (sealed text or gif), at                    those two only
rooms/{code}/banned/{uid}   people the owner or a co-host removed
rooms/{code}/reports/{msg}/{uid}  r (reason 0-3), at, p? (a comment: its post), b? (a note: its board)        owner and co-hosts only
rooms/{code}/push/{uid}    this member's push subscription, sealed by the push service      members read, self writes
rooms/{code}/qs/{id}        text, name?, avatar? (left out when anonymous), at, up/{uid}, done   members only
                            encrypted room: x (sealed text, name, avatar), at, up, done
rooms/{code}/qs/{id}/ans    by, at, text, name, avatar (the owner's or a co-host's answer)  members read, staff write
                            encrypted room: by, at, x (sealed text, name, avatar)
rooms/{code}/qq/{id}        a question waiting for review, same fields                 owner, co-hosts and the asker
rooms/{code}/qby/{id}       who asked                                                 only the asker reads it
rooms/{code}/games/{day}/{game}/{uid}  a mini-game score: s, t, h, m, l (the game played back), at; sealed x in an encrypted room   members; written once
rooms/{code}/qz/{id}        a quiz, under its card's id (msgs/{id}: quiz {t, n} and qm, or sealed x and qm):
                            by; src (the whole set, answers and all: owner and co-hosts only); live {ph, i, at, d, n, lock};
                            q/{i} a question as asked, k/{i} its right answers, s/{i} the scores after it (each JSON written
                            by a host, sealed in an encrypted room; a picture is im {f, w, h}, in R2 at {code}/{host}/{f}.jpg|bin,
                            f = the quiz's id + 10 random letters); p/{uid} a player; a/{i}/{uid} an answer {c, at} or {x, at}
                            (written once while answering is open; only its player and the hosts read it until then)   members
rooms/{code}/sb/{id}        a sticky-note board, under its card's id (msgs/{id}: board {t} and bm, or sealed x and bm):
                            by; live {ph add|vote|done, v, lim, an, lock, hd?}; cols [{k, n}] (JSON written by a host, sealed in an
                            encrypted room); n/{note} {t, c, k, o, at, nm?, av?} or {x, c, k, o, at}, or {c, k, o, at} on a
                            board opened hidden, its words in w/{note} {t, nm?, av?} or {x} (only its author reads them
                            until hd is false); nb/{note} its author (only they, and the operator, read it); bk/{uid} the key someone votes under (only they read it); v/{key} their
                            votes "a,a,b" or sealed (only they read it until ph is done)   members
rooms/{code}/typing/{uid}   server time while typing; dmt/{uidA_uidB}/{uid} the same in a private chat
stats/{YYYY-MM-DD}/{what}   anonymous daily counts, each write adds one              nobody reads it but the admin
ops/admins/{uid}            true for StoaTalk's operator, set by hand in the Firebase console   each reads only their own
ops/reports/{code}_{msg}_{uid}  code, msg, by, who (or b: a note's board), r, at, t (the words as the reporter saw them), n, f?, enc?   operator only
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

## Chrome extension

`extension/` puts StoaTalk in Chrome's side panel (Chrome 116+, also Edge): the toolbar button opens `panel.html`, which is just `https://stoatalk.app/` in a frame, so the panel always runs the live site and needs no new version when the site changes.

- **Same person as the tab.** The extension has host permission for `https://stoatalk.app/*`, and Chrome then gives a frame inside an extension page the site's own storage instead of a partition of its own. The Firebase sign-in (IndexedDB), nickname, `chat-dh`, `chat-key:*` and the room list are the ones a stoatalk.app tab has. Take the host permission away and the panel may become a stranger with none of that.
- **Framing.** `site/_headers` lets only extension pages (and the site itself) frame StoaTalk: `frame-ancestors 'self' chrome-extension:`; `/admin` stays unframeable.
- **Permissions** are the site's: notifications allowed in a stoatalk.app tab hold in the panel too (Chrome may not ask from inside a frame, so turn them on in a tab). The QR scanner gets the camera through the frame's `allow`.
- **Try it**: `chrome://extensions` > Developer mode > Load unpacked > `extension/`, then the StoaTalk button in the toolbar (pin it from the puzzle menu).
- **Publish**: every change to `extension/` builds `stoatalk-extension.zip` as an artifact of the "Pack the Chrome extension" run; upload it in the Chrome Web Store developer dashboard (US$5 once). Raise `version` in `manifest.json` for each upload. Store text is in `_locales/` (9 languages).

## Setting up Firebase

1. Create a project at https://console.firebase.google.com (a separate one from the scoreboard: the free plan allows 100 simultaneous connections per project).
2. **Authentication** > Sign-in method: enable **Anonymous**.
3. **Realtime Database** > Create database (Singapore, `asia-southeast1`, is closest to Taiwan), start in locked mode, then paste `database.rules.json` into the **Rules** tab and publish. Or: `npx firebase deploy --only database --project <project-id>`.
4. Project settings > Your apps > add a **Web app**, and copy its config (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`) into `site/js/config.js`.
5. Authentication > Settings > Authorized domains: add your site's domain (`stoatalk.app`, and `stoatalk.pages.dev` for trying a deploy).
6. For the hourly cleanup and for publishing rule changes automatically: Project settings > Service accounts > Generate new private key, then in the GitHub repository add the secrets `FIREBASE_SERVICE_ACCOUNT` (the whole JSON file) and `FIREBASE_DATABASE_URL`. Without them the cleanup job skips itself, and idle rooms stay until someone tries to open them or their code is reused. With them, `deploy-rules.yml` publishes `database.rules.json` whenever it changes on `main`.
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

## Staging

Every pull request is deployed to a preview of its own before it's merged: `https://<branch>.stoatalk.pages.dev`
(Cloudflare makes the branch name lowercase, turns `/` and other signs into `-` and keeps 28 characters), and a comment
on the pull request gives the exact address. Pushing to a branch named `staging` does the same at
`https://staging.stoatalk.pages.dev`. Merging into `main` is still the only way anything reaches stoatalk.app.

A preview is the same site with `staging/config.js` in place of `site/js/config.js` (`.github/workflows/staging.yml`),
so it uses a separate Firebase project, a separate photo service (`worker/` deployed with `--env staging` as
`stoatalk-photos-staging` at `api-staging.stoatalk.app`) and a separate bucket (`stoatalk-photos-staging`, public at
`files-staging.stoatalk.app`): rooms, photos and reports made while testing never mix with the real ones. Each preview
deploys its own `database.rules.json` and `worker/` to staging first, so with two pull requests open, staging's rules
and service are the last one pushed. Pages show a STAGING tag at the top and `[S]` in the tab's title; the
`*.pages.dev` addresses send `noindex` (`site/_headers`). The hourly cleanup also clears staging's idle rooms.

Setup, once (all on free plans):

1. Firebase: create a second project (e.g. `stoatalk-staging`) and set it up like the first (steps 1-4 of
   *Setting up Firebase*, Singapore again), then copy its web config into `staging/config.js` as `firebase`.
   For `site/admin.html` on staging, also add `staging.stoatalk.pages.dev` under Authorized domains and enable Google.
2. Its service account key and database URL go in the GitHub secrets `STAGING_FIREBASE_SERVICE_ACCOUNT` and
   `STAGING_FIREBASE_DATABASE_URL`. Without them a preview deploys only the site.
3. Cloudflare R2: create the bucket `stoatalk-photos-staging`, connect `files-staging.stoatalk.app`, give it a CORS
   policy allowing `GET`/`HEAD` from `*` (or the preview addresses), and a lifecycle rule deleting objects after 7 days
   (the cleanup leaves staging's photos to it).
4. The deploy token (`CLOUDFLARE_API_TOKEN`) already covers Pages and Workers; `api-staging.stoatalk.app` is made by the
   first deploy. Web Push on staging uses the same `VAPID_KEY`.
