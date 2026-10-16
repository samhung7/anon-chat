/* The connection to Firebase: anonymous sign-in, server time, and reading and writing by path.
   Nothing else in the app loads the SDK; the rest asks this for references and values.
   ?emu runs against the local Firebase emulator (testing only). */
import { CFG, params } from "./constants.js?v=dev";
import { store, KEYS } from "./storage.js?v=dev";

if (params.has("emu")) store.set(KEYS.emu, params.get("emu") === "0" ? null : "1");
export const EMU = !!store.get(KEYS.emu);
const FB = EMU ? { apiKey: "demo-key", projectId: "demo-anon-chat", databaseURL: `http://${location.hostname}:9000?ns=demo-anon-chat` } : CFG.firebase;
const SDK = new URL("js/vendor/firebase.js", location.href).href;
// with the emulator, ?as= gives each tab its own person; links keep it
export const asParam = (sep) => (EMU && params.get("as") ? sep + "as=" + params.get("as") : "");

class Backend {
  fb = null;     // the SDK's functions
  db = null;
  uid = null;    // this device's anonymous id
  offset = 0;    // server time minus this device's clock
  #connecting = null;

  get configured() { return !!FB?.databaseURL; }
  connect() {
    if (!this.configured) return Promise.reject(new Error("no-config"));
    if (!this.#connecting) this.#connecting = (async () => {
      const fb = (this.fb = await import(SDK));
      const app = fb.initializeApp(FB);
      this.db = fb.getDatabase(app);
      if (EMU) { // local emulator: a made-up id per device (or per tab with ?as=) stands in for anonymous sign-in
        const k = KEYS.emuUid(params.get("as"));
        this.uid = store.get(k) || "emu" + Math.random().toString(36).slice(2, 12); store.set(k, this.uid);
        fb.connectDatabaseEmulator(this.db, location.hostname, 9000, { mockUserToken: { sub: this.uid, user_id: this.uid } });
      } else this.uid = (await fb.signInAnonymously(fb.getAuth(app))).user.uid;
      fb.onValue(fb.ref(this.db, ".info/serverTimeOffset"), (s) => (this.offset = s.val() || 0));
    })().catch((e) => { this.#connecting = null; throw e; });
    return this.#connecting;
  }
  now() { return Date.now() + this.offset; }
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
