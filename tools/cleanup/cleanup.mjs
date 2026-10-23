// Deletes rooms nobody has written in for 48 hours (read-only for the last 24 of them), so "聊完即刪" holds even when
// the owner never ends the room, and warns their members by Web Push an hour before each step (expiry.mjs). Runs hourly from .github/workflows/cleanup.yml with a Firebase service account; the database rules can't delete on a timer by themselves.
// Then it tells the operator about new reports (a GitHub issue), keeps bans on Google accounts past their deletion
// (accounts.mjs), and deletes the photos in R2 that no room or quiz library points at any more (photos.mjs).
// Env: FIREBASE_SERVICE_ACCOUNT (the service account JSON), FIREBASE_DATABASE_URL; for photos also CLOUDFLARE_ACCOUNT_ID,
// R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (without them photos are skipped); for the warnings VAPID_KEY, the push
// service's own secret (worker/; without it no warning is sent). DRY_RUN=1 only lists what would go.
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getAuth } from "firebase-admin/auth";
import { AwsClient } from "aws4fetch";
import { strayPhotos, s3Bucket } from "./photos.mjs";
import { GONE_AFTER, windows, warnings } from "./expiry.mjs";
import { sweep } from "./accounts.mjs";
import { vapid, openSub, send, validSubscription, devices } from "../../worker/src/push.js";

const DAY = 864e5;
const sa = process.env.FIREBASE_SERVICE_ACCOUNT; // not needed against the emulator (FIREBASE_DATABASE_EMULATOR_HOST)
let key = null;
if (sa) {
  try { key = JSON.parse(sa); } catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON; paste the whole downloaded key file"); }
  if (key?.type !== "service_account" || typeof key.project_id !== "string") // names the keys only, never their values
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is not a service account key file (it has: ${Object.keys(key || {}).join(", ") || "nothing"})`);
}
const app = initializeApp({ ...(key ? { credential: cert(key) } : {}), databaseURL: process.env.FIREBASE_DATABASE_URL });
const db = getDatabase(app);
const now = Date.now();

const stale = await db.ref("rooms").orderByChild("meta/last").endAt(now - GONE_AFTER).get();
const codes = Object.keys(stale.val() || {});
// what's left of the old password rooms: no room needs a password any more
const oldPasswords = (await db.ref("secrets").get()).exists();

const upd = {};
codes.forEach((c) => { upd[`rooms/${c}`] = null; upd[`ops/warned/${c}`] = null; });
if (oldPasswords) upd.secrets = null;
console.log(`expired rooms: ${codes.length}${oldPasswords ? ", old passwords cleared" : ""}`);
if (Object.keys(upd).length && !process.env.DRY_RUN) await db.ref().update(upd);

// an hour before a room turns read-only, and an hour before it goes: a push to each member who has one in the room
const near = {};
for (const [from, to] of windows(now)) {
  const s = await db.ref("rooms").orderByChild("meta/last").startAt(from).endAt(to).get();
  s.forEach((r) => { near[r.key] = { meta: r.child("meta").val(), members: r.child("members").val() || {}, push: r.child("push").val() || {} }; });
}
const warned = (await db.ref("ops/warned").get()).val() || {};
const due = warnings(Object.fromEntries(Object.entries(near).map(([c, r]) => [c, r.meta])), warned, now);
const keys = process.env.VAPID_KEY ? await vapid({ VAPID_KEY: process.env.VAPID_KEY }) : null;
let pushed = 0;
for (const { code, s, payload } of due) {
  const { members, push } = near[code], text = JSON.stringify(payload);
  if (keys && !process.env.DRY_RUN) for (const [uid, sealed] of Object.entries(push).flatMap(([u, v]) => devices(v).map((s) => [u, s]))) {
    if (!members[uid]) continue;
    const sub = await openSub(keys, uid, sealed);
    if (!sub || !validSubscription(sub)) continue;
    try { if ((await send(keys, sub, text, { topic: code })) < 300) pushed++; } catch (e) { console.warn("push failed"); }
  }
  if (!process.env.DRY_RUN) await db.ref(`ops/warned/${code}`).set({ l: near[code].meta.last, s });
}
// warnings for rooms that ended some other way (the owner ended them)
const leftover = Object.entries(warned).filter(([, w]) => !(w?.l > now - GONE_AFTER - DAY)).map(([c]) => [`ops/warned/${c}`, null]);
if (leftover.length && !process.env.DRY_RUN) await db.ref().update(Object.fromEntries(leftover));
console.log(`warnings: ${due.length} rooms, ${pushed} pushes${keys ? "" : " (VAPID_KEY not set; none sent)"}`);

// reports for StoaTalk's operator (site/admin.html): tell them about new ones by opening a GitHub issue (GitHub emails
// the repository's owner), saying only how many, since the repository may be public; drop ones left for 90 days
const oldReports = Object.entries((await db.ref("ops/reports").orderByChild("at").endAt(Date.now() - 90 * DAY).get()).val() || {});
if (oldReports.length && !process.env.DRY_RUN) await db.ref("ops/reports").update(Object.fromEntries(oldReports.map(([k]) => [k, null])));
const reports = Object.values((await db.ref("ops/reports").get()).val() || {});
const told = (await db.ref("ops/told").get()).val() || 0;
const fresh = reports.filter((r) => r.at > told);
console.log(`reports: ${reports.length} open, ${fresh.length} new`);
if (fresh.length && !process.env.DRY_RUN) {
  const { GITHUB_TOKEN: gh, GITHUB_REPOSITORY: repo } = process.env;
  if (gh && repo) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: "POST",
      headers: { Authorization: "Bearer " + gh, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: `有 ${fresh.length} 則新的檢舉待處理`,
        body: `StoaTalk 收到新的檢舉（目前共 ${reports.length} 則待處理）。請到 https://stoatalk.app/admin.html 處理，商店要求 24 小時內回應。\n\n處理完就可以關閉這個 issue。` }) });
    console.log(`issue: ${res.status}`);
    if (res.ok) await db.ref("ops/told").set(Math.max(...fresh.map((r) => r.at)));
  } else console.log("GITHUB_TOKEN not set; not telling anyone");
}

// bans that outlast deleting the account (accounts.mjs): reads every Google sign-in, which needs the service account
// to reach Firebase Authentication too (the key the Firebase console makes can)
if (key || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  try {
    const users = [];
    let page;
    do {
      page = await getAuth(app).listUsers(1000, page?.pageToken);
      for (const u of page.users) { const g = u.providerData.find((p) => p.providerId === "google.com"); if (g) users.push({ uid: u.uid, sub: g.uid }); }
    } while (page.pageToken);
    const [bans, gbans] = (await Promise.all([db.ref("bans").get(), db.ref("ops/gbans").get()])).map((s) => s.val() || {});
    const { record, ban, drop } = sweep({ bans, gbans, users, now: Date.now() });
    const upd = { ...Object.fromEntries(Object.entries(record).map(([h, g]) => [`ops/gbans/${h}`, g])),
      ...Object.fromEntries(Object.entries(ban).map(([uid, b]) => [`bans/${uid}`, { ...b, why: b.why.slice(0, 200) }])),
      ...Object.fromEntries(drop.map((h) => [`ops/gbans/${h}`, null])) };
    console.log(`Google bans: ${Object.keys(record).length} kept, ${Object.keys(ban).length} banned again, ${drop.length} dropped (${users.length} Google sign-ins)`);
    if (Object.keys(upd).length && !process.env.DRY_RUN) await db.ref().update(upd);
  } catch (e) { console.warn(`Google bans skipped: ${e.code || e.message}`); }
}

const { CLOUDFLARE_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: keyId, R2_SECRET_ACCESS_KEY: secret } = process.env;
if (account && keyId && secret) {
  const aws = new AwsClient({ accessKeyId: keyId, secretAccessKey: secret, service: "s3", region: "auto" });
  const bucket = s3Bucket((url, init) => aws.fetch(url, init), `https://${account}.r2.cloudflarestorage.com/${process.env.R2_BUCKET || "stoatalk-photos"}`);
  const stray = await strayPhotos(await bucket.list(), (code) => db.ref(`rooms/${code}/files`).get().then((s) => s.val()), Date.now(),
    (code, quiz) => db.ref(`rooms/${code}/qz/${quiz}/by`).get().then((s) => s.val()),
    (uid) => db.ref(`users/${uid}/qzs`).get().then((s) => s.val()));
  console.log(`stray photos: ${stray.length}`);
  if (!process.env.DRY_RUN) for (const key of stray) await bucket.remove(key);
} else console.log("R2 keys not set; photos skipped");
await app.delete();
