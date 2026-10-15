// Publishes database.rules.json to the live database, so a rules change ships with the code that needs it.
// Runs from .github/workflows/deploy-rules.yml with the same service account as cleanup.mjs.
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)), databaseURL: process.env.FIREBASE_DATABASE_URL });
await getDatabase(app).setRules(readFileSync(new URL("../../database.rules.json", import.meta.url), "utf8"));
console.log("rules published");
await app.delete();
