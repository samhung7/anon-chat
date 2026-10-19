/* The service at api.stoatalk.app: photos, and Web Push (push.js).

   Photos. A room's photos live in the R2 bucket, public at files.stoatalk.app, under
   {room code}/{author's uid}/{photo id}.jpg (or .bin when sealed with an encrypted room's key). Downloads come
   straight from the bucket through Cloudflare's cache and cost nothing; this Worker only puts photos in and takes
   them out, and asks the database, with the person's own ID token so the database rules decide, whether it may:
     PUT    /photo/{code}/{uid}/{id}.jpg|.bin   the signed-in person, a member of the room, adds their own photo
     DELETE /photo/{code}/{uid}/{id}             a member deletes a photo whose marker (files/{id}) is already gone
     DELETE /room/{code}                         anyone deletes the photos of a room that no longer exists
   What a delete misses (a closed tab, a room that expired) the hourly cleanup (tools/cleanup) takes away.

   Web Push, so people hear about new messages while their page is closed:
     GET    /push/key                            the public key browsers subscribe with (404 until VAPID_KEY is set)
     POST   /push/seal                           a browser's subscription, sealed for the signed-in person to store in a room
     POST   /push/notify/{code}  {id, to?, from?}  the author of a message that just went out asks for it to be announced
   The notify call reads the room with the author's own sign-in (so the rules decide what it may see), checks the
   message is theirs and new, and pushes to the members with a subscription there who aren't online. A room's
   messages are announced at most every QUIET ms (a call too soon is told how long to wait); a private message only
   to the person it's for. In an encrypted room the push says only that there's something new. Each call sends at most PAGE pushes (a Worker's outgoing
   requests are limited) and says where to go on from. */
import { verifier } from "./token.js";
import { vapid, sealSub, openSub, send, validSubscription } from "./push.js";

const CODE = /^[2-9A-HJKMNP-Z]{4}$/, UID = /^[A-Za-z0-9]{1,128}$/, ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX = 330000 + 28; // the page's largest photo, plus the IV and tag when sealed
const TYPES = { jpg: "image/jpeg", bin: "application/octet-stream" };
const CACHE = "public, max-age=3600"; // a deleted photo can linger in Cloudflare's cache for at most this long
const PAGE = 40, QUIET = 20000, FRESH = 120000;
const lastPush = new Map(); // room → when it was last announced, in this Worker instance (a best effort; the page also waits)

class Denied extends Error {}
// the value at a database path as the person sees it (shallow: keys only), null if there's none; Denied if the rules say no
export async function readDb(path, token, env, shallow = true) {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${path}.json`;
  if (shallow) u.searchParams.set("shallow", "true");
  u.searchParams.set("auth", token);
  const res = await fetch(u);
  if (res.status === 401 || res.status === 403) throw new Denied();
  if (!res.ok) throw new Error("database " + res.status);
  return res.json();
}

// what a push says about a message in a plain room: who, where, and a line of it (the page's service worker words it)
function announce(code, msg, meta) {
  const line = (s) => String(s).replace(/\s+/g, " ").slice(0, 120);
  const what = msg.text ? { s: line(msg.text) } : msg.poll ? { i: "poll", s: line(msg.poll.q || "") } : msg.img ? { i: "img" } : msg.gif ? { i: "gif" } : msg.draw ? { i: "draw" } : {};
  return { c: code, k: "m", n: msg.name, a: msg.avatar, r: meta.title || "", ...what };
}

export function makeHandler({ verify, read, fetcher = (...a) => fetch(...a) }) {
  return async (req, env) => {
    const origin = req.headers.get("Origin");
    const cors = origin && (env.ORIGINS || "").split(",").includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    const out = (status) => new Response(null, { status, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
    try {
      const parts = new URL(req.url).pathname.split("/").filter(Boolean);
      const json = (status, o) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
      if (req.method === "GET" && parts[0] === "push" && parts[1] === "key" && parts.length === 2) {
        const keys = await vapid(env);
        return keys ? json(200, { key: keys.pub }) : out(404);
      }
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
      const uid = await verify(token, env);
      if (!uid) return out(401);
      const bucket = env.PHOTOS;

      if (req.method === "PUT" && parts[0] === "photo" && parts.length === 4) {
        const [, code, by, file] = parts, m = /^([A-Za-z0-9_-]{1,32})\.(jpg|bin)$/.exec(file);
        if (!CODE.test(code) || by !== uid || !m) return out(400);
        if (+req.headers.get("Content-Length") > MAX) return out(413);
        const body = new Uint8Array(await req.arrayBuffer());
        if (!body.length || body.length > MAX) return out(413);
        if (m[2] === "jpg" && !(body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)) return out(415); // only a JPEG is served as one
        if ((await read(`rooms/${code}/members/${uid}`, token, env)) === null) return out(403);
        const key = `${code}/${uid}/${file}`;
        if (await bucket.head(key)) return out(409); // never replaced: a message's photo stays the one it was sent with
        await bucket.put(key, body, { httpMetadata: { contentType: TYPES[m[2]], cacheControl: CACHE } });
        return out(201);
      }
      if (req.method === "DELETE" && parts[0] === "photo" && parts.length === 4) {
        const [, code, by, id] = parts;
        if (!CODE.test(code) || !UID.test(by) || !ID.test(id)) return out(400);
        if ((await read(`rooms/${code}/files/${id}`, token, env)) !== null) return out(409); // still shown
        await bucket.delete([`${code}/${by}/${id}.jpg`, `${code}/${by}/${id}.bin`]);
        return out(204);
      }
      if (req.method === "POST" && parts[0] === "push") {
        const keys = await vapid(env);
        if (!keys) return out(404);
        let body;
        try { body = JSON.parse(await req.text()); } catch (e) { return out(400); }
        if (parts[1] === "seal" && parts.length === 2) {
          if (!validSubscription(body)) return out(400);
          return json(200, { sealed: await sealSub(keys, uid, body) });
        }
        if (parts[1] === "notify" && parts.length === 3) {
          const code = parts[2], { id, to } = body, from = Math.max(0, Math.floor(+body.from || 0));
          if (!CODE.test(code) || !ID.test(id || "") || (to != null && (!UID.test(to) || to === uid))) return out(400);
          const [members, subs] = await Promise.all([read(`rooms/${code}/members`, token, env, false), read(`rooms/${code}/push`, token, env, false)]);
          if (!members?.[uid]) return out(403);
          const now = Date.now();
          let payload, targets;
          if (to) { // a private message: only for the person it's to
            const pair = uid < to ? `${uid}_${to}` : `${to}_${uid}`;
            const msg = await read(`rooms/${code}/dm/${pair}/${id}`, token, env, false);
            if (!msg || msg.by !== uid || msg.to !== to || !(msg.at > now - FRESH)) return out(409);
            payload = { c: code, k: "d" }; targets = [to];
          } else {
            const [msg, meta] = await Promise.all([read(`rooms/${code}/msgs/${id}`, token, env, false), read(`rooms/${code}/meta`, token, env, false)]);
            if (!msg || msg.by !== uid || !(msg.at > now - FRESH) || !meta) return out(409);
            if (!from) { // the page stamps meta/pa first (the rules allow that at most every QUIET ms)
              if (!(meta.pa > now - QUIET)) return json(200, { sent: 0, next: null });
              if (lastPush.get(code) > now - QUIET) return json(200, { sent: 0, next: null, wait: lastPush.get(code) + QUIET - now }); // try again then
              lastPush.set(code, now);
              if (lastPush.size > 10000) lastPush.clear();
            }
            payload = meta.enc ? { c: code, k: "x" } : announce(code, msg, meta);
            targets = Object.keys(subs || {}).sort();
          }
          // only members with a subscription here who aren't on line now (an open page notifies by itself)
          targets = targets.filter((u) => u !== uid && subs?.[u] && members[u] && members[u].online !== true);
          const page = targets.slice(from, from + PAGE), text = JSON.stringify(payload);
          const sent = await Promise.all(page.map(async (u) => {
            const sub = await openSub(keys, u, subs[u]);
            if (!sub || !validSubscription(sub)) return false;
            try { return (await send(keys, sub, text, { topic: code, fetcher })) < 300; } catch (e) { return false; }
          }));
          return json(200, { sent: sent.filter(Boolean).length, next: from + PAGE < targets.length ? from + PAGE : null });
        }
        return out(404);
      }
      if (req.method === "DELETE" && parts[0] === "room" && parts.length === 2) {
        const code = parts[1];
        if (!CODE.test(code)) return out(400);
        if ((await read(`rooms/${code}/meta`, token, env)) !== null) return out(409); // the room is still there
        let cursor;
        do {
          const page = await bucket.list({ prefix: code + "/", cursor });
          if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return out(204);
      }
      return out(404);
    } catch (e) {
      if (e instanceof Denied) return out(403);
      console.error(e);
      return out(500);
    }
  };
}

export default { fetch: makeHandler({ verify: verifier(), read: readDb }) };
