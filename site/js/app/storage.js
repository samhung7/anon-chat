/* What this device keeps: localStorage, which may be missing or full (private windows, Safari's limits), so
   nothing here ever throws unless asked to. Every key the app uses is named in KEYS. */
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  // the same, but a full storage throws, for callers that tell the person
  setOrThrow: (k, v) => localStorage.setItem(k, v),
  json: (k) => { try { return JSON.parse(store.get(k)); } catch (e) { return null; } },
};

export const KEYS = {
  me: "chat-me",                       // nickname and animal
  dh: "chat-dh",                       // the key pair for private messages
  rooms: "chat-rooms",                 // rooms this device is in, newest first
  roomsSeen: "chat-rooms-seen",        // the home list as last checked
  oldRoom: "chat-room",                // the single room kept before the list
  blocked: "chat-blocked",
  notifyAsked: "chat-notify-asked",
  push: "chat-push",                   // this browser's push subscription as the push service sealed it
  askAnon: "chat-ask-anon",
  lang: "chat-lang",
  records: "chat-records",
  emu: "chat-emu",
  emuUid: (as) => "chat-emu-uid" + (as || ""),
  record: (id) => "chat-record:" + id,
  roomKey: (code) => "chat-key:" + code,   // an encrypted room's key
  mute: (code) => "chat-mute:" + code,
  descHidden: (code) => "chat-desc-hidden:" + code, // the room description this device hid from above the chat
  read: (code) => "chat-read:" + code,     // read up to here in the room
  dmRead: (code, other) => `chat-dmread:${code}:${other}`,
  myQs: (code) => "chat-myq:" + code,      // questions this device asked
};

// a list kept as JSON under one key; anything that isn't a list, or entries that don't pass `valid`, read as absent
export class StoredList {
  constructor(key, valid = (x) => typeof x === "string") { this.key = key; this.valid = valid; }
  all() { const l = store.json(this.key); return Array.isArray(l) ? l.filter(this.valid) : []; }
  includes(x) { return this.all().includes(x); }
  save(list) { store.set(this.key, JSON.stringify(list)); }
}
