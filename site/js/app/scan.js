/* Joining by the room's QR Code, read with the device's camera (or from a photo of it) on the home page. The picture
   never leaves the device: it's decoded here, by the browser's own BarcodeDetector where it reads QR Codes (Chrome
   on Android and macOS) and otherwise by jsQR (js/vendor/jsqr.js, loaded only when needed; Safari has no detector).
   Only a StoaTalk invite link counts, and what joins is its code and, for a Private Salon, the key after #k=. */
import { el, sheet, toast } from "./dom.js?v=dev";
import { t } from "./text.js?v=dev";

const HOSTS = ["stoatalk.app", "www.stoatalk.app"];
const EVERY_MS = 150; // how often a frame is looked at
const SIDE = 720; // frames are shrunk to this many pixels on their long side before jsQR reads them

export const canScan = () => !!navigator.mediaDevices?.getUserMedia;

// the invite link in what a QR Code says, or null: this site (or stoatalk.app) with ?room= and a 4-character code
export function roomLink(text) {
  let u;
  try { u = new URL(String(text || "").trim()); } catch { return null; }
  if (u.origin !== location.origin && !(u.protocol === "https:" && HOSTS.includes(u.hostname))) return null;
  return /^[0-9A-Za-z]{4}$/.test(u.searchParams.get("room") || "") ? "?room=" + u.searchParams.get("room") + u.hash : null;
}

// what reads a QR Code from a picture: the browser's own, else jsQR
let reader = null;
function qrReader() {
  return (reader ??= (async () => {
    if ("BarcodeDetector" in window && (await BarcodeDetector.getSupportedFormats().catch(() => [])).includes("qr_code")) {
      const d = new BarcodeDetector({ formats: ["qr_code"] });
      return async (src) => (await d.detect(src)).map((c) => c.rawValue);
    }
    const jsQR = (await import("../vendor/jsqr.js?v=dev")).default, canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return async (src) => {
      const w = src.videoWidth || src.width, h = src.videoHeight || src.height, k = Math.min(1, SIDE / Math.max(w, h));
      if (!w || !h) return [];
      canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const found = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
      return found ? [found.data] : [];
    };
  })().catch((e) => { reader = null; throw e; }));
}

// the scanner sheet: resolves with the invite link it read, or null when closed
export function scanRoom() {
  let stream = null, timer = 0, closed = false, ov = null, wrong = "";
  const video = el("video", { playsinline: true, muted: true, autoplay: true, "aria-hidden": "true" });
  video.muted = true; // iOS plays inline only when muted is set as a property too
  const note = el("p", { class: "muted scannote", text: t("scanHint") });
  const file = el("input", { type: "file", accept: "image/*", hidden: true });
  const photo = el("button", { type: "button", class: "link", text: t("scanPhoto"), onclick: () => file.click() });
  const view = el("div", { class: "scanview" }, video, el("div", { class: "scanframe", "aria-hidden": "true" }));
  const body = el("div", { class: "scan" }, view, note, el("div", { class: "scanalt" }, photo), file);
  let found = null;

  // a QR Code was read: a room's link closes the sheet; anything else says so once and the camera keeps looking
  const take = (texts) => {
    for (const text of texts) {
      const link = roomLink(text);
      if (link) { found = link; ov?.close("found"); return true; }
      if (text !== wrong) { wrong = text; toast(t("scanNotRoom")); }
    }
    return false;
  };
  const look = async () => {
    if (closed) return;
    try { if (video.readyState >= 2 && take(await (await qrReader())(video))) return; } catch {}
    if (!closed) timer = setTimeout(look, EVERY_MS);
  };
  const noCamera = (e) => {
    view.hidden = true;
    note.textContent = t(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "scanDenied" : "scanNoCam");
  };
  file.addEventListener("change", async () => {
    const f = file.files[0]; file.value = "";
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f), texts = await (await qrReader())(bmp);
      bmp.close?.();
      if (!take(texts) && !texts.length) toast(t("scanNone"));
    } catch { toast(t("scanNone")); }
  });

  return sheet(t("scanH"), body, [["close", t("close")]], {
    onOpen: async (o) => {
      ov = o;
      qrReader().catch(() => {}); // jsQR starts loading while the camera asks
      if (!canScan()) return noCamera();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (closed) return stream.getTracks().forEach((tr) => tr.stop());
        video.srcObject = stream;
        await video.play().catch(() => {});
        look();
      } catch (e) { noCamera(e); }
    },
  }).then(() => {
    closed = true; clearTimeout(timer);
    stream?.getTracks().forEach((tr) => tr.stop());
    return found;
  });
}
