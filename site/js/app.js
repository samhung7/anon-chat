/* Anonymous chat rooms. Someone opens a room and gets a 4-character code; others join with the code or link.
   Nobody signs up: each device picks a nickname and an animal, and gets an anonymous Firebase id behind the scenes.
   A room is public (the code is enough) or private (the code plus a password). The owner can lock the room,
   remove people, delete messages and end the room, which deletes everything. A room nobody has written in
   for 24 hours is deleted too (see tools/cleanup). Anyone can export what they can see before it goes.
   Backend: Firebase Realtime Database + anonymous sign-in; database.rules.json is what actually enforces all of this. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const CFG = window.CHAT_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };
  // ?emu runs against the local Firebase emulator (testing only)
  if (params.has("emu")) store.set("chat-emu", params.get("emu") === "0" ? null : "1");
  const EMU = !!store.get("chat-emu");
  const FB = EMU ? { apiKey: "demo-key", projectId: "demo-anon-chat", databaseURL: `http://${location.hostname}:9000?ns=demo-anon-chat` } : CFG.firebase;
  const SDK = new URL("js/vendor/firebase.js", location.href).href;
  const ME_KEY = "chat-me", ROOM_KEY = "chat-room";
  const AVATARS = [["🐻", "小熊"], ["🦊", "狐狸"], ["🐼", "熊貓"], ["🐯", "老虎"], ["🦁", "獅子"], ["🐸", "青蛙"], ["🐵", "猴子"], ["🐧", "企鵝"], ["🦉", "貓頭鷹"], ["🐙", "章魚"], ["🦄", "獨角獸"], ["🐶", "小狗"], ["🐱", "小貓"], ["🐰", "兔子"], ["🐨", "無尾熊"], ["🐲", "小龍"]];
  const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
  const REACTS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
  const DAY = 864e5, MAX_LOAD = 2000;

  let fb, db, uid, offset = 0, connecting = null;
  // the room we're in
  let R = null; // { code, meta, members, msgs: Map, dms: Map<otherUid, Map>, view: "all" | otherUid, unread: {}, off: [], gone }
  let hiddenUnread = 0;

  /* ---------- small UI helpers ---------- */
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
    }
    kids.flat().forEach((c) => c != null && e.append(c));
    return e;
  }
  function toast(text) {
    if (!text) return;
    const t = el("div", { class: "toast", text });
    $("#toasts").append(t);
    setTimeout(() => t.classList.add("out"), 2600);
    setTimeout(() => t.remove(), 3000);
  }
  // a bottom sheet; resolves with the data-a of the button pressed (or null when dismissed)
  function sheet(title, body, buttons = [], { onOpen } = {}) {
    return new Promise((res) => {
      const ov = el("div", { class: "overlay" });
      const box = el("div", { class: "sheet", role: "dialog", "aria-label": title },
        title ? el("h2", { text: title }) : null, body,
        buttons.length ? el("div", { class: "actions" }, buttons.map(([a, label, cls]) => el("button", { class: "btn " + (cls || ""), type: "button", "data-a": a, text: label }))) : null);
      ov.append(box);
      const done = (v) => { ov.remove(); document.removeEventListener("keydown", esc); res(v); };
      const esc = (e) => { if (e.key === "Escape") done(null); };
      ov.addEventListener("click", (e) => {
        if (e.target === ov) return done(null);
        const b = e.target.closest("button[data-a]");
        if (b && box.contains(b) && b.closest(".actions")) done(b.dataset.a);
      });
      document.addEventListener("keydown", esc);
      ov.close = done;
      document.body.append(ov);
      onOpen?.(ov);
    });
  }
  const confirmSheet = (title, text, ok, cls = "danger") => sheet(title, el("p", { class: "muted", text }), [["no", "取消"], ["yes", ok, cls]]).then((a) => a === "yes");
  const fmtTime = (t) => new Date(t).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtFull = (t) => new Date(t).toLocaleString("zh-TW", { hour12: false });
  const roomUrl = (code) => location.origin + location.pathname + "?room=" + code;
  const now = () => Date.now() + offset; // server time
  const isOwner = () => !!R?.meta && R.meta.owner === uid;
  const pairKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const who = (id) => R?.members?.[id] || R?.seen?.[id] || null; // R.seen keeps people who have left
  const nameOf = (id) => { const m = who(id); return m ? `${m.avatar} ${m.name}` : "已離開的人"; };
  // GIFs come from the KLIPY search and only from KLIPY's servers (database.rules.json checks the same)
  const GIF_HOST = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//;
  function gifImg(g) {
    if (!g || !GIF_HOST.test(g.url || "")) return el("span", { class: "muted", text: "（GIF）" });
    return el("img", { src: g.url, width: g.w, height: g.h, alt: g.title || "GIF", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  }

  // text with clickable links; everything goes in as text, never as HTML
  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /https?:\/\/[^\s<>"'）」]+/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      frag.append(text.slice(last, m.index));
      frag.append(el("a", { href: m[0], target: "_blank", rel: "noopener noreferrer nofollow", text: m[0] }));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  /* ---------- identity: nickname + animal, kept on this device ---------- */
  const me = () => { try { const m = JSON.parse(store.get(ME_KEY)); if (m && m.name) return m; } catch (e) {} return null; };
  // nicknames are unique per room, compared without case; Firebase keys can't hold . # $ [ ] /
  const cleanName = (n) => String(n || "").replace(/[.#$[\]/]/g, "").replace(/\s+/g, " ").trim().slice(0, 12);
  const nameKey = (n) => n.toLowerCase();
  // the uid holding a nickname in a room, or null
  const nameHolder = (code, name) => fb.get(roomRef(code, "names/" + nameKey(name))).then((s) => s.val(), () => null);
  // inRoom: also rename in the room we're in (fails, and asks again, if someone there has that name)
  async function askMe(firstTime, note = "", inRoom = !firstTime) {
    const cur = me() || (() => { const [a, n] = AVATARS[(Math.random() * AVATARS.length) | 0]; return { avatar: a, name: n, auto: true }; })();
    let pick = cur.avatar, auto = !!cur.auto;
    const input = el("input", { class: "field", maxlength: 12, autocomplete: "off", id: "meName", "aria-label": "暱稱" });
    input.value = cur.name;
    input.addEventListener("input", () => (auto = false));
    const grid = el("div", { class: "avatars" }, AVATARS.map(([a, n]) => el("button", {
      class: "avbtn", type: "button", "aria-label": n, "aria-pressed": String(a === pick), text: a,
      onclick: (e) => { pick = a; grid.querySelectorAll(".avbtn").forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget))); if (auto) input.value = n; },
    })));
    const warn = el("p", { class: "note warn", hidden: !note, text: note });
    const body = el("div", {}, warn, el("p", { class: "muted", text: "不用註冊，其他人只會看到這個名字和頭像。同一個聊天室裡暱稱不能重複。" }), grid, el("label", { class: "lbl", for: "meName", text: "暱稱" }), input);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) body.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
    for (;;) {
      const a = await sheet(firstTime ? "先選一個身分" : note ? "換一個暱稱" : "修改身分", body, [["no", "取消"], ["yes", "確定", "primary"]], { onOpen: () => (firstTime || note) && input.select() });
      if (a !== "yes") return null;
      const m = { avatar: pick, name: cleanName(input.value) || AVATARS.find((x) => x[0] === pick)[1] };
      if (inRoom && R && !R.gone && R.members[uid]) {
        const old = R.members[uid].name;
        const upd = { [`members/${uid}/name`]: m.name, [`members/${uid}/avatar`]: m.avatar, [`names/${nameKey(m.name)}`]: uid };
        // give the old name back only if it's ours: in a room from before unique names, or with a
        // duplicate left over from then, someone else may hold it, and releasing it would fail the whole rename
        if (nameKey(old) !== nameKey(m.name) && (await nameHolder(R.code, old)) === uid) upd[`names/${nameKey(old)}`] = null;
        try { await fb.update(roomRef(R.code), upd); }
        catch (e) {
          const holder = await nameHolder(R.code, m.name);
          warn.textContent = holder && holder !== uid ? `「${m.name}」在這個聊天室已經有人用了，換一個吧。` : "沒有改成功，請再試一次。";
          warn.hidden = false; input.value = m.name; continue;
        }
      }
      store.set(ME_KEY, JSON.stringify(m));
      showMe();
      return m;
    }
  }
  const ensureMe = async () => me() || (await askMe(true));
  function showMe() {
    const m = me();
    $("#meBtn .av").textContent = m ? m.avatar : "🙂";
    $("#meBtn .nm").textContent = m ? m.name : "選身分";
  }

  /* ---------- Firebase ---------- */
  function connect() {
    if (!FB?.databaseURL) return Promise.reject(new Error("no-config"));
    if (!connecting) connecting = (async () => {
      fb = await import(SDK);
      const app = fb.initializeApp(FB);
      db = fb.getDatabase(app);
      if (EMU) { // local emulator: a made-up id per device (or per tab with ?as=) stands in for anonymous sign-in
        const k = "chat-emu-uid" + (params.get("as") || "");
        uid = store.get(k) || "emu" + Math.random().toString(36).slice(2, 12); store.set(k, uid);
        fb.connectDatabaseEmulator(db, location.hostname, 9000, { mockUserToken: { sub: uid, user_id: uid } });
      } else uid = (await fb.signInAnonymously(fb.getAuth(app))).user.uid;
      fb.onValue(fb.ref(db, ".info/serverTimeOffset"), (s) => (offset = s.val() || 0));
    })().catch((e) => { connecting = null; throw e; });
    return connecting;
  }
  const T = () => fb.serverTimestamp();
  const roomRef = (code, path = "") => fb.ref(db, `rooms/${code}${path ? "/" + path : ""}`);
  async function hashPw(code, pw) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`anon-chat:${code}:${pw}`));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function failed(e) {
    console.error(e);
    if (e?.message === "no-config") toast("還沒有設定資料庫");
    else toast(navigator.onLine ? "連線出了問題，請再試一次" : "沒有網路連線");
  }
  let busyN = 0;
  function busy(on) { busyN += on ? 1 : -1; document.body.classList.toggle("busy", busyN > 0); }

  /* ---------- creating and joining ---------- */
  async function create() {
    const m = await ensureMe(); if (!m) return;
    const title = el("input", { class: "field", maxlength: 40, placeholder: "例如：週三讀書會（可以不填）", id: "newTitle" });
    const pw = el("input", { class: "field", maxlength: 40, placeholder: "設定密碼", id: "newPw", autocomplete: "new-password" });
    const pwWrap = el("div", { hidden: true }, el("label", { class: "lbl", for: "newPw", text: "密碼" }), pw, el("p", { class: "muted small", text: "進來的人除了 4 碼，還要輸入這組密碼。" }));
    let priv = false;
    const seg = el("div", { class: "seg", role: "radiogroup", "aria-label": "誰可以加入" },
      el("button", { type: "button", role: "radio", "aria-checked": "true", "data-v": "pub", text: "🌐 公開：有碼就能進" }),
      el("button", { type: "button", role: "radio", "aria-checked": "false", "data-v": "priv", text: "🔒 私人：還要密碼" }));
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      priv = b.dataset.v === "priv";
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      pwWrap.hidden = !priv; if (priv) pw.focus();
    });
    const body = el("div", {}, el("label", { class: "lbl", for: "newTitle", text: "聊天室名稱" }), title, el("label", { class: "lbl", text: "誰可以加入" }), seg, pwWrap);
    for (;;) {
      const a = await sheet("開新聊天室", body, [["no", "取消"], ["yes", "開始", "primary"]]);
      if (a !== "yes") return;
      if (priv && !pw.value.trim()) { toast("私人聊天室要設定密碼"); continue; }
      break;
    }
    busy(true);
    try {
      await connect();
      for (let i = 0; i < 30; i++) {
        const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join("");
        const meta = { owner: uid, created: T(), last: T(), priv };
        if (title.value.trim()) meta.title = title.value.trim().slice(0, 40);
        try {
          await fb.update(fb.ref(db), {
            [`rooms/${code}`]: { meta, members: { [uid]: { name: m.name, avatar: m.avatar, joined: T(), online: true } }, names: { [nameKey(m.name)]: uid } },
            [`secrets/${code}`]: priv ? await hashPw(code, pw.value.trim()) : null,
          });
        } catch (e) { if (/permission/i.test(e.message)) continue; throw e; } // code in use: draw another
        await enter(code);
        share();
        return;
      }
      toast("暫時開不了新聊天室，請再試一次");
    } catch (e) { failed(e); } finally { busy(false); }
  }

  const cleanCode = (c) => {
    c = String(c || "").match(/[?&]room=([0-9A-Za-z]{4})/)?.[1] || c; // a pasted link works as well as the code
    return c.toUpperCase().replace(/[^0-9A-Z]/g, "");
  };
  async function join(raw) {
    const code = cleanCode(raw);
    if (code.length !== 4) { toast("代碼是 4 個字"); return; }
    if (R?.code === code && !R.gone) { showChat(); return; }
    busy(true);
    try {
      await connect();
      const meta = (await fb.get(roomRef(code, "meta"))).val();
      if (!meta || meta.last < now() - DAY) {
        toast("找不到這個聊天室，可能已經結束了");
        if (meta) fb.update(fb.ref(db), { [`rooms/${code}`]: null, [`secrets/${code}`]: null }).catch(() => {}); // expired: clear it out
        if (store.get(ROOM_KEY) === code) { store.set(ROOM_KEY, null); showResume(); }
        return;
      }
      // already inside (coming back)?
      const mine = await fb.get(roomRef(code, "members/" + uid)).then((s) => s.val(), () => null);
      if (mine) { await enter(code); return; }
      if (await fb.get(roomRef(code, "banned/" + uid)).then((s) => s.val(), () => null)) { toast("你已經被房主移出這個聊天室"); return; }
      if (meta.locked) { toast("房主已經鎖住聊天室，暫時不能加入"); return; }
      busy(false);
      let m = await ensureMe();
      busy(true);
      if (!m) return;
      let key = null;
      if (meta.priv) {
        busy(false);
        const pw = await askPassword(meta, code);
        busy(true);
        if (pw == null) return;
        key = await hashPw(code, pw);
      }
      for (;;) {
        const holder = await nameHolder(code, m.name);
        const upd = {
          [`rooms/${code}/members/${uid}`]: { name: m.name, avatar: m.avatar, joined: T(), online: true },
          [`rooms/${code}/names/${nameKey(m.name)}`]: uid,
          [`rooms/${code}/meta/last`]: T(),
        };
        if (key) upd[`rooms/${code}/keys/${uid}`] = key;
        try { await fb.update(fb.ref(db), upd); break; }
        catch (e) {
          if (!/permission/i.test(e.message)) throw e;
          if (holder && holder !== uid) { // someone here already goes by this name
            busy(false);
            m = await askMe(false, `「${m.name}」在這個聊天室已經有人用了，換一個暱稱再加入。`, false);
            busy(true);
            if (!m) return;
            continue;
          }
          toast(meta.priv ? "密碼不對" : "加入不了這個聊天室"); return;
        }
      }
      await enter(code);
    } catch (e) { failed(e); } finally { busy(false); }
  }
  function askPassword(meta, code) {
    const input = el("input", { class: "field", maxlength: 40, type: "password", id: "joinPw", autocomplete: "off", "aria-label": "密碼" });
    const body = el("div", {}, el("p", { class: "muted", text: `「${meta.title || code}」是私人聊天室，請輸入房主給你的密碼。` }), input);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) body.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
    return sheet("🔒 需要密碼", body, [["no", "取消"], ["yes", "加入", "primary"]], { onOpen: () => input.focus() }).then((a) => (a === "yes" && input.value.trim() ? input.value.trim() : null));
  }

  /* ---------- inside a room ---------- */
  async function enter(code) {
    leaveListeners();
    R = { code, meta: null, members: {}, seen: {}, msgs: new Map(), dms: new Map(), view: "all", unread: {}, off: [], gone: false, ready: false };
    store.set(ROOM_KEY, code);
    history.replaceState(null, "", "?room=" + code + (EMU && params.get("as") ? "&as=" + params.get("as") : ""));
    $("#list").replaceChildren();
    showChat();
    const r = R;
    const on = (off) => r.off.push(off);
    const lost = (e) => { if (r === R) checkGone(); else console.warn(e); };

    on(fb.onValue(roomRef(code, "meta"), (s) => {
      if (r !== R) return;
      if (!s.exists()) return gone("ended");
      R.meta = s.val(); renderHeader();
    }, lost));
    on(fb.onValue(roomRef(code, "members"), (s) => {
      if (r !== R) return;
      const next = s.val() || {};
      if (R.ready) Object.entries(next).forEach(([id, m]) => { if (!R.members[id] && id !== uid) toast(`${m.avatar} ${m.name} 加入了`); });
      if (R.ready) Object.entries(R.members).forEach(([id, m]) => { if (!next[id] && id !== uid) toast(`${m.avatar} ${m.name} 離開了`); });
      R.members = next; R.ready = true;
      Object.assign(R.seen, JSON.parse(JSON.stringify(next)));
      if (!next[uid]) return checkGone();
      Object.keys(next).forEach((id) => id !== uid && watchDm(id));
      renderHeader();
    }, lost));
    const q = fb.query(roomRef(code, "msgs"), fb.limitToLast(MAX_LOAD));
    on(fb.onChildAdded(q, (s) => { if (r !== R) return; R.msgs.set(s.key, s.val()); if (R.view === "all") addMsg(s.key, s.val()); noteNew(s.val(), null); }, lost));
    on(fb.onChildChanged(q, (s) => { if (r !== R) return; R.msgs.set(s.key, s.val()); if (R.view === "all") updateMsg(s.key, s.val()); }));
    on(fb.onChildRemoved(q, (s) => { if (r !== R) return; R.msgs.delete(s.key); if (R.view === "all") document.getElementById("m-" + s.key)?.remove(); }));

    // online / offline
    const mine = roomRef(code, "members/" + uid + "/online");
    on(fb.onValue(fb.ref(db, ".info/connected"), (s) => {
      if (!s.val() || r !== R || R.gone) return;
      fb.onDisconnect(mine).set(false).catch(() => {});
      fb.set(mine, true).catch(() => {});
    }));
    on(() => fb.onDisconnect(mine).cancel().catch(() => {}));
  }
  function watchDm(other) {
    if (R.dms.has(other)) return;
    const box = new Map(); R.dms.set(other, box);
    const r = R;
    R.off.push(fb.onChildAdded(fb.ref(db, `rooms/${R.code}/dm/${pairKey(uid, other)}`), (s) => {
      if (r !== R) return;
      const v = s.val(); box.set(s.key, v);
      if (R.view === other) addMsg(s.key, v, true);
      else if (v.by !== uid) { R.unread[other] = (R.unread[other] || 0) + 1; toast(`🔒 ${nameOf(other)} 傳了私訊給你`); renderHeader(); }
      noteNew(v, other);
    }, () => {}));
  }
  function noteNew(v, dmWith) {
    if (v.by === uid || !document.hidden || !R.ready) return;
    hiddenUnread++;
    document.title = `(${hiddenUnread}) ${R.meta?.title || "匿名聊天室"}`;
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { hiddenUnread = 0; document.title = R?.meta?.title || "匿名聊天室"; } });

  function leaveListeners() { R?.off.forEach((f) => { try { f(); } catch (e) {} }); }
  // the room went away under us: find out why
  async function checkGone() {
    if (!R || R.gone) return;
    const r = R;
    const meta = await fb.get(roomRef(r.code, "meta")).then((s) => s.val(), () => null);
    if (r !== R || R.gone) return;
    if (!meta) return gone("ended");
    const banned = await fb.get(roomRef(r.code, "banned/" + uid)).then((s) => s.val(), () => null);
    gone(banned ? "kicked" : "left");
  }
  async function gone(why) {
    if (!R || R.gone) return;
    R.gone = true; leaveListeners();
    store.set(ROOM_KEY, null);
    if (why === "self") return home();
    const text = { ended: "聊天室已經結束（房主結束了，或超過 24 小時沒人說話），訊息都已刪除。", kicked: "房主把你移出了這個聊天室。", left: "你已經不在這個聊天室裡了。" }[why];
    $("#composer").classList.add("off");
    for (;;) {
      const a = await sheet("聊天室已經結束", el("p", { class: "muted", text: text + "畫面上的記錄還在你的裝置上，關掉前可以先存起來。" }), [["save", "存到這台裝置", "primary"], ["export", "下載檔案"], ["home", "回首頁"]]);
      if (a === "save") { const id = saveRecord(archive()); if (id) return openRecord(null, id); continue; }
      if (a === "export") { await exportSheet(); continue; }
      break;
    }
    home();
  }

  /* ---------- rendering ---------- */
  function renderHeader() {
    if (!R) return;
    const meta = R.meta || {};
    $("#roomTitle").textContent = meta.title || "聊天室";
    $("#codeBtn").textContent = (meta.priv ? "🔒 " : "") + R.code + (meta.locked ? " · 已鎖" : "");
    const list = Object.values(R.members || {});
    $("#peopleBtn .n").textContent = list.filter((m) => m.online !== false).length;
    $("#peopleBtn .dot").hidden = !Object.values(R.unread).some((n) => n > 0);
    $("#composer").classList.toggle("off", R.gone);
    if (R.view !== "all") $("#dmBar .dmwho").textContent = nameOf(R.view);
    if (!document.hidden || !hiddenUnread) document.title = meta.title || "匿名聊天室";
  }
  function bubble(id, v, dm) {
    const mine = v.by === uid;
    const owner = R.meta?.owner === v.by;
    const prev = $("#list").lastElementChild;
    const cont = prev && prev.dataset.by === v.by && v.at - Number(prev.dataset.at) < 180000;
    const node = el("div", { class: "msg" + (mine ? " mine" : "") + (cont ? " cont" : ""), id: (dm ? "d-" : "m-") + id, "data-by": v.by, "data-at": v.at, "data-id": id },
      cont ? null : el("div", { class: "who" },
        el("span", { class: "av", text: dm ? who(v.by)?.avatar || "👤" : v.avatar }),
        el("span", { class: "nm", text: (dm ? who(v.by)?.name || "已離開的人" : v.name) + (owner ? " 👑" : "") }),
        el("time", { text: fmtTime(v.at) })),
      v.gif ? el("div", { class: "bub gifbub" }, gifImg(v.gif)) : el("div", { class: "bub" }, linkify(v.text || "")),
      dm ? null : el("div", { class: "re" }));
    if (!dm) fillReacts(node, v);
    node.addEventListener("click", (e) => { if (!e.target.closest("a, .re")) msgActions(id, v, dm); });
    return node;
  }
  function addMsg(id, v, dm) {
    const list = $("#list");
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80 || v.by === uid;
    $(".empty", list)?.remove();
    list.append(bubble(id, v, dm));
    if (stick) list.scrollTop = list.scrollHeight;
  }
  function updateMsg(id, v) {
    const node = document.getElementById("m-" + id);
    if (node) fillReacts(node, v);
  }
  function fillReacts(node, v) {
    const box = $(".re", node); if (!box) return;
    box.replaceChildren(...REACTS.map((emo, k) => {
      const who = Object.keys(v.re?.[k] || {});
      if (!who.length) return null;
      return el("button", { type: "button", class: "chip" + (who.includes(uid) ? " on" : ""), title: who.map(nameOf).join("、"), onclick: () => react(node.dataset.id, k, !who.includes(uid)) }, `${emo} ${who.length}`);
    }).filter(Boolean));
  }
  function renderView() {
    closePicker();
    const list = $("#list");
    list.replaceChildren();
    $("#dmBar").hidden = R.view === "all";
    $("#chat").classList.toggle("indm", R.view !== "all");
    if (R.view === "all") {
      if (!R.msgs.size) list.append(el("p", { class: "empty", text: "還沒有人說話。把右上角的代碼傳給大家，就可以開始聊了。" }));
      R.msgs.forEach((v, id) => list.append(bubble(id, v)));
      $("#text").placeholder = "說點什麼…";
    } else {
      const box = R.dms.get(R.view) || new Map();
      if (!box.size) list.append(el("p", { class: "empty", text: "私訊只有你們兩個看得到，房主也看不到。" }));
      box.forEach((v, id) => list.append(bubble(id, v, true)));
      R.unread[R.view] = 0;
      $("#text").placeholder = `私訊給 ${nameOf(R.view)}…`;
    }
    renderHeader();
    list.scrollTop = list.scrollHeight;
  }
  function openDm(other) {
    if (other === uid) return;
    watchDm(other);
    R.view = other; renderView(); $("#text").focus();
  }

  /* ---------- actions ---------- */
  async function send(text, gif) {
    text = (text || "").trim().slice(0, 1000);
    if ((!text && !gif) || !R || R.gone) return false;
    const body = gif ? { gif } : { text };
    const m = R.members[uid] || me(); // the name this room knows me by
    const base = `rooms/${R.code}`;
    const upd = { [`${base}/meta/last`]: T() };
    if (R.view === "all") {
      const id = fb.push(fb.ref(db, base + "/msgs")).key;
      upd[`${base}/msgs/${id}`] = { by: uid, name: m.name, avatar: m.avatar, ...body, at: T() };
    } else {
      if (!R.members[R.view]) { toast("對方已經離開聊天室了"); return false; }
      const p = `${base}/dm/${pairKey(uid, R.view)}`;
      upd[`${p}/${fb.push(fb.ref(db, p)).key}`] = { by: uid, to: R.view, ...body, at: T() };
    }
    $("#list .empty")?.remove();
    fb.update(fb.ref(db), upd).catch((e) => { console.error(e); toast("送不出去，請檢查網路"); });
    return true;
  }
  const react = (id, k, on) => fb.set(roomRef(R.code, `msgs/${id}/re/${k}/${uid}`), on ? true : null).catch(() => toast("沒有成功，請再試一次"));

  async function msgActions(id, v, dm) {
    if (!R || R.gone) return;
    const canDel = !dm && v.by === uid;
    const reacts = dm ? null : el("div", { class: "reactrow" }, REACTS.map((emo, k) => {
      const on = !!v.re?.[k]?.[uid];
      return el("button", { type: "button", class: "chip big" + (on ? " on" : ""), "data-a": "re" + k, text: emo });
    }));
    const btns = v.gif ? [] : [["copy", "複製文字"]];
    if (!dm && v.by !== uid && R.members[v.by]) btns.push(["dm", "私訊 " + v.name]);
    if (canDel) btns.push(["del", "刪除訊息", "danger"]);
    const body = el("div", {}, v.gif ? el("div", { class: "quote gifq" }, gifImg(v.gif)) : el("blockquote", { class: "quote", text: v.text.length > 140 ? v.text.slice(0, 140) + "…" : v.text }), reacts);
    let picked = null;
    const a = await sheet("", body, btns, { onOpen: (ov) => reacts?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { picked = +b.dataset.a.slice(2); ov.close("react"); } }) });
    if (a === "react") return react(id, picked, !v.re?.[picked]?.[uid]);
    if (a === "copy") navigator.clipboard?.writeText(v.text).then(() => toast("已複製"), () => toast("複製不了"));
    if (a === "dm") openDm(v.by);
    if (a === "del" && (await confirmSheet("刪除這則訊息？", "所有人都看不到這則訊息了。", "刪除"))) fb.remove(roomRef(R.code, "msgs/" + id)).catch(() => toast("刪不掉，請再試一次"));
  }

  function share() {
    if (!R) return;
    const url = roomUrl(R.code);
    const qr = qrcode(0, "M"); qr.addData(url); qr.make();
    const qrBox = el("div", { class: "qr", "aria-label": "QR Code" }); qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const body = el("div", { class: "share" },
      el("div", { class: "bigcode", text: R.code }),
      el("p", { class: "muted", text: R.meta?.priv ? "這是私人聊天室：對方輸入 4 碼後還需要你設定的密碼。" : "把 4 碼或連結傳給大家，打開就能加入。" }),
      el("div", { class: "linkrow" }, el("input", { class: "field", readonly: true, value: url, "aria-label": "連結", onfocus: (e) => e.target.select() })),
      qrBox);
    const btns = [["copy", "複製連結", "primary"]];
    if (navigator.share) btns.unshift(["share", "分享…"]);
    sheet("邀請大家加入", body, btns).then((a) => {
      if (a === "copy") navigator.clipboard?.writeText(url).then(() => toast("已複製連結"), () => toast("複製不了，請長按連結"));
      if (a === "share") navigator.share({ title: R.meta?.title || "匿名聊天室", text: `來聊天！代碼 ${R.code}`, url }).catch(() => {});
    });
  }

  function people() {
    if (!R) return;
    const ids = Object.keys(R.members).sort((a, b) => (a === R.meta?.owner ? -1 : b === R.meta?.owner ? 1 : (R.members[a].joined || 0) - (R.members[b].joined || 0)));
    const list = el("ul", { class: "plist" }, ids.map((id) => {
      const m = R.members[id];
      const tags = [id === uid ? "你" : null, id === R.meta?.owner ? "房主" : null, m.online === false ? "離線" : null].filter(Boolean).join(" · ");
      return el("li", { class: m.online === false ? "away" : "" },
        el("span", { class: "av", text: m.avatar }),
        el("span", { class: "nm" }, el("b", { text: m.name }), tags ? el("small", { text: tags }) : null),
        id !== uid ? el("button", { type: "button", class: "btn small", "data-dm": id }, "私訊", R.unread[id] ? el("i", { class: "badge", text: R.unread[id] }) : null) : null,
        id !== uid && isOwner() ? el("button", { type: "button", class: "btn small danger", "data-kick": id, text: "移出" }) : null);
    }));
    let choice = null;
    sheet(`成員（${ids.length}）`, list, [["close", "關閉"]], {
      onOpen: (ov) => list.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        choice = b.dataset.dm ? ["dm", b.dataset.dm] : ["kick", b.dataset.kick]; ov.close("pick");
      }),
    }).then(async () => {
      if (!choice) return;
      const [what, id] = choice;
      if (what === "dm") return openDm(id);
      const m = R.members[id];
      if (m && (await confirmSheet(`移出 ${m.avatar} ${m.name}？`, "對方會馬上離開，而且不能再用這個裝置回來。", "移出"))) {
        const release = (await nameHolder(R.code, m.name)) === id; // don't free a name someone else still uses
        fb.update(roomRef(R.code), { [`members/${id}`]: null, ...(release ? { [`names/${nameKey(m.name)}`]: null } : {}), [`banned/${id}`]: true }).then(() => toast(`已移出 ${m.name}`), () => toast("移不出去，請再試一次"));
      }
    });
  }

  async function menu() {
    if (!R) return;
    const btns = [["share", "邀請大家"], ["me", "修改我的暱稱和頭像"], ["export", "匯出聊天記錄"]];
    if (isOwner()) {
      btns.push(R.meta?.locked ? ["unlock", "解除鎖定，讓新的人加入"] : ["lock", "鎖住聊天室，不讓新的人加入"]);
      btns.push(["end", "結束並刪除聊天室", "danger"]);
    } else btns.push(["leave", "離開聊天室", "danger"]);
    const a = await sheet(R.meta?.title || "聊天室 " + R.code, null, btns);
    if (a === "share") share();
    if (a === "me") askMe(false);
    if (a === "export") exportSheet();
    if (a === "lock" || a === "unlock") fb.update(roomRef(R.code, "meta"), { locked: a === "lock" }).then(() => toast(a === "lock" ? "已鎖住，新的人進不來" : "已解除鎖定"), () => toast("沒有成功，請再試一次"));
    if (a === "leave" && (await confirmSheet("離開聊天室？", "離開後就看不到新的訊息了。" + (R.meta?.priv ? "要回來得再輸入一次密碼。" : ""), "離開"))) {
      const code = R.code;
      R.gone = true; leaveListeners();
      const mine = R.members[uid];
      const release = mine && (await nameHolder(code, mine.name)) === uid; // same reason as in askMe
      await fb.update(fb.ref(db), { [`rooms/${code}/members/${uid}`]: null, [`rooms/${code}/keys/${uid}`]: null, ...(release ? { [`rooms/${code}/names/${nameKey(mine.name)}`]: null } : {}) }).catch(() => {});
      R = null; store.set(ROOM_KEY, null); home();
    }
    if (a === "end") endRoom();
  }
  async function endRoom() {
    const a = await sheet("結束聊天室？", el("p", { class: "muted", text: "所有訊息和私訊都會永久刪除，所有人都會離開，代碼也會失效。想留記錄的話請先匯出。" }), [["no", "取消"], ["export", "先匯出"], ["yes", "結束並刪除", "danger"]]);
    if (a === "export") { await exportSheet(); return endRoom(); }
    if (a !== "yes") return;
    const code = R.code;
    R.gone = true; leaveListeners();
    try { await fb.update(fb.ref(db), { [`rooms/${code}`]: null, [`secrets/${code}`]: null }); toast("聊天室已結束，訊息都刪除了"); }
    catch (e) { failed(e); }
    R = null; store.set(ROOM_KEY, null); home();
  }

  /* ---------- export, and saved records ----------
     Everything is exported from one archive object; the .json file is that object, and the .html file carries it
     too (in a <script type="application/json">), so either can be imported back and read here, read-only. */
  const ARCHIVE = "anon-chat-archive";
  function archive() {
    const meta = R.meta || {};
    const self = R.members[uid] || R.seen[uid] || me();
    const reacts = (v) => {
      const out = {};
      REACTS.forEach((e, k) => { const n = Object.keys(v.re?.[k] || {}).length; if (n) out[e] = n; });
      return Object.keys(out).length ? out : undefined;
    };
    const one = (v, author) => ({ name: author.name, avatar: author.avatar, at: v.at, text: v.text || undefined, gif: v.gif || undefined, mine: v.by === uid || undefined });
    return {
      format: ARCHIVE, version: 1,
      title: meta.title || "聊天室 " + R.code, code: R.code, created: meta.created, exported: Date.now(),
      me: { name: self.name, avatar: self.avatar },
      messages: [...R.msgs.values()].map((v) => ({ ...one(v, v), owner: v.by === meta.owner || undefined, reactions: reacts(v) })),
      dms: [...R.dms.entries()].filter(([, box]) => box.size).map(([other, box]) => {
        const them = who(other) || { name: "已離開的人", avatar: "👤" };
        return { with: { name: them.name, avatar: them.avatar }, messages: [...box.values()].map((v) => one(v, v.by === uid ? self : them)) };
      }),
    };
  }
  // an imported file is untrusted: keep only the fields we know, with the same limits as the database
  function readArchive(o) {
    if (!o || o.format !== ARCHIVE || o.version !== 1 || !Array.isArray(o.messages)) throw new Error("not-archive");
    const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
    const num = (x) => (Number.isFinite(+x) ? +x : 0);
    const gif = (g) => (g && typeof g.url === "string" && GIF_HOST.test(g.url) ? { url: g.url.slice(0, 500), w: num(g.w) || 200, h: num(g.h) || 200, title: str(g.title, 120) } : undefined);
    const msg = (m) => {
      const out = { name: str(m?.name, 24) || "？", avatar: str(m?.avatar, 8), at: num(m?.at), text: str(m?.text, 1000) || undefined, gif: gif(m?.gif), mine: m?.mine === true || undefined, owner: m?.owner === true || undefined };
      if (m?.reactions && typeof m.reactions === "object") {
        const r = {}; REACTS.forEach((e) => { const n = num(m.reactions[e]); if (n > 0) r[e] = Math.min(n, 9999); });
        if (Object.keys(r).length) out.reactions = r;
      }
      return out;
    };
    const keep = (list) => (Array.isArray(list) ? list : []).slice(0, 5000).map(msg).filter((m) => m.text || m.gif);
    return {
      format: ARCHIVE, version: 1, title: str(o.title, 60) || "聊天記錄", code: str(o.code, 4), created: num(o.created), exported: num(o.exported),
      me: { name: str(o.me?.name, 24), avatar: str(o.me?.avatar, 8) },
      messages: keep(o.messages),
      dms: (Array.isArray(o.dms) ? o.dms : []).slice(0, 200).map((d) => ({ with: { name: str(d?.with?.name, 24) || "？", avatar: str(d?.with?.avatar, 8) }, messages: keep(d?.messages) })).filter((d) => d.messages.length),
    };
  }
  const countOf = (a) => a.messages.length + a.dms.reduce((s, d) => s + d.messages.length, 0);
  const label = (m) => `${m.avatar} ${m.name}`;
  function toText(a) {
    const line = (m) => `[${fmtFull(m.at)}] ${label(m)}${m.mine ? "（我）" : ""}：${m.gif ? `[GIF] ${m.gif.title || ""} ${m.gif.url}`.replace(/\s+/g, " ") : m.text.replace(/\n/g, "\n    ")}`;
    const out = [`${a.title}（代碼 ${a.code}）`, `匯出時間：${fmtFull(a.exported)}`, "", "── 大家 ──"];
    a.messages.forEach((m) => out.push(line(m)));
    if (!a.messages.length) out.push("（沒有訊息）");
    a.dms.forEach((d) => { out.push("", `── 🔒 和 ${label(d.with)} 的私訊 ──`); d.messages.forEach((m) => out.push(line(m))); });
    return out.join("\n") + "\n";
  }
  function toHtml(a) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const row = (m) => `<div class="m${m.mine ? " me" : ""}"><div class="h">${esc(label(m))}${m.owner ? " 👑" : ""} <time>${esc(fmtFull(m.at))}</time></div>${m.gif ? `<img class="g" src="${esc(m.gif.url)}" width="${+m.gif.w}" height="${+m.gif.h}" alt="${esc(m.gif.title || "GIF")}" loading="lazy">` : `<div class="b">${esc(m.text)}</div>`}${m.reactions ? `<div class="r">${Object.entries(m.reactions).map(([e, n]) => `${e} ${n}`).join("　")}</div>` : ""}</div>`;
    const sec = (h, list) => `<h2>${esc(h)}</h2>${list.map(row).join("") || '<p class="e">（沒有訊息）</p>'}`;
    const data = JSON.stringify(a).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(a.title)}</title>
<style>body{font:15px/1.55 system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#1e293b;background:#f8fafc}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}.sub{color:#64748b;font-size:13px}.m{margin:10px 0;max-width:85%}.m.me{margin-left:auto;text-align:right}.h{font-size:12px;color:#64748b;margin-bottom:2px}.b{display:inline-block;text-align:left;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}.me .b{background:#4f46e5;color:#fff;border-color:#4f46e5}.g{max-width:240px;height:auto;border-radius:12px}.r{font-size:13px;margin-top:2px}.e{color:#94a3b8}@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}.b{background:#1e293b;border-color:#334155}h2{border-color:#334155}}</style></head><body>
<h1>${esc(a.title)}</h1><div class="sub">代碼 ${esc(a.code)} · 匯出時間 ${esc(fmtFull(a.exported))} · 這個檔案可以在匿名聊天室匯入</div>
${sec("大家", a.messages)}
${a.dms.map((d) => sec(`🔒 和 ${label(d.with)} 的私訊`, d.messages)).join("")}
<script type="application/json" id="${ARCHIVE}">${data}</script>
</body></html>`;
  }
  function download(a, kind) {
    const stamp = new Date(a.exported || Date.now()).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const name = `chat-${a.code || "record"}-${stamp}.${kind}`; // ASCII: some browsers drop non-ASCII download names
    const body = kind === "txt" ? toText(a) : kind === "html" ? toHtml(a) : JSON.stringify(a, null, 1);
    const type = { txt: "text/plain", html: "text/html", json: "application/json" }[kind] + ";charset=utf-8";
    const link = el("a", { href: URL.createObjectURL(new Blob([body], { type })), download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    toast("已下載 " + name);
  }
  async function exportSheet() {
    if (!R) return;
    const a = archive();
    const pick = await sheet("匯出聊天記錄", el("div", {},
      el("p", { class: "muted", text: `共 ${countOf(a)} 則訊息，包含你自己的私訊。` }),
      el("p", { class: "muted small", text: "「存到這台裝置」之後可以在首頁的「我的聊天記錄」打開；JSON 和網頁檔都能在其他裝置匯入回來。" })),
      [["save", "存到這台裝置", "primary"], ["json", "JSON 檔（可匯入）"], ["html", "網頁檔 .html（可匯入）"], ["txt", "文字檔 .txt"]]);
    if (pick === "save") saveRecord(a);
    else if (pick) download(a, pick);
  }

  // saved records live in this browser's storage; nothing is uploaded
  const REC_LIST = "chat-records", REC = (id) => "chat-record:" + id;
  const records = () => { try { const l = JSON.parse(store.get(REC_LIST)); return Array.isArray(l) ? l : []; } catch (e) { return []; } };
  function saveRecord(a, quiet) {
    const id = `${a.code || "x"}-${a.exported || Date.now()}`;
    try {
      localStorage.setItem(REC(id), JSON.stringify(a));
      const list = records().filter((r) => r.id !== id);
      list.unshift({ id, title: a.title, code: a.code, exported: a.exported, n: countOf(a) });
      localStorage.setItem(REC_LIST, JSON.stringify(list));
    } catch (e) { toast("這台裝置的空間不夠，請改用下載檔案"); return null; }
    if (!quiet) toast("已存到「我的聊天記錄」");
    showRecords();
    return id;
  }
  function deleteRecord(id) {
    store.set(REC(id), null);
    try { localStorage.setItem(REC_LIST, JSON.stringify(records().filter((r) => r.id !== id))); } catch (e) {}
    showRecords();
  }
  function showRecords() {
    const list = records(), box = $("#records .reclist");
    box.replaceChildren(...list.map((r) => el("li", {},
      el("button", { type: "button", class: "rec", "data-open": r.id },
        el("b", { text: r.title }), el("small", { text: `${r.code ? "代碼 " + r.code + " · " : ""}${r.n} 則 · ${new Date(r.exported).toLocaleDateString("zh-TW")}` })))));
    $("#records .none").hidden = list.length > 0;
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 8e6) { toast("檔案太大了"); return; }
    let a;
    try {
      const text = await file.text();
      let raw;
      if (/^\s*</.test(text)) { // an exported .html: the archive rides along inside it
        const tag = new DOMParser().parseFromString(text, "text/html").getElementById(ARCHIVE);
        raw = tag && JSON.parse(tag.textContent);
      } else raw = JSON.parse(text);
      a = readArchive(raw);
    } catch (e) { toast("這不是匿名聊天室匯出的檔案"); return; }
    const id = saveRecord(a, true);
    openRecord(id ? null : a, id);
  }

  /* ---------- reading a saved record (read-only) ---------- */
  let REC_VIEW = null; // { a, id, tab }
  function openRecord(a, id) {
    if (!a) { try { a = readArchive(JSON.parse(localStorage.getItem(REC(id)))); } catch (e) { toast("這份記錄打不開了"); deleteRecord(id); return; } }
    REC_VIEW = { a, id, tab: -1 };
    $("#home").hidden = true; $("#chat").hidden = true; $("#record").hidden = false;
    $("#recTitle").textContent = a.title;
    $("#recSub").textContent = `📁 唯讀記錄 · ${fmtFull(a.exported)} 匯出`;
    const tabs = $("#recTabs");
    tabs.replaceChildren(el("button", { type: "button", class: "tab", "data-tab": -1, text: `大家（${a.messages.length}）` }),
      ...a.dms.map((d, i) => el("button", { type: "button", class: "tab", "data-tab": i, text: `🔒 ${label(d.with)}` })));
    tabs.hidden = !a.dms.length;
    renderRecord();
  }
  function renderRecord() {
    const { a, tab } = REC_VIEW;
    $("#recTabs").querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(+b.dataset.tab === tab)));
    const list = tab < 0 ? a.messages : a.dms[tab].messages;
    const box = $("#recList");
    let prev = null;
    box.replaceChildren(...(list.length ? list.map((m) => {
      const cont = prev && prev.name === m.name && !!prev.mine === !!m.mine && m.at - prev.at < 180000;
      prev = m;
      return el("div", { class: "msg" + (m.mine ? " mine" : "") + (cont ? " cont" : "") },
        cont ? null : el("div", { class: "who" }, el("span", { class: "av", text: m.avatar }), el("span", { class: "nm", text: m.name + (m.owner ? " 👑" : "") }), el("time", { text: fmtFull(m.at) })),
        m.gif ? el("div", { class: "bub gifbub ro" }, gifImg(m.gif)) : el("div", { class: "bub ro" }, linkify(m.text)),
        m.reactions ? el("div", { class: "re" }, Object.entries(m.reactions).map(([e, n]) => el("span", { class: "chip", text: `${e} ${n}` }))) : null);
    }) : [el("p", { class: "empty", text: "沒有訊息" })]));
    box.scrollTop = 0;
  }
  async function recordMenu() {
    const { a, id } = REC_VIEW;
    const pick = await sheet(a.title, el("p", { class: "muted", text: "這是匯入或保存的聊天記錄，只能閱讀，不能修改。" }),
      [["json", "下載 JSON 檔"], ["html", "下載網頁檔"], ["txt", "下載文字檔"], ...(id ? [["del", "從這台裝置刪除", "danger"]] : [])]);
    if (pick === "del" && (await confirmSheet("刪除這份記錄？", "只會從這台裝置刪除，已經下載的檔案不受影響。", "刪除"))) { deleteRecord(id); home(); }
    else if (pick && pick !== "del") download(a, pick);
  }

  /* ---------- emoji and GIF pickers ---------- */
  const EMOJI = {
    "😀": "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 💩",
    "👍": "👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 💪 🫶 ✍️ 👀 🧠 🫡 🤷 🤦 🙋 🙆 🙅 💁 🙇",
    "❤️": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤 ✨ 🔥 ⭐ 🌟 ⚡ 🎉 🎊 🎈 🎁 🏆 🥇",
    "🐶": "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦉 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🦑 🐠 🐬 🐳 🦈 🐲 🌸 🌻 🌈 ☀️ 🌙 ☔ ❄️",
    "🍔": "🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍑 🥭 🍍 🥝 🍅 🥑 🌽 🍞 🧀 🍳 🥓 🍔 🍟 🍕 🌭 🌮 🍜 🍝 🍣 🍱 🥟 🍙 🍚 🍦 🍩 🍪 🎂 🍰 🍫 🍬 🧋 ☕ 🍵 🍺 🍻 🥂 🍷",
    "⚽": "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 🥅 ⛳ 🎯 🎳 🎮 🕹️ 🎲 ♟️ 🧩 🎨 🎬 🎤 🎧 🎸 🎹 🥁 📚 📖 ✏️ 📝 📌 📎 💡 💻 📱 ⏰ 📅 🗳️ ✅ ❌ ❓ ❗ ⚠️ 🆗 🆒 🆕",
  };
  let pickerOpen = null; // "emoji" | "gif" | null
  function closePicker() { pickerOpen = null; $("#picker").hidden = true; $("#composer").querySelectorAll(".tool").forEach((b) => b.setAttribute("aria-pressed", "false")); }
  function openPicker(kind) {
    if (pickerOpen === kind) return closePicker();
    pickerOpen = kind;
    $("#composer").querySelectorAll(".tool").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.a === kind)));
    const box = $("#picker");
    box.hidden = false;
    if (kind === "emoji") {
      const grid = el("div", { class: "emojigrid" });
      const fill = (cat) => {
        grid.replaceChildren(...EMOJI[cat].split(" ").map((e) => el("button", { type: "button", class: "emo", text: e })));
        cats.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.cat === cat)));
      };
      const cats = el("div", { class: "cats", role: "tablist" }, Object.keys(EMOJI).map((c) => el("button", { type: "button", role: "tab", "data-cat": c, text: c, onclick: () => fill(c) })));
      grid.addEventListener("click", (e) => { const b = e.target.closest(".emo"); if (b) insertAtCursor(b.textContent); });
      box.replaceChildren(cats, grid);
      fill(Object.keys(EMOJI)[0]);
    } else gifPanel(box);
  }
  function insertAtCursor(t) {
    const ta = $("#text");
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
    ta.value = (ta.value.slice(0, a) + t + ta.value.slice(b)).slice(0, 1000);
    ta.selectionStart = ta.selectionEnd = Math.min(a + t.length, ta.value.length);
    ta.dispatchEvent(new Event("input"));
  }
  // KLIPY (klipy.com) GIF search; needs klipyKey in js/config.js
  const KLIPY = CFG.klipyKey;
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
    const base = `https://api.klipy.com/api/v1/${encodeURIComponent(KLIPY)}/gifs/${q ? "search" : "trending"}`;
    const qs = new URLSearchParams({ per_page: 24, page, locale: "zh_TW", rating: "pg-13", customer_id: uid || "guest" });
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
    const input = el("input", { class: "field gifq-in", type: "search", placeholder: "搜尋 GIF，例如：好耶、無言、cat", enterkeyhint: "search", "aria-label": "搜尋 GIF" });
    const grid = el("div", { class: "gifgrid" });
    const foot = el("div", { class: "gifby", text: "Powered by KLIPY" });
    box.replaceChildren(input, grid, foot);
    let n = 0;
    const load = async () => {
      const mine = ++n;
      grid.replaceChildren(el("p", { class: "muted small", text: "載入中…" }));
      try {
        const list = await klipy(input.value.trim());
        if (mine !== n) return;
        grid.replaceChildren(...(list.length ? list.map((g) => el("button", { type: "button", class: "gifpick", title: g.send.title, onclick: () => { send("", g.send); closePicker(); } },
          el("img", { src: g.show.url, alt: g.send.title || "GIF", loading: "lazy", referrerpolicy: "no-referrer" }))) : [el("p", { class: "muted small", text: "找不到相關的 GIF" })]));
      } catch (e) { console.error(e); if (mine === n) grid.replaceChildren(el("p", { class: "muted small", text: "GIF 搜尋暫時無法使用" })); }
    };
    let t = 0;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 350); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); clearTimeout(t); load(); } });
    load();
    if (matchMedia("(pointer: fine)").matches) input.focus();
  }

  /* ---------- screens ---------- */
  function showChat() { $("#home").hidden = true; $("#record").hidden = true; $("#chat").hidden = false; renderView(); }
  function home() {
    $("#chat").hidden = true; $("#record").hidden = true; $("#home").hidden = false;
    REC_VIEW = null; closePicker();
    $("#composer").classList.remove("off");
    document.title = "匿名聊天室｜不用加好友，輸入 4 碼就能聊";
    history.replaceState(null, "", location.pathname + (EMU && params.get("as") ? "?as=" + params.get("as") : ""));
    showResume();
  }
  async function showResume() {
    const code = store.get(ROOM_KEY), box = $("#resume");
    box.hidden = true;
    if (!code || !FB?.databaseURL) return;
    try {
      await connect();
      const meta = (await fb.get(roomRef(code, "meta"))).val();
      if (!meta || meta.last < now() - DAY) { store.set(ROOM_KEY, null); return; }
      $(".code", box).textContent = code;
      $(".sub", box).textContent = meta.title ? "「" + meta.title + "」" : "";
      box.hidden = false;
    } catch (e) {}
  }

  /* ---------- wiring ---------- */
  showMe();
  if (!FB?.databaseURL) { $("#setupNote").hidden = false; document.body.classList.add("nodb"); }
  $("#meBtn").addEventListener("click", () => askMe(false));
  $("#createBtn").addEventListener("click", create);
  $("#joinForm").addEventListener("submit", (e) => { e.preventDefault(); join($("#joinCode").value); });
  $("#joinCode").addEventListener("input", (e) => { const v = e.target.value; if (!/[/?]/.test(v)) e.target.value = v.toUpperCase(); });
  $("#resume").addEventListener("click", (e) => { if (e.target.closest("[data-a=resume]")) join(store.get(ROOM_KEY)); });
  $("#codeBtn").addEventListener("click", share);
  showRecords();
  $("#records").addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (b) openRecord(null, b.dataset.open);
    if (e.target.closest("[data-a=import]")) $("#importFile").click();
  });
  $("#importFile").addEventListener("change", (e) => { importFile(e.target.files[0]); e.target.value = ""; });
  $("#record").addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a, t = e.target.closest("[data-tab]");
    if (a === "home") home();
    if (a === "menu") recordMenu();
    if (t) { REC_VIEW.tab = +t.dataset.tab; renderRecord(); }
  });
  if (!KLIPY) $("#composer [data-a=gif]").hidden = true;
  $("#composer").addEventListener("click", (e) => { const b = e.target.closest(".tool"); if (b) openPicker(b.dataset.a); });
  $("#peopleBtn").addEventListener("click", people);
  $("#chat").addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "home") { if (R?.view !== "all") { R.view = "all"; renderView(); } else home(); }
    if (a === "menu") menu();
    if (a === "all") { R.view = "all"; renderView(); }
  });
  const ta = $("#text");
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
  ta.addEventListener("input", grow);
  // Enter sends on a keyboard; on phones Enter is a new line and the button sends. Never while an IME is composing.
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && matchMedia("(pointer: fine)").matches) { e.preventDefault(); $("#composer").requestSubmit(); }
  });
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await send(ta.value)) { ta.value = ""; grow(); if (pickerOpen === "emoji") closePicker(); }
    ta.focus();
  });

  const start = params.get("room");
  if (start && FB?.databaseURL) join(start); else home();
})();
