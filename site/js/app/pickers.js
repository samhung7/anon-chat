/* The panels above the message box: ＋ (photo, poll, draw, long post, games), emoji, and GIF search (KLIPY, which needs klipyKey
   in js/config.js). */
import { KLIPY_KEY, GIF_HOST } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { $, el, icon } from "./dom.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { insertAtCursor, sendGif } from "./composer.js?v=dev";
import { newPoll } from "./polls.js?v=dev";
import { newDraw } from "./draws.js?v=dev";
import { gamesSheet, gamesOn } from "./games.js?v=dev";
import { newPost, canPost } from "./posts.js?v=dev";
import { renderQuick } from "./quick.js?v=dev";

const EMOJI = {
  "😀": "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 💩",
  "👍": "👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 💪 🫶 ✍️ 👀 🧠 🫡 🤷 🤦 🙋 🙆 🙅 💁 🙇",
  "❤️": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤 ✨ 🔥 ⭐ 🌟 ⚡ 🎉 🎊 🎈 🎁 🏆 🥇",
  "🐶": "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦉 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🦑 🐠 🐬 🐳 🦈 🐲 🌸 🌻 🌈 ☀️ 🌙 ☔ ❄️",
  "🍔": "🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍑 🥭 🍍 🥝 🍅 🥑 🌽 🍞 🧀 🍳 🥓 🍔 🍟 🍕 🌭 🌮 🍜 🍝 🍣 🍱 🥟 🍙 🍚 🍦 🍩 🍪 🎂 🍰 🍫 🍬 🧋 ☕ 🍵 🍺 🍻 🥂 🍷",
  "⚽": "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 🥅 ⛳ 🎯 🎳 🎮 🕹️ 🎲 ♟️ 🧩 🎨 🎬 🎤 🎧 🎸 🎹 🥁 📚 📖 ✏️ 📝 📌 📎 💡 💻 📱 ⏰ 📅 🗳️ ✅ ❌ ❓ ❗ ⚠️ 🆗 🆒 🆕",
};
let open = null; // "more" | "emoji" | "gif" | null
export const pickerOpen = () => open;
export function closePicker() { open = null; $("#picker").hidden = true; $("#composer").querySelectorAll(".tool").forEach((b) => b.setAttribute("aria-pressed", "false")); renderQuick(); }
export function openPicker(kind) {
  if (open === kind) return closePicker();
  open = kind;
  $("#composer").querySelectorAll(".tool").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.a === kind)));
  const box = $("#picker");
  box.hidden = false;
  box.classList.toggle("short", kind === "more");
  renderQuick();
  ({ more: morePanel, emoji: emojiPanel, gif: gifPanel })[kind](box);
}
function morePanel(box) {
  const item = (name, label, fn) => el("button", { type: "button", class: "morebtn", onclick: () => { fn(); closePicker(); } }, icon(name, "lg"), el("span", { text: label }));
  // the file picker opens right inside the tap, or a phone may refuse to open it
  box.replaceChildren(el("div", { class: "morepanel" },
    item("photo", t("photo"), () => $("#photoFile").click()), item("poll", t("poll"), newPoll), item("draw", t("draw"), newDraw),
    canPost() ? item("post", t("post"), newPost) : null,
    gamesOn() ? item("game", t("games"), gamesSheet) : null));
}
function emojiPanel(box) {
  const grid = el("div", { class: "emojigrid" });
  const fill = (cat) => {
    grid.replaceChildren(...EMOJI[cat].split(" ").map((e) => el("button", { type: "button", class: "emo", text: e })));
    cats.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.cat === cat)));
  };
  const cats = el("div", { class: "cats", role: "tablist" }, Object.keys(EMOJI).map((c) => el("button", { type: "button", role: "tab", "data-cat": c, text: c, onclick: () => fill(c) })));
  grid.addEventListener("click", (e) => { const b = e.target.closest(".emo"); if (b) insertAtCursor(b.textContent); });
  box.replaceChildren(cats, grid);
  fill(Object.keys(EMOJI)[0]);
}

/* ---------- KLIPY ---------- */
const KLIPY_LOCALE = { "zh-TW": "zh_TW", "zh-CN": "zh_CN", en: "en_US", ja: "ja_JP", ko: "ko_KR", es: "es_ES", fr: "fr_FR", de: "de_DE", pt: "pt_BR" };
// Every gif/webp rendition in a result, wherever the response nests it (file.md.gif, files.gif, ...); no video formats.
function klipyFiles(item) {
  const out = [], seen = new Set();
  const walk = (o, path, depth) => {
    if (!o || typeof o !== "object" || depth > 5) return;
    if (typeof o.url === "string" && !seen.has(o.url) && /(^|\.)(gif|webp)\b/i.test(path + " " + o.url.split("?")[0].split(".").pop())) {
      seen.add(o.url);
      out.push({ url: o.url, w: Math.round(+o.width || +o.w || 0), h: Math.round(+o.height || +o.h || 0), ok: GIF_HOST.test(o.url) });
    }
    for (const [k, v] of Object.entries(o)) if (!/mp4|webm|video/i.test(k)) walk(v, path + "." + k, depth + 1);
  };
  walk(item?.file || item?.files || item, "", 0);
  if (out.length && !out.some((f) => f.ok)) console.warn("KLIPY media host not accepted:", out[0].url);
  return out.filter((f) => f.ok && f.w > 0 && f.h > 0);
}
async function klipy(q, page = 1) {
  const base = `https://api.klipy.com/api/v1/${encodeURIComponent(KLIPY_KEY)}/gifs/${q ? "search" : "trending"}`;
  const qs = new URLSearchParams({ per_page: 24, page, locale: KLIPY_LOCALE[I18N.lang] || "en_US", rating: "pg-13", customer_id: backend.uid || "guest" });
  if (q) qs.set("q", q);
  const res = await fetch(`${base}?${qs}`);
  if (!res.ok) throw new Error("klipy " + res.status);
  const body = await res.json();
  const items = body?.data?.data || body?.data || body?.results || [];
  return (Array.isArray(items) ? items : []).map((it) => {
    const files = klipyFiles(it);
    if (!files.length) return null;
    // preview: the smallest one at least 100px wide; to send: the one closest to 300px wide
    const bySize = [...files].sort((a, b) => a.w - b.w);
    const show = bySize.find((f) => f.w >= 100) || bySize[bySize.length - 1];
    const send = [...files].sort((a, b) => Math.abs(a.w - 300) - Math.abs(b.w - 300))[0];
    const fit = (f) => ({ url: f.url, w: Math.min(f.w, 2000), h: Math.min(f.h, 2000) });
    return { show: fit(show), send: { ...fit(send), title: String(it.title || "").slice(0, 120) } };
  }).filter(Boolean);
}
function gifPanel(box) {
  const input = el("input", { class: "field gifq-in", type: "search", placeholder: t("gifPh"), enterkeyhint: "search", "aria-label": t("gifAria") });
  const grid = el("div", { class: "gifgrid" });
  box.replaceChildren(input, grid, el("div", { class: "gifby", text: "Powered by KLIPY" }));
  const note = (key) => grid.replaceChildren(el("p", { class: "muted small", text: t(key) }));
  let n = 0;
  const load = async () => {
    const mine = ++n;
    note("loading");
    try {
      const list = await klipy(input.value.trim());
      if (mine !== n) return;
      if (!list.length) return note("noGif");
      // two columns that scroll down; each GIF goes to the shorter column
      const cols = [el("div", { class: "gifcol" }), el("div", { class: "gifcol" })], tall = [0, 0];
      list.forEach((g) => {
        const i = tall[0] <= tall[1] ? 0 : 1; tall[i] += g.show.h / g.show.w;
        cols[i].append(el("button", { type: "button", class: "gifpick", title: g.send.title, onclick: () => { sendGif(g.send); closePicker(); } },
          el("img", { src: g.show.url, width: g.show.w, height: g.show.h, alt: g.send.title || "GIF", loading: "lazy", referrerpolicy: "no-referrer" })));
      });
      grid.replaceChildren(...cols); grid.scrollTop = 0;
    } catch (e) { console.error(e); if (mine === n) note("gifDown"); }
  };
  let timer = 0;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 350); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); clearTimeout(timer); load(); } });
  load();
  if (matchMedia("(pointer: fine)").matches) input.focus();
}
