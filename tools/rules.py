"""Writes database.rules.json. The rules are kept here because JSON can't hold readable multi-line conditions.
Run: python3 tools/rules.py"""
import json, pathlib

DAY = "86400000"
QUIET = "20000"   # a room's messages are announced by Web Push at most this often (ms; worker/src/index.js agrees)
GAP = "800"   # the shortest time between two messages from one person (ms): stops a script from flooding a room
ROOM = "data.parent().parent()"           # from rooms/$code/<x>/$y
NEWROOM = "newData.parent().parent()"
def j(*parts): return " && ".join(f"({p})" for p in parts)
def o(*parts): return " || ".join(f"({p})" for p in parts)
# the owner, and the co-hosts the owner names (meta/mods); co-hosts remove messages and people, but not the owner or each other
is_owner = lambda room: f"{room}.child('meta/owner').val() === auth.uid"
is_mod = lambda room: f"{room}.child('meta/mods/' + auth.uid).val() === true"
is_staff = lambda room: o(is_owner(room), is_mod(room))
# StoaTalk's operator (ops/admins/{uid} = true, set by hand in the Firebase console) handles reports from every room:
# takes messages down, removes people, ends rooms, and bans someone everywhere (bans/{uid})
is_admin = "root.child('ops/admins/' + auth.uid).val() === true"
not_banned = "!root.child('bans/' + auth.uid).exists()"
can_manage = lambda room, target: o(is_owner(room), j(is_mod(room), f"{target} !== {room}.child('meta/owner').val()", f"{room}.child('meta/mods/' + {target}).val() !== true"))

stale = f"data.child('meta/last').val() < now - {DAY}"
fresh_room = o("!data.exists()", stale)

room_write = o(
    # owner ends the room, or anyone clears a room idle for 24 hours
    j("!newData.exists()", o("data.child('meta/owner').val() === auth.uid", stale, is_admin)),
    # creating (or taking over a stale code): the creator is inside, and no old content comes along
    j(fresh_room, not_banned, "newData.child('meta/owner').val() === auth.uid", "newData.child('members/' + auth.uid).exists()",
      "!newData.child('msgs').exists()", "!newData.child('files').exists()", "!newData.child('dm').exists()", "!newData.child('banned').exists()",
      "!newData.child('reports').exists()", "!newData.child('qs').exists()", "!newData.child('qq').exists()", "!newData.child('qby').exists()",
      "!newData.child('push').exists()"),
)

member_join = j(
    f"{ROOM}.child('meta').exists()",
    f"{ROOM}.child('meta/last').val() >= now - {DAY}",
    f"{ROOM}.child('meta/locked').val() !== true",
    # a room with a size limit (meta/cap) counts its members in meta/n: joining adds one, within the limit
    o(f"!{ROOM}.child('meta/cap').exists()",
      j(f"{NEWROOM}.child('meta/n').val() === {ROOM}.child('meta/n').val() + 1", f"{NEWROOM}.child('meta/n').val() <= {ROOM}.child('meta/cap').val()")),
    f"{ROOM}.child('meta/priv').val() !== true",   # an old password room, while it lasts: nobody new gets in
)
member_write = o(
    # (someone banned everywhere can still leave)
    j("auth.uid === $uid", f"!{ROOM}.child('banned/' + $uid).exists()", o("!newData.exists()", not_banned), o("data.exists()", member_join)),
    j("!newData.exists()", o(can_manage(ROOM, "$uid"), is_admin)),   # the owner or a co-host removes someone
)

is_member = lambda room: f"{room}.child('members/' + auth.uid).exists()"
# Posting is rate-limited: the same update must stamp the poster's ls (last sent, at most every GAP ms) and name
# this message in lm (a photo's picture in lf), so one write can't carry a pile of messages either.
sent_now = lambda room, field: j(f"{room}.child('members/' + auth.uid + '/ls').val() === now", f"{room}.child('members/' + auth.uid + '/{field}').val() === $id")
post_write = lambda field: j("auth != null", o(j(is_member(ROOM), o(
    j("!data.exists()", not_banned, "newData.child('by').val() === auth.uid", sent_now(NEWROOM, field)),
    # the author deletes a message; so do the owner and co-hosts (free accounts too: every room needs a way to take abuse down)
    j("!newData.exists()", o("data.child('by').val() === auth.uid", is_staff(ROOM))),
)), j("!newData.exists()", is_admin)))   # StoaTalk's operator takes a message down, acting on a report
msg_write, file_write = post_write("lm"), post_write("lf")
DMROOM = "data.parent().parent().parent()"
dm_write = j(
    "auth != null", "!data.exists()", not_banned, "newData.child('by').val() === auth.uid", sent_now("newData.parent().parent().parent()", "lm"),
    o("$pair === auth.uid + '_' + newData.child('to').val()", "$pair === newData.child('to').val() + '_' + auth.uid"),
    is_member(DMROOM), f"{DMROOM}.child('members/' + newData.child('to').val()).exists()",
)

S = lambda n: f"newData.isString() && newData.val().length <= {n}"
NO = {".validate": False}

# one nickname per room: names/{lowercased name} = uid. Claim a free name, or one whose holder has left;
# give back your own; the owner clears the name of someone they remove.
holder_gone = f"!{ROOM}.child('members/' + data.val()).exists()"
names_write = j("auth != null", o(
    j("newData.val() === auth.uid", o("!data.exists()", "data.val() === auth.uid", holder_gone)),
    j("!newData.exists()", o("data.val() === auth.uid", holder_gone, can_manage(ROOM, "data.val()"))),
))
# An encrypted room (meta/enc) keeps its title, nicknames and messages as ciphertext ("x", "xt") sealed with a key
# that only travels in the invite link; the server can check sizes and who wrote what, never the content.
ENC = lambda room: f"({room}.child('meta/enc').val() === true)"
MEMBER_ROOM = "newData.parent().parent().parent()"   # from rooms/$code/members/$uid/<field>
name_rule = {".validate": j(S(24), "newData.val().length > 0", r"!newData.val().matches(/[.#$\[\]\/]/)", "!" + ENC(MEMBER_ROOM),
                            "newData.parent().parent().parent().child('names/' + newData.val().toLowerCase()).val() === $uid")}
# in an encrypted room the nickname's claim is a keyed hash of it (h), so names stay unique without the server seeing them
hash_rule = {".validate": j(S(24), r"newData.val().matches(/^[0-9a-f]{24}$/)", ENC(MEMBER_ROOM),
                            f"{MEMBER_ROOM}.child('names/' + newData.val()).val() === $uid")}
PUSH_ID = r"newData.isString() && newData.val().matches(/^[A-Za-z0-9_-]{1,32}$/)"   # a message's key
SEALED = lambda n: S(n) + r" && newData.val().matches(/^[A-Za-z0-9_-]+$/)"
# a GIF picked from the KLIPY search; only images hosted by KLIPY, so nobody can post an arbitrary tracking image
GIF = {
    ".validate": "newData.hasChildren(['url', 'w', 'h'])",
    "url": {".validate": S(500) + r" && newData.val().matches(/^https:\/\/([a-z0-9-]+\.)*klipy\.com\//)"},
    "w": {".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 2000"},
    "h": {".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 2000"},
    "title": {".validate": S(120)},
    "$other": NO,
}
NOT_ENC = " && !" + ENC(MEMBER_ROOM)   # from rooms/$code/msgs/$id/<field>
NONEMPTY = lambda n: S(n) + " && newData.val().length > 0"
# a list kept as an object with keys 0, 1, 2, ... (what the SDK writes for an array)
LIST = lambda key_re, item: {"$i": {".validate": f"$i.matches({key_re}) && " + item}}
# a photo: the message points at its picture, kept apart under files/ so the message list stays small
IMG = {
    ".validate": "newData.hasChildren(['f', 'w', 'h'])" + NOT_ENC,
    # the picture is already there (written in the same update) and is the author's own
    "f": {".validate": PUSH_ID + " && newData.parent().parent().parent().parent().child('files/' + newData.val() + '/by').val() === auth.uid"},
    "w": {".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 4000"},
    "h": {".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 4000"},
    "$other": NO,
}
# a poll: a question, 2 to 10 options, and whether each person may pick more than one (m)
POLL = {
    ".validate": "newData.hasChildren(['q', 'o', 'm']) && newData.child('o/1').exists()" + NOT_ENC,
    "q": {".validate": NONEMPTY(200)},
    "o": LIST("/^[0-9]$/", NONEMPTY(80)),
    "m": {".validate": "newData.isBoolean()"},
    "$other": NO,
}
# a draw: who took part (p) and who was drawn (w), as member ids, and what it was for (t)
DRAW = {
    ".validate": "newData.hasChildren(['p', 'w'])" + NOT_ENC,
    "t": {".validate": S(60)},
    "p": LIST("/^[0-9]{1,3}$/", S(128)),
    "w": LIST("/^[0-9]{1,3}$/", S(128)),
    "$other": NO,
}
MSG_ROOM = "newData.parent().parent().parent().parent()"   # from rooms/$code/msgs/$id/votes/$uid
# a vote: the options picked, as "0" or "0,2"; sealed in an encrypted room. Only one option unless the poll allows more.
VOTE = {
    ".write": j("auth != null", "auth.uid === $uid", is_member("data.parent().parent().parent().parent()"),
                "data.parent().parent().child('closed').val() !== true"),
    ".validate": o(j(ENC(MSG_ROOM), SEALED(200)),
                   j("!" + ENC(MSG_ROOM), "newData.parent().parent().child('poll').exists()",
                     o(r"newData.isString() && newData.val().matches(/^[0-9]$/)",
                       j("newData.parent().parent().child('poll/m').val() === true", r"newData.isString() && newData.val().matches(/^[0-9](,[0-9]){1,9}$/)")))),
}
# the author edits a message's words: text in a plain room, the sealed x in an encrypted one; ed marks when
EDIT_ROOM = "data.parent().parent().parent()"   # from rooms/$code/msgs/$id/<field>
edit_write = j("auth != null", "data.parent().child('by').val() === auth.uid", is_member(EDIT_ROOM))
edit_field = j(edit_write, "data.exists()", "newData.exists()")
# a report: one per person per message, with a reason (0 harassment, 1 spam, 2 inappropriate, 3 other), read by the owner and co-hosts
REP_ROOM = "data.parent().parent().parent()"   # from rooms/$code/reports/$msg/$uid
REPORT = {
    ".write": j("auth != null", o(
        j("auth.uid === $uid", "!data.exists()", "newData.exists()", is_member(REP_ROOM), f"{REP_ROOM}.child('msgs/' + $msg).exists()"),
        j("!newData.exists()", is_staff(REP_ROOM)))),
    ".validate": "newData.hasChildren(['r', 'at'])",
    "r": {".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 3"},
    "at": {".validate": "newData.val() === now"},
    "$other": NO,
}
# "someone is typing": a server time, refreshed while they type, removed when they stop (or go)
TYPING = lambda room, extra="true": {
    ".write": j("auth != null", "auth.uid === $uid", o("!newData.exists()", j(is_member(room), extra))),
    ".validate": "newData.val() === now",
}
# Q&A (a lecture's questions, meta/qa on): qs/{id} are the questions everyone sees and upvotes; with meta/qmod on, a
# new question waits in qq/{id} until the owner or a co-host lets it through. A question names no author: who asked
# sits apart in qby/{id}, which only the asker can read, so a question can be anonymous even to the owner (and the
# asker can still take it back). Asking is rate-limited like posting, with lq naming the question.
QROOM = "root.child('rooms/' + $code)"
# (the owner's and co-hosts' own questions skip review)
q_on = lambda queued: j(f"{QROOM}.child('meta/qa').val() === true",
                        f"{QROOM}.child('meta/qmod').val() === true" if queued else o(f"{QROOM}.child('meta/qmod').val() !== true", is_staff(QROOM)))
q_ask = lambda queued: j("!data.exists()", not_banned, q_on(queued), f"!{QROOM}.child('qby/' + $id).exists()",
                         "newData.parent().parent().child('qby/' + $id).val() === auth.uid", sent_now("newData.parent().parent()", "lq"))
q_take_back = j("!newData.exists()", o(is_staff(QROOM), f"{QROOM}.child('qby/' + $id).val() === auth.uid"))
QUEUED = lambda f: f"newData.child('{f}').val() === {QROOM}.child('qq/' + $id + '/{f}').val()"
q_approve = j("!data.exists()", is_staff(QROOM), f"{QROOM}.child('qq/' + $id).exists()", "!newData.parent().parent().child('qq/' + $id).exists()",
              *[QUEUED(f) for f in ("text", "x", "name", "avatar", "at")])
Q_ENC = ENC(QROOM)
QUESTION = lambda extra: dict({
    ".validate": j("newData.hasChild('at')", o(j(Q_ENC, "newData.hasChild('x')", "!newData.hasChild('text')"), j("!" + Q_ENC, "newData.hasChild('text')"))),
    "text": {".validate": NONEMPTY(300) + " && !" + Q_ENC},
    "name": {".validate": S(24) + " && !" + Q_ENC}, "avatar": {".validate": S(8) + " && !" + Q_ENC},   # left out to ask anonymously
    "x": {".validate": SEALED(2000) + " && " + Q_ENC},   # {t, n?, a?} sealed to the question's id
    "at": {".validate": "newData.val() === now || newData.val() === data.val() || newData.val() === " + QROOM + ".child('qq/' + $id + '/at').val()"},
    "$other": NO,
}, **extra)
rules = {"rules": {
    ".read": False, ".write": False,
    "rooms": {
        ".indexOn": ["meta/last"],
        "$code": {
            ".write": j("auth != null", room_write),
            ".validate": j("$code.matches(/^[2-9A-HJKMNP-Z]{4}$/)", "newData.hasChild('meta')"),
            "meta": {
                ".read": "auth != null",
                ".write": "auth != null && data.child('owner').val() === auth.uid",
                # once encrypted, a room stays encrypted (until its code is reused after 24 idle hours)
                ".validate": j("newData.hasChildren(['owner', 'created', 'last'])",
                               o("!data.child('enc').exists()", "newData.child('enc').val() === data.child('enc').val()", f"data.child('last').val() < now - {DAY}")),
                # the owner can hand the room to someone in it
                "owner": {".validate": "newData.isString() && " + o("newData.val() === auth.uid", "newData.val() === data.val()",
                                                                   j("data.val() === auth.uid", "newData.parent().parent().child('members/' + newData.val()).exists()"))},
                "created": {".validate": "newData.isNumber()"},
                "last": {".write": f"auth != null && newData.parent().parent().child('members/' + auth.uid).exists()",
                         ".validate": "newData.val() === now"},
                "priv": {".validate": "newData.val() === false"},   # true only on old password rooms; pages from before still send false
                "locked": {".validate": "newData.isBoolean()"},
                "title": {".validate": S(40) + " && newData.parent().child('enc').val() !== true"},
                "enc": {".validate": "newData.isBoolean()"},
                "kc": {".validate": S(32)},   # lets a joiner tell a wrong key from a right one
                "xt": {".validate": SEALED(400) + " && newData.parent().child('enc').val() === true"},
                # what the room is for, shown under its name; the owner or a co-host writes it (sealed as xd in an encrypted room;
                # 500 characters sealed take at most about 4,100)
                "desc": {".write": "auth != null && (" + is_staff("data.parent().parent()") + ")",
                         ".validate": S(500) + " && newData.val().length > 0 && newData.parent().child('enc').val() !== true"},
                "xd": {".write": "auth != null && (" + is_staff("data.parent().parent()") + ")",
                       ".validate": SEALED(4200) + " && newData.parent().child('enc').val() === true"},
                # up to three messages the owner pins as announcements, one per slot
                "pins": {"$slot": {".validate": "$slot.matches(/^[0-2]$/) && " + PUSH_ID}},
                "mods": {"$uid": {".validate": "newData.val() === true"}},
                "qa": {".validate": "newData.isBoolean()"}, "qmod": {".validate": "newData.isBoolean()"},
                # the question being answered now, shown large on the projector; the owner or a co-host picks it
                "qnow": {".write": "auth != null && (" + is_staff("data.parent().parent()") + ")", ".validate": PUSH_ID},
                # when a message here was last announced by Web Push: any member stamps it, at most every 20 seconds, before
                # asking the push service (worker/) to announce theirs, so a busy room sends one push now and then, not one a message
                "pa": {".write": f"auth != null && data.parent().parent().child('members/' + auth.uid).exists() && (!data.exists() || data.val() < now - {QUIET})",
                       ".validate": "newData.val() === now"},
                "cap": {".validate": "newData.isNumber() && newData.val() >= 2 && newData.val() <= 1000"},
                # members counted while there's a size limit: each person adds or removes themselves; the owner sets it
                "n": {".write": j("auth != null", o(
                          j("newData.val() === data.val() + 1", "newData.parent().parent().child('members/' + auth.uid).exists()", "!data.parent().parent().child('members/' + auth.uid).exists()"),
                          j("newData.val() === data.val() - 1", o(j("!newData.parent().parent().child('members/' + auth.uid).exists()", "data.parent().parent().child('members/' + auth.uid).exists()"),
                                                                  is_mod("data.parent().parent()"))))),
                      ".validate": "newData.isNumber() && newData.val() >= 0"},
                "$other": NO,
            },
            "members": {
                ".read": "auth != null && data.child(auth.uid).exists()",
                "$uid": {
                    ".write": j("auth != null", member_write),
                    ".validate": "newData.hasChild('joined') && (newData.hasChildren(['name', 'avatar']) || newData.hasChildren(['x', 'h']))",
                    "name": name_rule,
                    "avatar": {".validate": S(8) + " && !" + ENC(MEMBER_ROOM)},
                    "x": {".validate": SEALED(600) + " && " + ENC(MEMBER_ROOM)},
                    "h": hash_rule,
                    "pk": {".validate": SEALED(120)},   # public key for end-to-end encrypted private messages
                    "joined": {".validate": "newData.isNumber()"},
                    "ls": {".validate": f"newData.val() === now && (!data.exists() || data.val() < now - {GAP})"},
                    "lm": {".validate": PUSH_ID}, "lf": {".validate": PUSH_ID}, "lq": {".validate": PUSH_ID},
                    "online": {".validate": "newData.isBoolean()"},
                    "$other": NO,
                },
            },
            "names": {"$key": {
                ".read": "auth != null",
                ".write": names_write,
                ".validate": "newData.isString() && $key.length <= 24"}},
            # what's left of password rooms can only be cleared (pages from before still clear it as they leave or end a room)
            "keys": {"$uid": {".write": "auth != null && auth.uid === $uid && !newData.exists()"}},
            "banned": {"$uid": {
                ".read": "auth != null && auth.uid === $uid",
                ".write": "auth != null && (" + o(can_manage(ROOM, "$uid"), is_admin) + ")",
                ".validate": "newData.val() === true"}},
            "msgs": {
                ".read": "auth != null && data.parent().child('members/' + auth.uid).exists()",
                "$id": {
                    ".write": msg_write,
                    ".validate": j("newData.hasChildren(['by', 'at'])", o(
                        j(ENC("newData.parent().parent()"), "newData.hasChild('x')"),
                        j("!" + ENC("newData.parent().parent()"), "newData.hasChildren(['name', 'avatar'])", o(*[f"newData.hasChild('{k}')" for k in ("text", "gif", "img", "poll", "draw")])))),
                    "by": {".validate": "newData.isString()"},
                    "name": {".validate": S(24) + " && !" + ENC(MEMBER_ROOM)},
                    "avatar": {".validate": S(8) + " && !" + ENC(MEMBER_ROOM)},
                    "text": {".write": edit_field, ".validate": S(1000) + " && newData.val().length > 0 && !" + ENC(MEMBER_ROOM)},
                    "gif": dict(GIF, **{".validate": GIF[".validate"] + " && !" + ENC(MEMBER_ROOM)}),
                    "img": IMG, "poll": POLL, "draw": DRAW,
                    "x": {".write": edit_field, ".validate": SEALED(12000)},
                    "ed": {".write": j(edit_write, "data.parent().exists()"), ".validate": "newData.val() === now"},
                    "rp": {".validate": PUSH_ID + " && !" + ENC(MEMBER_ROOM)},   # the message this one replies to (sealed inside x when encrypted)
                    "at": {".validate": "newData.val() === now || newData.val() === data.val()"},
                    "re": {"$k": {
                        ".validate": "$k.matches(/^[0-5]$/)",
                        "$uid": {".write": "auth != null && auth.uid === $uid && " + is_member("data.parent().parent().parent().parent().parent()"),
                                 ".validate": "newData.val() === true"}}},
                    "votes": {"$uid": VOTE},
                    # the poll's author closes it; votes stop
                    "closed": {".write": "auth != null && data.parent().child('by').val() === auth.uid", ".validate": "newData.val() === true"},
                    "$other": NO,
                },
            },
            # photos, one marker per picture: who sent it and when. The picture itself is in R2, put there by the photo
            # service (worker/), which only takes one from a member and only deletes one whose marker is gone.
            # Older markers also carry the bytes (d); they're still read and deleted, but no new one can be written.
            "files": {
                ".read": "auth != null && data.parent().child('members/' + auth.uid).exists()",
                "$id": {
                    ".write": file_write,
                    ".validate": "newData.hasChildren(['by', 'at'])",
                    "by": {".validate": "newData.isString()"},
                    "at": {".validate": "newData.val() === now"},
                    "$other": NO,
                },
            },
            "dm": {"$pair": {
                ".read": "auth != null && ($pair.beginsWith(auth.uid + '_') || $pair.endsWith('_' + auth.uid)) && " + is_member("data.parent().parent()"),
                "$id": {
                    ".write": dm_write,
                    # private messages are always end-to-end encrypted (a key the two derive from each other's pk)
                    ".validate": "newData.hasChildren(['by', 'to', 'at', 'x'])",
                    "by": {".validate": "newData.isString()"},
                    "to": {".validate": "newData.isString()"},
                    "x": {".validate": SEALED(4000)},
                    "at": {".validate": "newData.val() === now"},
                    "$other": NO,
                }}},
            "reports": {
                ".read": "auth != null && (" + is_staff("data.parent()") + ")",
                "$msg": {".write": "auth != null && !newData.exists() && (" + o(is_staff("data.parent().parent()"), is_admin) + ")", "$uid": REPORT}},
            # Web Push: each member who wants notifications while the page is closed leaves their browser's push
            # subscription here, sealed by the push service (worker/) so other members can't use it; the service reads
            # them with the sender's own sign-in when a message goes out. Gone when they mute the room or leave.
            "push": {
                ".read": "auth != null && data.parent().child('members/' + auth.uid).exists()",
                "$uid": {
                    ".write": j("auth != null", "auth.uid === $uid", o("!newData.exists()", is_member("data.parent().parent()"))),
                    ".validate": SEALED(2000)}},
            "typing": {
                ".read": "auth != null && data.parent().child('members/' + auth.uid).exists()",
                "$uid": TYPING("data.parent().parent()")},
            "dmt": {"$pair": {
                ".read": "auth != null && ($pair.beginsWith(auth.uid + '_') || $pair.endsWith('_' + auth.uid)) && " + is_member("data.parent().parent()"),
                "$uid": TYPING("data.parent().parent().parent()", "$pair.beginsWith(auth.uid + '_') || $pair.endsWith('_' + auth.uid)")}},
            "qs": {
                ".read": "auth != null && data.parent().child('members/' + auth.uid).exists()",
                "$id": QUESTION({
                    ".write": j("auth != null", is_member(QROOM), o(q_ask(False), q_approve, q_take_back)),
                    # an upvote, one per person, never on your own question
                    "up": {"$uid": {".write": j("auth != null", "auth.uid === $uid", is_member(QROOM), f"{QROOM}.child('qby/' + $id).val() !== auth.uid",
                                                "data.parent().parent().exists()"),
                                    ".validate": "newData.val() === true"}},
                    # answered, marked by the owner or a co-host
                    "done": {".write": j("auth != null", is_staff(QROOM), "data.parent().exists()"), ".validate": "newData.val() === now"},
                    # a written answer, by the owner or a co-host (who wrote it, under their room name); sealed in an encrypted room
                    "ans": {
                        ".write": j("auth != null", is_staff(QROOM), "data.parent().exists()"),
                        ".validate": j("newData.hasChildren(['by', 'at'])", o(j(Q_ENC, "newData.hasChild('x')", "!newData.hasChild('text')"),
                                                                           j("!" + Q_ENC, "newData.hasChildren(['text', 'name', 'avatar'])"))),
                        "by": {".validate": "newData.val() === auth.uid"},
                        "at": {".validate": "newData.val() === now"},
                        "text": {".validate": NONEMPTY(2000) + " && !" + Q_ENC},
                        "name": {".validate": S(24) + " && !" + Q_ENC}, "avatar": {".validate": S(8) + " && !" + Q_ENC},
                        "x": {".validate": SEALED(6000) + " && " + Q_ENC},   # {t, n, a} sealed to the question's id
                        "$other": NO,
                    },
                }),
            },
            "qq": {
                ".read": "auth != null && (" + is_staff("data.parent()") + ")",
                "$id": QUESTION({
                    ".read": f"auth != null && {QROOM}.child('qby/' + $id).val() === auth.uid",   # the asker sees it's still waiting
                    ".write": j("auth != null", o(j(is_member(QROOM), q_ask(True)), q_take_back)),
                }),
            },
            "qby": {"$id": {
                ".read": "auth != null && data.val() === auth.uid",
                ".write": j("auth != null", "!data.exists()", "newData.val() === auth.uid", is_member(QROOM)),
            }},
            "$other": NO,
        }
    },
    # usage, counted anonymously per day: stats/{YYYY-MM-DD}/{what} goes up by one at a time; nobody reads it but
    # the site's owner (Firebase console, or tools/cleanup/stats.mjs)
    "stats": {"$day": {"$k": {
        ".write": j("auth != null", r"$day.matches(/^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/)",
                    "$k.matches(/^(rooms|salons|joins|msgs|photos|polls|draws|dms|qa|qs|shows|exports)$/)",
                    o(j("!data.exists()", "newData.val() === 1"), "newData.val() === data.val() + 1")),
        ".validate": "newData.isNumber()"}}},
    # StoaTalk's operator: who it is (set by hand in the Firebase console; each can see only their own entry), and
    # reports from every room, which come in alongside the room's own (rooms/{code}/reports) for the operator to act
    # on (site/admin.html). A report carries what the reporter saw (t), so it works in an encrypted room too.
    "ops": {
        "admins": {"$uid": {".read": "auth != null && auth.uid === $uid"}},
        "reports": {
            ".read": "auth != null && " + is_admin,
            ".indexOn": ["at"],
            "$id": {
                ".write": j("auth != null", o(
                    j("!data.exists()", "newData.child('by').val() === auth.uid",
                      "$id === newData.child('code').val() + '_' + newData.child('msg').val() + '_' + auth.uid",
                      "root.child('rooms/' + newData.child('code').val() + '/members/' + auth.uid).exists()",
                      "root.child('rooms/' + newData.child('code').val() + '/msgs/' + newData.child('msg').val() + '/by').val() === newData.child('who').val()",
                      "newData.child('who').val() !== auth.uid"),
                    j("!newData.exists()", is_admin))),
                ".validate": "newData.hasChildren(['code', 'msg', 'by', 'who', 'r', 'at'])",
                "code": {".validate": r"newData.isString() && newData.val().matches(/^[2-9A-HJKMNP-Z]{4}$/)"},
                "msg": {".validate": PUSH_ID}, "by": {".validate": S(128)}, "who": {".validate": S(128)},
                "r": {".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 3"},
                "at": {".validate": "newData.val() === now"},
                "t": {".validate": S(1000)},     # the message as the reporter saw it (a photo, poll or GIF as a short label)
                "n": {".validate": S(24)},       # the name it was sent under
                "f": {".validate": PUSH_ID},     # a photo's id, in a plain room (its picture is public at files.stoatalk.app)
                "enc": {".validate": "newData.val() === true"},   # sent in an encrypted room: only the reporter's word for what it said
                "$other": NO,
            },
        },
        # when the hourly job last told the operator about new reports (tools/cleanup)
        "told": {".validate": "newData.isNumber()"},
    },
    # someone the operator banned: they can't open, join or write in any room (and can see that they're banned)
    "bans": {
        ".read": "auth != null && " + is_admin,
        "$uid": {
            ".read": "auth != null && auth.uid === $uid",
            ".write": "auth != null && " + is_admin,
            ".validate": "newData.hasChild('at')",
            "at": {".validate": "newData.val() === now || newData.val() === data.val()"},
            "why": {".validate": S(200)},
            "$other": NO,
        },
    },
    # old password rooms' passwords: never readable, and can only be cleared (the daily cleanup removes them)
    "secrets": {"$code": {
        ".write": j("auth != null", "!newData.exists()", o(
            "data.parent().parent().child('rooms/' + $code + '/meta/owner').val() === auth.uid",
            "!newData.parent().parent().child('rooms/' + $code).exists()"))}},
}}
out = pathlib.Path(__file__).parent.parent / "database.rules.json"
out.write_text(json.dumps(rules, indent=2, ensure_ascii=False) + "\n")
print("wrote", out)
