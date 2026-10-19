/* The interface text in the chosen language (js/i18n.js loads the dictionaries), and how times read in it. */
import { ANIMALS } from "./constants.js?v=dev";

export const t = (key, vars) => I18N.t(key, vars);
// the same, with elements in the {slots}: a list to append
export const tEl = (key, nodes) => t(key).split(/(\{\w+\})/).map((part) => nodes[part.slice(1, -1)] ?? part).filter((x) => x !== "");
// beside a message: the time today, with the month and day from yesterday back, and the year too before this year
export function fmtTime(at, now = new Date()) {
  const d = new Date(at), hm = { hour: "2-digit", minute: "2-digit", hour12: false };
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(I18N.lang, hm);
  return d.toLocaleString(I18N.lang, { ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }), month: "numeric", day: "numeric", ...hm });
}
// in a message's menu: the whole date, weekday and time
export const fmtWhen = (at) => new Date(at).toLocaleString(I18N.lang, { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export const fmtFull = (at) => new Date(at).toLocaleString(I18N.lang, { hour12: false });
// [emoji, name] for each animal
export const avatars = () => ANIMALS.map((a, i) => [a, t("av" + i)]);
