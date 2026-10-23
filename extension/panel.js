// Chrome shows a side panel only once its page has stopped loading, and a frame still loading inside holds that
// back (on Chrome 155 the panel stayed blank). So the page first shows "loading" on its own, and adds stoatalk.app
// a moment after its own load, once Chrome has shown the panel. In the panel the frame's own load event may never
// come, so the frame is shown at once: it lies over the loading line and covers it as soon as the site paints.
// If it never does, the line under it offers, after a while, to open StoaTalk in a tab instead.
const SITE = "https://stoatalk.app/";
const t = (k) => chrome.i18n.getMessage(k);
document.getElementById("msg").textContent = t("loading");
document.getElementById("tab").textContent = t("openTab");

addEventListener("load", () => setTimeout(() => {
  const frame = document.createElement("iframe");
  frame.title = "StoaTalk";
  frame.allow = "camera; clipboard-read; clipboard-write; web-share; fullscreen";
  setTimeout(() => document.getElementById("wait").classList.add("slow"), 8000);
  frame.src = SITE;
  document.body.append(frame);
}, 500));
