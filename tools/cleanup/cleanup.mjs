// Deletes rooms nobody has written in for 24 hours (and their passwords), so "聊完即刪" holds even when the owner never ends the room.
// Runs hourly from .github/workflows/cleanup.yml with a Firebase service account; the database rules can't delete on a timer by themselves.
// Env: FIREBASE_SERVICE_ACCOUNT (the service account JSON), FIREBASE_DATABASE_URL. DRY_RUN=1 only lists what would go.
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

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
// passwords whose room is already gone (only private rooms have one, so this list stays short)
const secrets = Object.keys((await db.ref("secrets").get()).val() || {}).filter((c) => !codes.includes(c));
const orphans = [];
for (const c of secrets) if (!(await db.ref(`rooms/${c}/meta`).get()).exists()) orphans.push(c);

const upd = {};
codes.forEach((c) => { upd[`rooms/${c}`] = null; upd[`secrets/${c}`] = null; });
orphans.forEach((c) => { upd[`secrets/${c}`] = null; });
console.log(`expired rooms: ${codes.length}, orphan passwords: ${orphans.length}`);
if (Object.keys(upd).length && !process.env.DRY_RUN) await db.ref().update(upd);
await app.delete();
