# 匿名聊天室 (Anonymous Chat Rooms)

Open a room, get a 4-character code, and share the code or link. Anyone with it joins straight from the browser: no sign-up, no LINE, FB or IG. When the talk is over the room is deleted, and anyone who wants a copy exports it first.
Made for lecture Q&A, anonymous reading groups, online Werewolf and group-project discussions. Interface: 繁體中文.

- **Rooms**: public (the code is enough) or private (code plus a password the owner sets). Join by code, by link or by QR code.
- **Identity**: a nickname and an animal, kept on the device. Nicknames are unique within a room (ignoring case). Behind the scenes each device gets an anonymous Firebase id.
- **Chat**: live messages, links, an emoji picker, GIF search (KLIPY), six reactions, who's here and who's online, private messages between two people (the owner can't read those either).
- **Owner**: lock the room to newcomers, remove someone (they can't come back from that device), end the room. People delete only their own messages.
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
rooms/{code}/members/{uid}  name, avatar, joined, online                               members only
rooms/{code}/names/{name}   uid holding that nickname (lowercased)                       any signed-in device
rooms/{code}/msgs/{id}      by, name, avatar, text or gif{url,w,h,title}, at, re/{0-5}/{uid}  members only
rooms/{code}/dm/{uidA_uidB}/{id}  by, to, text, at                                     those two only
rooms/{code}/keys/{uid}     the password hash a member joined with                     nobody reads it
rooms/{code}/banned/{uid}   people the owner removed
secrets/{code}              a private room's password hash                             nobody reads it; the rules compare against it
```

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
