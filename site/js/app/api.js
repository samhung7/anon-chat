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
  // count: the room's size count after I go, if it keeps one
  leave({ claim, count }) {
    return backend.update({ [this.root(`members/${this.uid}`)]: null, [this.root(`push/${this.uid}`)]: null,
      ...(claim ? { [this.root(`names/${claim}`)]: null } : {}), ...(count != null ? { [this.root("meta/n")]: count } : {}) });
  }
  holderOf(claim) { return backend.val(this.ref("names/" + claim)); }

  /* ---------- messages ---------- */
  react(id, k, on) { return this.set(`msgs/${id}/re/${k}/${this.uid}`, on ? true : null); }
  edit(id, fields) { return this.update(fields, "msgs/" + id); }
  // the message, and whatever goes with it (its picture, reports on it)
  remove(id, more = {}) { return this.update({ ["msgs/" + id]: null, ...more }); }
  vote(id, picks) { return this.set(`msgs/${id}/votes/${this.uid}`, picks); }
  closePoll(id) { return this.set(`msgs/${id}/closed`, true); }
  pin(slot, id) { return this.set("meta/pins/" + slot, id); }
  // a report goes to the room's owner and co-hosts, and to StoaTalk's operator with what the reporter saw (seen: t, n, f, enc;
  // p: the long post a reported comment is under)
  report(id, reason, seen) {
    const at = backend.stamp();
    return backend.update({ [this.root(`reports/${id}/${this.uid}`)]: { r: reason, at, ...(seen.p ? { p: seen.p } : {}) },
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
  // remove someone, who can't come back; claim: their nickname, freed if it's theirs; count: the size count after
  kick(id, { claim, count, unmod }) {
    const upd = { [`members/${id}`]: null, [`banned/${id}`]: true };
    if (claim) upd[`names/${claim}`] = null;
    if (count != null) upd["meta/n"] = count;
    if (unmod) upd[`meta/mods/${id}`] = null;
    return this.update(upd);
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
}
