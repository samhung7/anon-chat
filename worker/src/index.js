/* The photo service. A room's photos live in the R2 bucket, public at files.stoatalk.app, under
   {room code}/{author's uid}/{photo id}.jpg (or .bin when sealed with an encrypted room's key). Downloads come
   straight from the bucket through Cloudflare's cache and cost nothing; this Worker only puts photos in and takes
   them out, and asks the database, with the person's own ID token so the database rules decide, whether it may:
     PUT    /photo/{code}/{uid}/{id}.jpg|.bin   the signed-in person, a member of the room, adds their own photo
     DELETE /photo/{code}/{uid}/{id}             a member deletes a photo whose marker (files/{id}) is already gone
     DELETE /room/{code}                         anyone deletes the photos of a room that no longer exists
   What a delete misses (a closed tab, a room that expired) the hourly cleanup (tools/cleanup) takes away. */
import { verifier } from "./token.js";

const CODE = /^[2-9A-HJKMNP-Z]{4}$/, UID = /^[A-Za-z0-9]{1,128}$/, ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX = 330000 + 28; // the page's largest photo, plus the IV and tag when sealed
const TYPES = { jpg: "image/jpeg", bin: "application/octet-stream" };
const CACHE = "public, max-age=3600"; // a deleted photo can linger in Cloudflare's cache for at most this long

class Denied extends Error {}
// the value at a database path as the person sees it (shallow: keys only), null if there's none; Denied if the rules say no
export async function readDb(path, token, env) {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${path}.json`;
  u.searchParams.set("shallow", "true");
  u.searchParams.set("auth", token);
  const res = await fetch(u);
  if (res.status === 401 || res.status === 403) throw new Denied();
  if (!res.ok) throw new Error("database " + res.status);
  return res.json();
}

export function makeHandler({ verify, read }) {
  return async (req, env) => {
    const origin = req.headers.get("Origin");
    const cors = origin && (env.ORIGINS || "").split(",").includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    const out = (status) => new Response(null, { status, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors,
      "Access-Control-Allow-Methods": "PUT, DELETE", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
    try {
      const parts = new URL(req.url).pathname.split("/").filter(Boolean);
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
