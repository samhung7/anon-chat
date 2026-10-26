// Bans on Google accounts that outlast deleting the account (tools/cleanup/accounts.mjs). Plain functions, no emulator. npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweep, banHash, YEAR } from "../tools/cleanup/accounts.mjs";

const now = Date.UTC(2026, 9, 23);

test("Google bans: a banned account's hash is kept a year, never its email or Google id", () => {
  const { record, ban, drop } = sweep({ bans: { u1: { at: now - 1000, why: "spam" }, u9: { at: now } }, users: [{ uid: "u1", sub: "1098" }, { uid: "u2", sub: "2000" }], now });
  const h = banHash("1098");
  assert.deepEqual(Object.keys(record), [h]);   // u9 isn't signed in with Google: nothing to keep
  assert.deepEqual(record[h], { at: now - 1000, until: now - 1000 + YEAR, u: "u1", why: "spam" });
  assert.ok(!JSON.stringify(record).includes("1098"));
  assert.match(h, /^[A-Za-z0-9_-]{43}$/);   // a database key
  assert.deepEqual(ban, {}); assert.deepEqual(drop, []);
  // kept already: nothing to write
  assert.deepEqual(sweep({ bans: { u1: { at: now - 1000 } }, gbans: record, users: [{ uid: "u1", sub: "1098" }], now }), { record: {}, ban: {}, drop: [] });
});

test("Google bans: the account deleted and signed in again under a new id is banned again", () => {
  const h = banHash("1098"), gbans = { [h]: { at: now - 5000, until: now - 5000 + YEAR, u: "u1", why: "spam" } };
  // u1 is gone (deleted); the same Google account is back as u5
  const { record, ban, drop } = sweep({ bans: { u1: { at: now - 5000 } }, gbans, users: [{ uid: "u5", sub: "1098" }, { uid: "u6", sub: "3000" }], now });
  assert.deepEqual(Object.keys(ban), ["u5"]);
  assert.equal(ban.u5.at, now);
  assert.match(ban.u5.why, /^spam /);
  assert.equal(record[h].u, "u5");
  assert.equal(record[h].until, gbans[h].until);   // the year runs from the first ban
  assert.deepEqual(drop, []);
});

test("Google bans: a lifted ban and an expired one let the account go", () => {
  const h = banHash("1098"), h2 = banHash("4000");
  const gbans = { [h]: { at: now - 5000, until: now + YEAR, u: "u1" }, [h2]: { at: now - YEAR - 1, until: now - 1, u: "u7" } };
  // the operator deleted bans/u1 while u1 is still there; u8 (the expired hash's account) signs in again
  const { record, ban, drop } = sweep({ bans: {}, gbans, users: [{ uid: "u1", sub: "1098" }, { uid: "u8", sub: "4000" }], now });
  assert.deepEqual(drop.sort(), [h, h2].sort());
  assert.deepEqual(ban, {}); assert.deepEqual(record, {});
});
