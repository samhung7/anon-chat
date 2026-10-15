"""Writes database.rules.json. The rules are kept here because JSON can't hold readable multi-line conditions.
Run: python3 tools/rules.py"""
import json, pathlib

DAY = "86400000"
ROOM = "data.parent().parent()"           # from rooms/$code/<x>/$y
def j(*parts): return " && ".join(f"({p})" for p in parts)
def o(*parts): return " || ".join(f"({p})" for p in parts)

stale = f"data.child('meta/last').val() < now - {DAY}"
fresh_room = o("!data.exists()", stale)

room_write = o(
    # owner ends the room, or anyone clears a room idle for 24 hours
    j("!newData.exists()", o("data.child('meta/owner').val() === auth.uid", stale)),
    # creating (or taking over a stale code): the creator is inside, and no old content comes along
    j(fresh_room, "newData.child('meta/owner').val() === auth.uid", "newData.child('members/' + auth.uid).exists()",
      "!newData.child('msgs').exists()", "!newData.child('dm').exists()", "!newData.child('banned').exists()"),
)

member_join = j(
    f"{ROOM}.child('meta').exists()",
    f"{ROOM}.child('meta/last').val() >= now - {DAY}",
    f"{ROOM}.child('meta/locked').val() !== true",
    o(f"{ROOM}.child('meta/priv').val() !== true",
      j("root.child('secrets/' + $code).exists()",
        "newData.parent().parent().child('keys/' + $uid).val() === root.child('secrets/' + $code).val()")),
)
member_write = o(
    j("auth.uid === $uid", f"!{ROOM}.child('banned/' + $uid).exists()", o("data.exists()", member_join)),
    j("!newData.exists()", f"{ROOM}.child('meta/owner').val() === auth.uid"),   # owner removes someone
)

is_member = lambda room: f"{room}.child('members/' + auth.uid).exists()"
msg_write = j("auth != null", is_member(ROOM), o(
    j("!data.exists()", "newData.child('by').val() === auth.uid"),
    j("!newData.exists()", "data.child('by').val() === auth.uid"),   # only the author deletes a message
))
DMROOM = "data.parent().parent().parent()"
dm_write = j(
    "auth != null", "!data.exists()", "newData.child('by').val() === auth.uid",
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
    j("!newData.exists()", o("data.val() === auth.uid", holder_gone, f"{ROOM}.child('meta/owner').val() === auth.uid")),
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
                ".validate": j("newData.hasChildren(['owner', 'created', 'last', 'priv'])",
                               o("!data.child('enc').exists()", "newData.child('enc').val() === data.child('enc').val()", f"data.child('last').val() < now - {DAY}")),
                "owner": {".validate": "newData.isString() && (newData.val() === auth.uid || newData.val() === data.val())"},
                "created": {".validate": "newData.isNumber()"},
                "last": {".write": f"auth != null && newData.parent().parent().child('members/' + auth.uid).exists()",
                         ".validate": "newData.val() === now"},
                "priv": {".validate": "newData.isBoolean()"},
                "locked": {".validate": "newData.isBoolean()"},
                "title": {".validate": S(40) + " && newData.parent().child('enc').val() !== true"},
                "enc": {".validate": "newData.isBoolean()"},
                "kc": {".validate": S(32)},   # lets a joiner tell a wrong key from a right one
                "xt": {".validate": SEALED(400) + " && newData.parent().child('enc').val() === true"},
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
                    "online": {".validate": "newData.isBoolean()"},
                    "$other": NO,
                },
            },
            "names": {"$key": {
                ".read": "auth != null",
                ".write": names_write,
                ".validate": "newData.isString() && $key.length <= 24"}},
            "keys": {"$uid": {".write": "auth != null && auth.uid === $uid", ".validate": S(128)}},
            "banned": {"$uid": {
                ".read": "auth != null && auth.uid === $uid",
                ".write": f"auth != null && {ROOM}.child('meta/owner').val() === auth.uid",
                ".validate": "newData.val() === true"}},
            "msgs": {
                ".read": "auth != null && data.parent().child('members/' + auth.uid).exists()",
                "$id": {
                    ".write": msg_write,
                    ".validate": j("newData.hasChildren(['by', 'at'])", o(
                        j(ENC("newData.parent().parent()"), "newData.hasChild('x')"),
                        j("!" + ENC("newData.parent().parent()"), "newData.hasChildren(['name', 'avatar'])", "newData.hasChild('text') || newData.hasChild('gif')"))),
                    "by": {".validate": "newData.isString()"},
                    "name": {".validate": S(24) + " && !" + ENC(MEMBER_ROOM)},
                    "avatar": {".validate": S(8) + " && !" + ENC(MEMBER_ROOM)},
                    "text": {".validate": S(1000) + " && newData.val().length > 0 && !" + ENC(MEMBER_ROOM)},
                    "gif": dict(GIF, **{".validate": GIF[".validate"] + " && !" + ENC(MEMBER_ROOM)}),
                    "x": {".validate": SEALED(4000)},
                    "at": {".validate": "newData.val() === now || newData.val() === data.val()"},
                    "re": {"$k": {
                        ".validate": "$k.matches(/^[0-5]$/)",
                        "$uid": {".write": "auth != null && auth.uid === $uid && " + is_member("data.parent().parent().parent().parent().parent()"),
                                 ".validate": "newData.val() === true"}}},
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
            "$other": NO,
        }
    },
    # private-room passwords (a hash), never readable; only the rules compare against them
    "secrets": {"$code": {
        ".write": j("auth != null", o(
            "newData.parent().parent().child('rooms/' + $code + '/meta/owner').val() === auth.uid",
            "!newData.exists() && !newData.parent().parent().child('rooms/' + $code).exists()")),
        ".validate": S(128)}},
}}
out = pathlib.Path(__file__).parent.parent / "database.rules.json"
out.write_text(json.dumps(rules, indent=2, ensure_ascii=False) + "\n")
print("wrote", out)
