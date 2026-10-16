/* Shaping values that came from outside (the database, a decrypted payload, an imported file) into what the app
   expects, with the same limits as the database. Anything unexpected becomes empty rather than throwing. */
export const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
export const num = (x) => (Number.isFinite(+x) ? +x : 0);
export const arr = (x) => (Array.isArray(x) ? x : []);
// a list the SDK may hand back as an object with keys 0, 1, 2, ...
export const listOf = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
export const isObj = (x) => !!x && typeof x === "object";
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const PUSH_ID = /^[\w-]{1,32}$/;
