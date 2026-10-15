# Stoa Talk

Open a room, get a 4-character code, and share the code or link. Anyone with it joins straight from the browser: no sign-up, no LINE, FB or IG. When the talk is over the room is deleted, and anyone who wants a copy exports it first.
Made for lecture Q&A, anonymous reading groups, workshops and team projects. Interface: 繁體中文, 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Português. It follows the device's language (English when the site doesn't have it), and the ☰ menu on the home page can change it. Text lives in `site/js/i18n/<lang>.js`; add a key to every file when you add text.

- **Rooms**: Open Stoa / 公開議廊 (the code is enough) or Private Salon / 私人沙龍, which is always end-to-end encrypted (only the full link or QR code gets in). Older password rooms can still be joined with their password, but new ones can no longer be made.
- **End-to-end encryption**: private messages are always end-to-end encrypted. A room can also be opened as encrypted: its key travels only in the invite link and QR code (after the `#`, which browsers never send to a server), so the database holds the title, nicknames and messages only as ciphertext. People need the full link to join; the 4-character code alone isn't enough. See below.
- **Identity**: a nickname and an animal, kept on the device. Nicknames are unique within a room (ignoring case). Behind the scenes each device gets an anonymous Firebase id.
- **Chat**: live messages, replies that quote and jump to the original, links, an emoji picker, GIF search (KLIPY), six reactions, who's here and who's online, private messages between two people (the owner can't read those either).
- **Owner**: rename the room, pin up to three messages as announcements (one line at the top, tap to open), lock it to newcomers, remove someone (they can't come back from that device), end the room. People delete only their own messages.
- **Notifications**: a system notification for each new message while the page is open in the background (a tab, or the installed app). Each room can be muted from its ⋯ menu; the setting stays on the device. A closed page gets nothing, since that would need a push server.
- **Deleting**: ending a room deletes every message and private message right away. A room nobody has written in for 24 hours is deleted by an hourly job (`tools/cleanup`), and its code can be reused.
- **Export and records**: everyone can download what they can see, including their own private messages, as `.json`, `.html` or `.txt`, or keep it in this browser under 「我的聊天記錄」. The `.json` and `.html` files can be imported back and read here, read-only (the `.html` carries the same JSON inside it). Records stay on the device; nothing is uploaded. An imported file is checked field by field, but a file is only as trustworthy as whoever sent it: nothing proves it wasn't edited by hand.

## Layout

```
site/                       the whole app, served as-is by GitHub Pages
  index.html, css/app.css
  js/app.js                 everything the page does
  js/config.js              Firebase web config (public by design)
  js/vendor/                Firebase SDK bundle and qrcode-generator (npm run vendor rebuilds them)
  sw.js, manifest.webmanifest, icons/
database.rules.json         who may read and write what; generated from tools/rules.py
tools/rules.py              the rules, written readably (npm run rules)
tools/cleanup/              hourly job that deletes rooms idle for 24 hours
test/rules.test.mjs         rule tests against the Firebase emulator
```

Data in the Realtime Database:

```
rooms/{code}/meta           owner, title, created, last (last activity), priv, locked   readable by any signed-in device
                            encrypted room: enc, kc (key check), xt (sealed title) instead of title
rooms/{code}/members/{uid}  name, avatar, joined, online, pk (public key for private messages)   members only
                            encrypted room: x (sealed name and avatar), h (keyed hash of the name) instead of name, avatar
rooms/{code}/names/{key}    uid holding that nickname: the lowercased name, or h in an encrypted room   any signed-in device
rooms/{code}/msgs/{id}      by, name, avatar, text or gif{url,w,h,title}, at, re/{0-5}/{uid}  members only
                            encrypted room: by, x (sealed text or gif, name, avatar), at, re
rooms/{code}/dm/{uidA_uidB}/{id}  by, to, x (sealed text or gif), at                    those two only
rooms/{code}/keys/{uid}     the password hash a member joined with                     nobody reads it
rooms/{code}/banned/{uid}   people the owner removed
secrets/{code}              a private room's password hash                             nobody reads it; the rules compare against it
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
After editing `tools/rules.py`, run `npm run rules` and commit the new `database.rules.json` (CI checks they match).

Pushing to `main` deploys `site/` to GitHub Pages (`.github/workflows/pages.yml`).

## Setting up Firebase

1. Create a project at https://console.firebase.google.com (a separate one from the scoreboard: the free plan allows 100 simultaneous connections per project).
2. **Authentication** > Sign-in method: enable **Anonymous**.
3. **Realtime Database** > Create database (Singapore, `asia-southeast1`, is closest to Taiwan), start in locked mode, then paste `database.rules.json` into the **Rules** tab and publish. Or: `npx firebase deploy --only database --project <project-id>`.
4. Project settings > Your apps > add a **Web app**, and copy its config (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`) into `site/js/config.js`.
5. Authentication > Settings > Authorized domains: add `<user>.github.io`.
6. For the 24-hour cleanup and for publishing rule changes automatically: Project settings > Service accounts > Generate new private key, then in the GitHub repository add the secrets `FIREBASE_SERVICE_ACCOUNT` (the whole JSON file) and `FIREBASE_DATABASE_URL`. Without them the cleanup job skips itself, and idle rooms stay until someone tries to open them or their code is reused. With them, `deploy-rules.yml` publishes `database.rules.json` whenever it changes on `main`.
7. GIF search: create a key at https://klipy.com/developers and put it in `site/js/config.js` as `klipyKey`. Without one the GIF button is hidden. GIFs are only accepted from `*.klipy.com` (checked in the rules too).

Capacity on the free (Spark) plan: 100 people online at once across all rooms, 1 GB stored, 10 GB downloaded a month. A lecture with more than 100 people needs the pay-as-you-go (Blaze) plan; chat text is small, so the cost is usually tiny.
