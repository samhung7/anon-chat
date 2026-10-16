/* Keeps the app shell so the page opens (and can be installed) on a flaky connection.
   Network first, so a new version shows up on the next load; chat itself always needs the network.
   The deploy stamps "dev" below and the ?v=dev on index.html's files and the modules' imports with the commit,
   so a phone never runs a new page with an old script it still had in its HTTP cache. Every module in js/app/
   is listed here (test/unit.test.mjs checks). */
const CACHE = "anon-chat-dev";
const SHELL = ["./", "css/app.css", "js/config.js", "js/theme.js", "js/i18n.js", "js/app/actions.js", "js/app/api.js", "js/app/archive.js", "js/app/backend.js", "js/app/blocking.js", "js/app/chat.js", "js/app/clean.js", "js/app/composer.js", "js/app/constants.js", "js/app/crypto.js", "js/app/dom.js", "js/app/draws.js", "js/app/home.js", "js/app/identity.js", "js/app/kinds.js", "js/app/lobby.js", "js/app/main.js", "js/app/menu.js", "js/app/notify.js", "js/app/people.js", "js/app/photos.js", "js/app/pickers.js", "js/app/polls.js", "js/app/qa.js", "js/app/records.js", "js/app/richtext.js", "js/app/room.js", "js/app/session.js", "js/app/show.js", "js/app/storage.js", "js/app/text.js", "js/i18n/zh-TW.js", "js/i18n/zh-CN.js", "js/i18n/en.js", "js/i18n/ja.js", "js/i18n/ko.js", "js/i18n/es.js", "js/i18n/fr.js", "js/i18n/de.js", "js/i18n/pt.js", "js/vendor/firebase.js", "js/vendor/qrcode.js", "manifest.webmanifest", "icons/stoa2-192.png"];
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
