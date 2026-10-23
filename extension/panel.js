// Chrome shows a side panel only once its page has stopped loading, and a frame still loading inside holds that
// back (on Chrome 155 the panel stayed blank). So the page first shows "loading" on its own, and adds stoatalk.app
// a moment after its own load, once Chrome has shown the panel. If the site hasn't come up after a while, it
// offers to open StoaTalk in a tab instead.
const SITE = "https://stoatalk.app/";
const t = (k) => chrome.i18n.getMessage(k);
document.getElementById("msg").textContent = t("loading");
document.getElementById("tab").textContent = t("openTab");

addEventListener("load", () => setTimeout(() => {
  const frame = document.createElement("iframe");
  frame.title = "StoaTalk";
  frame.allow = "camera; clipboard-read; clipboard-write; web-share; fullscreen";
  const slow = setTimeout(() => document.getElementById("wait").classList.add("slow"), 8000);
  frame.addEventListener("load", () => { clearTimeout(slow); frame.classList.add("on"); });
  frame.src = SITE;
  document.body.append(frame);
}, 500));
