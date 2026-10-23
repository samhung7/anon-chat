// Chrome may keep the side panel blank until its page has loaded, and a frame inside holds that back, so the page
// first shows "loading" and adds stoatalk.app only after its own load. If the site hasn't come up after a while,
// it offers to open StoaTalk in a tab instead.
const SITE = "https://stoatalk.app/";
const t = (k) => chrome.i18n.getMessage(k);
document.getElementById("msg").textContent = t("loading");
document.getElementById("tab").textContent = t("openTab");

addEventListener("load", () => {
  const frame = document.createElement("iframe");
  frame.title = "StoaTalk";
  frame.allow = "camera; clipboard-read; clipboard-write; web-share; fullscreen";
  const slow = setTimeout(() => document.getElementById("wait").classList.add("slow"), 8000);
  frame.addEventListener("load", () => { clearTimeout(slow); frame.classList.add("on"); });
  frame.src = SITE;
  document.body.append(frame);
});
