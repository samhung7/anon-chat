/* Message text as shown: clickable links, and @names of people in the room marked. Everything goes in as text. */
import { el } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";

export function linkify(text, mentions) {
  const frag = document.createDocumentFragment();
  const plain = (s) => (mentions ? withMentions(frag, s) : frag.append(s));
  const re = /https?:\/\/[^\s<>"'）」]+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    plain(text.slice(last, m.index));
    frag.append(el("a", { href: m[0], target: "_blank", rel: "noopener noreferrer nofollow", text: m[0] }));
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return frag;
}
// the person an @ at text[i] names: the longest nickname in the room that follows it (names may hold spaces)
function mentionAt(text, i) {
  const rest = text.slice(i + 1).toLowerCase();
  let best = null;
  Object.entries(room?.members || {}).forEach(([id, m]) => { const n = (m.name || "").toLowerCase(); if (n && rest.startsWith(n) && (!best || n.length > best.len)) best = { id, len: n.length }; });
  return best;
}
function withMentions(frag, text) {
  let last = 0;
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    const m = mentionAt(text, i); if (!m) continue;
    frag.append(text.slice(last, i), el("span", { class: "ment" + (m.id === backend.uid ? " self" : ""), text: text.slice(i, i + 1 + m.len) }));
    last = i + 1 + m.len; i = last - 1;
  }
  frag.append(text.slice(last));
}
export function mentionsMe(text) {
  if (!text || !room?.members[backend.uid]) return false;
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) if (mentionAt(text, i)?.id === backend.uid) return true;
  return false;
}
