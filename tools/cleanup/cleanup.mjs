// Deletes rooms nobody has written in for 24 hours, so "聊完即刪" holds even when the owner never ends the room.
// Runs hourly from .github/workflows/cleanup.yml with a Firebase service account; the database rules can't delete on a timer by themselves.
// Then it tells the operator about new reports (a GitHub issue) and deletes the photos in R2 that no room points at any more (photos.mjs).
// Env: FIREBASE_SERVICE_ACCOUNT (the service account JSON), FIREBASE_DATABASE_URL; for photos also CLOUDFLARE_ACCOUNT_ID,
// R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (without them photos are skipped). DRY_RUN=1 only lists what would go.
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { AwsClient } from "aws4fetch";
import { strayPhotos, s3Bucket } from "./photos.mjs";

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
const cutoff = Date.now() - DAY;

const stale = await db.ref("rooms").orderByChild("meta/last").endAt(cutoff).get();
const codes = Object.keys(stale.val() || {});
// what's left of the old password rooms: no room needs a password any more
const oldPasswords = (await db.ref("secrets").get()).exists();

const upd = {};
codes.forEach((c) => { upd[`rooms/${c}`] = null; });
if (oldPasswords) upd.secrets = null;
console.log(`expired rooms: ${codes.length}${oldPasswords ? ", old passwords cleared" : ""}`);
if (Object.keys(upd).length && !process.env.DRY_RUN) await db.ref().update(upd);

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

const { CLOUDFLARE_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: keyId, R2_SECRET_ACCESS_KEY: secret } = process.env;
if (account && keyId && secret) {
  const aws = new AwsClient({ accessKeyId: keyId, secretAccessKey: secret, service: "s3", region: "auto" });
  const bucket = s3Bucket((url, init) => aws.fetch(url, init), `https://${account}.r2.cloudflarestorage.com/${process.env.R2_BUCKET || "stoatalk-photos"}`);
  const stray = await strayPhotos(await bucket.list(), (code) => db.ref(`rooms/${code}/files`).get().then((s) => s.val()));
  console.log(`stray photos: ${stray.length}`);
  if (!process.env.DRY_RUN) for (const key of stray) await bucket.remove(key);
} else console.log("R2 keys not set; photos skipped");
await app.delete();
