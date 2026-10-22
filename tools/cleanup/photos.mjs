// Photos in R2 whose marker (rooms/{code}/files/{id}) is gone: their message was deleted, their room ended or expired,
// or the upload was never followed by a message. The page asks the photo service to delete them as it goes; this
// catches what it missed. A photo is only taken once it's GRACE old, so one being sent right now isn't touched.
export const GRACE = 15 * 60e3;
const KEY = /^([^/]+)\/([^/]+)\/([A-Za-z0-9_-]+)\.(jpg|bin)$/;
const QUIZ_IMG = /^([A-Za-z0-9_-]{20})[A-Za-z0-9]{10}$/; // a quiz's picture (as in worker/src/index.js): kept while its quiz is

// objects: [{ key, uploaded (ms) }]; markers(code) gives that room's files/ (or null); quizBy(code, quiz) who runs that
// quiz (or null when it's gone). Returns the keys to delete.
export async function strayPhotos(objects, markers, now = Date.now(), quizBy = async () => null) {
  const rooms = new Map(), quizzes = new Map(), stray = [];
  for (const o of objects) {
    const m = KEY.exec(o.key);
    if (!m) { if (o.uploaded < now - GRACE) stray.push(o.key); continue; }
    if (o.uploaded >= now - GRACE) continue;
    const q = QUIZ_IMG.exec(m[3]);
    if (q) {
      const k = m[1] + "/" + q[1];
      if (!quizzes.has(k)) quizzes.set(k, await quizBy(m[1], q[1]));
      if (quizzes.get(k) !== m[2]) stray.push(o.key);
      continue;
    }
    if (!rooms.has(m[1])) rooms.set(m[1], (await markers(m[1])) || {});
    if (rooms.get(m[1])[m[3]]?.by !== m[2]) stray.push(o.key);
  }
  return stray;
}

// the bucket over R2's S3 API, signed with an R2 access key; send is aws4fetch's AwsClient.fetch
export function s3Bucket(send, endpoint) {
  return {
    async list() {
      const out = [];
      let token = "";
      do {
        const xml = await (await send(`${endpoint}?list-type=2${token ? "&continuation-token=" + encodeURIComponent(token) : ""}`)).text();
        for (const [, c] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
          out.push({ key: /<Key>([^<]*)<\/Key>/.exec(c)[1].replace(/&amp;/g, "&"), uploaded: Date.parse(/<LastModified>([^<]*)<\/LastModified>/.exec(c)[1]) });
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]*)</.exec(xml)[1] : "";
      } while (token);
      return out;
    },
    async remove(key) {
      const res = await send(`${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`delete ${key}: ${res.status}`);
    },
  };
}
