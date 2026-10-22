/* The kinds of message: text, GIF, photo, poll, draw, a mini-game's result and a long post. Each kind says, in one place, how it is stored (plain
   and sealed), cleaned, shown, summed up in a line, offered in a message's ⋯ menu, and kept in an exported record.
   Everything else asks the kind (kindOf / savedKindOf) instead of checking fields, so a new kind is one more
   object here. Order matters: a message is the first kind that claims it, and text claims what's left.

   A live message `v` is what the database holds, decrypted; a saved message `m` is its shape in an exported
   record (archive.js), which has no ids and nothing that needs the room. */
import { LIMITS, GIF_HOST, REACTS } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { el, toast, orToast, saveFile, confirmSheet } from "./dom.js?v=dev";
import { str, num, arr, listOf, isObj, clamp, PUSH_ID } from "./clean.js?v=dev";
import { linkify } from "./richtext.js?v=dev";
import { room } from "./session.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { photoUrl, photoImg, viewPhoto, dropPhoto } from "./photos.js?v=dev";
import { livePoll, livePollView, pollView, pollVoters } from "./polls.js?v=dev";
import { liveDraw, drawView } from "./draws.js?v=dev";
import { gameCard, gameText, GAME } from "./games.js?v=dev";
import { GAMES, DAY_RE } from "./puzzles.js?v=dev";
import { postCard, savedPostCard, openPost, editPost, copyPost, knownBody, postName } from "./posts.js?v=dev";
import { knownComments } from "./comments.js?v=dev";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export { esc as escHtml };
// what a saved message shows as text, in an exported .txt or .html file
const savedHtmlText = (text) => `<div class="b">${esc(text)}</div>`;
const quoteText = (text) => el("blockquote", { class: "quote", text: text.length > 140 ? text.slice(0, 140) + "…" : text });
const gifImg = (g) => (!g || !GIF_HOST.test(g.url || "") ? el("span", { class: "muted", text: t("gifGone") })
  : el("img", { src: g.url, width: g.w, height: g.h, alt: g.title || "GIF", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }));
export { gifImg };

// the parts of a photo, poll or draw that may be trusted, as stored or as unsealed (so both are checked the same way)
const cleanImg = (i) => (i && typeof i.f === "string" && PUSH_ID.test(i.f) ? { f: i.f, w: Math.min(+i.w || 300, 4000), h: Math.min(+i.h || 300, 4000) } : null);
const cleanPoll = (p) => { const o = listOf(p?.o).slice(0, LIMITS.pollOpts).map((x) => str(x, LIMITS.pollOpt)); return p && o.length >= 2 ? { q: str(p.q, LIMITS.pollQ), o, m: p.m === true } : null; };
const cleanDraw = (d) => (d ? { t: str(d.t, LIMITS.drawTitle), p: listOf(d.p).slice(0, 200).map((x) => str(x, 128)), w: listOf(d.w).slice(0, 200).map((x) => str(x, 128)) } : null);
const int = (x, hi) => (Number.isInteger(x) ? clamp(x, 0, hi) : 0);
const cleanGame = (x) => (x && GAMES.includes(x.g) && DAY_RE.test(x.d) ? { g: x.g, d: x.d, s: int(x.s, 100), t: int(x.t, 86400),
  ...(x.n ? { n: int(x.n, 8) } : {}), ...(x.h ? { h: int(x.h, 99) } : {}), ...(x.m ? { m: int(x.m, 999) } : {}),
  ...(typeof x.r === "string" && /^[0-4]{2}(,[0-4]{2}){0,7}$/.test(x.r) ? { r: x.r } : {}) } : null);
// the title may be left out
const cleanPost = (p) => {
  if (!isObj(p)) return null;
  const title = str(p.t, LIMITS.postTitle);
  const pics = listOf(p.p).slice(0, LIMITS.postPhotos).map(cleanImg).filter(Boolean);
  return { t: title, s: str(p.s, LIMITS.postEx), n: clamp(Math.round(num(p.n)), 1, LIMITS.postBody), ...(pics.length ? { p: pics } : {}) };
};
const cleanGif = (g) => ({ url: g.url.slice(0, LIMITS.gifUrl), w: Math.min(+g.w || 200, 2000), h: Math.min(+g.h || 200, 2000), title: String(g.title || "").slice(0, LIMITS.gifTitle) });

/* Each kind:
   live(v) / saved(m)        whether it claims a live or a saved message
   pack(value)               [the body a plain room stores, the body sealed inside x]; mark: plain fields beside a sealed one
   plain(v)                  the cleaned fields of a plain room's stored message
   unsealed(p, dm)           the fields of a decrypted body, or null if it isn't this kind (dm: in a private chat)
   opened(out, raw, id)      anything more to work out once a message is open (a poll's votes)
   stat                      the usage count a new one adds to
   snippet(v)                one line naming it
   bubble(id, v, dm)         its bubble in the chat; refresh(node, id, v) updates one in place
   preview(v)                shown at the top of its ⋯ menu; pinned(v) in the pinned bar
   notice(v)                 a notification's text
   actions                   more entries for its ⋯ menu: [action, label, when(v), run(id, v)]
   removes(v)                more paths deleted with it; removed(v) what else to do once it's gone
   line                      shown as a line across the chat, its snippet, rather than as someone's bubble
   toSaved(v, pics)          its fields in an exported record; readSaved(m) the same, from an untrusted file
   savedText(m), savedHtml(m, src), savedBubble(m)   a saved one in a .txt file, an .html file, and on screen */
const text = {
  name: "text", stat: "msgs", editable: true,
  live: () => true, saved: () => true,
  pack: (s) => [{ text: s }, { t: s }],
  unsealed: (p) => ({ text: String(p.t || "").slice(0, LIMITS.text) }),
  snippet: (v) => v.text || "",
  bubble: (id, v, dm) => el("div", { class: "bub" }, linkify(v.text || "", !dm)),
  preview: (v) => quoteText(v.text || ""),
  notice: (v) => (v.text ? v.text.slice(0, 120) : ""),
  toSaved: (v) => ({ text: v.text || undefined }),
  readSaved: (m) => ({ text: str(m?.text, LIMITS.text) || undefined }),
  savedText: (m) => m.text,
  savedHtml: (m) => savedHtmlText(m.text),
  savedBubble: (m) => el("div", { class: "bub ro" }, linkify(m.text)),
};
const gif = {
  name: "gif", stat: "msgs",
  live: (v) => !!v.gif, saved: (m) => !!m.gif,
  pack: (g) => [{ gif: g }, { g }],
  unsealed: (p) => (p.g && typeof p.g.url === "string" ? { gif: cleanGif(p.g) } : null),
  snippet: () => "GIF",
  bubble: (id, v) => el("div", { class: "bub gifbub" }, gifImg(v.gif)),
  preview: (v) => el("div", { class: "quote gifq" }, gifImg(v.gif)),
  pinned: (v) => gifImg(v.gif),
  notice: () => t("sentGif"),
  toSaved: (v) => ({ gif: v.gif || undefined }),
  readSaved: (m) => {
    const g = m?.gif;
    return { gif: g && typeof g.url === "string" && GIF_HOST.test(g.url) ? { url: g.url.slice(0, LIMITS.gifUrl), w: num(g.w) || 200, h: num(g.h) || 200, title: str(g.title, LIMITS.gifTitle) } : undefined };
  },
  savedText: (m) => `[GIF] ${m.gif.title || ""} ${m.gif.url}`.replace(/\s+/g, " "),
  savedHtml: (m) => `<img class="g" src="${esc(m.gif.url)}" width="${+m.gif.w}" height="${+m.gif.h}" alt="${esc(m.gif.title || "GIF")}" loading="lazy">`,
  savedBubble: (m) => el("div", { class: "bub gifbub ro" }, gifImg(m.gif)),
};
const photo = {
  name: "photo", stat: "photos", roomOnly: true,
  live: (v) => !!v.img, saved: (m) => !!m.photo,
  pack: (img) => [{ img }, { i: img }],
  plain: (v) => (v.img ? { img: cleanImg(v.img) } : {}),
  unsealed: (p, dm) => (p.i && !dm ? { img: cleanImg(p.i) } : null),
  snippet: () => "📷 " + t("photo"),
  // tapping the photo opens it full size
  bubble: (id, v) => el("button", { type: "button", class: "bub imgbub", "aria-label": t("viewPhoto"), onclick: () => photoUrl(v.img.f, v.by).then((u) => (u ? viewPhoto(u) : toast(t("photoGone")))) }, photoImg(v)),
  preview: (v) => el("div", { class: "quote gifq" }, photoImg(v, true)),
  pinned: (v) => photoImg(v, true),
  actions: [["save", "savePhoto", () => true, (id, v) => photoUrl(v.img.f, v.by).then((u) => (u ? saveFile(u, `photo-${room.code}-${id}.jpg`) : toast(t("photoGone"))))]],
  removes: (v) => ({ ["files/" + v.img.f]: null }), // the picture goes with its message
  removed: (v) => dropPhoto(room.code, v.by, v.img.f),
  toSaved: (v, pics, m) => { if (!v.img) return {}; pics.push([m, v]); return { photo: { w: v.img.w, h: v.img.h } }; },
  readSaved: (m) => { const p = m?.photo; return { photo: isObj(p) ? { w: Math.min(num(p.w), 4000) || 300, h: Math.min(num(p.h), 4000) || 300 } : undefined }; },
  savedText: () => "📷 " + t("photo"),
  savedHtml: (m, src) => (src ? `<img class="p" src="${esc(src)}" width="${+m.photo.w}" height="${+m.photo.h}" alt="${esc(t("photo"))}">` : savedHtmlText("📷 " + t("photo"))),
  savedBubble: () => el("div", { class: "bub ro" }, "📷 " + t("photo")),
};
// everyone's votes on a poll, { uid: [option, ...] }; each is "0" or "0,2", sealed in an encrypted room
async function openVotes(raw, id, poll) {
  const out = {};
  for (const [who, s] of Object.entries(raw || {})) {
    let picks = typeof s === "string" ? s : "";
    if (room.cipher && picks) { const o = await room.open(room.cipher.aes, picks, `v:${id}:${who}`); picks = typeof o === "string" ? o : ""; }
    const list = [...new Set(picks ? picks.split(",").map(Number) : [])].filter((k) => Number.isInteger(k) && k >= 0 && k < poll.o.length);
    if (list.length) out[who] = poll.m ? list : list.slice(0, 1);
  }
  return out;
}
const pollText = (p) => `📊 ${p.q} (${t(p.m ? "pollMultiTag" : "pollSingleTag")}${p.closed ? " · " + t("pollClosed") : ""})\n` +
  p.o.map((o) => `· ${o.t}${t("colon")}${o.n}`).join("\n") + "\n" + t("pollVotes", { n: p.total });
const poll = {
  name: "poll", stat: "polls", roomOnly: true,
  live: (v) => !!v.poll, saved: (m) => !!m.poll,
  pack: (p) => [{ poll: p }, { p }],
  plain: (v) => (v.poll ? { poll: cleanPoll(v.poll) } : {}),
  unsealed: (p, dm) => (p.p && !dm ? { poll: cleanPoll(p.p) } : null),
  async opened(out, raw, id) { if (out.poll && raw.votes) out.votes = await openVotes(raw.votes, id, out.poll); },
  snippet: (v) => "📊 " + v.poll.q,
  bubble: (id, v) => el("div", { class: "bub pollbub" }, livePollView(id, v)),
  preview: (v) => quoteText(snippet(v)),
  refresh: (node, id, v) => node.querySelector(".pollbub")?.replaceChildren(livePollView(id, v)),
  actions: [
    ["voters", "pollWho", () => true, (id, v) => pollVoters(v)],
    ["close", "pollClose", (v) => !v.closed && v.by === backend.uid, async (id) => {
      if (await confirmSheet(t("pollClose"), t("pollCloseBody"), t("pollClose"), "primary")) orToast(room.api.closePoll(id));
    }],
  ],
  toSaved: (v) => { if (!v.poll) return {}; const { q, m, closed, total, o } = livePoll(v); return { poll: { q, m, closed: closed || undefined, total, o: o.map(({ t: label, n }) => ({ t: label, n })) } }; },
  readSaved: (m) => {
    const p = m?.poll, o = arr(p?.o).slice(0, LIMITS.pollOpts).map((x) => ({ t: str(x?.t, LIMITS.pollOpt), n: clamp(num(x?.n), 0, 9999) }));
    return { poll: isObj(p) && o.length >= 2 ? { q: str(p.q, LIMITS.pollQ), m: p.m === true, closed: p.closed === true || undefined, total: clamp(num(p.total), 0, 9999), o } : undefined };
  },
  savedText: (m) => pollText(m.poll),
  savedHtml: (m) => savedHtmlText(pollText(m.poll)),
  savedBubble: (m) => el("div", { class: "bub pollbub ro" }, pollView(m.poll, null)),
};
const drawText = (d) => `🎲 ${d.t || t("draw")}\n${t("drawFrom", { n: d.p.length, k: d.w.length })}\n🏆 ${d.w.join(t("listSep"))}\n${t("drawWhoIn")}${t("colon")}${d.p.join(t("listSep"))}`;
const draw = {
  name: "draw", stat: "draws", roomOnly: true,
  live: (v) => !!v.draw, saved: (m) => !!m.draw,
  pack: (d) => [{ draw: d }, { d }],
  plain: (v) => (v.draw ? { draw: cleanDraw(v.draw) } : {}),
  unsealed: (p, dm) => (p.d && !dm ? { draw: cleanDraw(p.d) } : null),
  snippet: (v) => "🎲 " + (v.draw.t || t("draw")),
  bubble: (id, v) => el("div", { class: "bub drawbub" }, drawView(liveDraw(v))),
  preview: (v) => quoteText(snippet(v)),
  toSaved: (v) => { if (!v.draw) return {}; const { t: title, p, w } = liveDraw(v); return { draw: { t: title || undefined, p, w } }; },
  readSaved: (m) => { const d = m?.draw; return { draw: isObj(d) ? { t: str(d.t, LIMITS.drawTitle) || undefined, p: arr(d.p).slice(0, 200).map((x) => str(x, 40)), w: arr(d.w).slice(0, 200).map((x) => str(x, 40)) } : undefined }; },
  savedText: (m) => drawText(m.draw),
  savedHtml: (m) => savedHtmlText(drawText(m.draw)),
  savedBubble: (m) => el("div", { class: "bub drawbub ro" }, drawView(m.draw)),
};

// a mini-game's result, shared by the player: { g, d (the day), s (score), t (seconds), n, h, m, r } (games.js)
const game = {
  name: "game", stat: "msgs", roomOnly: true,
  live: (v) => !!v.game, saved: (m) => !!m.game,
  pack: (x) => [{ game: x }, { gm: x }],
  plain: (v) => (v.game ? { game: cleanGame(v.game) } : {}),
  unsealed: (p, dm) => (p.gm && !dm ? { game: cleanGame(p.gm) } : null),
  snippet: (v) => `🧩 ${t(GAME[v.game.g].name)} · ${t("gmPts", { n: v.game.s })}`,
  bubble: (id, v) => el("div", { class: "bub gamebub" }, gameCard(v.game, true)),
  preview: (v) => quoteText(snippet(v)),
  toSaved: (v) => (v.game ? { game: v.game } : {}),
  readSaved: (m) => ({ game: cleanGame(m?.game) || undefined }),
  savedText: (m) => gameText(m.game),
  savedHtml: (m) => savedHtmlText(gameText(m.game)),
  savedBubble: (m) => el("div", { class: "bub gamebub ro" }, gameCard(m.game, false)),
};

// a long post (posts.js): its card here, its whole text apart in posts/{id}; pt marks it, sealed or not. Its comments
// (comments.js) are counted in cc, and kept in a record as c: [{ n, a, t }]
const commentsText = (cs) => (cs?.length ? `\n\n💬 ${t("commentsN", { n: cs.length })}\n` + cs.map((c) => `${c.a} ${c.n}${t("colon")}${c.t}`).join("\n") : "");
const postText = (m) => `📝 ${postName(m.post)}\n${m.post.b || m.post.s}${commentsText(m.post.c)}`;
const cleanComments = (cs) => arr(cs).slice(0, 2000).map((c) => ({ n: str(c?.n, 24) || "？", a: str(c?.a, 8) || "👤", t: str(c?.t, LIMITS.comment) })).filter((c) => c.t);
const post = {
  name: "post", stat: "posts", roomOnly: true,
  live: (v) => !!v.post, saved: (m) => !!m.post,
  pack: (p) => [{ post: p, pt: true }, { ps: p }], mark: { pt: true },
  plain: (v) => ("post" in v ? { post: v.pt === true ? cleanPost(v.post) : null } : {}),
  unsealed: (p, dm) => (p.ps && !dm ? { post: cleanPost(p.ps) } : null),
  // sealed as a post but not marked as one (the rules check the mark): not shown as one
  async opened(out, raw, id) { if (out.post && raw.pt !== true) { delete out.post; Object.assign(out, { text: t("cantDecrypt"), bad: true }); } else if (out.post) out.pid = id; },
  snippet: (v) => "📝 " + postName(v.post),
  bubble: (id, v) => postCard(id, v),
  refresh: (node, id, v) => node.querySelector(".postbub")?.replaceWith(postCard(id, v)), // the comment count
  preview: (v) => quoteText(snippet(v)),
  pinned: (v) => "📝 " + postName(v.post),
  notice: (v) => "📝 " + postName(v.post),
  // what a report carries to the operator: the title and as much of the text as this device has read
  reported: (v) => `${v.post.t ? v.post.t + "\n" : ""}${knownBody(v.pid) ?? v.post.s}`,
  actions: [
    ["read", "postRead", () => !document.querySelector(".reader"), (id) => openPost(id)],
    ["copypost", "postCopy", () => true, (id, v) => copyPost(id, v)],
    ["editpost", "postEdit", (v) => v.by === backend.uid && !room.readOnly && !room.gone, (id, v) => editPost(id, v)],
  ],
  // the text, its comments and any pictures go with it
  removes: (v) => Object.fromEntries([["posts/" + v.pid, null], ["pc/" + v.pid, null], ...(v.post.p || []).map((p) => ["files/" + p.f, null])]),
  removed: (v) => (v.post.p || []).forEach((p) => dropPhoto(room.code, v.by, p.f)),
  toSaved: (v) => {
    if (!v.post) return {};
    const cs = (knownComments(v.pid) || []).filter((c) => !c.bad).map((c) => ({ n: c.name, a: c.avatar, t: c.text }));
    return { post: { t: v.post.t, s: v.post.s, b: knownBody(v.pid) ?? undefined, c: cs.length ? cs : undefined } };
  },
  readSaved: (m) => {
    const p = m?.post, c = cleanComments(p?.c);
    return { post: isObj(p) && (str(p.t, LIMITS.postTitle) || str(p.s, LIMITS.postEx) || str(p.b, LIMITS.postBody))
      ? { t: str(p.t, LIMITS.postTitle), s: str(p.s, LIMITS.postEx), b: str(p.b, LIMITS.postBody) || undefined, c: c.length ? c : undefined } : undefined };
  },
  savedText: postText,
  savedHtml: (m) => `<div class="b">${m.post.t ? `<b>${esc("📝 " + m.post.t)}</b>\n\n` : "📝 "}${esc(m.post.b || m.post.s)}${esc(commentsText(m.post.c))}</div>`,
  savedBubble: (m) => savedPostCard(m),
};

// a line saying someone went (composer.js goneNote): left (ev "l", under the name they had) or removed by a host (ev "k",
// naming them in tn and ta). Not a message anyone wrote: no bubble, menu or reactions, and not kept in an exported record
const goneName = (n, a) => `${str(a, 8) || "👤"} ${str(n, 24) || "？"}`;
const gone = {
  name: "gone", line: true,
  live: (v) => !v.bad && (v.ev === "l" || v.ev === "k"), saved: () => false,
  plain: (v) => (v.ev === "k" ? { tn: str(v.tn, 24), ta: str(v.ta, 8) } : {}),
  unsealed: (p) => (p.e === "l" ? {} : p.e === "k" ? { tn: str(p.tn, 24), ta: str(p.ta, 8) } : null),
  snippet: (v) => (v.ev === "k" ? t("lineKicked", { who: goneName(v.tn, v.ta) }) : t("lineLeft", { who: goneName(v.name, v.avatar) })),
  toSaved: () => ({}), readSaved: () => ({}),
};

export const KIND = { text, gif, photo, poll, draw, game, post };
const KINDS = [gone, gif, photo, poll, draw, game, post, text];
export const kindOf = (v) => KINDS.find((k) => k.live(v));
export const savedKindOf = (m) => KINDS.find((k) => k.saved(m));
export const snippet = (v) => kindOf(v).snippet(v).replace(/\s+/g, " ").slice(0, 80);
export const hasContent = (m) => KINDS.some((k) => k !== text && k.saved(m)) || !!m.text;

// a stored message's fields, cleaned; and a decrypted one's, as the first kind that recognises it
export const plainFields = (v) => Object.assign({}, ...KINDS.map((k) => k.plain?.(v) || {}));
export const unsealedFields = (p, dm) => { for (const k of KINDS) { const f = k.unsealed(p, dm); if (f) return f; } };
export async function finishOpen(out, raw, id) { for (const k of KINDS) await k.opened?.(out, raw, id); }

// a message's fields in an exported record (pics collects the photos an .html file carries), and from an untrusted one
export const toSaved = (v, pics, m) => Object.assign(m, ...KINDS.map((k) => k.toSaved(v, pics, m)));
export const readSaved = (m) => Object.assign({}, ...[text, gif, photo, poll, draw, game, post].map((k) => k.readSaved(m)));
// reactions as counts per emoji, kept in a record
export function readReactions(r) {
  if (!isObj(r)) return undefined;
  const out = {}; REACTS.forEach((e) => { const n = num(r[e]); if (n > 0) out[e] = Math.min(n, 9999); });
  return Object.keys(out).length ? out : undefined;
}
