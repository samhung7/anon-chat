// Prints the anonymous daily usage counts (stats/{day}/{what}) for the last 30 days as a table, and adds it to the
// GitHub job summary. Runs from .github/workflows/stats.yml with the same service account as cleanup.mjs.
import { appendFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
const app = initializeApp({ ...(sa ? { credential: cert(JSON.parse(sa)) } : {}), databaseURL: process.env.FIREBASE_DATABASE_URL });
const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
const days = (await getDatabase(app).ref("stats").orderByKey().startAt(since).get()).val() || {};
const COLS = ["rooms", "salons", "joins", "msgs", "photos", "polls", "draws", "dms", "qa", "qs", "shows", "exports", "games", "posts", "comments", "quizzes"];
const rows = Object.entries(days).sort(([a], [b]) => b.localeCompare(a));
const sum = Object.fromEntries(COLS.map((k) => [k, rows.reduce((s, [, d]) => s + (+d[k] || 0), 0)]));
const table = [`| day | ${COLS.join(" | ")} |`, `|---|${COLS.map(() => "---:").join("|")}|`,
  `| **30 days** | ${COLS.map((k) => `**${sum[k]}**`).join(" | ")} |`,
  ...rows.map(([day, d]) => `| ${day} | ${COLS.map((k) => +d[k] || 0).join(" | ")} |`)].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## StoaTalk usage, last 30 days\n\n" + table + "\n");
await app.delete();
