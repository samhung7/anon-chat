/* Long posts: written on a page of their own, shown in the chat as a card (title, the first lines, how long it is),
   and read whole on a page of their own. The card is an ordinary message (msgs/{id}, marked pt, with post {t, s, n, p}
   or sealed inside x), so reactions, replies, pins, reports and taking it down work as they do for any message. The
   whole text sits apart in posts/{id} (b, or x sealed with the room key and bound to the post's id and author), so
   entering a room never downloads every post: only opening one does. Pictures go to the photo service like any photo,
   before the post, and the text names them on lines of their own (![](id)).
   The owner and co-hosts write them; the owner can let everyone (meta/po). What's being written is kept on this device
   as it's typed (a page closed, a phone that drops the app, a room turning read-only), until it's published.
   Anyone can comment under a post, on its page (comments.js); the card counts them. */
import { LIMITS, REACTS } from "./constants.js?v=dev";
import { t, fmtTime } from "./text.js?v=dev";
import { el, toast, icon, avatar, busy, orToast, confirmSheet } from "./dom.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { room } from "./session.js?v=dev";
import { linkify } from "./richtext.js?v=dev";
import { post, posts as queue } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";
import { shrinkPhoto, uploadPhoto, jpegUrl, photoUrl, viewPhoto, dropPhoto } from "./photos.js?v=dev";
import { phase } from "./expiry.js?v=dev";
import { msgActions } from "./actions.js?v=dev";
import { commentsView, commentCount, loadComments } from "./comments.js?v=dev";

export const canPost = () => !!room && !room.gone && !room.readOnly && (room.isStaff() || room.meta?.po === true);
const PIC_LINE = /^!\[[^\]]*\]\(([\w-]{1,32})\)$/;
const SEALED_MAX = 82000; // what the rules take for a sealed text (tools/rules.py)

/* ---------- the text: a few marks of Markdown, drawn as elements (never as HTML) ---------- */
// **bold** and links, inside a line
function inline(s) {
  const frag = document.createDocumentFragment();
  s.split(/\*\*(.+?)\*\*/g).forEach((part, i) => frag.append(i % 2 ? el("b", {}, linkify(part, false)) : linkify(part, false)));
  return frag;
}
// the whole text as blocks: # and ## headings, > quotes, - and 1. lists, --- a rule, ![](id) a picture, else paragraphs.
// pic(id) gives a picture's element, or null for one the post doesn't carry
export function mdView(text, pic) {
  const out = el("div", { class: "md" });
  let para = null, list = null, quote = null;
  const end = () => { para = list = quote = null; };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd(), m = line.trim();
    let x;
    if (!m) { end(); continue; }
    if ((x = m.match(/^(#{1,2})\s+(.*)$/))) { end(); out.append(el(x[1].length === 1 ? "h3" : "h4", {}, inline(x[2]))); continue; }
    if (/^(-{3,}|\*{3,})$/.test(m)) { end(); out.append(el("hr")); continue; }
    if ((x = m.match(PIC_LINE))) { end(); const p = pic(x[1]); if (p) out.append(p); continue; }
    if ((x = m.match(/^>\s?(.*)$/))) {
      if (!quote) { end(); out.append(quote = el("blockquote")); } else quote.append(el("br"));
      quote.append(inline(x[1])); continue;
    }
    const li = m.match(/^[-*]\s+(.*)$/), ol = !li && m.match(/^\d{1,3}[.)]\s+(.*)$/);
    if (li || ol) {
      const tag = li ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) { end(); out.append(list = el(tag)); }
      list.append(el("li", {}, inline((li || ol)[1]))); continue;
    }
    if (!para) { end(); out.append(para = el("p")); } else para.append(el("br"));
    para.append(inline(line));
  }
  return out;
}
// what a post goes by: its title, or without one its first words
export const postName = (p) => p.t || (p.s ? (p.s.length > 40 ? p.s.slice(0, 40) + "…" : p.s) : t("post"));
// the words without the marks, for the card's first lines, a notification or a file
export const plainOf = (text) => String(text || "").split("\n").map((l) => l.trim()).filter((l) => l && !PIC_LINE.test(l) && !/^(-{3,}|\*{3,})$/.test(l))
  .map((l) => l.replace(/^(#{1,2}\s+|>\s?|[-*]\s+|\d{1,3}[.)]\s+)/, "").replace(/\*\*(.+?)\*\*/g, "$1")).join(" ").replace(/\s+/g, " ").trim();
// the pictures a text names, in order, once each
const picsIn = (text) => [...new Set(String(text || "").split("\n").map((l) => l.trim().match(PIC_LINE)?.[1]).filter(Boolean))];

/* ---------- the whole text ---------- */
const aad = (id, by) => `b:${id}:${by}`;
// a post's text, fetched once per version (null when it's gone or can't be read); kept for exports and reports
export function postBody(id, v) {
  const r = room, key = id + ":" + (v.ed || 0);
  r.bodies ||= new Map(); r.bodyText ||= new Map();
  if (!r.bodies.has(key)) r.bodies.set(key, backend.val(r.api.ref("posts/" + id)).then(async (p) => {
    if (!p || p.by !== v.by) return null;
    const b = p.x ? (r.cipher ? (await r.cipher.unseal(p.x, aad(id, v.by)))?.b : null) : p.b;
    return typeof b === "string" ? b.slice(0, LIMITS.postBody) : null;
  }).then((b) => { if (b == null) r.bodies.delete(key); else r.bodyText.set(id, b); return b; }));
  return r.bodies.get(key);
}
// the text of a post already read on this device (for an export or a report, which can't wait)
export const knownBody = (id) => room?.bodyText?.get(id) ?? null;
// every post's text and comments, before an export
export async function loadBodies() {
  if (!room) return;
  const list = [...room.msgs.entries()].filter(([, v]) => v.post && !v.bad);
  if (list.length) busy(true);
  try {
    await Promise.all(list.flatMap(([id, v]) => [postBody(id, v).catch(() => null), commentCount(v) ? loadComments(id).catch(() => null) : null]));
  } finally { if (list.length) busy(false); }
}

/* ---------- the card in the chat ---------- */
export function postCard(id, v) {
  const p = v.post;
  return el("button", { type: "button", class: "bub postbub", onclick: () => openPost(id) },
    el("span", { class: "ptag" }, icon("post", "sm"), el("span", { text: t("post") })),
    p.t ? el("b", { class: "pt", text: p.t }) : null,
    p.s ? el("span", { class: "ps" + (p.t ? "" : " lead"), text: p.s }) : null,
    el("span", { class: "pmore" }, el("span", { text: t("postReadMore") }), el("span", { class: "muted", text: t("postChars", { n: p.n.toLocaleString(I18N.lang) }) }),
      commentCount(v) ? el("span", { class: "muted pcc", text: "💬 " + commentCount(v).toLocaleString(I18N.lang) }) : null));
}
// a saved one (in a record): the same card, opening the text the record kept
export function savedPostCard(m) {
  return el("button", { type: "button", class: "bub postbub ro", onclick: () => readPage(m.post.t, () => mdView(m.post.b || m.post.s, () => el("p", { class: "muted", text: "📷 " + t("photo") })), m.post.c) },
    el("span", { class: "ptag" }, icon("post", "sm"), el("span", { text: t("post") })),
    m.post.t ? el("b", { class: "pt", text: m.post.t }) : null, m.post.s ? el("span", { class: "ps" + (m.post.t ? "" : " lead"), text: m.post.s }) : null);
}

/* ---------- a page over the chat, which the back button closes ---------- */
function page(cls, head, body) {
  const ov = el("div", { class: "overlay pagewrap" });
  const box = el("div", { class: "page " + cls, role: "dialog" }, head, body);
  ov.append(box);
  let open = true;
  const pop = () => close(true);
  const esc = (e) => { if (e.key === "Escape" && ov === document.querySelector(".overlay:last-of-type")) { e.preventDefault(); ov.onEsc ? ov.onEsc() : close(); } };
  function close(popped) {
    if (!open) return;
    open = false; ov.remove();
    removeEventListener("popstate", pop); document.removeEventListener("keydown", esc);
    ov.onClose?.();
    if (!popped && history.state?.page) history.back();
  }
  history.pushState({ ...(history.state || {}), page: true }, "");
  addEventListener("popstate", pop);
  document.addEventListener("keydown", esc);
  ov.close = close;
  document.body.append(ov);
  return ov;
}
const bar = (title, right, onBack) => el("header", { class: "bar" },
  el("button", { type: "button", class: "icon", "aria-label": t("close"), "data-a": "back", onclick: onBack }, icon("back")),
  el("div", { class: "ttl" }, el("b", { text: title })), right);

/* ---------- reading ---------- */
// a post, read whole: its author, title, text and reactions, kept up to date while it's open
export function openPost(id) {
  const r = room, v0 = r?.msgs.get(id);
  if (!v0 || !v0.post) return toast(t("postGone"));
  const top = el("div"), foot = el("footer", { class: "cfoot" }), cs = commentsView(id, foot);
  const body = el("div", { class: "pagebody" }, top, cs.el);
  const more = el("button", { type: "button", class: "icon", "aria-label": t("msgMenu"), onclick: () => r.msgs.get(id) && msgActions(id, r.msgs.get(id), false) }, icon("more"));
  const ov = page("reader", bar(t("post"), more, () => ov.close()), body);
  ov.querySelector(".page").append(foot);
  ov.querySelector(".page").dataset.post = id;
  let shownEd = null;
  const draw = async () => {
    const v = r.msgs.get(id);
    if (!v || !v.post) { ov.close(); return toast(t("postGone")); }
    const who = r.author(v), uid = backend.uid;
    const reacts = el("div", { class: "re big" }, REACTS.map((emo, k) => {
      const ids = Object.keys(v.re?.[k] || {});
      return el("button", { type: "button", class: "chip" + (ids.includes(uid) ? " on" : ""), "aria-pressed": String(ids.includes(uid)),
        disabled: r.readOnly || r.gone || null, onclick: () => orToast(r.api.react(id, k, !ids.includes(uid))) }, ids.length ? `${emo} ${ids.length}` : emo);
    }));
    if (shownEd === (v.ed || 0) && top.querySelector(".md, .pfail")) { top.querySelector(".re")?.replaceWith(reacts); return; }
    shownEd = v.ed || 0;
    const text = el("div", { class: "ptext" }, el("p", { class: "muted", text: t("loading") }));
    top.replaceChildren(
      el("div", { class: "who" }, el("span", { class: "av" }, avatar(who.avatar)), el("span", { class: "nm", text: who.name + r.badge(v.by) }),
        el("time", { text: fmtTime(v.at) }), v.ed ? el("small", { class: "muted", text: t("edited") }) : null),
      v.post.t ? el("h2", { class: "ptitle", text: v.post.t }) : "", text, reacts); // (replaceChildren would write out a null)
    const b = await postBody(id, v).catch(() => null);
    if (!ov.isConnected) return;
    text.replaceChildren(b == null ? el("p", { class: "muted pfail", text: t("postLoadFail") }) : mdView(b, livePic(v)));
  };
  const changed = (cid) => { if (cid === id && ov.isConnected) draw(); };
  const removed = (cid) => { if (cid === id && ov.isConnected) { ov.close(); toast(t("postGone")); } };
  r.on("msg-changed", changed).on("msg-removed", removed);
  ov.onClose = () => { r.un("msg-changed", changed); r.un("msg-removed", removed); cs.stop(); };
  draw();
}
// a read-only page of a post from a saved record, with the comments it kept
function readPage(title, make, cs) {
  const body = el("div", { class: "pagebody" }, title ? el("h2", { class: "ptitle", text: title }) : null, make(),
    cs?.length ? el("section", { class: "comments" }, el("h3", { class: "chead", text: t("commentsN", { n: cs.length }) }),
      el("ol", { class: "clist" }, cs.map((c) => el("li", { class: "cmt" }, el("span", { class: "av" }, avatar(c.a)),
        el("div", { class: "cbody" }, el("div", { class: "cwho" }, el("b", { text: c.n })), el("div", { class: "ctext" }, linkify(c.t, false))))))) : null);
  const ov = page("reader", bar(t("post"), null, () => ov.close()), body);
}
// a picture in a live post: one the post carries, fetched as it comes near
const livePic = (v) => (f) => {
  const p = (v.post.p || []).find((x) => x.f === f);
  if (!p) return null;
  const img = el("img", { class: "photo", width: p.w, height: p.h, alt: t("photo"), decoding: "async" });
  photoUrl(p.f, v.by).then((u) => { if (u) img.src = u; else img.replaceWith(el("span", { class: "muted", text: t("photoGone") })); });
  return el("button", { type: "button", class: "ppic", "aria-label": t("viewPhoto"), onclick: () => img.src && viewPhoto(img.src) }, img);
};
// the whole text, to copy
export async function copyPost(id, v) {
  const b = await postBody(id, v).catch(() => null);
  if (b == null) return toast(t("postLoadFail"));
  navigator.clipboard?.writeText(v.post.t ? `${v.post.t}\n\n${b}` : b).then(() => toast(t("copied")), () => toast(t("cantCopy")));
}

/* ---------- writing ---------- */
const draftKey = (id) => KEYS.postDraft(room.code, id || "new");
export const newPost = () => editor(null, null);
export async function editPost(id, v) {
  const b = await postBody(id, v).catch(() => null);
  if (b == null) return toast(t("postLoadFail"));
  editor(id, v, b);
}
// the writing page: a new post (id null) or the author's own (v, its text b)
function editor(id, v, b = "") {
  const r = room;
  if (!id && !canPost()) return toast(t(r?.readOnly ? "roNoPost" : "postNotOpen"));
  const draft = store.json(draftKey(id));
  const fresh = draft && typeof draft.b === "string" && (draft.t || draft.b) && (!id || draft.from === (v.ed || 0));
  const title = el("input", { class: "field ptitlein", maxlength: LIMITS.postTitle, placeholder: t("postTitlePh"), "aria-label": t("postTitlePh"), value: fresh ? draft.t || "" : v?.post.t || "" });
  const ta = el("textarea", { class: "field pbody", maxlength: LIMITS.postBody, placeholder: t("postBodyPh"), "aria-label": t("postBodyPh") });
  ta.value = fresh ? draft.b.slice(0, LIMITS.postBody) : b;
  const view = el("div", { class: "pview", hidden: true });
  const count = el("span", { class: "muted small" }), note = el("span", { class: "muted small pnote" });
  const file = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  // pictures added here, not sent yet: id -> { bytes, w, h, url }; and those the post already carries
  const added = new Map(), had = new Map((v?.post.p || []).map((p) => [p.f, p]));
  const picEl = (f) => {
    const n = added.get(f), o = had.get(f);
    if (!n && !o) return null;
    const img = el("img", { class: "photo", width: (n || o).w, height: (n || o).h, alt: t("photo") });
    if (n) img.src = n.url; else photoUrl(f, v.by).then((u) => { if (u) img.src = u; });
    return el("div", { class: "ppic" }, img);
  };
  let previewing = false;
  const tool = (name, label, fn) => el("button", { type: "button", class: "icon small", "aria-label": label, title: label, "data-tool": name, onclick: fn }, el("span", { text: name === "b" ? "B" : name === "h" ? "H" : name === "ul" ? "•" : name === "ol" ? "1." : "❝" }));
  const picBtn = el("button", { type: "button", class: "icon small", "aria-label": t("postPhotoBtn"), title: t("postPhotoBtn"), onclick: () => file.click() }, icon("photo"));
  const prevBtn = el("button", { type: "button", class: "btn small", text: t("postPreview"), onclick: () => {
    previewing = !previewing;
    prevBtn.textContent = t(previewing ? "postWrite" : "postPreview");
    view.hidden = !previewing; ta.hidden = previewing;
    toolbar.querySelectorAll("[data-tool], .icon").forEach((x) => { if (x !== prevBtn) x.disabled = previewing; });
    if (previewing) view.replaceChildren(title.value.trim() ? el("h2", { class: "ptitle", text: title.value.trim() }) : "", mdView(ta.value, picEl));
  } });
  const toolbar = el("div", { class: "ptools" },
    tool("b", t("postBold"), () => wrap("**", "**")), tool("h", t("postHeading"), () => prefix("## ")),
    tool("ul", t("postList"), () => prefix("- ")), tool("ol", t("postNumList"), () => prefix("1. ")), tool("q", t("postQuote"), () => prefix("> ")),
    picBtn, el("span", { class: "grow" }), prevBtn);
  // the marks go around what's selected, or at the start of each line it touches
  function wrap(a, z) {
    const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e) || t("postBold");
    ta.setRangeText(a + sel + z, s, e, "end"); ta.selectionStart = s + a.length; ta.selectionEnd = s + a.length + sel.length;
    ta.focus(); changed();
  }
  function prefix(p) {
    const s = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1, e0 = ta.value.indexOf("\n", ta.selectionEnd), e = e0 < 0 ? ta.value.length : e0;
    const lines = ta.value.slice(s, e).split("\n").map((l) => (l.startsWith(p) ? l.slice(p.length) : p + l.replace(/^(#{1,2}|>|[-*]|\d{1,3}[.)])\s+/, "")));
    ta.setRangeText(lines.join("\n"), s, e, "end"); ta.focus(); changed();
  }
  file.addEventListener("change", async () => {
    const files = [...file.files].filter((f) => !f.type || f.type.startsWith("image/")); file.value = "";
    busy(true);
    try {
      for (const f of files) {
        if (picsIn(ta.value).length >= LIMITS.postPhotos) { toast(t("postPhotoMax", { n: LIMITS.postPhotos })); break; }
        let p;
        try { p = await shrinkPhoto(f); } catch (e) { toast(t("photoFail")); continue; }
        const fid = backend.pushKey(r.api.ref("files"));
        added.set(fid, { ...p, url: jpegUrl(p.bytes) });
        const at = ta.selectionEnd, before = ta.value.slice(0, at);
        ta.setRangeText(`${before && !before.endsWith("\n") ? "\n" : ""}![${t("photo")} ${picsIn(ta.value).length + 1}](${fid})\n`, at, at, "end");
      }
    } finally { busy(false); changed(); }
  });

  // kept on this device as it's typed, until it's out
  let saveT = 0;
  const keep = () => {
    if (title.value.trim() || ta.value.trim()) store.set(draftKey(id), JSON.stringify({ t: title.value, b: ta.value, at: Date.now(), ...(id ? { from: v.ed || 0 } : {}) }));
    else store.set(draftKey(id), null);
  };
  function changed() {
    count.textContent = t("postCount", { n: ta.value.length.toLocaleString(I18N.lang), max: LIMITS.postBody.toLocaleString(I18N.lang) });
    clearTimeout(saveT); saveT = setTimeout(() => { keep(); note.textContent = t("postDraftSaved"); }, 800);
  }
  title.addEventListener("input", changed); ta.addEventListener("input", changed);
  // a room close to turning read-only says so here too, so the post goes out in time
  const warn = () => { if (r.meta && phase(r.meta.last, backend.now()).state === "soon") note.textContent = t("postSoon"); };
  const drop = fresh ? el("button", { type: "button", class: "link small", text: t("postDraftDrop"), onclick: async () => {
    if (!(await confirmSheet(t("postDraftDrop"), t("postDraftDropBody"), t("postDraftDrop")))) return;
    store.set(draftKey(id), null); added.clear(); title.value = id ? v.post.t : ""; ta.value = b; drop.remove(); changed();
  } }) : null;
  const send = el("button", { type: "button", class: "btn small primary", text: t(id ? "postSave" : "postPublish"), onclick: () => publish() });
  const ov = page("writer", bar(t(id ? "postEditTitle" : "postNew"), send, () => close()),
    el("div", { class: "pagebody" }, title, toolbar, ta, view, file, el("div", { class: "pfoot" }, count, note, drop)));
  ov.onEsc = () => close();
  function close() {
    clearTimeout(saveT); keep();
    if (title.value.trim() || ta.value.trim()) toast(t("postDraftKept"));
    ov.close();
  }
  changed(); clearTimeout(saveT); warn();
  if (fresh) toast(t("postDraftBack"));
  setTimeout(() => (id ? ta : title).focus(), 50);

  let sending = false;
  async function publish() {
    if (sending) return;
    const T = title.value.trim().slice(0, LIMITS.postTitle);
    // pictures the text no longer names are left out; a line naming one this post doesn't carry is dropped
    const text = ta.value.split("\n").filter((l) => { const m = l.trim().match(PIC_LINE); return !m || added.has(m[1]) || had.has(m[1]); }).join("\n").trim().slice(0, LIMITS.postBody);
    if (!plainOf(text) && !picsIn(text).length) { ta.focus(); return toast(t("postNeedBody")); }
    if (r !== room || r.gone) return close();
    if (r.readOnly) { keep(); return toast(t("roNoPost")); }
    if (!id && !canPost()) { keep(); return toast(t("postNotOpen")); }
    const pics = picsIn(text).slice(0, LIMITS.postPhotos);
    sending = true; send.disabled = true; busy(true);
    try {
      // the new pictures first: each to the photo service, then its marker (one write each, like a photo message)
      const p = [];
      for (const f of pics) {
        if (had.has(f)) { p.push(had.get(f)); continue; }
        const n = added.get(f), sealed = !!r.cipher, uid = backend.uid;
        await uploadPhoto(r.code, f, sealed ? await r.cipher.sealRaw(n.bytes, `f:${uid}:${f}`) : n.bytes, sealed);
        r.imgs.set(f, Promise.resolve(n.url));
        const ok = await queue.write({ [r.api.root("files/" + f)]: { by: uid, at: backend.stamp() }, [r.api.root(`members/${uid}/ls`)]: backend.stamp(), [r.api.root(`members/${uid}/lf`)]: f }, "photos");
        if (!ok) throw new Error("photo");
        p.push({ f, w: n.w, h: n.h });
      }
      const card = { t: T, s: plainOf(text).slice(0, LIMITS.postEx), n: Math.max(1, text.length), ...(p.length ? { p } : {}) };
      const ok = id ? await saveEdit(r, id, v, card, text) : await post(KIND.post, card, (pid) => bodyWrite(r, pid, text), { wait: true });
      if (!ok) throw new Error("post");
      // pictures taken out in an edit go with their markers
      if (id) for (const f of had.keys()) if (!p.some((x) => x.f === f)) r.api.update({ ["files/" + f]: null }).then(() => dropPhoto(r.code, backend.uid, f), () => {});
      clearTimeout(saveT); store.set(draftKey(id), null);
      ov.close();
      toast(t(id ? "postSaved" : "postPosted"));
    } catch (e) {
      console.warn(e); keep();
      toast(t(e?.message === "big" ? "postTooLong" : "postFail"));
    } finally { sending = false; send.disabled = false; busy(false); }
  }
}
// what goes in posts/{id} beside the card: the text, sealed in a Private Salon
async function bodyWrite(r, id, text) {
  const body = r.cipher ? { x: await r.cipher.seal({ b: text }, aad(id, backend.uid)) } : { b: text };
  if (body.x && body.x.length > SEALED_MAX) throw new Error("big");
  return { [r.api.root("posts/" + id)]: { by: backend.uid, at: backend.stamp(), ...body } };
}
// the author's new version: the card and the text together, both marked edited
async function saveEdit(r, id, v, card, text) {
  const T = backend.stamp(), uid = backend.uid;
  const cardFields = r.cipher
    ? { x: await r.cipher.seal({ ps: card, n: v.name, a: v.avatar, ...(v.rp ? { r: v.rp } : {}) }, "m:" + uid) }
    : { post: card };
  const sealed = r.cipher ? await r.cipher.seal({ b: text }, aad(id, uid)) : null;
  if (sealed && sealed.length > SEALED_MAX) throw new Error("big");
  const upd = { ...Object.fromEntries(Object.entries(cardFields).map(([k, x]) => [r.api.root(`msgs/${id}/${k}`), x])), [r.api.root(`msgs/${id}/ed`)]: T,
    [r.api.root(`posts/${id}/${sealed ? "x" : "b"}`)]: sealed || text, [r.api.root(`posts/${id}/ed`)]: T };
  return backend.update(upd).then(() => true, (e) => { console.warn(e); return false; });
}
