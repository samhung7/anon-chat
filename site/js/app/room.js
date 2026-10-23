/* One room this device is in: what the database holds about it, decrypted, kept live while it's on screen.
   A Room only knows data. It follows the database and tells whoever listens what changed (on/emit); it never
   draws anything, and the screens never subscribe to the database themselves. Its writes go through room.api. */
import { MAX_LOAD } from "./constants.js?v=dev";
import { t } from "./text.js?v=dev";
import { PUSH_ID } from "./clean.js?v=dev";
import { backend } from "./backend.js?v=dev";
import { deviceKeys, sharedKey, unseal } from "./crypto.js?v=dev";
import { room as current } from "./session.js?v=dev";
import { plainFields, unsealedFields, finishOpen, openPicks } from "./kinds.js?v=dev";
import { RoomApi } from "./api.js?v=dev";
import { cleanLive, cleanAsked, cleanKey, cleanScores, cleanPlayer, cleanChoice } from "./quizset.js?v=dev";
import { cleanLive as cleanBoardLive, cleanCols, cleanNote, cleanPicks } from "./stickyset.js?v=dev";

export const pairKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
// the key a nickname is claimed under: the name itself, lowercased, or in an encrypted room a keyed hash of it
export const nameKey = (n) => n.toLowerCase();
export const nameClaim = async (cipher, name) => (cipher ? cipher.mac("name:" + nameKey(name)) : nameKey(name));

// how this device is looking at the room: which view, what's typed, where it scrolled. Each room starts fresh.
export class ViewState {
  view = "all";        // "all" (the room), "qa" (its questions) or the uid of someone in a private chat
  shown = undefined;   // the view whose draft is in the box
  drafts = {};         // unsent text per view, so a private message can't slip into the room (or the other way)
  reply = null;        // { id, dm } of the message being replied to
  unread = {};         // new private messages per person
  below = 0;           // messages that came in while scrolled up
  touched = false;     // they scrolled by hand while history was loading
  readMark = 0;        // where this device stopped reading the room
  div = null;          // the "new messages" line
  qdoneOpen = false;   // the answered questions are unfolded
  get isDm() { return this.view !== "all" && this.view !== "qa"; }
}

class Emitter {
  #handlers = {};
  on(event, fn) { (this.#handlers[event] ||= []).push(fn); return this; }
  un(event, fn) { this.#handlers[event] = (this.#handlers[event] || []).filter((f) => f !== fn); return this; }
  emit(event, ...args) { (this.#handlers[event] || []).forEach((fn) => fn(...args)); }
}

/* Events: meta, ended, lost, arrivals({ joined, left }), members, msg(id, v), msg-changed(id, v, old),
   msg-removed(id), dm(other, id, v), typing, qs, qq({ more }), reports({ more }), quiz(id), board(id) */
export class Room extends Emitter {
  constructor(code, cipher) {
    super();
    this.code = code;
    this.cipher = cipher;      // RoomCipher in an encrypted room, else null
    this.api = new RoomApi(code);
    this.ui = new ViewState();
    this.meta = null;
    // members/seen: as shown (decrypted); raw/rawSeen: as stored. seen keeps people who have left.
    this.members = {}; this.seen = {}; this.raw = {}; this.rawSeen = {};
    this.msgs = new Map();
    this.dms = new Map();       // other uid -> Map of private messages
    this.qs = new Map(); this.qq = new Map(); this.qqRaw = {};
    this.pushSynced = false;    // this device's push subscription is in the room (or isn't wanted), once per visit
    this.myWait = new Set();    // my questions still waiting for review
    this.justAsked = new Set(); // asked from here, not back from the server yet
    this.reports = {}; this.typing = {}; this.dmTyping = {};
    this.plain = new Map();     // sealed value -> what it opened to
    this.dk = new Map();        // private-chat keys
    this.imgs = new Map();      // photo id -> blob: URL
    this.ballots = new Map();   // poll id -> its votes, when they're kept apart (followBallots)
    this.quizzes = new Map();   // quiz id (its card's) -> where it's at (followQuiz)
    this.boards = new Map();    // sticky-note board id (its card's) -> what's on it (followBoard)
    this.off = [];              // what stops each subscription
    this.gone = false; this.ready = false;
    this.readOnly = false;      // nobody spoke for 24 hours (js/app/expiry.js): read and save, nothing new
    this.t0 = backend.now();    // messages from before this are history
    this.lastAt = 0;
    // everything that arrives goes through one queue, so decrypting never reorders messages
    this.q = Promise.resolve();
  }
  get current() { return current === this; }
  queue(fn) { return (this.q = this.q.then(() => (this.current ? fn() : null)).catch((e) => console.error(e))); }
  stop() { this.off.forEach((f) => { try { f(); } catch (e) {} }); }

  /* ---------- who's who ---------- */
  get uid() { return backend.uid; }
  isOwner() { return !!this.meta && this.meta.owner === this.uid; }
  // co-hosts (meta/mods) remove messages and people, but not the owner or each other
  isMod(id = this.uid) { return this.meta?.mods?.[id] === true; }
  isStaff() { return this.isOwner() || this.isMod(); }
  canManage(id) { return id !== this.uid && (this.isOwner() || (this.isMod() && id !== this.meta?.owner && !this.isMod(id))); }
  badge(id) { return this.meta?.owner === id ? " 👑" : this.isMod(id) ? " 🛡️" : ""; }
  who(id) { return this.members[id] || this.seen[id] || null; }
  nameOf(id) { const m = this.who(id); return m ? `${m.avatar} ${m.name}` : t("someoneLeft"); }
  // who wrote a message, under their current name: messages keep the name they were sent with,
  // which only shows for someone who left before this device saw them
  author(v, dm) { return this.who(v.by) || (dm ? { name: t("someoneLeft"), avatar: "👤" } : v); }
  // the nickname claim someone holds now
  claimOf(id) { return this.cipher ? this.raw[id]?.h : this.members[id] && nameKey(this.members[id].name); }

  /* ---------- opening what's stored ---------- */
  // a sealed value, opened once per visit; key may be a function that finds it
  async open(key, x, aad) {
    let p = this.plain.get(x);
    if (p === undefined) {
      const k = typeof key === "function" ? await key() : key;
      p = k ? await unseal(k, x, aad) : null;
      if (p != null) this.plain.set(x, p);
    }
    return p;
  }
  // the key two people share for their private messages in this room (null if the other has no public key yet)
  dmKey(other) {
    const pk = (this.raw[other] || this.rawSeen[other])?.pk;
    if (!pk) return Promise.resolve(null);
    const id = other + ":" + pk;
    if (!this.dk.has(id)) this.dk.set(id, sharedKey(pk, `anon-chat dm ${this.code} ${pairKey(this.uid, other)}`).catch(() => null));
    return this.dk.get(id);
  }
  async openMember(id, m) {
    if (!m?.x || !this.cipher) return m;
    const p = (await this.cipher.unseal(m.x, "u:" + id)) || {};
    return { ...m, name: String(p.n || "？").slice(0, 24), avatar: String(p.a || "👤").slice(0, 8) };
  }
  // a message as shown: decrypted (or marked unreadable), everything else as stored
  async openMsg(v, dmWith, id) {
    if (!v) return v;
    if (!v.x) {
      const out = { ...v, ...plainFields(v) };
      await finishOpen(out, v, id);
      return out;
    }
    const p = await this.open(() => (dmWith ? this.dmKey(dmWith) : this.cipher?.aes), v.x, (dmWith ? "d:" : "m:") + v.by);
    const out = { ...v }; delete out.x;
    if (!p) return { ...out, text: t(dmWith ? "cantDecryptDm" : "cantDecrypt"), bad: true };
    Object.assign(out, unsealedFields(p, !!dmWith));
    await finishOpen(out, v, id);
    if (!dmWith) { out.name = String(p.n || "？").slice(0, 24); out.avatar = String(p.a || "👤").slice(0, 8); }
    if (typeof p.r === "string" && PUSH_ID.test(p.r)) out.rp = p.r;
    return out;
  }
  // a question or an answer's words and who wrote them: as stored, or sealed with the room key (bound by aad)
  words(v, aad) { return v.x ? this.open(this.cipher?.aes, v.x, aad) : { t: v.text, n: v.name, a: v.avatar }; }
  async openQ(id, v) {
    const p = await this.words(v, "q:" + id);
    const base = { id, at: +v.at || 0, up: Object.keys(v.up || {}), done: +v.done || 0, ans: v.ans && typeof v.ans === "object" ? await this.openAns(id, v.ans) : null };
    if (!p) return { ...base, text: t("cantDecrypt"), name: "", avatar: "", bad: true };
    const named = typeof p.n === "string" && !!p.n;
    return { ...base, text: String(p.t || "").slice(0, 300), name: named ? p.n.slice(0, 24) : "", avatar: named ? String(p.a || "👤").slice(0, 8) : "" };
  }
  // the owner's or a co-host's written answer, under their room name
  async openAns(id, v) {
    const p = await this.words(v, "a:" + id);
    const base = { by: String(v.by || ""), at: +v.at || 0 };
    if (!p) return { ...base, text: t("cantDecrypt"), name: "", avatar: "", bad: true };
    return { ...base, text: String(p.t || "").slice(0, 2000), name: String(p.n || "").slice(0, 24), avatar: String(p.a || "👤").slice(0, 8) };
  }
  async openQs(raw) {
    const out = new Map();
    for (const [id, v] of Object.entries(raw || {})) if (v && typeof v === "object") out.set(id, await this.openQ(id, v));
    return out;
  }

  /* ---------- following the database ---------- */
  start() {
    const { fb } = backend, api = this.api, uid = this.uid;
    const on = (off) => this.off.push(off);
    const lost = (e) => { if (this.current) this.emit("lost"); else console.warn(e); };
    on(fb.onValue(api.ref("meta"), (s) => this.queue(async () => {
      if (!s.exists()) return this.emit("ended");
      const meta = s.val();
      if (this.cipher) {
        meta.title = meta.xt ? (await this.cipher.unseal(meta.xt, "t"))?.t || "" : "";
        meta.desc = meta.xd ? (await this.cipher.unseal(meta.xd, "d"))?.t || "" : "";
        meta.qr = meta.xr ? (await this.cipher.unseal(meta.xr, "r"))?.t || "" : "";
      }
      this.meta = meta;
      this.emit("meta");
      this.followStaffFeeds();
    }), lost));
    on(fb.onValue(api.ref("members"), (s) => this.queue(() => this.takeMembers(s.val() || {})), lost));
    const msgs = fb.query(api.ref("msgs"), fb.limitToLast(MAX_LOAD));
    on(fb.onChildAdded(msgs, (s) => this.queue(async () => {
      const v = this.withBallots(s.key, await this.openMsg(s.val(), null, s.key));
      this.msgs.set(s.key, v); this.lastAt = Math.max(this.lastAt, +v.at || 0);
      if (v.quiz) this.followQuiz(s.key);
      if (v.board) this.followBoard(s.key);
      this.emit("msg", s.key, v);
    }), lost));
    on(fb.onChildChanged(msgs, (s) => this.queue(async () => {
      const old = this.msgs.get(s.key), v = this.withBallots(s.key, await this.openMsg(s.val(), null, s.key));
      this.msgs.set(s.key, v);
      this.emit("msg-changed", s.key, v, old);
    })));
    on(fb.onChildRemoved(msgs, (s) => this.queue(() => { this.msgs.delete(s.key); this.dropBallots(s.key); this.dropQuiz(s.key); this.dropBoard(s.key); this.emit("msg-removed", s.key); })));
    on(() => [...this.ballots.keys()].forEach((id) => this.dropBallots(id)));
    on(() => [...this.quizzes.keys()].forEach((id) => this.dropQuiz(id)));
    on(() => [...this.boards.keys()].forEach((id) => this.dropBoard(id)));
    on(fb.onValue(api.ref("typing"), (s) => { this.typing = s.val() || {}; this.emit("typing"); }, () => {}));
    on(fb.onValue(api.ref("qs"), (s) => this.queue(async () => {
      this.qs = await this.openQs(s.val());
      this.qs.forEach((q, id) => this.justAsked.delete(id));
      this.emit("qs");
    }), () => {}));
    // online / offline: the server marks me offline when my connection drops, and I mark myself online on connecting.
    // A hidden page counts as offline too: a phone that locks or switches apps stops running the page long before the
    // server notices the connection is gone, and offline is what lets the push service tell me about new messages
    const online = api.ref("members/" + uid + "/online");
    let connected = false;
    const here = () => {
      if (!connected || !this.current || this.gone || document.hidden) return;
      fb.onDisconnect(online).set(false).catch(() => {});
      fb.set(online, true).catch(() => {});
    };
    const seen = () => (document.hidden ? this.current && !this.gone && fb.set(online, false).catch(() => {}) : here());
    document.addEventListener("visibilitychange", seen);
    on(() => document.removeEventListener("visibilitychange", seen));
    on(fb.onValue(backend.ref(".info/connected"), (s) => { connected = !!s.val(); here(); }));
    // ...but a dropped connection the server only notices late (a phone that slept), or this room open in another tab
    // that closes, sets me offline while I'm still here: I'm connected, so I'm online again
    on(fb.onValue(online, (s) => { if (s.val() === false) here(); }, () => {}));
    on(() => fb.onDisconnect(online).cancel().catch(() => {}));
  }
  async takeMembers(raw) {
    const uid = this.uid, next = {};
    for (const [id, m] of Object.entries(raw)) next[id] = await this.openMember(id, m);
    this.raw = raw; Object.assign(this.rawSeen, JSON.parse(JSON.stringify(raw)));
    const dh = await deviceKeys();
    if (raw[uid] && raw[uid].pk !== dh.pub) this.api.setPublicKey(dh.pub).catch(() => {}); // members from before encrypted private messages
    if (this.ready) this.emit("arrivals", {
      joined: Object.entries(next).filter(([id]) => !this.members[id] && id !== uid).map(([, m]) => m),
      left: Object.entries(this.members).filter(([id]) => !next[id] && id !== uid).map(([, m]) => m),
    });
    this.members = next; this.ready = true;
    Object.assign(this.seen, JSON.parse(JSON.stringify(next)));
    if (!next[uid]) return this.emit("lost");
    // with a size limit, the owner's device keeps the count true (someone may have left without counting down)
    const count = Object.keys(next).length;
    if (this.isOwner() && this.meta?.cap && this.meta.n !== count) this.api.setCount(count).catch(() => {});
    Object.keys(next).forEach((id) => id !== uid && this.watchDm(id));
    this.emit("members");
  }
  // private messages with someone, and whether they're typing to me
  watchDm(other) {
    if (this.dms.has(other)) return;
    const box = new Map(), { fb } = backend, path = `dm/${pairKey(this.uid, other)}`;
    this.dms.set(other, box);
    this.off.push(fb.onChildAdded(this.api.ref(path), (s) => this.queue(async () => {
      const v = await this.openMsg(s.val(), other); box.set(s.key, v);
      this.emit("dm", other, s.key, v);
    }), () => {}));
    this.off.push(fb.onValue(this.api.ref(`dmt/${pairKey(this.uid, other)}`), (s) => {
      if (this.current) { this.dmTyping[other] = s.val()?.[other] || 0; this.emit("typing"); }
    }, () => {}));
  }
  // the owner and co-hosts follow the reports and the questions waiting for review; nobody else can read them
  followStaffFeeds() {
    const want = this.isStaff() && !this.gone, { fb } = backend;
    if (want && !this.repOff) {
      let first = true;
      this.repOff = fb.onValue(this.api.ref("reports"), (s) => {
        if (!this.current) return;
        const prev = this.reports; this.reports = s.val() || {};
        const more = Object.entries(this.reports).some(([id, by]) => Object.keys(by || {}).length > Object.keys(prev[id] || {}).length && this.reportLive(id));
        this.emit("reports", { more: !first && more });
        first = false;
      }, () => { this.repOff = null; });
      this.off.push(() => this.repOff?.());
    } else if (!want && this.repOff) { this.repOff(); this.repOff = null; this.reports = {}; this.emit("reports", { more: false }); }
    if (want && !this.qqOff) {
      let first = true;
      this.qqOff = fb.onValue(this.api.ref("qq"), (s) => this.queue(async () => {
        const raw = s.val() || {}, before = this.qq.size;
        this.qqRaw = raw; this.qq = await this.openQs(raw);
        this.emit("qq", { more: !first && this.qq.size > before });
        first = false;
      }), () => { this.qqOff = null; });
      this.off.push(() => this.qqOff?.());
    } else if (!want && this.qqOff) { this.qqOff(); this.qqOff = null; this.qq = new Map(); this.qqRaw = {}; this.emit("qq", { more: false }); }
  }
  /* ---------- polls whose votes are kept apart ---------- */
  // An anonymous poll (an) or one hidden until rv keeps its votes outside the message (tools/rules.py pv, ab and av):
  // my own vote is followed from the start, everyone's once the results are out. A message as shown carries them:
  // votes (everyone's, by uid or by ballot), mine, key (my ballot's) and ready (mine has come in)
  withBallots(id, v) {
    if (!v?.poll || !(v.an || v.rv)) return v;
    const b = this.followBallots(id, v);
    return { ...v, votes: b.votes || {}, mine: b.mine, key: b.key, ready: b.ready };
  }
  followBallots(id, v) {
    let b = this.ballots.get(id);
    if (!b) {
      b = { v, votes: null, mine: [], key: null, ready: false, offs: [], all: null, timer: 0 };
      this.ballots.set(id, b);
      const { fb } = backend, api = this.api, uid = this.uid;
      const mineAt = (ref, aad) => b.offs.push(fb.onValue(ref, (s) => this.queue(async () => {
        b.mine = await openPicks(s.val(), aad, b.v.poll); b.ready = true; this.ballotsChanged(id);
      }), () => {}));
      if (v.an) b.offs.push(fb.onValue(api.ref(`av/${id}/${uid}`), (s) => {
        const key = typeof s.val() === "string" ? s.val() : null;
        if (key && !b.key) { b.key = key; mineAt(api.ref(`ab/${id}/${key}`), `b:${id}:${key}`); }
        else if (!key) this.queue(() => { b.ready = true; this.ballotsChanged(id); });
      }, () => {}));
      else mineAt(api.ref(`pv/${id}/${uid}`), `v:${id}:${uid}`);
    }
    b.v = v;
    this.followAllBallots(id, b);
    return b;
  }
  // everyone's votes, once they can be read: straight away, or when the poll is revealed (its time, or its author closing it)
  followAllBallots(id, b) {
    const v = b.v;
    if (b.all) return;
    clearTimeout(b.timer);
    const wait = v.rv && !v.closed ? v.rv - backend.now() : 0;
    if (wait > 0) { b.timer = setTimeout(() => this.followAllBallots(id, b), Math.min(wait + 500, 2 ** 31 - 1)); return; }
    const { fb } = backend, path = (v.an ? "ab/" : "pv/") + id;
    b.all = fb.onValue(this.api.ref(path), (s) => this.queue(async () => {
      const out = {};
      for (const [k, x] of Object.entries(s.val() || {})) {
        const list = await openPicks(x, v.an ? `b:${id}:${k}` : `v:${id}:${k}`, v.poll);
        if (list.length) out[k] = list;
      }
      b.votes = out; this.ballotsChanged(id);
    }), () => { // not readable yet (this device's clock runs ahead of the server's): again shortly
      b.all = null;
      if (this.current && this.ballots.get(id) === b) b.timer = setTimeout(() => this.followAllBallots(id, b), 3000);
    });
  }
  ballotsChanged(id) {
    const old = this.msgs.get(id);
    if (!old) return;
    const v = this.withBallots(id, old);
    this.msgs.set(id, v);
    this.emit("msg-changed", id, v, old);
  }
  dropBallots(id) {
    const b = this.ballots.get(id);
    if (!b) return;
    this.ballots.delete(id); clearTimeout(b.timer);
    [...b.offs, b.all].forEach((f) => { try { f?.(); } catch (e) {} });
  }
  /* ---------- quizzes (quiz.js) ----------
     A quiz's card follows where it's at (qz/{id}/live). While it's on, the rest of it too: the questions as they're
     asked, their right answers and scores once shown, who plays, my own answer to the question being asked, and (for
     the owner and co-hosts, who may read them) everyone's answers to it. Once it's over, only its final scores. What
     the hosts write is plain JSON in a plain room and sealed in a Private Salon, bound to where it sits (aad). */
  followQuiz(z) {
    let e = this.quizzes.get(z);
    if (e) return e;
    e = { live: null, q: {}, k: {}, s: {}, p: {}, mine: {}, all: {}, final: null, offs: [], more: [], i: null, iOffs: [] };
    this.quizzes.set(z, e);
    e.offs.push(backend.fb.onValue(this.api.ref(`qz/${z}/live`), (s) => this.queue(async () => {
      e.live = cleanLive(s.val());
      await this.quizMoved(z, e);
      this.emit("quiz", z);
    }), () => {}));
    return e;
  }
  // a host's write as it reads: JSON in a plain room, sealed in an encrypted one
  async openBlob(b, aad) {
    if (typeof b !== "string") return null;
    if (this.cipher) return this.open(this.cipher.aes, b, aad);
    try { return JSON.parse(b); } catch (e) { return null; }
  }
  async openAnswer(z, i, uid, v) {
    if (!v || typeof v !== "object") return null;
    const c = cleanChoice(v.x ? (this.cipher ? await this.open(this.cipher.aes, v.x, `za:${z}:${i}:${uid}`) : null) : typeof v.c === "string" ? +v.c : null);
    return c == null ? null : { c, at: +v.at || 0 };
  }
  async quizMoved(z, e) {
    const { fb } = backend, ref = (p) => this.api.ref(`qz/${z}/${p}`), on = !!e.live && e.live.ph !== "end";
    const each = async (raw, open) => {
      const out = {};
      for (const [k, v] of Object.entries(raw || {})) { const x = await open(k, v); if (x) out[k] = x; }
      return out;
    };
    const open = async (uid, v) => (v?.x ? cleanPlayer(this.cipher && (await this.open(this.cipher.aes, v.x, `zp:${z}:${uid}`))) : cleanPlayer(v));
    const follow = (path, field, open) => e.more.push(fb.onValue(ref(path), (s) => this.queue(async () => {
      e[field] = await each(s.val(), open); this.emit("quiz", z);
    }), () => {}));
    if (on && !e.more.length) {
      follow("q", "q", async (i, v) => cleanAsked(await this.openBlob(v, `zq:${z}:${i}`)));
      follow("k", "k", async (i, v) => { const k = cleanKey(await this.openBlob(v, `zk:${z}:${i}`)); return k.length ? k : null; });
      follow("s", "s", async (i, v) => cleanScores(await this.openBlob(v, `zr:${z}:${i}`)));
      follow("p", "p", open);
    } else if (!on && e.more.length) { e.more.forEach((f) => f()); e.more = []; }
    // the question being asked: my answer to it, and for the hosts everyone's
    const i = on ? e.live.i : null;
    if (i !== e.i) {
      e.iOffs.forEach((f) => f()); e.iOffs = []; e.i = i;
      if (i != null) {
        e.iOffs.push(fb.onValue(ref(`a/${i}/${this.uid}`), (s) => this.queue(async () => {
          const a = await this.openAnswer(z, i, this.uid, s.val());
          if (a) e.mine[i] = a; else if (e.mine[i]) delete e.mine[i]; // (an answer the server turned down goes again)
          this.emit("quiz", z);
        }), () => {}));
        if (this.isStaff()) e.iOffs.push(fb.onValue(ref(`a/${i}`), (s) => this.queue(async () => {
          e.all[i] = await each(s.val(), (uid, v) => this.openAnswer(z, i, uid, v)); this.emit("quiz", z);
        }), () => {}));
      }
    }
    // over: the scores after its last question and who played, fetched once (apart from the queue, which it would hold up)
    if (e.live?.ph === "end" && !e.final && !e.fetching) {
      e.fetching = true;
      Promise.all([backend.val(ref("s/" + e.live.i)), backend.val(ref("p"))]).then(([s, p]) => this.queue(async () => {
        e.final = cleanScores(await this.openBlob(s, `zr:${z}:${e.live.i}`)) || { n: [], g: {}, sc: {}, r: {}, ms: {} };
        e.p = await each(p, open);
        this.emit("quiz", z);
      }), () => { e.fetching = false; });
    }
  }
  dropQuiz(z) {
    const e = this.quizzes.get(z);
    if (!e) return;
    this.quizzes.delete(z);
    [...e.offs, ...e.more, ...e.iOffs].forEach((f) => { try { f(); } catch (e) {} });
  }
  /* ---------- sticky-note boards (sticky.js) ----------
     A board's card follows the whole board: where it's at (sb/{id}/live), its columns and its notes, and my own votes
     (under the key only I know, bk/{me}); everyone's votes once the result is out. Which notes are mine is asked note by
     note (nb/{note}, which only its author reads), and only while the board is open on this device (mineOn). The hosts'
     columns are JSON in a plain room and sealed in a Private Salon; so are a note's words and name (x) and the votes.
     On a board opened hidden the words sit apart (w/{note}): my own notes' one by one while hidden, everyone's once shown. */
  followBoard(b) {
    let e = this.boards.get(b);
    if (e) return e;
    e = { live: null, cols: [], notes: new Map(), mine: new Set(), asked: new Set(), watch: false, key: null, picks: [], votes: null, offs: [], all: null, pickOff: null,
      raw: {}, words: {}, wAll: null, wOne: new Map() };
    this.boards.set(b, e);
    const { fb } = backend, ref = (p) => this.api.ref(`sb/${b}/${p}`), changed = () => this.emit("board", b);
    e.offs.push(fb.onValue(ref("live"), (s) => this.queue(() => {
      const was = e.live?.hd;
      e.live = cleanBoardLive(s.val());
      this.followWords(b);
      if (was !== e.live?.hd) this.noteMap(b, e);
      if (e.live?.ph === "done" && !e.all) e.all = fb.onValue(ref("v"), (v) => this.queue(async () => {
        const out = {};
        for (const [k, x] of Object.entries(v.val() || {})) out[k] = await this.openPicks(b, k, x, e.live.v);
        e.votes = out; changed();
      }), () => {});
      changed();
    }), () => {}));
    e.offs.push(fb.onValue(ref("cols"), (s) => this.queue(async () => { e.cols = cleanCols(await this.openBlob(s.val(), `bm:${b}`)); changed(); }), () => {}));
    e.offs.push(fb.onValue(ref("n"), (s) => this.queue(async () => {
      e.raw = s.val() || {};
      await this.noteMap(b, e);
      this.askMine(b, e);
    }), () => {}));
    // my votes: the key I vote under, then what's under it
    e.offs.push(fb.onValue(ref("bk/" + this.uid), (s) => {
      const key = typeof s.val() === "string" ? s.val() : null;
      if (!key || key === e.key) return;
      e.key = key; e.pickOff?.();
      e.pickOff = fb.onValue(ref("v/" + key), (v) => this.queue(async () => { e.picks = await this.openPicks(b, key, v.val(), e.live?.v || 5); changed(); }), () => {});
    }, () => {}));
    return e;
  }
  // the notes as shown, from what's stored (raw) and, on a hidden board, the words as far as I can read them
  async noteMap(b, e) {
    const split = e.live?.hd !== undefined, next = new Map();
    for (const [id, x] of Object.entries(e.raw)) {
      const v = split && x ? { ...x, ...(e.words[id] || {}) } : x;
      const p = v?.x && this.cipher ? await this.open(this.cipher.aes, v.x, `bn:${b}:${id}`) : null;
      const n = cleanNote(v, p, split);
      if (n) next.set(id, n);
    }
    for (const [id, off] of e.wOne) if (!(id in e.raw)) { off(); e.wOne.delete(id); delete e.words[id]; }
    if (this.boards.get(b) !== e) return;
    e.notes = next; this.emit("board", b);
  }
  // a hidden board's words: everyone's once they're shown, my own notes' one by one until then
  followWords(b) {
    const e = this.boards.get(b), hd = e?.live?.hd;
    if (hd === undefined) return;
    const { fb } = backend, got = () => this.queue(() => this.noteMap(b, e));
    if (hd === false) {
      if (e.wAll) return;
      e.wOne.forEach((off) => off()); e.wOne.clear();
      e.wAll = fb.onValue(this.api.ref(`sb/${b}/w`), (s) => { e.words = s.val() || {}; got(); }, () => {});
      return;
    }
    for (const id of e.mine) {
      if (e.wOne.has(id) || !(id in e.raw)) continue;
      e.wOne.set(id, fb.onValue(this.api.ref(`sb/${b}/w/${id}`), (s) => {
        if (s.val()) e.words[id] = s.val(); else delete e.words[id];
        got();
      }, () => e.wOne.delete(id)));
    }
  }
  async openPicks(b, key, x, most) {
    if (typeof x !== "string" || !x) return [];
    return cleanPicks(this.cipher ? await this.open(this.cipher.aes, x, `bv:${b}:${key}`) : x, most);
  }
  // which notes on a board are mine, while it's open here: each one asked once
  mineOn(b, on) {
    const e = this.boards.get(b);
    if (!e) return;
    e.watch = on;
    if (on) this.askMine(b, e);
  }
  askMine(b, e) {
    if (!e.watch || e.live?.ph === "done") return;
    for (const id of e.notes.keys()) {
      if (e.asked.has(id)) continue;
      e.asked.add(id);
      backend.val(this.api.ref(`sb/${b}/nb/${id}`)).then((who) => {
        if (who === this.uid && !e.mine.has(id)) { e.mine.add(id); this.followWords(b); if (this.current) this.emit("board", b); }
      }, () => {});
    }
  }
  dropBoard(b) {
    const e = this.boards.get(b);
    if (!e) return;
    this.boards.delete(b);
    [...e.offs, e.all, e.pickOff, e.wAll, ...e.wOne.values()].forEach((f) => { try { f?.(); } catch (err) {} });
  }
  // the room went away under us: "ended", "kicked" or "left" (null if this room is no longer the one on screen)
  async whyGone() {
    const meta = await backend.val(this.api.ref("meta"));
    if (!this.current || this.gone) return null;
    if (!meta) return "ended";
    return (await backend.val(this.api.ref("banned/" + this.uid))) ? "kicked" : "left";
  }
  // the post a reported comment is under (reports/{comment}/{uid}.p), or null for a reported message
  reportPost(id) { return Object.values(this.reports?.[id] || {}).find((x) => typeof x?.p === "string")?.p || null; }
  // the board a reported note is on (reports/{note}/{uid}.b), or null
  reportBoard(id) { return Object.values(this.reports?.[id] || {}).find((x) => typeof x?.b === "string")?.b || null; }
  // a report on something still here: a message, a note on a board, or a comment whose post is (the comment itself is
  // checked when listed)
  reportLive(id) { const b = this.reportBoard(id); return b ? !!this.boards.get(b)?.notes.has(id) : this.msgs.has(this.reportPost(id) || id); }
  reportCount() { return this.isStaff() ? Object.keys(this.reports || {}).filter((id) => this.reportLive(id)).length : 0; }
}
