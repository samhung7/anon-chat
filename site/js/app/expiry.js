/* How a room winds down once nobody writes in it (meta/last, stamped by every message and join): an hour before
   24 quiet hours it warns, at 24 hours it turns read-only (still open to its members, who can save or export it),
   and 24 hours after that the hourly cleanup (tools/cleanup) deletes it, so up to an hour late. Speaking during the
   warning keeps the room going; nothing reopens a read-only room. tools/rules.py enforces the same times, and the
   cleanup imports this file for its warnings. */
export const HOUR = 36e5;
export const READ_ONLY_AFTER = 24 * HOUR;
export const GONE_AFTER = 48 * HOUR;
export const WARN_BEFORE = HOUR;

// where a room is: "live", "soon" (read-only within the hour), "ro" (read-only) or "gone"; left: ms to the next step
export function phase(last, now) {
  const age = now - (+last || 0);
  if (age >= GONE_AFTER) return { state: "gone", left: 0 };
  if (age > READ_ONLY_AFTER) return { state: "ro", left: GONE_AFTER - age };
  if (age >= READ_ONLY_AFTER - WARN_BEFORE) return { state: "soon", left: READ_ONLY_AFTER - age };
  return { state: "live", left: READ_ONLY_AFTER - WARN_BEFORE - age };
}
export const isReadOnly = (last, now) => ["ro", "gone"].includes(phase(last, now).state);
// what's left, rounded up, as people read it: whole hours, or minutes in the last hour
export const hoursLeft = (ms) => Math.max(1, Math.ceil(ms / HOUR));
export const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / 6e4));
