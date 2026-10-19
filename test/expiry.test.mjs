// How a quiet room winds down (site/js/app/expiry.js), and which rooms the hourly cleanup warns by Web Push
// (tools/cleanup/expiry.mjs). Plain functions, no emulator. npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { phase, hoursLeft, minutesLeft, HOUR } from "../site/js/app/expiry.js";
import { windows, warnings } from "../tools/cleanup/expiry.mjs";

const now = Date.parse("2026-10-19T12:00:00Z"), ago = (h) => now - h * HOUR;

test("a room is live for 23 hours, warns in the 24th, is read-only for the next 24, then gone", () => {
  assert.deepEqual(phase(ago(1), now), { state: "live", left: 22 * HOUR });
  assert.deepEqual(phase(ago(23.5), now), { state: "soon", left: 0.5 * HOUR });
  assert.equal(phase(ago(24), now).state, "soon"); // the rules call it read-only once it's past 24 hours
  assert.deepEqual(phase(ago(30), now), { state: "ro", left: 18 * HOUR });
  assert.equal(phase(ago(48), now).state, "gone");
  assert.equal(phase(undefined, now).state, "gone");
  assert.equal(hoursLeft(18 * HOUR), 18);
  assert.equal(hoursLeft(17.2 * HOUR), 18);
  assert.equal(hoursLeft(1000), 1);
  assert.equal(minutesLeft(0.5 * HOUR), 30);
});

test("cleanup: warns once before read-only, once before deleting, and again after someone speaks", () => {
  const [[a1, b1], [a2, b2]] = windows(now);
  assert.deepEqual([a1, b1, a2, b2], [ago(25), ago(23), ago(48), ago(47)]);
  const rooms = {
    LIVE: { last: ago(10) },
    SOON: { last: ago(23.25), title: "讀書會" },
    LATE: { last: ago(24.5), title: "遲到的" },   // the run that should have warned came late
    SEAL: { last: ago(23.5), enc: true, title: "x" }, // an encrypted room's name never goes in a push
    LAST: { last: ago(47.5) },
    DONE: { last: ago(23.5) },
    AGAIN: { last: ago(23.5) },
  };
  const warned = { DONE: { l: ago(23.5), s: 1 }, AGAIN: { l: ago(40), s: 2 } };
  assert.deepEqual(warnings(rooms, warned, now), [
    { code: "SOON", s: 1, payload: { c: "SOON", k: "e", ro: 0, m: 45, r: "讀書會" } },
    { code: "LATE", s: 1, payload: { c: "LATE", k: "e", ro: 1, h: 24, r: "遲到的" } },
    { code: "SEAL", s: 1, payload: { c: "SEAL", k: "e", ro: 0, m: 30 } },
    { code: "LAST", s: 2, payload: { c: "LAST", k: "e", ro: 1, h: 1 } },
    { code: "AGAIN", s: 1, payload: { c: "AGAIN", k: "e", ro: 0, m: 30 } },
  ]);
  // the second warning still comes after the first
  assert.equal(warnings({ LAST: { last: ago(47.5) } }, { LAST: { l: ago(47.5), s: 1 } }, now).length, 1);
  assert.equal(warnings({ LAST: { last: ago(47.5) } }, { LAST: { l: ago(47.5), s: 2 } }, now).length, 0);
});
