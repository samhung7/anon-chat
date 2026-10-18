/* Keeps the app shell so the page opens (and can be installed) on a flaky connection.
   Network first, so a new version shows up on the next load; chat itself always needs the network.
   The deploy stamps "dev" below and the ?v=dev on index.html's files and the modules' imports with the commit,
   so a phone never runs a new page with an old script it still had in its HTTP cache. Every module in js/app/
   is listed here (test/unit.test.mjs checks). */
const CACHE = "anon-chat-dev";
const SHELL = ["./", "css/app.css", "js/config.js", "js/theme.js", "js/i18n.js", "js/app/actions.js", "js/app/api.js", "js/app/archive.js", "js/app/backend.js", "js/app/blocking.js", "js/app/chat.js", "js/app/clean.js", "js/app/composer.js", "js/app/constants.js", "js/app/crypto.js", "js/app/dom.js", "js/app/draws.js", "js/app/home.js", "js/app/identity.js", "js/app/kinds.js", "js/app/lobby.js", "js/app/main.js", "js/app/menu.js", "js/app/notify.js", "js/app/people.js", "js/app/photos.js", "js/app/push.js", "js/app/pickers.js", "js/app/polls.js", "js/app/qa.js", "js/app/records.js", "js/app/richtext.js", "js/app/room.js", "js/app/session.js", "js/app/show.js", "js/app/storage.js", "js/app/text.js", "js/i18n/zh-TW.js", "js/i18n/zh-CN.js", "js/i18n/en.js", "js/i18n/ja.js", "js/i18n/ko.js", "js/i18n/es.js", "js/i18n/fr.js", "js/i18n/de.js", "js/i18n/pt.js", "js/vendor/firebase.js", "js/vendor/qrcode.js", "manifest.webmanifest", "icons/stoa2-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req, { cache: "no-cache" }).then((res) => { // always ask the server, never a stale HTTP cache
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
// tapping a new-message notification opens (or brings back) the chat
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.split("#")[0].split("?")[0] === url.split("#")[0].split("?")[0]);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});

/* Web Push (js/app/push.js, worker/): a new message while the page is closed. The push service can't know the
   reader's language or decrypt anything, so it sends what happened and the words are picked here. */
const PUSH_TEXT = {
  "zh-TW": ["聊天室 {c}", "有新訊息", "有人傳私訊給你", "打開來看", ["GIF", "📷 照片", "📊 投票", "🎲 抽籤"]],
  "zh-CN": ["聊天室 {c}", "有新消息", "有人给你发了私信", "打开查看", ["GIF", "📷 照片", "📊 投票", "🎲 抽签"]],
  en: ["Room {c}", "New message", "Someone sent you a private message", "Open to read", ["GIF", "📷 Photo", "📊 Poll", "🎲 Draw"]],
  ja: ["ルーム {c}", "新しいメッセージ", "個人メッセージが届きました", "開いて読む", ["GIF", "📷 写真", "📊 投票", "🎲 抽選"]],
  ko: ["방 {c}", "새 메시지", "누군가 개인 메시지를 보냈어요", "열어서 보기", ["GIF", "📷 사진", "📊 투표", "🎲 추첨"]],
  es: ["Sala {c}", "Mensaje nuevo", "Alguien te envió un mensaje privado", "Ábrelo para leerlo", ["GIF", "📷 Foto", "📊 Encuesta", "🎲 Sorteo"]],
  fr: ["Salon {c}", "Nouveau message", "Quelqu'un vous a envoyé un message privé", "Ouvrez pour lire", ["GIF", "📷 Photo", "📊 Sondage", "🎲 Tirage"]],
  de: ["Raum {c}", "Neue Nachricht", "Jemand hat dir eine private Nachricht geschickt", "Zum Lesen öffnen", ["GIF", "📷 Foto", "📊 Umfrage", "🎲 Auslosung"]],
  pt: ["Sala {c}", "Nova mensagem", "Alguém te enviou uma mensagem privada", "Abra para ler", ["GIF", "📷 Foto", "📊 Enquete", "🎲 Sorteio"]],
};
function pushWords() {
  const l = (self.navigator.language || "en").toLowerCase();
  const key = l.startsWith("zh") ? (/(tw|hk|mo|hant)/.test(l) ? "zh-TW" : "zh-CN") : l.split("-")[0];
  return PUSH_TEXT[key] || PUSH_TEXT.en;
}
self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data?.json() || {}; } catch (err) {}
  if (!/^[2-9A-HJKMNP-Z]{4}$/.test(p.c || "")) return;
  const [room, fresh, dm, open, kinds] = pushWords(), where = room.replace("{c}", p.c);
  const what = { gif: kinds[0], img: kinds[1], poll: kinds[2], draw: kinds[3] }[p.i];
  const title = p.k === "m" ? `${p.a || ""} ${p.n || ""} | ${p.r || where}`.trim() : p.k === "d" ? dm : where;
  const body = p.k === "m" ? [what, p.s].filter(Boolean).join(" ") || fresh : p.k === "d" ? `${where} · ${open}` : fresh;
  const url = new URL("./?room=" + p.c, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    // someone already looking at that room doesn't need telling
    if (list.some((c) => c.visibilityState === "visible" && c.focused && new URL(c.url).searchParams.get("room") === p.c)) return;
    return self.registration.showNotification(title, { body, tag: "room-" + p.c, renotify: true, icon: "icons/stoa2-192.png", data: { url } });
  }));
});
