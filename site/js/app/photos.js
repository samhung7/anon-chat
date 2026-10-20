/* Photos. A photo is shrunk on the device before it's sent: at most 1280px on its long side, as a JPEG of at most
   about 300 KB. Phone photos are often 3-10 MB; sent as they are they'd be slow on mobile data and fill the
   database (and its monthly download allowance) fast. Redrawing the picture also drops its EXIF data: where it was
   taken, when, and on what phone. The picture itself goes to the photo service (worker/, a Cloudflare Worker),
   which keeps it in R2 at {code}/{author}/{id}.jpg (.bin when sealed with the room key in an encrypted room); the
   database only holds a marker, files/{id} = {by, at}. Downloads from R2 cost nothing, where the database charges for
   every copy each viewer reads. Each picture is fetched only when it scrolls into view, and only while its marker is
   there: deleting the message deletes the marker, and the picture with it. Photos from before R2 kept their bytes
   in the marker (d) and still open until their rooms expire. */
import { t } from "./text.js?v=dev";
import { $, el, toast, busy, icon } from "./dom.js?v=dev";
import { backend, PHOTOS } from "./backend.js?v=dev";
import { unb64u } from "./crypto.js?v=dev";
import { room } from "./session.js?v=dev";
import { post } from "./composer.js?v=dev";
import { KIND } from "./kinds.js?v=dev";

const PHOTO_EDGE = 1280, PHOTO_MAX = 300000, PHOTO_LIMIT = 330000, PHOTOS_AT_ONCE = 6;
const PHOTO_SEALED = PHOTO_LIMIT + 28; // the IV and the AES-GCM tag
const jpegUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));

async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error("no-size");
    let edge = PHOTO_EDGE, q = 0.8;
    for (let n = 0; ; n++) {
      const s = Math.min(1, edge / Math.max(W, H)), w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
      const cv = el("canvas", { width: w, height: h }), cx = cv.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); // a transparent PNG gets a white background, not a black one
      cx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", q));
      if (!blob) throw new Error("encode");
      if (blob.size <= PHOTO_MAX || n >= 6) return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
      if (q > 0.65) q -= 0.1; else edge = Math.round(edge * 0.8); // lower the quality a little first, then the size
    }
  } finally { URL.revokeObjectURL(url); }
}
const photoPath = (code, by, f, sealed) => `${code}/${by}/${f}.${sealed ? "bin" : "jpg"}`;
async function upload(code, f, bytes, sealed) {
  const res = await fetch(`${PHOTOS.api}/photo/${photoPath(code, backend.uid, f, sealed)}`, {
    method: "PUT", body: bytes, headers: { Authorization: "Bearer " + (await backend.idToken()), "Content-Type": sealed ? "application/octet-stream" : "image/jpeg" },
  });
  if (!res.ok) throw new Error("upload " + res.status);
}
// asks the photo service to delete pictures whose markers are gone: one photo, or a whole room that has ended.
// It checks the database itself, so this can't take down a picture that's still shown. Best effort: the hourly cleanup catches the rest.
async function drop(what) {
  if (!PHOTOS) return;
  try { await fetch(`${PHOTOS.api}/${what}`, { method: "DELETE", headers: { Authorization: "Bearer " + (await backend.idToken()) } }); } catch (e) {}
}
export const dropPhoto = (code, by, f) => drop(`photo/${code}/${by}/${f}`);
export const dropRoomPhotos = (code) => drop(`room/${code}`);
export async function sendPhotos(files) {
  if (!room || room.gone || room.ui.view !== "all") return;
  const list = [...files].filter((f) => !f.type || f.type.startsWith("image/"));
  if (!list.length) return;
  if (list.length > PHOTOS_AT_ONCE) toast(t("photoMax", { n: PHOTOS_AT_ONCE }));
  busy(true);
  try {
    for (const file of list.slice(0, PHOTOS_AT_ONCE)) {
      let p;
      try { p = await shrink(file); } catch (e) { console.warn(e); toast(t("photoFail")); continue; }
      if (p.bytes.length > PHOTO_LIMIT || !room || room.gone) { toast(t("photoFail")); continue; }
      const r = room, uid = backend.uid, f = backend.pushKey(r.api.ref("files")), sealed = !!r.cipher;
      try { await upload(r.code, f, sealed ? await r.cipher.sealRaw(p.bytes, `f:${uid}:${f}`) : p.bytes, sealed); }
      catch (e) { console.warn(e); toast(t("photoFail")); continue; }
      r.imgs.set(f, Promise.resolve(jpegUrl(p.bytes))); // no need to fetch my own
      await post(KIND.photo, { f, w: p.w, h: p.h }, { [`rooms/${r.code}/files/${f}`]: { by: uid, at: backend.stamp() }, [`rooms/${r.code}/members/${uid}/lf`]: f });
    }
  } finally { busy(false); }
}
// a photo's picture as a blob: URL, fetched once per visit (null if it's gone or can't be read)
export function photoUrl(f, by) {
  const r = room;
  if (!r.imgs.has(f)) r.imgs.set(f, backend.fb.get(r.api.ref("files/" + f)).then(async (s) => {
    const v = s.val();
    if (!v || v.by !== by) return null;
    let bytes = null;
    if (typeof v.d === "string") { // from before R2
      if (r.cipher) bytes = await r.cipher.unsealBytes(v.d, `f:${by}:${f}`);
      else try { bytes = unb64u(v.d); } catch (e) {}
    } else if (PHOTOS) {
      const res = await fetch(`${PHOTOS.host}/${photoPath(r.code, by, f, !!r.cipher)}`);
      if (!res.ok) return null;
      const got = new Uint8Array(await res.arrayBuffer());
      if (got.length > PHOTO_SEALED) return null;
      bytes = r.cipher ? await r.cipher.unsealRaw(got, `f:${by}:${f}`) : got;
    }
    return bytes ? jpegUrl(bytes) : null;
  }).catch(() => null).then((u) => { if (!u) r.imgs.delete(f); return u; }));
  return r.imgs.get(f);
}
// fetch a photo when its message comes near the screen, not all of them on entering the room
let photoWatch = null;
export function photoImg(v, now) {
  const { f, w, h } = v.img;
  const img = el("img", { class: "photo", width: w, height: h, alt: t("photo"), decoding: "async" });
  img.fetchPhoto = () => photoUrl(f, v.by).then((u) => { if (u) img.src = u; else img.replaceWith(el("span", { class: "muted", text: t("photoGone") })); });
  if (now || !("IntersectionObserver" in window)) img.fetchPhoto();
  else {
    photoWatch ||= new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { photoWatch.unobserve(e.target); e.target.fetchPhoto(); } }), { root: $("#list"), rootMargin: "600px 0px" });
    photoWatch.observe(img);
  }
  return img;
}
export function viewPhoto(src) {
  const close = () => { ov.remove(); document.removeEventListener("keydown", esc); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const ov = el("div", { class: "lightbox", role: "dialog", "aria-label": t("photo"), onclick: close },
    el("img", { src, alt: t("photo") }), el("button", { type: "button", class: "icon", "aria-label": t("close") }, icon("close")));
  document.addEventListener("keydown", esc);
  document.body.append(ov);
}
