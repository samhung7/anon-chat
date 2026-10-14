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
    j("!newData.exists()", o("data.child('by').val() === auth.uid", f"{ROOM}.child('meta/owner').val() === auth.uid")),
))
DMROOM = "data.parent().parent().parent()"
dm_write = j(
    "auth != null", "!data.exists()", "newData.child('by').val() === auth.uid",
    o("$pair === auth.uid + '_' + newData.child('to').val()", "$pair === newData.child('to').val() + '_' + auth.uid"),
    is_member(DMROOM), f"{DMROOM}.child('members/' + newData.child('to').val()).exists()",
)

S = lambda n: f"newData.isString() && newData.val().length <= {n}"
NO = {".validate": False}
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
                ".validate": "newData.hasChildren(['owner', 'created', 'last', 'priv'])",
                "owner": {".validate": "newData.isString() && (newData.val() === auth.uid || newData.val() === data.val())"},
                "created": {".validate": "newData.isNumber()"},
                "last": {".write": f"auth != null && newData.parent().parent().child('members/' + auth.uid).exists()",
                         ".validate": "newData.val() === now"},
                "priv": {".validate": "newData.isBoolean()"},
                "locked": {".validate": "newData.isBoolean()"},
                "title": {".validate": S(40)},
                "$other": NO,
            },
            "members": {
                ".read": "auth != null && data.child(auth.uid).exists()",
                "$uid": {
                    ".write": j("auth != null", member_write),
                    ".validate": "newData.hasChildren(['name', 'avatar', 'joined'])",
                    "name": {".validate": S(24) + " && newData.val().length > 0"},
                    "avatar": {".validate": S(8)},
                    "joined": {".validate": "newData.isNumber()"},
                    "online": {".validate": "newData.isBoolean()"},
                    "$other": NO,
                },
            },
            "keys": {"$uid": {".write": "auth != null && auth.uid === $uid", ".validate": S(128)}},
            "banned": {"$uid": {
                ".read": "auth != null && auth.uid === $uid",
                ".write": f"auth != null && {ROOM}.child('meta/owner').val() === auth.uid",
                ".validate": "newData.val() === true"}},
            "msgs": {
                ".read": "auth != null && data.parent().child('members/' + auth.uid).exists()",
                "$id": {
                    ".write": msg_write,
                    ".validate": "newData.hasChildren(['by', 'name', 'avatar', 'text', 'at'])",
                    "by": {".validate": "newData.isString()"},
                    "name": {".validate": S(24)},
                    "avatar": {".validate": S(8)},
                    "text": {".validate": S(1000) + " && newData.val().length > 0"},
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
                    ".validate": "newData.hasChildren(['by', 'to', 'text', 'at'])",
                    "by": {".validate": "newData.isString()"},
                    "to": {".validate": "newData.isString()"},
                    "text": {".validate": S(1000) + " && newData.val().length > 0"},
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
