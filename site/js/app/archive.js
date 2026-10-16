/* A room as a record to keep: the one object every export is made from. The .json file is that object, and the
   .html file carries it too (in a <script type="application/json">), so either can be imported back and read
   here, read-only. Reading one back trusts nothing in it. */
import { t, fmtFull } from "./text.js?v=dev";
import { str, num, arr, isObj, clamp } from "./clean.js?v=dev";
import { savedKindOf, toSaved, readSaved, readReactions, hasContent, escHtml as esc } from "./kinds.js?v=dev";
import { REACTS } from "./constants.js?v=dev";

export const ARCHIVE = "anon-chat-archive";
const label = (m) => `${m.avatar} ${m.name}`;
const nameOr = (n, a) => (n ? `${a || ""} ${n}`.trim() : "");

// the record of a room as this device sees it: everything it can read, under everyone's current name
export function buildArchive(room, uid, self) {
  const meta = room.meta || {};
  const reacts = (v) => {
    const out = {};
    REACTS.forEach((e, k) => { const n = Object.keys(v.re?.[k] || {}).length; if (n) out[e] = n; });
    return Object.keys(out).length ? out : undefined;
  };
  const pics = []; // photos, for the .html file to carry; not kept in the archive itself
  const one = (v, author) => Object.assign(toSaved(v, pics, { name: author.name, avatar: author.avatar, at: v.at }), { mine: v.by === uid || undefined });
  const a = {
    format: ARCHIVE, version: 1,
    title: meta.title || t("roomN", { code: room.code }), code: room.code, created: meta.created, exported: Date.now(),
    me: { name: self.name, avatar: self.avatar },
    messages: [...room.msgs.values()].map((v) => Object.assign(one(v, room.author(v)), { owner: v.by === meta.owner || undefined, reactions: reacts(v) })),
    dms: [...room.dms.entries()].filter(([, msgs]) => msgs.size).map(([other, msgs]) => {
      const them = room.who(other) || { name: t("someoneLeft"), avatar: "👤" };
      return { with: { name: them.name, avatar: them.avatar }, messages: [...msgs.values()].map((v) => one(v, v.by === uid ? self : them)) };
    }),
  };
  // the lecture's questions, most upvoted first: the record a host takes away
  const qs = [...room.qs.values()].filter((q) => !q.bad).sort((x, y) => y.up.length - x.up.length || x.at - y.at)
    .map((q) => ({ text: q.text, name: q.name || undefined, avatar: q.avatar || undefined, at: q.at, votes: q.up.length, done: !!q.done || undefined,
      answer: q.ans && !q.ans.bad ? { text: q.ans.text, name: q.ans.name || undefined, avatar: q.ans.avatar || undefined, at: q.ans.at } : undefined }));
  if (qs.length) a.questions = qs;
  Object.defineProperty(a, "pics", { value: pics });
  return a;
}

// an imported file is untrusted: keep only the fields we know, with the same limits as the database
export function readArchive(o) {
  if (!o || o.format !== ARCHIVE || o.version !== 1 || !Array.isArray(o.messages)) throw new Error("not-archive");
  const msg = (m) => {
    const out = { name: str(m?.name, 24) || "？", avatar: str(m?.avatar, 8), at: num(m?.at), mine: m?.mine === true || undefined, owner: m?.owner === true || undefined, ...readSaved(m) };
    const r = readReactions(m?.reactions);
    if (r) out.reactions = r;
    return out;
  };
  const keep = (list) => arr(list).slice(0, 5000).map(msg).filter(hasContent);
  const person = (p) => str(p?.name, 24);
  const answer = (x) => (isObj(x) && str(x.text, 2000) ? { text: str(x.text, 2000), name: person(x) || undefined, avatar: str(x.avatar, 8) || undefined, at: num(x.at) } : undefined);
  const qs = arr(o.questions).slice(0, 2000).map((q) => ({ text: str(q?.text, 300), name: person(q) || undefined, avatar: str(q?.avatar, 8) || undefined,
    at: num(q?.at), votes: clamp(num(q?.votes), 0, 9999), done: q?.done === true || undefined, answer: answer(q?.answer) })).filter((q) => q.text);
  return {
    format: ARCHIVE, version: 1, title: str(o.title, 60) || t("recordDefault"), code: str(o.code, 4), created: num(o.created), exported: num(o.exported),
    me: { name: person(o.me), avatar: str(o.me?.avatar, 8) },
    messages: keep(o.messages),
    dms: arr(o.dms).slice(0, 200).map((d) => ({ with: { name: person(d?.with) || "？", avatar: str(d?.with?.avatar, 8) }, messages: keep(d?.messages) })).filter((d) => d.messages.length),
    ...(qs.length ? { questions: qs } : {}),
  };
}
export const countOf = (a) => a.messages.length + a.dms.reduce((s, d) => s + d.messages.length, 0) + (a.questions?.length || 0);

// a question's and an answer's heading line in a file
export const qLine = (q) => `▲ ${q.votes} · ${nameOr(q.name, q.avatar) || t("anonAsker")} · ${fmtFull(q.at)}${q.done ? " · " + t("qAnswered") : ""}`;
const ansLine = (a) => `💬 ${t("qAnsLabel")}${a.name ? ` · ${nameOr(a.name, a.avatar)}` : ""}${a.at ? " · " + fmtFull(a.at) : ""}`;
export { label as personLabel };

export function toText(a) {
  const line = (m) => `[${fmtFull(m.at)}] ${label(m)}${m.mine ? t("meTag") : ""}${t("colon")}${savedKindOf(m).savedText(m).replace(/\n/g, "\n    ")}`;
  const out = [t("expHead", { title: a.title, code: a.code }), t("expAt", { t: fmtFull(a.exported) }), "", `── ${t("everyone")} ──`];
  a.messages.forEach((m) => out.push(line(m)));
  if (!a.messages.length) out.push(t("noMsgs"));
  a.dms.forEach((d) => { out.push("", `── ${t("dmHead", { who: label(d.with) })} ──`); d.messages.forEach((m) => out.push(line(m))); });
  if (a.questions) {
    out.push("", `── ${t("qaTab")} ──`);
    a.questions.forEach((q) => {
      out.push(`[${qLine(q)}]`, "    " + q.text.replace(/\n/g, "\n    "));
      if (q.answer) out.push(`    [${ansLine(q.answer)}]`, "        " + q.answer.text.replace(/\n/g, "\n        "));
    });
  }
  return out.join("\n") + "\n";
}
const HTML_STYLE = `body{font:15px/1.55 system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#3a3128;background:#f4efe6}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e4dccc}.sub{color:#857a6b;font-size:13px}.m{margin:10px 0;max-width:85%}.m.me{margin-left:auto;text-align:right}.h{font-size:12px;color:#857a6b;margin-bottom:2px}.b{display:inline-block;text-align:left;background:#fff;border:1px solid #e4dccc;border-radius:14px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}.me .b{background:#d9cdb6;color:#3a3128;border-color:#d9cdb6}.g{max-width:240px;height:auto;border-radius:12px}.p{max-width:min(360px,100%);height:auto;border-radius:12px}.r{font-size:13px;margin-top:2px}.a{margin:6px 0 0 24px;padding-left:10px;border-left:3px solid #d9cdb6}.e{color:#b3aa9b}@media(prefers-color-scheme:dark){body{background:#1b1916;color:#f4efe6}.b{background:#25221e;border-color:#3e3a33}.me .b{background:#e7decd;border-color:#e7decd;color:#2a251f}h2{border-color:#3e3a33}}`;
// srcs: each photo message's picture as a data: URL, so the file shows them after the room is gone
export function toHtml(a, srcs = new Map()) {
  const row = (m) => `<div class="m${m.mine ? " me" : ""}"><div class="h">${esc(label(m))}${m.owner ? " 👑" : ""} <time>${esc(fmtFull(m.at))}</time></div>${savedKindOf(m).savedHtml(m, srcs.get(m))}${m.reactions ? `<div class="r">${Object.entries(m.reactions).map(([e, n]) => `${e} ${n}`).join("　")}</div>` : ""}</div>`;
  const sec = (h, list) => `<h2>${esc(h)}</h2>${list.map(row).join("") || `<p class="e">${esc(t("noMsgs"))}</p>`}`;
  const data = JSON.stringify(a).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="${I18N.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(a.title)}</title>
<style>${HTML_STYLE}</style></head><body>
<h1>${esc(a.title)}</h1><div class="sub">${esc(t("expSub", { code: a.code, t: fmtFull(a.exported) }))}</div>
${sec(t("everyone"), a.messages)}
${a.dms.map((d) => sec(t("dmHead", { who: label(d.with) }), d.messages)).join("")}
${a.questions ? `<h2>${esc(t("qaTab"))}</h2>${a.questions.map((q) => `<div class="m"><div class="h">${esc(qLine(q))}</div><div class="b">${esc(q.text)}</div>${q.answer ? `<div class="a"><div class="h">${esc(ansLine(q.answer))}</div><div class="b">${esc(q.answer.text)}</div></div>` : ""}</div>`).join("")}` : ""}
<script type="application/json" id="${ARCHIVE}">${data}</script>
</body></html>`;
}
