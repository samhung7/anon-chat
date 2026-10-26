/* Every write to one room, by what it means. The screens call these instead of building database paths, so the
   room's layout (see the README, and tools/rules.py for who may write what) is spelled out here and in the rules
   only. Each returns the write's promise. */
import { backend } from "./backend.js?v=dev";

export class RoomApi {
  constructor(code) { this.code = code; }
  get uid() { return backend.uid; }
  ref(path = "") { return backend.roomRef(this.code, path); }
  set(path, v) { return backend.fb.set(this.ref(path), v); }
  // several paths inside the room in one write
  update(upd, path = "") { return backend.fb.update(this.ref(path), upd); }
  // several paths from the root of the database in one write (rooms/{code}/... spelled out)
  root(path) { return `rooms/${this.code}${path ? "/" + path : ""}`; }

  /* ---------- me in the room ---------- */
  setPublicKey(pk) { return this.set(`members/${this.uid}/pk`, pk); }
  // my member record (as memberRecord made it) under a new name; oldClaim is released when it's mine
  rename(rec, newClaim, oldClaim) {
    const upd = { [`names/${newClaim}`]: this.uid };
    Object.entries(rec).forEach(([k, v]) => (upd[`members/${this.uid}/${k}`] = v));
    if (oldClaim) upd[`names/${oldClaim}`] = null;
    return this.update(upd);
  }
  // count: the room's size count after I go, if it keeps one; note: the line saying I left (goneNote), written with it
  leave({ claim, count }, note = {}) {
    return backend.update({ [this.root(`members/${this.uid}`)]: null, [this.root(`push/${this.uid}`)]: null,
      ...(claim ? { [this.root(`names/${claim}`)]: null } : {}), ...(count != null ? { [this.root("meta/n")]: count } : {}), ...note });
  }
  holderOf(claim) { return backend.val(this.ref("names/" + claim)); }

  /* ---------- messages ---------- */
  react(id, k, on) { return this.set(`msgs/${id}/re/${k}/${this.uid}`, on ? true : null); }
  edit(id, fields) { return this.update(fields, "msgs/" + id); }
  // the message, and whatever goes with it (its picture, reports on it)
  remove(id, more = {}) { return this.update({ ["msgs/" + id]: null, ...more }); }
  vote(id, picks) { return this.set(`msgs/${id}/votes/${this.uid}`, picks); }
  // a poll hidden until it's revealed keeps my vote apart, where nobody else reads it before then
  hiddenVote(id, picks) { return this.set(`pv/${id}/${this.uid}`, picks); }
  // an anonymous poll: my ballot under a key of my own, which only I can tie to me; the first names the key ("" takes it back)
  ballot(id, key, picks, first) {
    return first ? this.update({ [`av/${id}/${this.uid}`]: key, [`ab/${id}/${key}`]: picks }) : this.set(`ab/${id}/${key}`, picks);
  }
  ballotKey(id) { return backend.pushKey(this.ref("ab/" + id)); }
  closePoll(id) { return this.set(`msgs/${id}/closed`, true); }
  pin(slot, id) { return this.set("meta/pins/" + slot, id); }
  // a report goes to the room's owner and co-hosts, and to StoaTalk's operator with what the reporter saw (seen: who, t, n,
  // f, enc; p: the long post a reported comment is under; b: the board a reported note is on, whose author goes unnamed)
  report(id, reason, seen) {
    const at = backend.stamp();
    return backend.update({ [this.root(`reports/${id}/${this.uid}`)]: { r: reason, at, ...(seen.p ? { p: seen.p } : {}), ...(seen.b ? { b: seen.b } : {}) },
      [`ops/reports/${this.code}_${id}_${this.uid}`]: { code: this.code, msg: id, by: this.uid, r: reason, at, ...seen } });
  }
  dismissReport(id) { return this.set("reports/" + id, null); }
  dropReports(ids) { return this.update(Object.fromEntries(ids.map((id) => [id, null])), "reports"); }
  /* ---------- comments under a long post ---------- */
  reactComment(pid, id, k, on) { return this.set(`pc/${pid}/${id}/re/${k}/${this.uid}`, on ? true : null); }
  // the comment and its place in the post's card; a host also clears any reports on it
  removeComment(pid, id, staff) { return this.update({ [`pc/${pid}/${id}`]: null, [`msgs/${pid}/cc/${id}`]: null, ...(staff ? { ["reports/" + id]: null } : {}) }); }
  // where I say I'm typing: in the room, or in a private chat (pair)
  typingRef(pair) { return this.ref(pair ? `dmt/${pair}/${this.uid}` : `typing/${this.uid}`); }

  /* ---------- the owner and co-hosts ---------- */
  setMeta(fields) { return this.update(fields, "meta"); }
  setCount(n) { return this.set("meta/n", n); }
  setMod(id, on) { return this.set(`meta/mods/${id}`, on ? true : null); }
  // the owner hands the room to someone in it, and stays on as a co-host
  transfer(to) { return this.setMeta({ owner: to, [`mods/${to}`]: null, [`mods/${this.uid}`]: true }); }
  // remove someone, who can't come back; claim: their nickname, freed if it's theirs; count: the size count after;
  // note: the line saying they were removed (goneNote), written with it
  kick(id, { claim, count, unmod }, note = {}) {
    const upd = { [this.root(`members/${id}`)]: null, [this.root(`banned/${id}`)]: true, ...note };
    if (claim) upd[this.root(`names/${claim}`)] = null;
    if (count != null) upd[this.root("meta/n")] = count;
    if (unmod) upd[this.root(`meta/mods/${id}`)] = null;
    return backend.update(upd);
  }
  end() { return backend.update({ [`rooms/${this.code}`]: null }); }

  /* ---------- lecture Q&A ---------- */
  upvote(id, on) { return this.set(`qs/${id}/up/${this.uid}`, on ? true : null); }
  // a waiting question goes out word for word
  approve(id, q) { return this.update({ ["qs/" + id]: q, ["qq/" + id]: null }); }
  removeQuestion(id, { waiting, clearNow }) {
    const upd = { [(waiting ? "qq/" : "qs/") + id]: null };
    if (clearNow) upd["meta/qnow"] = null;
    return this.update(upd);
  }
  markDone(id, on, clearNow) {
    const upd = { [`qs/${id}/done`]: on ? backend.stamp() : null };
    if (clearNow) upd["meta/qnow"] = null;
    return this.update(upd);
  }
  // saving an answer also marks the question answered, unless it already is
  answer(id, ans, markDone) {
    const upd = { [`qs/${id}/ans`]: ans };
    if (markDone) upd[`qs/${id}/done`] = backend.stamp();
    return this.update(upd);
  }
  deleteAnswer(id) { return this.set(`qs/${id}/ans`, null); }
  setQNow(id) { return this.set("meta/qnow", id); }

  /* ---------- mini-games ---------- */
  // my score for a game of the day: written once, never changed
  gameScore(day, g, rec) { return this.set(`games/${day}/${g}/${this.uid}`, rec); }

  /* ---------- quizzes (quiz.js; the layout is in tools/rules.py QUIZ) ---------- */
  quizJoin(z, rec) { return this.set(`qz/${z}/p/${this.uid}`, rec); }
  // a player leaves, or a host takes one out
  quizDrop(z, uid = this.uid) { return this.set(`qz/${z}/p/${uid}`, null); }
  // my answer to question i: once, while answering is open
  quizAnswer(z, i, rec) { return this.set(`qz/${z}/a/${i}/${this.uid}`, rec); }
  // a host moves the quiz on (fields under qz/{z}), which keeps the room going like a message does
  quizStep(z, fields) {
    return this.update({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`qz/${z}/${k}`, v])), "meta/last": backend.stamp() });
  }

  /* ---------- sticky-note boards (sticky.js; the layout is in tools/rules.py BOARD) ---------- */
  // a host moves the board on, or changes its columns (fields under sb/{b})
  boardStep(b, fields) { return this.update(Object.fromEntries(Object.entries(fields).map(([k, v]) => [`sb/${b}/${k}`, v]))); }
  // a new note, with who wrote it apart, stamped like a message (posting is rate-limited: composer.js posts.write takes it);
  // as paths from the root. On a hidden board its words (w) go apart from it
  newNote(b, id, note, w) {
    const T = backend.stamp();
    return { [this.root(`sb/${b}/n/${id}`)]: { ...note, at: T }, [this.root(`sb/${b}/nb/${id}`)]: this.uid, ...(w ? { [this.root(`sb/${b}/w/${id}`)]: w } : {}),
      [this.root(`members/${this.uid}/ls`)]: T, [this.root(`members/${this.uid}/ln`)]: id, [this.root("meta/last")]: T };
  }
  // its author changes it (at stays as it was)
  editNote(b, id, note, w) { return w ? this.update({ [`n/${id}`]: note, [`w/${id}`]: w }, `sb/${b}`) : this.set(`sb/${b}/n/${id}`, note); }
  // where it sits: its column and its place there
  moveNote(b, id, k, o) { return this.update({ [`n/${id}/k`]: k, [`n/${id}/o`]: o }, `sb/${b}`); }
  // its author takes it back, or a host takes any note down: with who wrote it, its words (on a hidden board) and any
  // reports on it
  dropNote(b, id, staff) {
    return this.update({ [`sb/${b}/n/${id}`]: null, [`sb/${b}/nb/${id}`]: null, [`sb/${b}/w/${id}`]: null, ...(staff ? { [`reports/${id}`]: null } : {}) });
  }
  // my votes under my own key; the first names the key
  boardVote(b, key, picks, first) { return this.update({ ...(first ? { [`bk/${this.uid}`]: key } : {}), [`v/${key}`]: picks }, `sb/${b}`); }
  voteKey(b) { return backend.pushKey(this.ref(`sb/${b}/v`)); }
}
