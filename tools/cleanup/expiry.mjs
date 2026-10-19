// Rooms winding down (site/js/app/expiry.js has the times): which ones the hourly job warns by Web Push this run, and
// what each push says. Two warnings a room: an hour before it turns read-only, and an hour before it's deleted.
// A run that comes late (GitHub's schedule can slip, or skip an hour) still sends the first, saying the room is
// already read-only; ops/warned/{code} remembers the meta/last each warning was for, so none is sent twice and a
// room someone spoke in again starts over.
import { HOUR, READ_ONLY_AFTER, GONE_AFTER, WARN_BEFORE, phase, hoursLeft, minutesLeft } from "../../site/js/app/expiry.js";

export { HOUR, READ_ONLY_AFTER, GONE_AFTER };
// the meta/last ranges this run looks at (each is a query, so only these rooms are read): the warnings' hours, and
// one more hour after each for a run that came late
export const windows = (now) => [
  [now - READ_ONLY_AFTER - HOUR, now - READ_ONLY_AFTER + WARN_BEFORE],
  [now - GONE_AFTER, now - GONE_AFTER + WARN_BEFORE],
];

// rooms: { code: meta } from those ranges; warned: ops/warned. Gives [{ code, s, payload }], s being the warning
// (1 read-only soon, 2 gone soon) to store with meta/last in ops/warned/{code}.
export function warnings(rooms, warned, now) {
  const out = [];
  for (const [code, meta] of Object.entries(rooms || {})) {
    const last = meta?.last;
    if (typeof last !== "number") continue;
    const age = now - last, { state, left } = phase(last, now);
    const s = age >= GONE_AFTER - WARN_BEFORE ? 2 : age >= READ_ONLY_AFTER - WARN_BEFORE ? 1 : 0;
    if (!s || state === "gone") continue;
    const before = warned?.[code];
    if (before?.l === last && before.s >= s) continue;
    if (s === 1 && age > READ_ONLY_AFTER + HOUR) continue; // too late for the first warning: the second one will come
    // ro 0: read-only in m minutes; ro 1: read-only already, deleted in h hours (the page's service worker words it)
    const payload = state === "soon" ? { c: code, k: "e", ro: 0, m: minutesLeft(left) } : { c: code, k: "e", ro: 1, h: hoursLeft(left) };
    if (meta.title && !meta.enc) payload.r = String(meta.title).slice(0, 40);
    out.push({ code, s, payload });
  }
  return out;
}
