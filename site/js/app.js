/* Anonymous chat rooms. Someone opens a room and gets a 4-character code; others join with the code or link.
   Nobody signs up: each device picks a nickname and an animal, and gets an anonymous Firebase id behind the scenes.
   A room is public (the code is enough) or private (the code plus a password). The owner can lock the room,
   remove people, delete messages and end the room, which deletes everything. A room nobody has written in
   for 24 hours is deleted too (see tools/cleanup). Anyone can export what they can see before it goes.
   A room can also be end-to-end encrypted: its key travels only in the invite link (after the #), so the server
   stores the title, nicknames and messages as ciphertext. Private messages are always end-to-end encrypted.
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
  const ME_KEY = "chat-me", ROOMS_KEY = "chat-rooms";
  // interface text in the chosen language (js/i18n.js)
  const t = I18N.t, APP = "Stoa Talk";
  // each animal with its name in the current language, which is also the default nickname
  // the same, with elements in the slots: a list to append
  const tEl = (key, nodes) => t(key).split(/(\{\w+\})/).map((part) => nodes[part.slice(1, -1)] ?? part).filter((x) => x !== "");
  const AVATARS = () => ["🐻", "🦊", "🐼", "🐯", "🦁", "🐸", "🐵", "🐧", "🦉", "🐙", "🦄", "🐶", "🐱", "🐰", "🐨", "🐲"].map((a, i) => [a, t("av" + i)]);
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
        buttons.length ? el("div", { class: "actions" + (buttons.length > 3 ? " many" : "") }, buttons.map(([a, label, cls]) => el("button", { class: "btn " + (cls || ""), type: "button", "data-a": a, text: label }))) : null);
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
  const confirmSheet = (title, text, ok, cls = "danger") => sheet(title, el("p", { class: "muted", text }), [["no", t("cancel")], ["yes", ok, cls]]).then((a) => a === "yes");
  const fmtTime = (t) => new Date(t).toLocaleTimeString(I18N.lang, { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtFull = (t) => new Date(t).toLocaleString(I18N.lang, { hour12: false });
  const roomUrl = (code) => location.origin + location.pathname + "?room=" + code + (R?.c && store.get(ROOMKEY(code)) ? "#k=" + store.get(ROOMKEY(code)) : "");
  const now = () => Date.now() + offset; // server time
  const isOwner = () => !!R?.meta && R.meta.owner === uid;
  const pairKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const who = (id) => R?.members?.[id] || R?.seen?.[id] || null; // R.seen keeps people who have left
  const nameOf = (id) => { const m = who(id); return m ? `${m.avatar} ${m.name}` : t("someoneLeft"); };
  // GIFs come from the KLIPY search and only from KLIPY's servers (database.rules.json checks the same)
  const GIF_HOST = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//;
  function gifImg(g) {
    if (!g || !GIF_HOST.test(g.url || "")) return el("span", { class: "muted", text: t("gifGone") });
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

  /* ---------- end-to-end encryption (Web Crypto) ----------
     Encrypted room: a random 256-bit key K, shared only through the link (#k=...), and kept on each device under
     chat-key:{code}. From K come an AES-GCM key for content and an HMAC key for nickname claims and the key check.
     Private messages: each device has an ECDH P-256 key pair (chat-dh); its public key sits on the member record,
     and two people derive the same AES-GCM key. Every sealed value is bound to who it belongs to (AES-GCM
     additional data), so the server can't move a message or a nickname onto someone else. */
  const SUB = crypto.subtle, TE = new TextEncoder(), TD = new TextDecoder();
  const b64u = (buf) => { let s = ""; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const KEY_RE = /#k=([A-Za-z0-9_-]{43})/;
  const ROOMKEY = (code) => "chat-key:" + code;
  const hkdf = async (bits, info, alg, use) => SUB.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: TE.encode(info) },
    await SUB.importKey("raw", bits, "HKDF", false, ["deriveKey"]), alg, false, use);
  async function roomCrypto(raw) {
    return {
      aes: await hkdf(raw, "anon-chat room aes", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
      mac: await hkdf(raw, "anon-chat room mac", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
    };
  }
  const mac = async (c, s) => hex(await SUB.sign("HMAC", c.mac, TE.encode(s))).slice(0, 24);
  const keyCheck = async (c) => (await mac(c, "key-check")).slice(0, 16);
  async function sealBytes(key, bytes, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await SUB.encrypt({ name: "AES-GCM", iv, additionalData: TE.encode(aad) }, key, bytes));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64u(out);
  }
  async function unsealBytes(key, s, aad) {
    try { const b = unb64u(s); return new Uint8Array(await SUB.decrypt({ name: "AES-GCM", iv: b.slice(0, 12), additionalData: TE.encode(aad) }, key, b.slice(12))); }
    catch (e) { return null; }
  }
  const seal = (key, obj, aad) => sealBytes(key, TE.encode(JSON.stringify(obj)), aad);
  async function unseal(key, s, aad) {
    const b = await unsealBytes(key, s, aad);
    try { return b && JSON.parse(TD.decode(b)); } catch (e) { return null; }
  }
  // this device's key pair for private messages
  let DH = null;
  async function myDh() {
    if (DH) return DH;
    const EC = { name: "ECDH", namedCurve: "P-256" };
    try {
      const s = JSON.parse(store.get("chat-dh"));
      if (s?.priv && s?.pub) return (DH = { priv: await SUB.importKey("jwk", s.priv, EC, false, ["deriveBits"]), pub: s.pub });
    } catch (e) {}
    const kp = await SUB.generateKey(EC, true, ["deriveBits"]);
    const pub = b64u(await SUB.exportKey("raw", kp.publicKey));
    store.set("chat-dh", JSON.stringify({ priv: await SUB.exportKey("jwk", kp.privateKey), pub }));
    return (DH = { priv: kp.privateKey, pub });
  }
  // the key two people share for their private messages in this room (null if the other has no public key yet)
  function dmKey(other) {
    const pk = (R.raw[other] || R.rawSeen[other])?.pk;
    if (!pk) return Promise.resolve(null);
    const id = other + ":" + pk, code = R.code;
    if (!R.dk.has(id)) R.dk.set(id, (async () => {
      const theirs = await SUB.importKey("raw", unb64u(pk), { name: "ECDH", namedCurve: "P-256" }, false, []);
      const bits = await SUB.deriveBits({ name: "ECDH", public: theirs }, (await myDh()).priv, 256);
      return hkdf(bits, `anon-chat dm ${code} ${pairKey(uid, other)}`, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
    })().catch(() => null));
    return R.dk.get(id);
  }
  // the room's key if this device has the right one, asking for the invite link when it doesn't; false if they give up
  async function unlock(code, meta) {
    if (!meta.enc) return null;
    let note = "";
    for (;;) {
      const raw = store.get(ROOMKEY(code));
      if (raw) {
        try { const c = await roomCrypto(unb64u(raw)); if ((await keyCheck(c)) === meta.kc) return c; } catch (e) {}
        store.set(ROOMKEY(code), null);
        note = t("badLink");
      }
      busy(false); backdrop();
      const k = await askLink(code, note);
      busy(true);
      if (!k) return false;
      store.set(ROOMKEY(code), k);
    }
  }
  function askLink(code, note) {
    const input = el("input", { class: "field", id: "joinLink", autocomplete: "off", placeholder: t("linkPh"), "aria-label": t("linkAria") });
    const body = el("div", {}, el("p", { class: "note warn", hidden: !note, text: note }),
      el("p", { class: "muted", text: t("needLink", { code }) }), input);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) body.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
    return sheet(t("needLinkTitle"), body, [["no", t("cancel")], ["yes", t("join"), "primary"]], { onOpen: () => input.focus() })
      .then((a) => (a === "yes" ? input.value.match(KEY_RE)?.[1] || (/^[A-Za-z0-9_-]{43}$/.test(input.value.trim()) ? input.value.trim() : "") : null))
      .then((k) => (k === "" ? askLink(code, t("notFullLink")) : k));
  }
  // a member record as stored: plain, or sealed in an encrypted room (c)
  async function memberRec(c, id, m, extra) {
    return c ? { x: await seal(c.aes, { n: m.name, a: m.avatar }, "u:" + id), h: await nkey(c, m.name), ...extra } : { name: m.name, avatar: m.avatar, ...extra };
  }
  async function openMember(id, m) {
    if (!m?.x || !R.c) return m;
    const p = (await unseal(R.c.aes, m.x, "u:" + id)) || {};
    return { ...m, name: String(p.n || "？").slice(0, 24), avatar: String(p.a || "👤").slice(0, 8) };
  }
  // photos, polls and draws as stored, or as unsealed (so checked the same way)
  const listOf = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
  const strOf = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
  const cleanImg = (i) => (i && typeof i.f === "string" && /^[\w-]{1,32}$/.test(i.f) ? { f: i.f, w: Math.min(+i.w || 300, 4000), h: Math.min(+i.h || 300, 4000) } : null);
  const cleanPoll = (p) => { const o = listOf(p?.o).slice(0, 10).map((x) => strOf(x, 80)); return p && o.length >= 2 ? { q: strOf(p.q, 200), o, m: p.m === true } : null; };
  const cleanDraw = (d) => (d ? { t: strOf(d.t, 60), p: listOf(d.p).slice(0, 200).map((x) => strOf(x, 128)), w: listOf(d.w).slice(0, 200).map((x) => strOf(x, 128)) } : null);
  // a message as shown: decrypted (or marked unreadable), everything else as stored
  async function openMsg(v, dmWith, id) {
    if (!v) return v;
    if (!v.x) {
      const out = { ...v };
      if (v.img) out.img = cleanImg(v.img);
      if (v.poll) out.poll = cleanPoll(v.poll);
      if (v.draw) out.draw = cleanDraw(v.draw);
      if (out.poll && v.votes) out.votes = await openVotes(v.votes, id, out.poll);
      return out;
    }
    let p = R.plain.get(v.x);
    if (p === undefined) {
      const key = dmWith ? await dmKey(dmWith) : R.c?.aes;
      p = key ? await unseal(key, v.x, (dmWith ? "d:" : "m:") + v.by) : null;
      if (p) R.plain.set(v.x, p);
    }
    const out = { ...v }; delete out.x;
    if (!p) return { ...out, text: t(dmWith ? "cantDecryptDm" : "cantDecrypt"), bad: true };
    if (p.g && typeof p.g.url === "string") out.gif = { url: p.g.url.slice(0, 500), w: Math.min(+p.g.w || 200, 2000), h: Math.min(+p.g.h || 200, 2000), title: String(p.g.title || "").slice(0, 120) };
    else if (p.i && !dmWith) out.img = cleanImg(p.i);
    else if (p.p && !dmWith) out.poll = cleanPoll(p.p);
    else if (p.d && !dmWith) out.draw = cleanDraw(p.d);
    else out.text = String(p.t || "").slice(0, 1000);
    if (out.poll && v.votes) out.votes = await openVotes(v.votes, id, out.poll);
    if (!dmWith) { out.name = String(p.n || "？").slice(0, 24); out.avatar = String(p.a || "👤").slice(0, 8); }
    if (typeof p.r === "string" && /^[\w-]{1,32}$/.test(p.r)) out.rp = p.r;
    return out;
  }
  // everyone's votes on a poll, { uid: [option, ...] }; each is "0" or "0,2", sealed in an encrypted room
  async function openVotes(raw, id, poll) {
    const out = {};
    for (const [who, s] of Object.entries(raw || {})) {
      let picks = typeof s === "string" ? s : "";
      if (R.c && picks) {
        let o = R.plain.get(picks);
        if (o === undefined) { o = await unseal(R.c.aes, picks, `v:${id}:${who}`); if (o != null) R.plain.set(picks, o); }
        picks = typeof o === "string" ? o : "";
      }
      const list = [...new Set(picks ? picks.split(",").map(Number) : [])].filter((k) => Number.isInteger(k) && k >= 0 && k < poll.o.length);
      if (list.length) out[who] = poll.m ? list : list.slice(0, 1);
    }
    return out;
  }

  /* ---------- identity: nickname + animal, kept on this device ---------- */
  const me = () => { try { const m = JSON.parse(store.get(ME_KEY)); if (m && m.name) return m; } catch (e) {} return null; };
  // nicknames are unique per room, compared without case; Firebase keys can't hold . # $ [ ] /
  const cleanName = (n) => String(n || "").replace(/[.#$[\]/]/g, "").replace(/\s+/g, " ").trim().slice(0, 12);
  const nameKey = (n) => n.toLowerCase();
  // the key a nickname is claimed under: the name itself, or in an encrypted room a keyed hash of it
  const nkey = async (c, name) => (c ? mac(c, "name:" + nameKey(name)) : nameKey(name));
  // the uid holding a claim in a room, or null
  const holderOf = (code, k) => fb.get(roomRef(code, "names/" + k)).then((s) => s.val(), () => null);
  const myKeyIn = (id) => (R.c ? R.raw[id]?.h : R.members[id] && nameKey(R.members[id].name)); // the claim someone holds now
  // inRoom: also rename in the room we're in (fails, and asks again, if someone there has that name)
  async function askMe(firstTime, note = "", inRoom = !firstTime) {
    const cur = me() || (() => { const all = AVATARS(), [a, n] = all[(Math.random() * all.length) | 0]; return { avatar: a, name: n, auto: true }; })();
    let pick = cur.avatar, auto = !!cur.auto;
    const input = el("input", { class: "field", maxlength: 12, autocomplete: "off", id: "meName", "aria-label": t("nickname") });
    input.value = cur.name;
    input.addEventListener("input", () => (auto = false));
    const grid = el("div", { class: "avatars" }, AVATARS().map(([a, n]) => el("button", {
      class: "avbtn", type: "button", "aria-label": n, "aria-pressed": String(a === pick), text: a,
      onclick: (e) => { pick = a; grid.querySelectorAll(".avbtn").forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget))); if (auto) input.value = n; },
    })));
    const warn = el("p", { class: "note warn", hidden: !note, text: note });
    const body = el("div", {}, warn, el("p", { class: "muted", text: t("meHint") }), grid, el("label", { class: "lbl", for: "meName", text: t("nickname") }), input);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) body.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
    for (;;) {
      const a = await sheet(t(firstTime ? "meFirst" : note ? "meRetry" : "meEdit"), body, [["no", t("cancel")], ["yes", t("ok"), "primary"]], { onOpen: () => (firstTime || note) && input.select() });
      if (a !== "yes") return null;
      const m = { avatar: pick, name: cleanName(input.value) || AVATARS().find((x) => x[0] === pick)[1] };
      if (inRoom && R && !R.gone && R.members[uid]) {
        const oldK = myKeyIn(uid), newK = await nkey(R.c, m.name);
        const rec = await memberRec(R.c, uid, m, {});
        const upd = { [`names/${newK}`]: uid };
        Object.entries(rec).forEach(([k, v]) => (upd[`members/${uid}/${k}`] = v));
        // give the old name back only if it's ours: in a room from before unique names, or with a
        // duplicate left over from then, someone else may hold it, and releasing it would fail the whole rename
        if (oldK && oldK !== newK && (await holderOf(R.code, oldK)) === uid) upd[`names/${oldK}`] = null;
        try { await fb.update(roomRef(R.code), upd); }
        catch (e) {
          const holder = await holderOf(R.code, newK);
          warn.textContent = holder && holder !== uid ? t("nameTaken", { name: m.name }) : t("renameFail");
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
    if (e?.message === "no-config") toast(t("noDb"));
    else toast(t(navigator.onLine ? "netErr" : "offline"));
  }
  let busyN = 0;
  function busy(on) { busyN += on ? 1 : -1; document.body.classList.toggle("busy", busyN > 0); }

  /* ---------- creating and joining ---------- */
  async function create() {
    const m = await ensureMe(); if (!m) return;
    const title = el("input", { class: "field", maxlength: 40, placeholder: t("titlePh"), id: "newTitle" });
    // two kinds: public (the 4-character code is enough) or private, which is always end-to-end encrypted
    let enc = false;
    const seg = el("div", { class: "seg", role: "radiogroup", "aria-label": t("roomType") },
      el("button", { type: "button", role: "radio", "aria-checked": "true", "data-v": "pub", text: t("openStoa") }),
      el("button", { type: "button", role: "radio", "aria-checked": "false", "data-v": "priv", text: t("closedSession") }));
    const pubNote = el("p", { class: "muted small", text: t("pubNote") });
    const encNote = el("div", { class: "encnote", hidden: true },
      el("b", { text: t("e2ee") }),
      el("p", { class: "muted small", text: t("encNote") }));
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      enc = b.dataset.v === "priv";
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      pubNote.hidden = enc; encNote.hidden = !enc;
    });
    const body = el("div", {}, el("label", { class: "lbl", for: "newTitle", text: t("roomName") }), title, el("label", { class: "lbl", text: t("roomType") }), seg, pubNote, encNote);
    if (await sheet(t("newRoom"), body, [["no", t("cancel")], ["yes", t("start"), "primary"]]) !== "yes") return;
    busy(true);
    try {
      await connect();
      const raw = enc ? crypto.getRandomValues(new Uint8Array(32)) : null;
      const c = raw && (await roomCrypto(raw));
      const name = title.value.trim().slice(0, 40);
      for (let i = 0; i < 30; i++) {
        const code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join("");
        const meta = { owner: uid, created: T(), last: T(), priv: false };
        if (c) { meta.enc = true; meta.kc = await keyCheck(c); if (name) meta.xt = await seal(c.aes, { t: name }, "t"); }
        else if (name) meta.title = name;
        try {
          await fb.update(fb.ref(db), {
            [`rooms/${code}`]: { meta, members: { [uid]: await memberRec(c, uid, m, { joined: T(), online: true, pk: (await myDh()).pub }) }, names: { [await nkey(c, m.name)]: uid } },
          });
        } catch (e) { if (/permission/i.test(e.message)) continue; throw e; } // code in use: draw another
        if (raw) store.set(ROOMKEY(code), b64u(raw));
        await enter(code, c);
        share();
        return;
      }
      toast(t("createFail"));
    } catch (e) { failed(e); } finally { busy(false); }
  }

  const cleanCode = (c) => {
    c = String(c || "");
    c = c.match(/[?&]room=([0-9A-Za-z]{4})/)?.[1] || c.replace(/#.*/, ""); // a pasted link works as well as the code
    return c.toUpperCase().replace(/[^0-9A-Z]/g, "");
  };
  async function join(raw) {
    const code = cleanCode(raw);
    if (code.length !== 4) { toast(t("code4")); return; }
    const linkKey = String(raw || "").match(KEY_RE)?.[1];
    if (linkKey) store.set(ROOMKEY(code), linkKey); // a pasted invite link of an encrypted room
    if (R?.code === code && !R.gone) { roomPath(code); showChat(); return; }
    busy(true);
    try {
      await connect();
      const meta = (await fb.get(roomRef(code, "meta"))).val();
      if (!meta || meta.last < now() - DAY) {
        toast(t("notFound"));
        if (meta) fb.update(fb.ref(db), { [`rooms/${code}`]: null, [`secrets/${code}`]: null }).catch(() => {}); // expired: clear it out
        store.set(ROOMKEY(code), null);
        forgetRoom(code); if (!$("#home").hidden) showResume();
        return;
      }
      const c = await unlock(code, meta);
      if (c === false) return;
      // already inside (coming back)?
      const mine = await fb.get(roomRef(code, "members/" + uid)).then((s) => s.val(), () => null);
      if (mine) { await enter(code, c); return; }
      if (await fb.get(roomRef(code, "banned/" + uid)).then((s) => s.val(), () => null)) { toast(t("bannedToast")); return; }
      if (meta.locked) { toast(t("lockedToast")); return; }
      busy(false);
      if (!me()) backdrop();
      let m = await ensureMe();
      busy(true);
      if (!m) return;
      let key = null;
      if (meta.priv) {
        busy(false); backdrop();
        const pw = await askPassword(meta, code);
        busy(true);
        if (pw == null) return;
        key = await hashPw(code, pw);
      }
      for (;;) {
        const k = await nkey(c, m.name);
        const holder = await holderOf(code, k);
        const upd = {
          [`rooms/${code}/members/${uid}`]: await memberRec(c, uid, m, { joined: T(), online: true, pk: (await myDh()).pub }),
          [`rooms/${code}/names/${k}`]: uid,
          [`rooms/${code}/meta/last`]: T(),
        };
        if (key) upd[`rooms/${code}/keys/${uid}`] = key;
        try { await fb.update(fb.ref(db), upd); break; }
        catch (e) {
          if (!/permission/i.test(e.message)) throw e;
          if (holder && holder !== uid) { // someone here already goes by this name
            busy(false); backdrop();
            m = await askMe(false, t("nameTakenJoin", { name: m.name }), false);
            busy(true);
            if (!m) return;
            continue;
          }
          toast(t(meta.priv ? "wrongPw" : "cantJoin")); return;
        }
      }
      await enter(code, c);
    } catch (e) { failed(e); } finally { busy(false); }
  }
  function askPassword(meta, code) {
    const input = el("input", { class: "field", maxlength: 40, type: "password", id: "joinPw", autocomplete: "off", "aria-label": t("pwAria") });
    const body = el("div", {}, el("p", { class: "muted", text: t("pwBody", { title: meta.title || code }) }), input);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) body.closest(".overlay")?.querySelector("[data-a=yes]").click(); });
    return sheet(t("pwTitle"), body, [["no", t("cancel")], ["yes", t("join"), "primary"]], { onOpen: () => input.focus() }).then((a) => (a === "yes" && input.value.trim() ? input.value.trim() : null));
  }

  /* ---------- inside a room ---------- */
  async function enter(code, c) {
    leaveListeners();
    // raw/rawSeen: member records as stored; members/seen: as shown (decrypted). Everything that arrives goes
    // through one queue (q), so decrypting never reorders messages.
    R = { code, c, meta: null, members: {}, seen: {}, raw: {}, rawSeen: {}, msgs: new Map(), dms: new Map(), plain: new Map(), dk: new Map(),
          view: "all", unread: {}, drafts: {}, reply: null, imgs: new Map(), off: [], gone: false, ready: false, q: Promise.resolve(), t0: Date.now() + offset };
    rememberRoom(code);
    roomPath(code);
    $("#list").replaceChildren();
    showChat(); offerNotify();
    const r = R;
    const on = (off) => r.off.push(off);
    const lost = (e) => { if (r === R) checkGone(); else console.warn(e); };
    const queue = (fn) => (r.q = r.q.then(() => (r === R ? fn() : null)).catch((e) => console.error(e)));
    R.queue = queue;

    on(fb.onValue(roomRef(code, "meta"), (s) => queue(async () => {
      if (!s.exists()) return gone("ended");
      const meta = s.val();
      if (R.c) meta.title = meta.xt ? (await unseal(R.c.aes, meta.xt, "t"))?.t || "" : "";
      R.meta = meta; renderHeader(); renderPins();
    }), lost));
    on(fb.onValue(roomRef(code, "members"), (s) => queue(async () => {
      const raw = s.val() || {};
      const next = {};
      for (const [id, m] of Object.entries(raw)) next[id] = await openMember(id, m);
      R.raw = raw; Object.assign(R.rawSeen, JSON.parse(JSON.stringify(raw)));
      const dh = await myDh();
      if (raw[uid] && raw[uid].pk !== dh.pub) fb.set(roomRef(code, `members/${uid}/pk`), dh.pub).catch(() => {}); // members from before encrypted private messages
      if (R.ready) Object.entries(next).forEach(([id, m]) => { if (!R.members[id] && id !== uid) toast(t("joinedToast", { who: `${m.avatar} ${m.name}` })); });
      if (R.ready) Object.entries(R.members).forEach(([id, m]) => { if (!next[id] && id !== uid) toast(t("leftToast", { who: `${m.avatar} ${m.name}` })); });
      R.members = next; R.ready = true;
      Object.assign(R.seen, JSON.parse(JSON.stringify(next)));
      if (!next[uid]) return checkGone();
      Object.keys(next).forEach((id) => id !== uid && watchDm(id));
      renderHeader(); refreshNames();
    }), lost));
    const q = fb.query(roomRef(code, "msgs"), fb.limitToLast(MAX_LOAD));
    on(fb.onChildAdded(q, (s) => queue(async () => { const v = await openMsg(s.val(), null, s.key); R.msgs.set(s.key, v); if (R.view === "all") addMsg(s.key, v); if (pinIds().includes(s.key)) renderPins(); noteNew(v, null); }), lost));
    on(fb.onChildChanged(q, (s) => queue(async () => { const v = await openMsg(s.val(), null, s.key); R.msgs.set(s.key, v); if (R.view === "all") updateMsg(s.key, v); })));
    on(fb.onChildRemoved(q, (s) => queue(() => { R.msgs.delete(s.key); if (R.view === "all") document.getElementById("m-" + s.key)?.remove(); renderPins(); })));

    // online / offline
    const mine = roomRef(code, "members/" + uid + "/online");
    on(fb.onValue(fb.ref(db, ".info/connected"), (s) => {
      if (!s.val() || r !== R || R.gone) return;
      fb.onDisconnect(mine).set(false).catch(() => {});
      fb.set(mine, true).catch(() => {});
    }));
    on(() => fb.onDisconnect(mine).cancel().catch(() => {}));
  }
  // when this device last read each private chat, so a reload doesn't count old messages as new
  const readKey = (other) => `chat-dmread:${R.code}:${other}`;
  const lastRead = (other) => +store.get(readKey(other)) || 0;
  const markRead = (other, at) => { if (typeof at === "number" && at > lastRead(other)) store.set(readKey(other), String(at)); };
  function watchDm(other) {
    if (R.dms.has(other)) return;
    const box = new Map(); R.dms.set(other, box);
    const r = R;
    R.off.push(fb.onChildAdded(fb.ref(db, `rooms/${R.code}/dm/${pairKey(uid, other)}`), (s) => r.queue(async () => {
      const v = await openMsg(s.val(), other); box.set(s.key, v);
      if (R.view === other) { addMsg(s.key, v, true); markRead(other, v.at); }
      else if (v.by !== uid && v.at > lastRead(other)) {
        R.unread[other] = (R.unread[other] || 0) + 1;
        if (Date.now() - v.at < 60000) toast(t("dmToast", { who: nameOf(other) }));
        renderHeader();
      }
      noteNew(v, other);
    }), () => {}));
  }
  function noteNew(v, dmWith) {
    if (v.by === uid || !document.hidden || !R.ready) return;
    hiddenUnread++;
    document.title = `(${hiddenUnread}) ${R.meta?.title || APP}`;
    if (v.at > R.t0 && Date.now() - v.at < 60000) notify(v, dmWith); // not the history that loads on entering
  }

  /* ---------- notifications ----------
     A system notification for each new message while the page is in the background. Each room can be muted on
     this device (chat-mute:{code}). It works while the page is open in a tab or an installed app, even hidden;
     a closed page would need a push server, which this app doesn't have. */
  const CAN_NOTIFY = "Notification" in window;
  const MUTE = (code) => "chat-mute:" + code;
  const notifyOn = (code) => CAN_NOTIFY && Notification.permission === "granted" && !store.get(MUTE(code));
  async function notify(v, dmWith) {
    if (!notifyOn(R.code)) return;
    const a = author(v, dmWith);
    const title = dmWith ? t("dmToast", { who: a.name }) : `${a.avatar} ${a.name} | ${R.meta?.title || t("roomN", { code: R.code })}`;
    const opts = { body: dmWith ? t("openToRead") : v.gif ? t("sentGif") : v.text ? v.text.slice(0, 120) : snippet(v), tag: "room-" + R.code, renotify: true, icon: "icons/stoa2-192.png", data: { url: roomUrl(R.code) } };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) return await reg.showNotification(title, opts); // phones only show notifications through the service worker
      const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { console.warn(e); }
  }
  async function setNotify(on) {
    if (!R) return;
    $("#notifyBar").hidden = true;
    store.set("chat-notify-asked", "1");
    if (!on) { store.set(MUTE(R.code), "1"); toast(t("mutedToast")); return; }
    if (!CAN_NOTIFY) { toast(t("noNotify")); return; }
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (p !== "granted") { toast(t("notifyBlocked")); return; }
    store.set(MUTE(R.code), null); toast(t("notifyOnToast"));
  }
  // ask once per device, in a bar rather than a pop-up, and only where notifications could work
  const offerNotify = () => { $("#notifyBar").hidden = !(CAN_NOTIFY && Notification.permission === "default" && !store.get("chat-notify-asked")); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { hiddenUnread = 0; document.title = R?.meta?.title || APP; } });

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
    forgetRoom(R.code); store.set(ROOMKEY(R.code), null);
    if (why === "self") return home();
    const text = t({ ended: "goneEnded", kicked: "goneKicked", left: "goneLeft" }[why]);
    $("#composer").classList.add("off");
    for (;;) {
      const a = await sheet(t("goneTitle"), el("p", { class: "muted", text: text + t("goneKeep") }), [["save", t("saveHere"), "primary"], ["export", t("downloadFile")], ["home", t("backHome")]]);
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
    $("#roomTitle").textContent = meta.title || t("room");
    $("#codeBtn").textContent = (meta.enc ? "🔐 " : "") + (meta.priv ? "🔒 " : "") + R.code + (meta.locked ? " · " + t("lockedTag") : "");
    const list = Object.values(R.members || {});
    $("#peopleBtn .n").textContent = list.filter((m) => m.online !== false).length;
    $("#peopleBtn .dot").hidden = !Object.values(R.unread).some((n) => n > 0);
    $("#composer").classList.toggle("off", R.gone);
    if (R.view !== "all") $("#dmBar .dmwho").replaceChildren(...tEl("dmBar", { name: el("b", { text: nameOf(R.view) }) }));
    if (!document.hidden || !hiddenUnread) document.title = meta.title || APP;
  }
  // who wrote a message, under their current name: messages keep the name they were sent with,
  // which only shows for someone who left before this device saw them
  const author = (v, dm) => { const p = who(v.by); return p ? p : dm ? { name: t("someoneLeft"), avatar: "👤" } : v; };
  function refreshNames() {
    document.querySelectorAll("#list .msg").forEach((node) => {
      const p = who(node.dataset.by); if (!p) return;
      const av = $(".who .av", node), nm = $(".who .nm", node); if (!nm) return;
      av.textContent = p.avatar; nm.textContent = p.name + (R.meta?.owner === node.dataset.by ? " 👑" : "");
    });
  }
  function bubble(id, v, dm) {
    const mine = v.by === uid;
    const owner = R.meta?.owner === v.by;
    const prev = $("#list").lastElementChild;
    const cont = prev && prev.dataset.by === v.by && v.at - Number(prev.dataset.at) < 180000;
    const node = el("div", { class: "msg" + (mine ? " mine" : "") + (cont ? " cont" : ""), id: (dm ? "d-" : "m-") + id, "data-by": v.by, "data-at": v.at, "data-id": id },
      cont ? null : el("div", { class: "who" },
        el("span", { class: "av", text: author(v, dm).avatar }),
        el("span", { class: "nm", text: author(v, dm).name + (owner ? " 👑" : "") }),
        el("time", { text: fmtTime(v.at) })),
      v.rp ? replyQuote(v.rp, dm) : null,
      v.gif ? el("div", { class: "bub gifbub" }, gifImg(v.gif))
        : v.img ? el("div", { class: "bub imgbub" }, photoImg(v))
        : v.poll ? el("div", { class: "bub pollbub" }, pollView(livePoll(v), (k) => vote(id, k)))
        : v.draw ? el("div", { class: "bub drawbub" }, drawView(liveDraw(v)))
        : el("div", { class: "bub" }, linkify(v.text || "")),
      dm ? null : el("div", { class: "re" }));
    if (!dm) fillReacts(node, v);
    // only the bubble itself opens the actions; the name line and the empty space beside it do nothing,
    // nor do a link, a poll's options or a draw's list of who took part
    node.addEventListener("click", (e) => { if (e.target.closest(".bub") && !e.target.closest("a, .opt, details")) msgActions(id, (dm ? null : R.msgs.get(id)) || v, dm); });
    return node;
  }
  // one line naming a message: who, and the start of what they said
  const findMsg = (id, dm) => (dm ? R.dms.get(R.view)?.get(id) : R.msgs.get(id));
  const snippet = (v) => (v.gif ? "GIF" : v.img ? "📷 " + t("photo") : v.poll ? "📊 " + v.poll.q : v.draw ? "🎲 " + (v.draw.t || t("draw"))
    : (v.text || "")).replace(/\s+/g, " ").slice(0, 80);
  function replyQuote(rp, dm) {
    const o = findMsg(rp, dm);
    return el("button", { type: "button", class: "rpq", onclick: () => jumpTo(rp, dm) },
      o ? el("b", { text: author(o, dm).name + t("colon") }) : null, o ? snippet(o) : t("origDeleted"));
  }
  function jumpTo(id, dm) {
    const node = document.getElementById((dm ? "d-" : "m-") + id);
    if (!node) return toast(t("origNotFound"));
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash");
  }
  function startReply(id, v, dm) {
    R.reply = { id, dm };
    const bar = $("#replyBar");
    $(".rtxt", bar).replaceChildren(...tEl("replyingTo", { name: el("b", { text: author(v, dm).name }), text: snippet(v) }));
    bar.hidden = false; $("#text").focus();
  }
  function cancelReply() { if (R) R.reply = null; $("#replyBar").hidden = true; }

  /* ---------- pinned announcements (meta/pins, owner only, at most 3) ---------- */
  const pinIds = () => Object.entries(R?.meta?.pins || {}).sort(([a], [b]) => a - b).map(([, id]) => id);
  let pinsOpen = false;
  function renderPins() {
    const box = $("#pins");
    if (!R) return;
    const ids = pinIds();
    box.hidden = !ids.length || R.view !== "all";
    if (box.hidden) return box.replaceChildren();
    // newest message first; one gone from the room still shows, so the owner can take it down
    const items = ids.map((id) => ({ id, v: R.msgs.get(id) })).sort((a, b) => (b.v?.at || 0) - (a.v?.at || 0));
    const line = (it) => (it.v ? snippet(it.v) : t("pinGone"));
    box.classList.toggle("open", pinsOpen);
    box.replaceChildren(...[
      el("button", { type: "button", class: "pinhead", "aria-expanded": String(pinsOpen), onclick: () => { pinsOpen = !pinsOpen; renderPins(); } },
        el("span", { text: "📌" }), el("span", { class: "one", text: pinsOpen ? t("pinsTitle") : line(items[0]) }),
        el("span", { class: "n", text: ids.length > 1 || pinsOpen ? t("pinsN", { n: ids.length }) : "" }), el("span", { class: "chev", text: "▾" })),
      pinsOpen ? el("ul", {}, items.map((it) => el("li", {},
        el("button", { type: "button", class: "go", onclick: () => it.v && jumpTo(it.id) },
          it.v ? el("small", { text: `${author(it.v).avatar} ${author(it.v).name} · ${fmtTime(it.v.at)}` }) : null,
          it.v?.gif ? gifImg(it.v.gif) : it.v?.img ? photoImg(it.v, true) : line(it)),
        isOwner() ? el("button", { type: "button", class: "btn small unpin", text: t("unpin"), onclick: () => pin(it.id, false) }) : null))) : null].filter(Boolean));
  }
  function pin(id, on) {
    const pins = R.meta?.pins || {};
    const slot = on ? ["0", "1", "2"].find((k) => !pins[k]) : Object.keys(pins).find((k) => pins[k] === id);
    if (slot === undefined) return toast(on ? t("pinMax") : "");
    fb.set(roomRef(R.code, "meta/pins/" + slot), on ? id : null)
      .then(() => toast(t(on ? "pinnedToast" : "unpinnedToast")), () => toast(t("tryAgain")));
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
    if (!node) return;
    fillReacts(node, v);
    if (v.poll) $(".pollbub", node)?.replaceChildren(pollView(livePoll(v), (k) => vote(id, k)));
  }
  function fillReacts(node, v) {
    const box = $(".re", node); if (!box) return;
    box.replaceChildren(...REACTS.map((emo, k) => {
      const who = Object.keys(v.re?.[k] || {});
      if (!who.length) return null;
      return el("button", { type: "button", class: "chip" + (who.includes(uid) ? " on" : ""), title: who.map(nameOf).join(t("listSep")), onclick: () => react(node.dataset.id, k, !who.includes(uid)) }, `${emo} ${who.length}`);
    }).filter(Boolean));
  }
  function renderView() {
    closePicker();
    // each view keeps its own unsent text, so a private message can't slip into the room (or the other way)
    const ta = $("#text");
    if (R.shown !== R.view) {
      if (R.shown !== undefined) R.drafts[R.shown] = ta.value;
      ta.value = R.drafts[R.view] || ""; ta.dispatchEvent(new Event("input"));
      R.shown = R.view; cancelReply();
    }
    renderPins();
    const list = $("#list");
    list.replaceChildren();
    $("#dmBar").hidden = R.view === "all";
    $("#composer [data-a=more]").hidden = R.view !== "all"; // photos, polls and draws are for the room
    $("#chat").classList.toggle("indm", R.view !== "all");
    if (R.view === "all") {
      if (!R.msgs.size) list.append(el("p", { class: "empty", text: t("emptyRoom") }));
      R.msgs.forEach((v, id) => list.append(bubble(id, v)));
      $("#text").placeholder = t("textPh");
    } else {
      const box = R.dms.get(R.view) || new Map();
      if (!box.size) list.append(el("p", { class: "empty", text: t("emptyDm") }));
      box.forEach((v, id) => { list.append(bubble(id, v, true)); markRead(R.view, v.at); });
      R.unread[R.view] = 0;
      $("#text").placeholder = t("dmPh", { name: nameOf(R.view) });
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
  function send(text, gif) {
    text = (text || "").trim().slice(0, 1000);
    if (!text && !gif) return false;
    return post(gif ? { gif } : { text }, gif ? { g: gif } : { t: text });
  }
  // one message to the room or the private chat on view: body as a plain room stores it, sealed as it goes inside x;
  // more: other paths written in the same update (a photo's picture)
  async function post(body, sealed, more = {}) {
    if (!R || R.gone) return false;
    const rp = R.reply && !!R.reply.dm === (R.view !== "all") ? R.reply.id : null;
    if (rp) { sealed.r = rp; if (!R.c) body.rp = rp; }
    const m = R.members[uid] || me(); // the name this room knows me by
    const base = `rooms/${R.code}`;
    const upd = { [`${base}/meta/last`]: T(), ...more };
    if (R.view === "all") {
      const id = fb.push(fb.ref(db, base + "/msgs")).key;
      upd[`${base}/msgs/${id}`] = R.c ? { by: uid, x: await seal(R.c.aes, { ...sealed, n: m.name, a: m.avatar }, "m:" + uid), at: T() }
        : { by: uid, name: m.name, avatar: m.avatar, ...body, at: T() };
    } else {
      if (!R.members[R.view]) { toast(t("peerLeft")); return false; }
      const key = await dmKey(R.view);
      if (!key) { toast(t("peerOld")); return false; }
      const p = `${base}/dm/${pairKey(uid, R.view)}`;
      upd[`${p}/${fb.push(fb.ref(db, p)).key}`] = { by: uid, to: R.view, x: await seal(key, sealed, "d:" + uid), at: T() };
    }
    $("#list .empty")?.remove(); cancelReply();
    fb.update(fb.ref(db), upd).catch((e) => { console.error(e); toast(t("sendFail")); });
    return true;
  }
  const react = (id, k, on) => fb.set(roomRef(R.code, `msgs/${id}/re/${k}/${uid}`), on ? true : null).catch(() => toast(t("tryAgain")));

  async function msgActions(id, v, dm) {
    if (!R || R.gone) return;
    const canDel = !dm && v.by === uid;
    const reacts = dm ? null : el("div", { class: "reactrow" }, REACTS.map((emo, k) => {
      const on = !!v.re?.[k]?.[uid];
      return el("button", { type: "button", class: "chip big" + (on ? " on" : ""), "data-a": "re" + k, text: emo });
    }));
    const btns = v.bad ? [] : [["reply", t("reply")]];
    if (v.text && !v.bad) btns.push(["copy", t("copyText")]);
    if (v.img) btns.push(["view", t("viewPhoto")], ["save", t("savePhoto")]);
    if (v.poll) btns.push(["voters", t("pollWho")]);
    if (v.poll && !v.closed && v.by === uid) btns.push(["close", t("pollClose")]);
    if (!dm && !v.bad && isOwner()) btns.push(pinIds().includes(id) ? ["unpin", t("unpin")] : ["pin", t("pinAsNotice")]);
    if (!dm && v.by !== uid && R.members[v.by]) btns.push(["dm", t("dmTo", { name: author(v).name })]);
    if (canDel) btns.push(["del", t("delMsg"), "danger"]);
    const txt = v.poll || v.draw ? snippet(v) : v.text || "";
    const body = el("div", {}, v.gif ? el("div", { class: "quote gifq" }, gifImg(v.gif)) : v.img ? el("div", { class: "quote gifq" }, photoImg(v, true))
      : el("blockquote", { class: "quote", text: txt.length > 140 ? txt.slice(0, 140) + "…" : txt }), reacts);
    let picked = null;
    const a = await sheet("", body, btns, { onOpen: (ov) => reacts?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { picked = +b.dataset.a.slice(2); ov.close("react"); } }) });
    if (a === "react") return react(id, picked, !v.re?.[picked]?.[uid]);
    if (a === "copy") navigator.clipboard?.writeText(v.text).then(() => toast(t("copied")), () => toast(t("cantCopy")));
    if (a === "dm") openDm(v.by);
    if (a === "reply") startReply(id, v, dm);
    if (a === "pin" || a === "unpin") pin(id, a === "pin");
    if (a === "view") photoUrl(v.img.f, v.by).then((u) => (u ? viewPhoto(u) : toast(t("photoGone"))));
    if (a === "save") photoUrl(v.img.f, v.by).then((u) => (u ? saveFile(u, `photo-${R.code}-${id}.jpg`) : toast(t("photoGone"))));
    if (a === "voters") pollVoters(v);
    if (a === "close" && (await confirmSheet(t("pollClose"), t("pollCloseBody"), t("pollClose"), "primary"))) fb.set(roomRef(R.code, `msgs/${id}/closed`), true).catch(() => toast(t("tryAgain")));
    // a photo's picture goes with its message
    if (a === "del" && (await confirmSheet(t("delMsgTitle"), t("delMsgBody"), t("del"))))
      fb.update(roomRef(R.code), { ["msgs/" + id]: null, ...(v.img ? { ["files/" + v.img.f]: null } : {}) }).catch(() => toast(t("delFail")));
  }

  /* ---------- photos ----------
     A photo is shrunk on the device before it's sent: at most 1280px on its long side, as a JPEG of at most about
     300 KB. Phone photos are often 3-10 MB; sent as they are they'd be slow on mobile data and fill the database
     (and its monthly download allowance) fast. Redrawing the picture also drops its EXIF data: where it was taken,
     when, and on what phone. The picture is stored apart from the message (files/{id}), so the message list stays
     small, and each one is fetched only when it scrolls into view. In an encrypted room it's sealed with the room key. */
  const PHOTO_EDGE = 1280, PHOTO_MAX = 300000, PHOTO_LIMIT = 330000, PHOTOS_AT_ONCE = 6;
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
      const W = img.naturalWidth, H = img.naturalHeight;
      if (!W || !H) throw new Error("no-size");
      let edge = PHOTO_EDGE, q = 0.8;
      for (let n = 0; ; n++) {
        const s = Math.min(1, edge / Math.max(W, H)), w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
        const cv = el("canvas", { width: w, height: h }), cx = cv.getContext("2d");
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); // a transparent PNG gets a white background, not a black one
        cx.drawImage(img, 0, 0, w, h);
        const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", q));
        if (!blob) throw new Error("encode");
        if (blob.size <= PHOTO_MAX || n >= 6) return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
        if (q > 0.65) q -= 0.1; else edge = Math.round(edge * 0.8); // lower the quality a little first, then the size
      }
    } finally { URL.revokeObjectURL(url); }
  }
  async function sendPhotos(files) {
    if (!R || R.gone || R.view !== "all") return;
    const list = [...files].filter((f) => !f.type || f.type.startsWith("image/"));
    if (!list.length) return;
    if (list.length > PHOTOS_AT_ONCE) toast(t("photoMax", { n: PHOTOS_AT_ONCE }));
    busy(true);
    try {
      for (const file of list.slice(0, PHOTOS_AT_ONCE)) {
        let p;
        try { p = await shrink(file); } catch (e) { console.warn(e); toast(t("photoFail")); continue; }
        if (p.bytes.length > PHOTO_LIMIT || !R || R.gone) { toast(t("photoFail")); continue; }
        const f = fb.push(roomRef(R.code, "files")).key;
        const d = R.c ? await sealBytes(R.c.aes, p.bytes, `f:${uid}:${f}`) : b64u(p.bytes);
        R.imgs.set(f, Promise.resolve(URL.createObjectURL(new Blob([p.bytes], { type: "image/jpeg" })))); // no need to fetch my own
        const img = { f, w: p.w, h: p.h };
        await post({ img }, { i: img }, { [`rooms/${R.code}/files/${f}`]: { by: uid, d, at: T() } });
      }
    } finally { busy(false); }
  }
  // a photo's picture as a blob: URL, fetched once per visit (null if it's gone or can't be read)
  function photoUrl(f, by) {
    const r = R;
    if (!r.imgs.has(f)) r.imgs.set(f, fb.get(roomRef(r.code, "files/" + f)).then(async (s) => {
      const v = s.val();
      if (!v || v.by !== by || typeof v.d !== "string") return null;
      let bytes = null;
      if (r.c) bytes = await unsealBytes(r.c.aes, v.d, `f:${by}:${f}`);
      else try { bytes = unb64u(v.d); } catch (e) {}
      return bytes ? URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) : null;
    }).catch(() => null).then((u) => { if (!u) r.imgs.delete(f); return u; }));
    return r.imgs.get(f);
  }
  // fetch a photo when its message comes near the screen, not all of them on entering the room
  let photoWatch = null;
  function photoImg(v, now) {
    const { f, w, h } = v.img;
    const img = el("img", { class: "photo", width: w, height: h, alt: t("photo"), decoding: "async" });
    img.fetchPhoto = () => photoUrl(f, v.by).then((u) => { if (u) img.src = u; else img.replaceWith(el("span", { class: "muted", text: t("photoGone") })); });
    if (now || !("IntersectionObserver" in window)) img.fetchPhoto();
    else {
      photoWatch ||= new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { photoWatch.unobserve(e.target); e.target.fetchPhoto(); } }), { root: $("#list"), rootMargin: "600px 0px" });
      photoWatch.observe(img);
    }
    return img;
  }
  function viewPhoto(src) {
    const close = () => { ov.remove(); document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    const ov = el("div", { class: "lightbox", role: "dialog", "aria-label": t("photo"), onclick: close },
      el("img", { src, alt: t("photo") }), el("button", { type: "button", class: "icon", "aria-label": t("close"), text: "✕" }));
    document.addEventListener("keydown", esc);
    document.body.append(ov);
  }
  function saveFile(href, name) {
    const link = el("a", { href, download: name });
    document.body.append(link); link.click(); link.remove();
  }

  /* ---------- polls ----------
     Anyone starts one: a question and 2 to 10 options, one vote per person or several. Tapping an option votes,
     tapping it again takes the vote back; votes can change until the poll's author closes it. Who voted for what
     is visible to the room, like reactions. */
  // a poll as shown, the same shape a saved record keeps: { q, m, closed, total, o: [{ t, n, on, names }] }
  function livePoll(v) {
    const votes = v.votes || {}, ids = Object.keys(votes);
    return { q: v.poll.q, m: v.poll.m, closed: !!v.closed, total: ids.length, o: v.poll.o.map((label, k) => {
      const who = ids.filter((w) => votes[w].includes(k));
      return { t: label, n: who.length, on: who.includes(uid), names: who.map(nameOf) };
    }) };
  }
  // onVote: null for a saved record, which only shows the result
  function pollView(p, onVote) {
    return el("div", { class: "pollbox" + (p.closed ? " closed" : "") },
      el("div", { class: "ph" }, el("span", { text: "📊 " + t("poll") }), el("small", { text: [t(p.m ? "pollMultiTag" : "pollSingleTag"), p.closed ? t("pollClosed") : null].filter(Boolean).join(" · ") })),
      el("b", { class: "pq", text: p.q }),
      p.o.map((o, k) => el("button", {
        type: "button", class: "opt" + (o.on ? " on" : ""), "aria-pressed": String(!!o.on), disabled: !onVote || p.closed || R?.gone,
        title: o.names?.join(t("listSep")) || null, onclick: () => onVote?.(k),
      }, el("span", { class: "bar", style: `width:${p.total ? Math.round((o.n * 100) / p.total) : 0}%` }),
        el("span", { class: "ol", text: (o.on ? "✓ " : "") + o.t }), el("span", { class: "oc", text: o.n }))),
      el("small", { class: "pf", text: t("pollVotes", { n: p.total }) }));
  }
  async function vote(id, k) {
    const v = R?.msgs.get(id);
    if (!v?.poll || v.closed || R.gone) return;
    const mine = v.votes?.[uid] || [];
    const next = v.poll.m ? (mine.includes(k) ? mine.filter((x) => x !== k) : [...mine, k].sort((a, b) => a - b)) : mine.includes(k) ? [] : [k];
    const s = next.join(",");
    const val = !s ? null : R.c ? await seal(R.c.aes, s, `v:${id}:${uid}`) : s;
    fb.set(roomRef(R.code, `msgs/${id}/votes/${uid}`), val).catch(() => toast(t("tryAgain")));
  }
  function pollVoters(v) {
    const p = livePoll(v);
    sheet(p.q, el("div", { class: "voters" }, p.o.map((o) => el("div", {},
      el("b", { text: `${o.t} · ${o.n}` }), el("p", { class: "muted small", text: o.names.join(t("listSep")) || "—" })))), [["close", t("close")]]);
  }
  // the radio-button pair used by the poll and draw sheets
  function choice(opts, value, onPick) {
    const seg = el("div", { class: "seg row", role: "radiogroup" }, opts.map(([v, label]) => el("button", { type: "button", role: "radio", "aria-checked": String(v === value), "data-v": v, text: label })));
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); onPick(b.dataset.v);
    });
    return seg;
  }
  async function newPoll() {
    if (!R || R.gone) return;
    const q = el("input", { class: "field", maxlength: 200, id: "pollQ", placeholder: t("pollQPh"), autocomplete: "off" });
    const opts = el("div", { class: "pollopts" });
    const addBtn = el("button", { type: "button", class: "btn small", text: t("pollAdd"), onclick: () => { addOpt(); opts.lastElementChild.focus(); } });
    const addOpt = () => {
      if (opts.children.length < 10) opts.append(el("input", { class: "field", maxlength: 80, autocomplete: "off", placeholder: t("pollOpt", { n: opts.children.length + 1 }), "aria-label": t("pollOpt", { n: opts.children.length + 1 }) }));
      addBtn.hidden = opts.children.length >= 10;
    };
    addOpt(); addOpt();
    let multi = false;
    const warn = el("p", { class: "note warn", hidden: true });
    const body = el("div", {}, warn, el("label", { class: "lbl", for: "pollQ", text: t("pollQ") }), q,
      el("label", { class: "lbl", text: t("pollOpts") }), opts, addBtn,
      el("label", { class: "lbl", text: t("pollHow") }), choice([["1", t("pollSingle")], ["n", t("pollMulti")]], "1", (v) => (multi = v === "n")));
    for (;;) {
      const a = await sheet(t("pollNew"), body, [["no", t("cancel")], ["yes", t("pollStart"), "primary"]], { onOpen: () => q.focus() });
      if (a !== "yes" || !R || R.gone) return;
      const question = q.value.trim().slice(0, 200);
      const o = [...opts.querySelectorAll("input")].map((x) => x.value.trim().slice(0, 80)).filter(Boolean);
      if (!question || o.length < 2) { warn.textContent = t("pollNeed"); warn.hidden = false; continue; }
      const poll = { q: question, o, m: multi };
      return post({ poll }, { p: poll });
    }
  }

  /* ---------- draws ----------
     Pick who takes part (everyone here, to start with) and how many to draw. The drawing happens on this device,
     with the browser's cryptographic random numbers, and the result goes to the room as a message. */
  const randBelow = (n) => { const a = new Uint32Array(1), lim = Math.floor(2 ** 32 / n) * n; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n; };
  const drawOf = (list, k) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = randBelow(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  // a draw as shown, the same shape a saved record keeps: { t, p: [names], w: [names] }; a new one is revealed slowly
  const liveDraw = (v) => ({ t: v.draw.t, p: v.draw.p.map(nameOf), w: v.draw.w.map(nameOf), fresh: v.at > R.t0 && now() - v.at < 15000 });
  function drawView(d) {
    return el("div", { class: "drawbox" + (d.fresh ? " fresh" : "") },
      el("div", { class: "ph" }, el("span", { text: "🎲 " + t("draw") })),
      d.t ? el("b", { class: "pq", text: d.t }) : null,
      el("small", { class: "pf", text: t("drawFrom", { n: d.p.length, k: d.w.length }) }),
      el("div", { class: "winners" }, d.w.map((n, i) => el("span", { class: "win", style: `--i:${i}`, text: "🏆 " + n }))),
      el("details", {}, el("summary", { text: t("drawWhoIn") }), el("p", { class: "small", text: d.p.join(t("listSep")) })));
  }
  async function newDraw() {
    if (!R || R.gone) return;
    const ids = Object.keys(R.members).sort((a, b) => (R.members[a].joined || 0) - (R.members[b].joined || 0));
    const what = el("input", { class: "field", maxlength: 60, id: "drawWhat", placeholder: t("drawWhatPh"), autocomplete: "off" });
    const boxes = el("div", { class: "picklist" }, ids.map((id) => el("label", { class: "pick" },
      el("input", { type: "checkbox", value: id, checked: true }),
      el("span", { class: "av", text: R.members[id].avatar }),
      el("span", { class: "nm", text: R.members[id].name + (id === uid ? t("meTag") : "") }))));
    const count = el("input", { class: "field num", type: "number", min: 1, max: ids.length, value: 1, id: "drawN", inputmode: "numeric" });
    const picked = () => [...boxes.querySelectorAll("input:checked")].map((x) => x.value);
    const allBtn = el("button", { type: "button", class: "btn small", text: t("drawNone"), onclick: () => {
      const on = !picked().length; boxes.querySelectorAll("input").forEach((x) => (x.checked = on)); sync();
    } });
    const sync = () => { const n = picked().length; allBtn.textContent = t(n ? "drawNone" : "drawAll"); count.max = Math.max(1, n); };
    boxes.addEventListener("change", sync);
    const warn = el("p", { class: "note warn", hidden: true });
    const body = el("div", {}, warn, el("label", { class: "lbl", for: "drawWhat", text: t("drawWhat") }), what,
      el("div", { class: "lblrow" }, el("label", { class: "lbl", text: t("drawWho") }), allBtn), boxes,
      el("label", { class: "lbl", for: "drawN", text: t("drawCount") }), count);
    for (;;) {
      const a = await sheet(t("drawNew"), body, [["no", t("cancel")], ["yes", t("drawGo"), "primary"]]);
      if (a !== "yes" || !R || R.gone) return;
      const p = picked().filter((id) => R.members[id]), k = Math.floor(+count.value);
      if (!p.length) { warn.textContent = t("drawNeed"); warn.hidden = false; continue; }
      if (!(k >= 1 && k <= p.length)) { warn.textContent = t("drawCountBad", { n: p.length }); warn.hidden = false; continue; }
      const title = what.value.trim().slice(0, 60);
      const draw = { ...(title ? { t: title } : {}), p, w: drawOf(p, k) };
      return post({ draw }, { d: draw });
    }
  }

  function share() {
    if (!R) return;
    const url = roomUrl(R.code);
    const qr = qrcode(0, "M"); qr.addData(url); qr.make();
    const qrBox = el("div", { class: "qr", "aria-label": "QR Code" }); qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const body = el("div", { class: "share" },
      el("div", { class: "bigcode", text: R.code }),
      el("p", { class: "muted", text: t(R.c ? "shareEnc" : "shareOpen") + (R.meta?.priv ? t("sharePw") : "") }),
      el("div", { class: "linkrow" }, el("input", { class: "field", readonly: true, value: url, "aria-label": t("linkAriaShort"), onfocus: (e) => e.target.select() })),
      qrBox);
    const btns = [["copy", t("copyLink"), "primary"]];
    if (navigator.share) btns.unshift(["share", t("shareDots")]);
    sheet(t("inviteTitle"), body, btns).then((a) => {
      if (a === "copy") navigator.clipboard?.writeText(url).then(() => toast(t("linkCopied")), () => toast(t("cantCopyLink")));
      if (a === "share") navigator.share({ title: R.meta?.title || APP, text: t("shareText", { code: R.code }), url }).catch(() => {});
    });
  }

  function people() {
    if (!R) return;
    const ids = Object.keys(R.members).sort((a, b) => (a === R.meta?.owner ? -1 : b === R.meta?.owner ? 1 : (R.members[a].joined || 0) - (R.members[b].joined || 0)));
    const list = el("ul", { class: "plist" }, ids.map((id) => {
      const m = R.members[id];
      const tags = [id === uid ? t("you") : null, id === R.meta?.owner ? t("ownerTag") : null, m.online === false ? t("offlineTag") : null].filter(Boolean).join(" · ");
      return el("li", { class: m.online === false ? "away" : "" },
        el("span", { class: "av", text: m.avatar }),
        el("span", { class: "nm" }, el("b", { text: m.name }), tags ? el("small", { text: tags }) : null),
        id !== uid ? el("button", { type: "button", class: "btn small", "data-dm": id }, t("dm"), R.unread[id] ? el("i", { class: "badge", text: R.unread[id] }) : null) : null,
        id !== uid && isOwner() ? el("button", { type: "button", class: "btn small danger", "data-kick": id, text: t("kick") }) : null);
    }));
    let choice = null;
    sheet(t("membersN", { n: ids.length }), list, [["close", t("close")]], {
      onOpen: (ov) => list.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        choice = b.dataset.dm ? ["dm", b.dataset.dm] : ["kick", b.dataset.kick]; ov.close("pick");
      }),
    }).then(async () => {
      if (!choice) return;
      const [what, id] = choice;
      if (what === "dm") return openDm(id);
      const m = R.members[id];
      if (m && (await confirmSheet(t("kickTitle", { who: `${m.avatar} ${m.name}` }), t("kickBody"), t("kick")))) {
        const k = myKeyIn(id), release = k && (await holderOf(R.code, k)) === id; // don't free a name someone else still uses
        fb.update(roomRef(R.code), { [`members/${id}`]: null, ...(release ? { [`names/${k}`]: null } : {}), [`banned/${id}`]: true }).then(() => toast(t("kickedToast", { name: m.name })), () => toast(t("kickFail")));
      }
    });
  }

  async function menu() {
    if (!R) return;
    const btns = [["share", t("invite")], ["me", t("editMe")],
      notifyOn(R.code) ? ["mute", t("muteRoom")] : ["notify", t("notifyRoom")], ["export", t("exportChat")]];
    if (isOwner()) {
      btns.splice(1, 0, ["title", t("renameRoom")]);
      btns.push(R.meta?.locked ? ["unlock", t("unlockRoom")] : ["lock", t("lockRoom")]);
      btns.push(["end", t("endRoom"), "danger"]);
    } else btns.push(["leave", t("leaveRoom"), "danger"]);
    const a = await sheet(R.meta?.title || t("roomN", { code: R.code }), null, btns);
    if (a === "share") share();
    if (a === "me") askMe(false);
    if (a === "title") renameRoom();
    if (a === "notify" || a === "mute") setNotify(a === "notify");
    if (a === "export") exportSheet();
    if (a === "lock" || a === "unlock") fb.update(roomRef(R.code, "meta"), { locked: a === "lock" }).then(() => toast(t(a === "lock" ? "lockedDone" : "unlockedDone")), () => toast(t("tryAgain")));
    if (a === "leave" && (await confirmSheet(t("leaveTitle"), t("leaveBody") + (R.meta?.priv ? t("leavePw") : ""), t("leave")))) {
      const code = R.code;
      R.gone = true; leaveListeners();
      const k = myKeyIn(uid), release = k && (await holderOf(code, k)) === uid; // same reason as in askMe
      await fb.update(fb.ref(db), { [`rooms/${code}/members/${uid}`]: null, [`rooms/${code}/keys/${uid}`]: null, ...(release ? { [`rooms/${code}/names/${k}`]: null } : {}) }).catch(() => {});
      R = null; forgetRoom(code); store.set(ROOMKEY(code), null); home();
    }
    if (a === "end") endRoom();
  }
  async function renameRoom() {
    const input = el("input", { class: "field", maxlength: 40, placeholder: t("titlePh"), id: "roomName", value: R.meta?.title || "" });
    const body = el("div", {}, el("label", { class: "lbl", for: "roomName", text: t("roomName") }), input,
      el("p", { class: "muted small", text: t(R.c ? "renameEnc" : "renameOpen") }));
    const a = await sheet(t("renameRoom"), body, [["no", t("cancel")], ["yes", t("save"), "primary"]], { onOpen: () => input.select() });
    if (a !== "yes" || !R) return;
    const title = input.value.trim().slice(0, 40);
    if (title === (R.meta?.title || "")) return;
    try {
      // an encrypted room keeps only the sealed title (xt); a plain one only the readable one
      await fb.update(roomRef(R.code, "meta"), R.c ? { xt: title ? await seal(R.c.aes, { t: title }, "t") : null } : { title: title || null });
      toast(title ? t("renamedToast", { t: title }) : t("titleCleared"));
    } catch (e) { failed(e); }
  }
  async function endRoom() {
    const a = await sheet(t("endTitle"), el("p", { class: "muted", text: t("endBody") }), [["no", t("cancel")], ["export", t("exportFirst")], ["yes", t("endDel"), "danger"]]);
    if (a === "export") { await exportSheet(); return endRoom(); }
    if (a !== "yes") return;
    const code = R.code;
    R.gone = true; leaveListeners();
    try { await fb.update(fb.ref(db), { [`rooms/${code}`]: null, [`secrets/${code}`]: null }); toast(t("endedToast")); }
    catch (e) { failed(e); }
    R = null; forgetRoom(code); store.set(ROOMKEY(code), null); home();
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
    const pics = []; // photos, for the .html file to carry; not kept in the archive itself
    const one = (v, author) => {
      const m = { name: author.name, avatar: author.avatar, at: v.at, text: v.text || undefined, gif: v.gif || undefined, mine: v.by === uid || undefined };
      if (v.img) { m.photo = { w: v.img.w, h: v.img.h }; pics.push([m, v]); }
      if (v.poll) { const { q, m: multi, closed, total, o } = livePoll(v); m.poll = { q, m: multi, closed: closed || undefined, total, o: o.map(({ t: x, n }) => ({ t: x, n })) }; }
      if (v.draw) { const { t: x, p, w } = liveDraw(v); m.draw = { t: x || undefined, p, w }; }
      return m;
    };
    const a = {
      format: ARCHIVE, version: 1,
      title: meta.title || t("roomN", { code: R.code }), code: R.code, created: meta.created, exported: Date.now(),
      me: { name: self.name, avatar: self.avatar },
      messages: [...R.msgs.values()].map((v) => Object.assign(one(v, author(v)), { owner: v.by === meta.owner || undefined, reactions: reacts(v) })),
      dms: [...R.dms.entries()].filter(([, box]) => box.size).map(([other, box]) => {
        const them = who(other) || { name: t("someoneLeft"), avatar: "👤" };
        return { with: { name: them.name, avatar: them.avatar }, messages: [...box.values()].map((v) => one(v, v.by === uid ? self : them)) };
      }),
    };
    Object.defineProperty(a, "pics", { value: pics });
    return a;
  }
  // an imported file is untrusted: keep only the fields we know, with the same limits as the database
  function readArchive(o) {
    if (!o || o.format !== ARCHIVE || o.version !== 1 || !Array.isArray(o.messages)) throw new Error("not-archive");
    const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
    const num = (x) => (Number.isFinite(+x) ? +x : 0);
    const gif = (g) => (g && typeof g.url === "string" && GIF_HOST.test(g.url) ? { url: g.url.slice(0, 500), w: num(g.w) || 200, h: num(g.h) || 200, title: str(g.title, 120) } : undefined);
    const arr = (x) => (Array.isArray(x) ? x : []);
    const photo = (p) => (p && typeof p === "object" ? { w: Math.min(num(p.w), 4000) || 300, h: Math.min(num(p.h), 4000) || 300 } : undefined);
    const poll = (p) => {
      const o = arr(p?.o).slice(0, 10).map((x) => ({ t: str(x?.t, 80), n: Math.min(Math.max(num(x?.n), 0), 9999) }));
      return p && typeof p === "object" && o.length >= 2 ? { q: str(p.q, 200), m: p.m === true, closed: p.closed === true || undefined, total: Math.min(Math.max(num(p.total), 0), 9999), o } : undefined;
    };
    const draw = (d) => (d && typeof d === "object" ? { t: str(d.t, 60) || undefined, p: arr(d.p).slice(0, 200).map((x) => str(x, 40)), w: arr(d.w).slice(0, 200).map((x) => str(x, 40)) } : undefined);
    const msg = (m) => {
      const out = { name: str(m?.name, 24) || "？", avatar: str(m?.avatar, 8), at: num(m?.at), text: str(m?.text, 1000) || undefined, gif: gif(m?.gif), mine: m?.mine === true || undefined, owner: m?.owner === true || undefined,
        photo: photo(m?.photo), poll: poll(m?.poll), draw: draw(m?.draw) };
      if (m?.reactions && typeof m.reactions === "object") {
        const r = {}; REACTS.forEach((e) => { const n = num(m.reactions[e]); if (n > 0) r[e] = Math.min(n, 9999); });
        if (Object.keys(r).length) out.reactions = r;
      }
      return out;
    };
    const keep = (list) => (Array.isArray(list) ? list : []).slice(0, 5000).map(msg).filter((m) => m.text || m.gif || m.photo || m.poll || m.draw);
    return {
      format: ARCHIVE, version: 1, title: str(o.title, 60) || t("recordDefault"), code: str(o.code, 4), created: num(o.created), exported: num(o.exported),
      me: { name: str(o.me?.name, 24), avatar: str(o.me?.avatar, 8) },
      messages: keep(o.messages),
      dms: (Array.isArray(o.dms) ? o.dms : []).slice(0, 200).map((d) => ({ with: { name: str(d?.with?.name, 24) || "？", avatar: str(d?.with?.avatar, 8) }, messages: keep(d?.messages) })).filter((d) => d.messages.length),
    };
  }
  const countOf = (a) => a.messages.length + a.dms.reduce((s, d) => s + d.messages.length, 0);
  const label = (m) => `${m.avatar} ${m.name}`;
  // a photo, poll or draw in words, for the .txt file (and the .html one)
  const pollText = (p) => `📊 ${p.q} (${t(p.m ? "pollMultiTag" : "pollSingleTag")}${p.closed ? " · " + t("pollClosed") : ""})\n` +
    p.o.map((o) => `· ${o.t}${t("colon")}${o.n}`).join("\n") + "\n" + t("pollVotes", { n: p.total });
  const drawText = (d) => `🎲 ${d.t || t("draw")}\n${t("drawFrom", { n: d.p.length, k: d.w.length })}\n🏆 ${d.w.join(t("listSep"))}\n${t("drawWhoIn")}${t("colon")}${d.p.join(t("listSep"))}`;
  const bodyText = (m) => (m.photo ? "📷 " + t("photo") : m.poll ? pollText(m.poll) : m.draw ? drawText(m.draw) : m.text);
  function toText(a) {
    const line = (m) => `[${fmtFull(m.at)}] ${label(m)}${m.mine ? t("meTag") : ""}${t("colon")}${m.gif ? `[GIF] ${m.gif.title || ""} ${m.gif.url}`.replace(/\s+/g, " ") : bodyText(m).replace(/\n/g, "\n    ")}`;
    const out = [t("expHead", { title: a.title, code: a.code }), t("expAt", { t: fmtFull(a.exported) }), "", `── ${t("everyone")} ──`];
    a.messages.forEach((m) => out.push(line(m)));
    if (!a.messages.length) out.push(t("noMsgs"));
    a.dms.forEach((d) => { out.push("", `── ${t("dmHead", { who: label(d.with) })} ──`); d.messages.forEach((m) => out.push(line(m))); });
    return out.join("\n") + "\n";
  }
  function toHtml(a, srcs = new Map()) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const row = (m) => `<div class="m${m.mine ? " me" : ""}"><div class="h">${esc(label(m))}${m.owner ? " 👑" : ""} <time>${esc(fmtFull(m.at))}</time></div>${m.gif ? `<img class="g" src="${esc(m.gif.url)}" width="${+m.gif.w}" height="${+m.gif.h}" alt="${esc(m.gif.title || "GIF")}" loading="lazy">` : srcs.get(m) ? `<img class="p" src="${esc(srcs.get(m))}" width="${+m.photo.w}" height="${+m.photo.h}" alt="${esc(t("photo"))}">` : `<div class="b">${esc(bodyText(m))}</div>`}${m.reactions ? `<div class="r">${Object.entries(m.reactions).map(([e, n]) => `${e} ${n}`).join("　")}</div>` : ""}</div>`;
    const sec = (h, list) => `<h2>${esc(h)}</h2>${list.map(row).join("") || `<p class="e">${esc(t("noMsgs"))}</p>`}`;
    const data = JSON.stringify(a).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="${I18N.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(a.title)}</title>
<style>body{font:15px/1.55 system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#3a3128;background:#f4efe6}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e4dccc}.sub{color:#857a6b;font-size:13px}.m{margin:10px 0;max-width:85%}.m.me{margin-left:auto;text-align:right}.h{font-size:12px;color:#857a6b;margin-bottom:2px}.b{display:inline-block;text-align:left;background:#fff;border:1px solid #e4dccc;border-radius:14px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}.me .b{background:#d9cdb6;color:#3a3128;border-color:#d9cdb6}.g{max-width:240px;height:auto;border-radius:12px}.p{max-width:min(360px,100%);height:auto;border-radius:12px}.r{font-size:13px;margin-top:2px}.e{color:#b3aa9b}@media(prefers-color-scheme:dark){body{background:#1b1916;color:#f4efe6}.b{background:#25221e;border-color:#3e3a33}.me .b{background:#e7decd;border-color:#e7decd;color:#2a251f}h2{border-color:#3e3a33}}</style></head><body>
<h1>${esc(a.title)}</h1><div class="sub">${esc(t("expSub", { code: a.code, t: fmtFull(a.exported) }))}</div>
${sec(t("everyone"), a.messages)}
${a.dms.map((d) => sec(t("dmHead", { who: label(d.with) }), d.messages)).join("")}
<script type="application/json" id="${ARCHIVE}">${data}</script>
</body></html>`;
  }
  // the .html file carries the photos themselves, so it shows them after the room is gone
  async function photoSrcs(a) {
    const out = new Map();
    if (!a.pics?.length || !R) return out;
    toast(t("photosPacking"));
    for (const [m, v] of a.pics) {
      const u = await photoUrl(v.img.f, v.by);
      if (u) out.set(m, await fetch(u).then((r) => r.blob()).then((b) => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(null); fr.readAsDataURL(b); })).catch(() => null));
    }
    return out;
  }
  async function download(a, kind) {
    const stamp = new Date(a.exported || Date.now()).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const name = `chat-${a.code || "record"}-${stamp}.${kind}`; // ASCII: some browsers drop non-ASCII download names
    const body = kind === "txt" ? toText(a) : kind === "html" ? toHtml(a, await photoSrcs(a)) : JSON.stringify(a, null, 1);
    const type = { txt: "text/plain", html: "text/html", json: "application/json" }[kind] + ";charset=utf-8";
    const link = el("a", { href: URL.createObjectURL(new Blob([body], { type })), download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    toast(t("downloaded", { name }));
  }
  async function exportSheet() {
    if (!R) return;
    const a = archive();
    const pick = await sheet(t("exportChat"), el("div", {},
      el("p", { class: "muted", text: t("exportCount", { n: countOf(a) }) }),
      el("p", { class: "muted small", text: t("exportHint") })),
      [["save", t("saveHere"), "primary"], ["json", t("jsonImp")], ["html", t("htmlImp")], ["txt", t("txtFile")]]);
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
    } catch (e) { toast(t("noSpace")); return null; }
    if (!quiet) toast(t("savedRec"));
    return id;
  }
  function deleteRecord(id) {
    store.set(REC(id), null);
    try { localStorage.setItem(REC_LIST, JSON.stringify(records().filter((r) => r.id !== id))); } catch (e) {}
  }
  // the menu behind the ☰ button on the home screen: who I am, and my saved records
  function homeMenu() {
    const m = me(), list = records();
    const body = el("div", { class: "hmenu" },
      el("button", { type: "button", class: "merow", "data-a": "me" },
        el("span", { class: "av", text: m ? m.avatar : "🙂" }),
        el("span", { class: "txt" }, el("b", { text: m ? m.name : t("noIdentity") }), el("small", { text: t("editMeShort") })),
        el("span", { class: "chev", text: "›" })),
      el("button", { type: "button", class: "merow", "data-a": "lang" },
        el("span", { class: "av", text: "🌐" }),
        el("span", { class: "txt" }, el("b", { text: t("language") + (I18N.lang === "en" ? "" : " · Language") }), el("small", { text: I18N.LANGS.find(([c]) => c === I18N.lang)[1] })),
        el("span", { class: "chev", text: "›" })),
      el("button", { type: "button", class: "merow", "data-a": "theme" },
        el("span", { class: "av", text: "🌓" }),
        el("span", { class: "txt" }, el("b", { text: t("theme") }), el("small", { text: t({ light: "themeLight", dark: "themeDark" }[I18N.theme()] || "themeSystem") })),
        el("span", { class: "chev", text: "›" })),
      el("h3", { text: t("myRecords") }),
      list.length ? el("ul", { class: "reclist" }, list.map((r) => el("li", {},
        el("button", { type: "button", class: "rec", "data-open": r.id },
          el("b", { text: r.title }), el("small", { text: [r.code ? t("recCode", { code: r.code }) : null, t("recN", { n: r.n }), new Date(r.exported).toLocaleDateString(I18N.lang)].filter(Boolean).join(" · ") })))))
        : el("p", { class: "muted small", text: t("noRecords") }),
      el("button", { type: "button", class: "btn wide", "data-a": "import", text: t("importRec") }));
    sheet(t("menu"), body, [["close", t("close")]], {
      onOpen: (ov) => body.addEventListener("click", (e) => {
        const b = e.target.closest("[data-a], [data-open]"); if (!b) return;
        if (b.dataset.a === "import") $("#importFile").click(); // right inside the tap, or the file picker may not open
        ov.close(b.dataset.open ? "open:" + b.dataset.open : b.dataset.a);
      }),
    }).then((a) => {
      if (a === "me") askMe(false);
      else if (a === "lang") pickLang();
      else if (a === "theme") pickTheme();
      else if (a?.startsWith("open:")) openRecord(null, a.slice(5));
    });
  }
  // the languages, each in its own name; the choice stays on this device
  async function pickLang() {
    let saved = null;
    try { saved = localStorage.getItem("chat-lang"); } catch (e) {}
    const list = el("div", { class: "langs", role: "radiogroup" },
      [["", t("followDevice")], ...I18N.LANGS].map(([c, n]) => el("button", { type: "button", class: "btn wide", role: "radio", "data-lang": c, "aria-checked": String(c === (saved || "")), text: n })));
    const a = await sheet(t("language") + (I18N.lang === "en" ? "" : " · Language"), list, [["close", t("close")]], {
      onOpen: (ov) => list.addEventListener("click", (e) => { const b = e.target.closest("[data-lang]"); if (b) ov.close("lang:" + b.dataset.lang); }),
    });
    if (!a?.startsWith("lang:")) return;
    I18N.set(a.slice(5) || null);
    showMe(); home(); homeMenu();
  }
  // light, dark, or whatever the device uses (the default)
  async function pickTheme() {
    const cur = I18N.theme() || "";
    const list = el("div", { class: "langs", role: "radiogroup" },
      [["", t("themeSystem")], ["light", "☀️ " + t("themeLight")], ["dark", "🌙 " + t("themeDark")]].map(([v, n]) =>
        el("button", { type: "button", class: "btn wide", role: "radio", "data-theme": v, "aria-checked": String(v === cur), text: n })));
    const a = await sheet(t("theme"), list, [["close", t("close")]], {
      onOpen: (ov) => list.addEventListener("click", (e) => { const b = e.target.closest("[data-theme]"); if (b) ov.close("theme:" + b.dataset.theme); }),
    });
    if (!a?.startsWith("theme:")) return;
    I18N.theme(a.slice(6) || null);
    homeMenu();
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 8e6) { toast(t("tooBig")); return; }
    let a;
    try {
      const text = await file.text();
      let raw;
      if (/^\s*</.test(text)) { // an exported .html: the archive rides along inside it
        const tag = new DOMParser().parseFromString(text, "text/html").getElementById(ARCHIVE);
        raw = tag && JSON.parse(tag.textContent);
      } else raw = JSON.parse(text);
      a = readArchive(raw);
    } catch (e) { toast(t("notArchive")); return; }
    const id = saveRecord(a, true);
    openRecord(id ? null : a, id);
  }

  /* ---------- reading a saved record (read-only) ---------- */
  let REC_VIEW = null; // { a, id, tab }
  function openRecord(a, id) {
    if (!a) { try { a = readArchive(JSON.parse(localStorage.getItem(REC(id)))); } catch (e) { toast(t("recBroken")); deleteRecord(id); return; } }
    REC_VIEW = { a, id, tab: -1 };
    $("#home").hidden = true; $("#chat").hidden = true; $("#record").hidden = false;
    $("#recTitle").textContent = a.title;
    $("#recSub").textContent = t("recSub", { t: fmtFull(a.exported) });
    const tabs = $("#recTabs");
    tabs.replaceChildren(el("button", { type: "button", class: "tab", "data-tab": -1, text: t("everyoneN", { n: a.messages.length }) }),
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
        m.gif ? el("div", { class: "bub gifbub ro" }, gifImg(m.gif))
          : m.poll ? el("div", { class: "bub pollbub ro" }, pollView(m.poll, null))
          : m.draw ? el("div", { class: "bub drawbub ro" }, drawView(m.draw))
          : el("div", { class: "bub ro" }, m.photo ? "📷 " + t("photo") : linkify(m.text)),
        m.reactions ? el("div", { class: "re" }, Object.entries(m.reactions).map(([e, n]) => el("span", { class: "chip", text: `${e} ${n}` }))) : null);
    }) : [el("p", { class: "empty", text: t("empty") })]));
    box.scrollTop = 0;
  }
  async function recordMenu() {
    const { a, id } = REC_VIEW;
    const pick = await sheet(a.title, el("p", { class: "muted", text: t("recInfo") }),
      [["json", t("dlJson")], ["html", t("dlHtml")], ["txt", t("dlTxt")], ...(id ? [["del", t("delLocal"), "danger"]] : [])]);
    if (pick === "del" && (await confirmSheet(t("delRecTitle"), t("delRecBody"), t("del")))) { deleteRecord(id); home(); }
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
    box.classList.toggle("short", kind === "more");
    if (kind === "more") {
      const item = (icon, label, fn) => el("button", { type: "button", class: "morebtn", onclick: () => { fn(); closePicker(); } }, el("span", { class: "i", text: icon }), el("span", { text: label }));
      // the file picker opens right inside the tap, or a phone may refuse to open it
      box.replaceChildren(el("div", { class: "more" },
        item("📷", t("photo"), () => $("#photoFile").click()), item("📊", t("poll"), newPoll), item("🎲", t("draw"), newDraw)));
    } else if (kind === "emoji") {
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
    const base = `https://api.klipy.com/api/v1/${encodeURIComponent(KLIPY)}/gifs/${q ? "search" : "trending"}`;
    const qs = new URLSearchParams({ per_page: 24, page, locale: KLIPY_LOCALE[I18N.lang] || "en_US", rating: "pg-13", customer_id: uid || "guest" });
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
    const foot = el("div", { class: "gifby", text: "Powered by KLIPY" });
    box.replaceChildren(input, grid, foot);
    let n = 0;
    const load = async () => {
      const mine = ++n;
      grid.replaceChildren(el("p", { class: "muted small", text: t("loading") }));
      try {
        const list = await klipy(input.value.trim());
        if (mine !== n) return;
        if (!list.length) { grid.replaceChildren(el("p", { class: "muted small", text: t("noGif") })); return; }
        // two columns that scroll down; each GIF goes to the shorter column
        const cols = [el("div", { class: "gifcol" }), el("div", { class: "gifcol" })], tall = [0, 0];
        list.forEach((g) => {
          const i = tall[0] <= tall[1] ? 0 : 1; tall[i] += g.show.h / g.show.w;
          cols[i].append(el("button", { type: "button", class: "gifpick", title: g.send.title, onclick: () => { send("", g.send); closePicker(); } },
            el("img", { src: g.show.url, width: g.show.w, height: g.show.h, alt: g.send.title || "GIF", loading: "lazy", referrerpolicy: "no-referrer" })));
        });
        grid.replaceChildren(...cols); grid.scrollTop = 0;
      } catch (e) { console.error(e); if (mine === n) grid.replaceChildren(el("p", { class: "muted small", text: t("gifDown") })); }
    };
    let timer = 0;
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 350); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); clearTimeout(timer); load(); } });
    load();
    if (matchMedia("(pointer: fine)").matches) input.focus();
  }

  /* ---------- screens ---------- */
  // the address names the room, so reloading the page comes back to it
  const roomPath = (code) => history.replaceState(null, "", "?room=" + code + (EMU && params.get("as") ? "&as=" + params.get("as") : ""));
  // opening a room's link starts with no screen showing; a question on the way in (nickname, link, password) shows the home page behind it
  function backdrop() { if ($("#home").hidden && $("#chat").hidden && $("#record").hidden) { $("#home").hidden = false; showResume(); } }
  function showChat() { $("#home").hidden = true; $("#record").hidden = true; $("#chat").hidden = false; renderView(); }
  function home() {
    $("#chat").hidden = true; $("#record").hidden = true; $("#home").hidden = false;
    REC_VIEW = null; closePicker();
    $("#composer").classList.remove("off");
    document.title = t("docTitle");
    history.replaceState(null, "", location.pathname + (EMU && params.get("as") ? "?as=" + params.get("as") : ""));
    showResume();
  }
  // rooms this device is in, most recently entered first
  const myRooms = () => { try { const l = JSON.parse(store.get(ROOMS_KEY)); return Array.isArray(l) ? l.filter((c) => /^[2-9A-HJKMNP-Z]{4}$/.test(c)) : []; } catch (e) { return []; } };
  const rememberRoom = (code) => store.set(ROOMS_KEY, JSON.stringify([code, ...myRooms().filter((c) => c !== code)].slice(0, 30)));
  const forgetRoom = (code) => store.set(ROOMS_KEY, JSON.stringify(myRooms().filter((c) => c !== code)));
  { const old = store.get("chat-room"); if (old) { if (!myRooms().includes(old)) store.set(ROOMS_KEY, JSON.stringify([old, ...myRooms()])); store.set("chat-room", null); } } // before the list
  const PAGE = 5;
  let resumePage = 0, resumeRows = [], resumeSeq = 0;
  // the list as last checked, so the home page shows it at once instead of after signing in and asking the server
  const RESUME_KEY = "chat-rooms-seen";
  const seenRows = () => { try { const l = JSON.parse(store.get(RESUME_KEY)); return Array.isArray(l) ? l : []; } catch (e) { return []; } };
  async function showResume() {
    const seq = ++resumeSeq, codes = myRooms();
    if (!codes.length || !FB?.databaseURL) { $("#resume").hidden = true; return; }
    const seen = seenRows().filter((r) => r && codes.includes(r.code));
    if (seen.length) { resumeRows = codes.map((c) => seen.find((r) => r.code === c)).filter(Boolean); renderResume(); }
    try { await connect(); } catch (e) { return; }
    const rows = (await Promise.all(codes.map(async (code) => {
      const meta = await fb.get(roomRef(code, "meta")).then((s) => s.val(), () => undefined);
      if (meta === undefined) return seen.find((r) => r.code === code) || null; // offline: keep what we last saw
      if (!meta || meta.last < now() - DAY) { forgetRoom(code); return null; }
      const inside = await fb.get(roomRef(code, "members/" + uid)).then((s) => s.exists(), () => false);
      if (!inside) { forgetRoom(code); return null; }
      let t = meta.title || "";
      if (meta.enc) { try { t = (await unseal((await roomCrypto(unb64u(store.get(ROOMKEY(code))))).aes, meta.xt, "t"))?.t || ""; } catch (e) { t = ""; } }
      return { code, t, enc: !!meta.enc, priv: !!meta.priv };
    }))).filter(Boolean);
    if (seq !== resumeSeq) return;
    resumeRows = rows;
    store.set(RESUME_KEY, JSON.stringify(rows));
    renderResume();
  }
  function renderResume() {
    const box = $("#resume"), rows = resumeRows, pages = Math.ceil(rows.length / PAGE);
    box.hidden = !rows.length;
    if (!rows.length) return;
    resumePage = Math.min(resumePage, pages - 1);
    $("h2", box).textContent = rows.length === 1 ? t("stillIn") : t("stillInN", { n: rows.length });
    $(".roomlist", box).replaceChildren(...rows.slice(resumePage * PAGE, resumePage * PAGE + PAGE).map((r) => el("li", {},
      el("button", { type: "button", class: "roomrow", "data-code": r.code },
        // laid out like the room's own header: its name, then the code on a chip
        el("span", { class: "txt" }, el("b", { text: r.t || t("room") }), el("span", { class: "codechip", text: (r.enc ? "🔐 " : "") + (r.priv ? "🔒 " : "") + r.code })),
        el("span", { class: "go", text: t("backToRoom") })))));
    $(".pager", box).hidden = pages < 2;
    $(".pager .pg", box).textContent = `${resumePage + 1} / ${pages}`;
    $(".pager [data-a=prev]", box).disabled = resumePage === 0;
    $(".pager [data-a=next]", box).disabled = resumePage >= pages - 1;
  }

  /* ---------- wiring ---------- */
  I18N.apply();
  showMe();
  if (!FB?.databaseURL) { $("#setupNote").hidden = false; document.body.classList.add("nodb"); }
  $("#meBtn").addEventListener("click", homeMenu);
  $("#createBtn").addEventListener("click", create);
  $("#logoBtn").addEventListener("click", create);
  $("#joinForm").addEventListener("submit", (e) => { e.preventDefault(); join($("#joinCode").value); });
  $("#joinCode").addEventListener("input", (e) => { const v = e.target.value; if (!/[/?]/.test(v)) e.target.value = v.toUpperCase(); });
  $("#resume").addEventListener("click", (e) => {
    const b = e.target.closest("[data-code], [data-a]"); if (!b) return;
    if (b.dataset.code) join(b.dataset.code);
    else { resumePage += b.dataset.a === "next" ? 1 : -1; renderResume(); }
  });
  $("#codeBtn").addEventListener("click", share);
  $("#importFile").addEventListener("change", (e) => { importFile(e.target.files[0]); e.target.value = ""; });
  $("#photoFile").addEventListener("change", (e) => { const files = [...e.target.files]; e.target.value = ""; sendPhotos(files); });
  $("#record").addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a, t = e.target.closest("[data-tab]");
    if (a === "home") home();
    if (a === "menu") recordMenu();
    if (t) { REC_VIEW.tab = +t.dataset.tab; renderRecord(); }
  });
  if (!KLIPY) $("#composer [data-a=gif]").hidden = true;
  $("#composer").addEventListener("click", (e) => { const b = e.target.closest(".tool"); if (b) openPicker(b.dataset.a); });
  $("#peopleBtn").addEventListener("click", people);
  // tapping the conversation while the emoji / GIF panel is open just closes the panel
  ["#list", "#pins"].forEach((s) => $(s).addEventListener("click", (e) => { if (pickerOpen) { closePicker(); e.stopPropagation(); e.preventDefault(); } }, true));
  $("#chat").addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "home") { if (R?.view !== "all") { R.view = "all"; renderView(); } else home(); }
    if (a === "menu") menu();
    if (a === "all") { R.view = "all"; renderView(); }
    if (a === "notifyYes" || a === "notifyNo") setNotify(a === "notifyYes");
    if (a === "noreply") cancelReply();
  });
  const ta = $("#text");
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
  ta.addEventListener("input", grow);
  // a picture pasted into the box is sent as a photo
  ta.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length && R && R.view === "all") { e.preventDefault(); sendPhotos(files); }
  });
  // the keyboard covers the home indicator, so the home-screen app's extra space under the box goes while typing
  ta.addEventListener("focus", () => document.body.classList.add("typing"));
  ta.addEventListener("blur", () => document.body.classList.remove("typing"));
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
  if (start && FB?.databaseURL) { // an encrypted room's key rides after the #
    $("#home").hidden = true; // straight into the room, without the home page showing first
    document.documentElement.classList.remove("opening");
    join(start + location.hash).finally(() => { if (!R || R.gone) home(); else if ($("#chat").hidden) backdrop(); });
  } else { document.documentElement.classList.remove("opening"); home(); }
})();
