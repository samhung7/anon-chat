/* The connection to Firebase: anonymous sign-in, server time, and reading and writing by path.
   Nothing else in the app loads the SDK; the rest asks this for references and values. Someone may have tied
   their id to a Google account (account.js), which keeps it on every device they sign in on.
   ?emu runs against the local Firebase emulator (testing only). */
import { CFG, params } from "./constants.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";

if (params.has("emu")) store.set(KEYS.emu, params.get("emu") === "0" ? null : "1");
export const EMU = !!store.get(KEYS.emu);
const FB = EMU ? { apiKey: "demo-key", projectId: "demo-anon-chat", databaseURL: `http://${location.hostname}:9000?ns=demo-anon-chat` } : CFG.firebase;
const SDK = new URL("js/vendor/firebase.js", location.href).href;
// where photos go: our upload service and the public host it stores them on (a local stand-in with the emulator)
export const PHOTOS = EMU ? { api: `http://${location.hostname}:8787`, host: `http://${location.hostname}:8787` } : CFG.photos || null;
// with the emulator, ?as= gives each tab its own person; links keep it
export const asParam = (sep) => (EMU && params.get("as") ? sep + "as=" + params.get("as") : "");

class Backend {
  fb = null;     // the SDK's functions
  db = null;
  auth = null;
  uid = null;    // this device's anonymous id, or the Google account's (the same on each device signed in with it)
  user = null;   // the signed-in user, for an ID token (not with the emulator)
  google = null; // the Google account this id is tied to, { email, name }, or null
  offset = 0;    // server time minus this device's clock
  signedIn = []; // what runs once signed in, before connect() resolves (account.js: what the account keeps)
  #connecting = null;
  #paused = false;

  get configured() { return !!FB?.databaseURL; }
  connect() {
    if (!this.configured) return Promise.reject(new Error("no-config"));
    this.resume();
    if (!this.#connecting) this.#connecting = (async () => {
      const fb = (this.fb = await import(SDK));
      const app = fb.initializeApp(FB);
      this.db = fb.getDatabase(app);
      if (EMU) { // local emulator: a made-up id per device (or per tab with ?as=) stands in for anonymous sign-in
        const k = KEYS.emuUid(params.get("as"));
        this.uid = store.get(k) || "emu" + Math.random().toString(36).slice(2, 12); store.set(k, this.uid);
        const email = store.get(KEYS.emuGoogle(params.get("as"))); // a made-up Google account (account.js)
        this.google = email ? { email, name: email.split("@")[0] } : null;
        fb.connectDatabaseEmulator(this.db, location.hostname, 9000, { mockUserToken: { sub: this.uid, user_id: this.uid,
          ...(email ? { email, firebase: { sign_in_provider: "google.com" } } : {}) } });
      } else { // the same places getAuth keeps the sign-in, so every device keeps its id (and with it its rooms)
        const auth = (this.auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence, fb.browserSessionPersistence] }));
        // someone signed in with Google stays so: signing in anonymously over them would give them a new id
        await auth.authStateReady();
        this.user = auth.currentUser || (await fb.signInAnonymously(auth)).user; this.uid = this.user.uid;
        const g = this.user.providerData.find((p) => p.providerId === "google.com");
        this.google = g ? { email: g.email || this.user.email || "", name: g.displayName || "" } : null;
      }
      fb.onValue(fb.ref(this.db, ".info/serverTimeOffset"), (s) => (this.offset = s.val() || 0));
      for (const f of this.signedIn) await f();
    })().catch((e) => { this.#connecting = null; throw e; });
    return this.#connecting;
  }
  /* Every open page holds a connection, and the free plan allows only 100 at once: when they're all taken, the
     database turns new ones away and the SDK keeps retrying without ever failing, so a page nothing needs lets go. */
  pause() { if (this.db && !this.#paused) { this.#paused = true; this.fb.goOffline(this.db); } }
  resume() { if (this.#paused) { this.#paused = false; this.fb.goOnline(this.db); } }
  now() { return Date.now() + this.offset; }
  // proof of who this is for our own server (the photo service); the emulator's is unsigned, like the SDK's mock token
  idToken() {
    if (this.user) return this.user.getIdToken();
    const enc = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const iat = Math.floor(Date.now() / 1000);
    return Promise.resolve(enc({ alg: "none", type: "JWT" }) + "." + enc({ iss: `https://securetoken.google.com/${FB.projectId}`, aud: FB.projectId,
      iat, exp: iat + 3600, auth_time: iat, sub: this.uid, user_id: this.uid, firebase: { sign_in_provider: "anonymous", identities: {} } }) + ".");
  }
  // the emulator's database as its owner, past the rules: what stands in for Google's own records there (account.js)
  emuOwner(path, method = "GET", body) {
    return fetch(`http://${location.hostname}:9000/${path}.json?ns=${FB.projectId}`, { method, headers: { Authorization: "Bearer owner" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  }
  // "the server's time" in a write
  stamp() { return this.fb.serverTimestamp(); }
  ref(path) { return path ? this.fb.ref(this.db, path) : this.fb.ref(this.db); }
  roomRef(code, path = "") { return this.ref(`rooms/${code}${path ? "/" + path : ""}`); }
  // the value at a reference, or `failed` when it can't be read
  val(ref, failed = null) { return this.fb.get(ref).then((s) => s.val(), () => failed); }
  // several paths from the root in one write, all or nothing
  update(upd) { return this.fb.update(this.ref(), upd); }
  pushKey(ref) { return this.fb.push(ref).key; }
  // usage, counted anonymously: one more of something today (stats/{day}/{what}); no content, no ids
  stat(what) { if (this.db) this.fb.set(this.ref(`stats/${new Date(this.now()).toISOString().slice(0, 10)}/${what}`), this.fb.increment(1)).catch(() => {}); }
}
export const backend = new Backend();
export const isDenied = (e) => /permission/i.test(e?.message || "");
// p, or a "timeout" error once ms go by: the SDK waits for the server forever (the work itself carries on)
export const within = (p, ms) => new Promise((ok, no) => { const id = setTimeout(() => no(new Error("timeout")), ms); p.then((v) => { clearTimeout(id); ok(v); }, (e) => { clearTimeout(id); no(e); }); });
// the server is out of reach or turning people away (all connections taken, too many new sign-ins from one network)
export const isBusy = (e) => e?.message === "timeout" || e?.code === "auth/too-many-requests" || e?.code === "auth/quota-exceeded";
