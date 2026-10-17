// A stand-in for the photo service on this machine: the real Worker code (worker/src/index.js) over an in-memory
// bucket, checking with the database emulator. The page uses it at :8787 when it runs against the emulator (?emu).
// The emulator's ID tokens are unsigned, so here a token is trusted for whoever it names; the real service checks Google's signature.
import { createServer } from "node:http";
import { makeHandler, readDb } from "../worker/src/index.js";

export class MemoryBucket {
  objects = new Map();
  async head(key) { return this.objects.get(key) || null; }
  async get(key) { return this.objects.get(key) || null; }
  async put(key, body, { httpMetadata } = {}) { this.objects.set(key, { key, body: new Uint8Array(body), httpMetadata, uploaded: new Date() }); }
  async delete(keys) { for (const k of [].concat(keys)) this.objects.delete(k); }
  async list({ prefix = "" } = {}) { return { objects: [...this.objects.values()].filter((o) => o.key.startsWith(prefix)), truncated: false }; }
}
export const unsignedUid = async (token) => {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url")).sub || null; } catch (e) { return null; }
};
export const env = (bucket) => ({ PHOTOS: bucket, PROJECT_ID: "demo-anon-chat", DATABASE_URL: "http://127.0.0.1:9000/?ns=demo-anon-chat", ORIGINS: "*" });
export const handler = makeHandler({ verify: unsignedUid, read: readDb });

// the service and the bucket's public address on one port: PUT/DELETE go to the Worker, GET reads the bucket
export async function startPhotoStub(port = 8787) {
  const bucket = new MemoryBucket();
  const server = createServer(async (req, out) => {
    const origin = req.headers.origin || "*";
    if (req.method === "GET") {
      const o = bucket.objects.get(decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)));
      out.writeHead(o ? 200 : 404, { "Access-Control-Allow-Origin": "*", ...(o ? { "Content-Type": o.httpMetadata.contentType } : {}) });
      return out.end(o ? Buffer.from(o.body) : undefined);
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
    const res = await handler(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body, duplex: "half" }), { ...env(bucket), ORIGINS: origin });
    out.writeHead(res.status, Object.fromEntries(res.headers));
    out.end();
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { bucket, close: () => new Promise((ok) => server.close(ok)) };
}
