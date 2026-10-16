/* The interface text in the chosen language (js/i18n.js loads the dictionaries), and how times read in it. */
import { ANIMALS } from "./constants.js?v=dev";

export const t = (key, vars) => I18N.t(key, vars);
// the same, with elements in the {slots}: a list to append
export const tEl = (key, nodes) => t(key).split(/(\{\w+\})/).map((part) => nodes[part.slice(1, -1)] ?? part).filter((x) => x !== "");
export const fmtTime = (at) => new Date(at).toLocaleTimeString(I18N.lang, { hour: "2-digit", minute: "2-digit", hour12: false });
export const fmtFull = (at) => new Date(at).toLocaleString(I18N.lang, { hour12: false });
// [emoji, name] for each animal
export const avatars = () => ANIMALS.map((a, i) => [a, t("av" + i)]);
