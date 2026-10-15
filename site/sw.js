/* Keeps the app shell so the page opens (and can be installed) on a flaky connection.
   Network first, so a new version shows up on the next load; chat itself always needs the network.
   The deploy stamps "dev" below and the ?v=dev on index.html's files with the commit, so a phone never
   runs a new page with an old script it still had in its HTTP cache. */
const CACHE = "anon-chat-dev";
const SHELL = ["./", "css/app.css", "js/app.js", "js/config.js", "js/i18n.js", "js/i18n/zh-TW.js", "js/i18n/zh-CN.js", "js/i18n/en.js", "js/i18n/ja.js", "js/i18n/ko.js", "js/i18n/es.js", "js/i18n/fr.js", "js/i18n/de.js", "js/i18n/pt.js", "js/vendor/firebase.js", "js/vendor/qrcode.js", "manifest.webmanifest", "icons/icon-192.png"];
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
