// Photos in R2 whose marker (rooms/{code}/files/{id}) is gone: their message was deleted, their room ended or expired,
// or the upload was never followed by a message. The page asks the photo service to delete them as it goes; this
// catches what it missed. A photo is only taken once it's GRACE old, so one being sent right now isn't touched.
// A Google account's quiz library keeps its pictures at u/{uid}/{id}.jpg (site/js/app/quizlib.js): one goes when no set
// in the account points at it any more, or the account is deleted.
export const GRACE = 15 * 60e3;
const KEY = /^([^/]+)\/([^/]+)\/([A-Za-z0-9_-]+)\.(jpg|bin)$/;
const QUIZ_IMG = /^([A-Za-z0-9_-]{20})[A-Za-z0-9]{10}$/; // a quiz's picture (as in worker/src/index.js): kept while its quiz is
const LIB_KEY = /^u\/([A-Za-z0-9]{1,128})\/([A-Za-z0-9_-]{22})\.jpg$/;
// the pictures a library's sets point at: sets is users/{uid}/qzs, { id: the set as JSON }
export function libraryPictures(sets) {
  const out = new Set();
  for (const body of Object.values(sets || {})) {
    try { for (const q of JSON.parse(body).q || []) if (typeof q?.img?.f === "string") out.add(q.img.f); } catch (e) {}
  }
  return out;
}

// objects: [{ key, uploaded (ms) }]; markers(code) gives that room's files/ (or null); quizBy(code, quiz) who runs that
// quiz (or null when it's gone); library(uid) that account's users/{uid}/qzs (or null). Returns the keys to delete.
export async function strayPhotos(objects, markers, now = Date.now(), quizBy = async () => null, library = async () => null) {
  const rooms = new Map(), quizzes = new Map(), libs = new Map(), stray = [];
  for (const o of objects) {
    const lib = LIB_KEY.exec(o.key);
    if (lib) {
      if (o.uploaded >= now - GRACE) continue;
      if (!libs.has(lib[1])) libs.set(lib[1], libraryPictures(await library(lib[1])));
      if (!libs.get(lib[1]).has(lib[2])) stray.push(o.key);
      continue;
    }
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
