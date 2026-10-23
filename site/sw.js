/* Keeps the app shell so the page opens (and can be installed) on a flaky connection.
   Network first, so a new version shows up on the next load; chat itself always needs the network.
   The deploy stamps "dev" below and the ?v=dev on index.html's files and the modules' imports with the commit,
   so a phone never runs a new page with an old script it still had in its HTTP cache. Every module in js/app/
   is listed here (test/unit.test.mjs checks). */
const CACHE = "anon-chat-dev";
const SHELL = ["./", "css/app.css", "js/config.js", "js/theme.js", "js/i18n.js", "js/app/account.js", "js/app/actions.js", "js/app/api.js", "js/app/archive.js", "js/app/backend.js", "js/app/blocking.js", "js/app/boards.js", "js/app/chat.js", "js/app/clean.js", "js/app/comments.js", "js/app/composer.js", "js/app/constants.js", "js/app/crypto.js", "js/app/dom.js", "js/app/draws.js", "js/app/expiry.js", "js/app/games.js", "js/app/home.js", "js/app/identity.js", "js/app/kinds.js", "js/app/lobby.js", "js/app/main.js", "js/app/menu.js", "js/app/notify.js", "js/app/people.js", "js/app/photos.js", "js/app/push.js", "js/app/puzzles.js", "js/app/pickers.js", "js/app/polls.js", "js/app/posts.js", "js/app/qa.js", "js/app/quick.js", "js/app/quiz.js", "js/app/quizedit.js", "js/app/quizlib.js", "js/app/quizset.js", "js/app/records.js", "js/app/richtext.js", "js/app/room.js", "js/app/scan.js", "js/app/session.js", "js/app/show.js", "js/app/stickyset.js", "js/app/sticky.js", "js/app/storage.js", "js/app/text.js", "js/i18n/zh-TW.js", "js/i18n/zh-CN.js", "js/i18n/en.js", "js/i18n/ja.js", "js/i18n/ko.js", "js/i18n/es.js", "js/i18n/fr.js", "js/i18n/de.js", "js/i18n/pt.js", "js/vendor/firebase.js", "js/vendor/qrcode.js", "manifest.webmanifest", "icons/stoa3-192.png", "icons/icons.svg", "avatars/bear.svg", "avatars/fox.svg", "avatars/panda.svg", "avatars/tiger.svg", "avatars/lion.svg", "avatars/frog.svg", "avatars/monkey.svg", "avatars/penguin.svg", "avatars/owl.svg", "avatars/octopus.svg", "avatars/unicorn.svg", "avatars/dog.svg", "avatars/cat.svg", "avatars/rabbit.svg", "avatars/koala.svg", "avatars/dragon.svg"];
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

/* Web Push (js/app/push.js, worker/): a new message while the page is closed, or a room about to wind down
   (tools/cleanup). The push service can't know the reader's language or decrypt anything, so it sends what happened
   and the words are picked here. */
const PUSH_TEXT = {
  "zh-TW": ["聊天室 {c}", "有新訊息", "有人傳私訊給你", "打開來看", ["GIF", "📷 照片", "📊 投票", "🎲 抽籤"], ["{r} 快要轉為唯讀", "快 24 小時沒人說話了，約 {m} 分鐘後轉為唯讀。說句話就能繼續聊。", "{r} 快要刪除", "已轉為唯讀，約 {h} 小時後刪除。想留下聊天記錄，請打開存檔。"]],
  "zh-CN": ["聊天室 {c}", "有新消息", "有人给你发了私信", "打开查看", ["GIF", "📷 照片", "📊 投票", "🎲 抽签"], ["{r} 快要变为只读", "快 24 小时没人说话了，约 {m} 分钟后变为只读。说句话就能继续聊。", "{r} 快要删除", "已变为只读，约 {h} 小时后删除。想留下聊天记录，请打开存档。"]],
  en: ["Room {c}", "New message", "Someone sent you a private message", "Open to read", ["GIF", "📷 Photo", "📊 Poll", "🎲 Draw"], ["{r} turns read-only soon", "Nobody has spoken for almost 24 hours: it turns read-only in about {m} min. Say something to keep it going.", "{r} will be deleted soon", "It's read-only and will be deleted in about {h} h. Open it to save the chat."]],
  ja: ["ルーム {c}", "新しいメッセージ", "個人メッセージが届きました", "開いて読む", ["GIF", "📷 写真", "📊 投票", "🎲 抽選"], ["{r} はまもなく読み取り専用に", "24時間近く発言がありません。約{m}分後に読み取り専用になります。発言すれば続けられます。", "{r} はまもなく削除されます", "読み取り専用になっています。約{h}時間後に削除されます。残したい場合は開いて保存してください。"]],
  ko: ["방 {c}", "새 메시지", "누군가 개인 메시지를 보냈어요", "열어서 보기", ["GIF", "📷 사진", "📊 투표", "🎲 추첨"], ["{r} 곧 읽기 전용으로 바뀌어요", "24시간 가까이 아무도 말하지 않았어요. 약 {m}분 후 읽기 전용이 돼요. 한마디 하면 계속할 수 있어요.", "{r} 곧 삭제돼요", "읽기 전용이 되었고 약 {h}시간 후 삭제돼요. 대화를 남기려면 열어서 저장하세요."]],
  es: ["Sala {c}", "Mensaje nuevo", "Alguien te envió un mensaje privado", "Ábrelo para leerlo", ["GIF", "📷 Foto", "📊 Encuesta", "🎲 Sorteo"], ["{r} pasará a solo lectura", "Nadie ha hablado en casi 24 horas: pasa a solo lectura en unos {m} min. Escribe algo para seguir.", "{r} se borrará pronto", "Está en solo lectura y se borra en unas {h} h. Ábrela para guardar el chat."]],
  fr: ["Salon {c}", "Nouveau message", "Quelqu'un vous a envoyé un message privé", "Ouvrez pour lire", ["GIF", "📷 Photo", "📊 Sondage", "🎲 Tirage"], ["{r} passe bientôt en lecture seule", "Personne n'a parlé depuis près de 24 heures : lecture seule dans environ {m} min. Écrivez pour continuer.", "{r} sera bientôt supprimé", "Il est en lecture seule et sera supprimé dans environ {h} h. Ouvrez-le pour enregistrer la discussion."]],
  de: ["Raum {c}", "Neue Nachricht", "Jemand hat dir eine private Nachricht geschickt", "Zum Lesen öffnen", ["GIF", "📷 Foto", "📊 Umfrage", "🎲 Auslosung"], ["{r} wird bald schreibgeschützt", "Seit fast 24 Stunden hat niemand geschrieben: in etwa {m} Min. wird der Raum schreibgeschützt. Schreib etwas, um weiterzumachen.", "{r} wird bald gelöscht", "Er ist schreibgeschützt und wird in etwa {h} Std. gelöscht. Öffne ihn, um den Chat zu speichern."]],
  pt: ["Sala {c}", "Nova mensagem", "Alguém te enviou uma mensagem privada", "Abra para ler", ["GIF", "📷 Foto", "📊 Enquete", "🎲 Sorteio"], ["{r} vai ficar somente leitura", "Ninguém fala há quase 24 horas: fica somente leitura em cerca de {m} min. Diga algo para continuar.", "{r} será apagada em breve", "Está somente leitura e será apagada em cerca de {h} h. Abra para salvar a conversa."]],
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
  const [room, fresh, dm, open, kinds, ending] = pushWords(), where = room.replace("{c}", p.c);
  const what = { gif: kinds[0], img: kinds[1], poll: kinds[2], draw: kinds[3] }[p.i];
  // k "e": the hourly cleanup warns that the room turns read-only (ro 0, in m minutes) or is deleted (ro 1, in h hours)
  const fill = (s) => s.replace("{r}", p.r || where).replace("{m}", +p.m || 1).replace("{h}", +p.h || 1);
  const [endT, endB] = p.ro ? ending.slice(2) : ending;
  const title = p.k === "m" ? `${p.a || ""} ${p.n || ""} | ${p.r || where}`.trim() : p.k === "d" ? dm : p.k === "e" ? fill(endT) : where;
  const body = p.k === "m" ? [what, p.s].filter(Boolean).join(" ") || fresh : p.k === "d" ? `${where} · ${open}` : p.k === "e" ? fill(endB) : fresh;
  const url = new URL("./?room=" + p.c, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    // someone already looking at that room doesn't need telling
    if (list.some((c) => c.visibilityState === "visible" && c.focused && new URL(c.url).searchParams.get("room") === p.c)) return;
    return self.registration.showNotification(title, { body, tag: "room-" + p.c, renotify: true, icon: "icons/stoa3-192.png", data: { url } });
  }));
});
