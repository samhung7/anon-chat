// Bans that outlast deleting the account. Someone signed in with Google (site/js/app/account.js) who is banned
// (bans/{uid}) could delete the account and sign in again with the same Google account, which gives a new id. So for
// a year from the ban the hourly job keeps a hash of the Google account's id (never its email) in ops/gbans/{hash},
// and bans again any new id that Google account signs in under. When the operator lifts a ban (deletes bans/{uid}) and
// the account is still there under that id, its hash goes too. A ban the account is deleted within the hour of
// (before a run sees it) leaves no hash: the job can only hash an account that still exists.
import { createHash } from "node:crypto";

export const YEAR = 365 * 864e5;
// sub: the Google account's own id (the user's providerData uid for google.com)
export const banHash = (sub) => createHash("sha256").update("stoatalk-ban:" + sub).digest("base64url");

// bans: bans/ as stored; gbans: ops/gbans/ as stored; users: every account signed in with Google, [{ uid, sub }].
// Gives what to write: hashes to keep (record), ids to ban (ban), hashes to drop (drop).
export function sweep({ bans = {}, gbans = {}, users = [], now }) {
  const record = {}, ban = {}, drop = [];
  const byUid = new Map(users.map((u) => [u.uid, u])), byHash = new Map();
  for (const u of users) { const h = banHash(u.sub); byHash.set(h, [...(byHash.get(h) || []), u.uid]); }
  // a banned id signed in with Google: its account's hash, kept a year from the ban
  for (const [uid, b] of Object.entries(bans)) {
    const u = byUid.get(uid);
    if (!u) continue;
    const h = banHash(u.sub), at = typeof b?.at === "number" ? b.at : now, g = gbans[h];
    if (g?.u === uid) continue;
    record[h] = { at, until: at + YEAR, u: uid, ...(b?.why ? { why: String(b.why).slice(0, 200) } : {}) };
  }
  for (const [h, g] of Object.entries(gbans)) {
    if (record[h]) continue;
    if (!(g?.until > now)) { drop.push(h); continue; }
    const ids = byHash.get(h) || [];
    if (g.u && ids.includes(g.u) && !bans[g.u]) { drop.push(h); continue; } // the operator lifted it
    // the same Google account under a new id: banned again, and the hash follows it
    const back = ids.find((id) => !bans[id]);
    if (back) {
      ban[back] = { at: now, why: (g.why ? g.why + " " : "") + "(again, after the account was deleted)" };
      record[h] = { ...g, u: back };
    }
  }
  return { record, ban, drop };
}
