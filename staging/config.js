/* Site settings for staging: .github/workflows/staging.yml puts this file in place of site/js/config.js before it deploys
   a preview, so the preview talks to the staging Firebase project and photo service, never to stoatalk.app's data.
   firebase: the web app config of the staging Firebase project (Project settings > Your apps > Web app); public by design.
   Everything else is as in site/js/config.js. */
window.CHAT_CONFIG = {
  firebase: {
    apiKey: "AIzaSyDM4qoE9ChsPyOc-VcaXT1_e46EwCHQU_Q",
    authDomain: "stoatalk-staging.firebaseapp.com",
    databaseURL: "https://stoatalk-staging-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "stoatalk-staging",
    appId: "1:362975458094:web:0252e4a972050d2a6f00bf",
  },
  photos: { api: "https://api-staging.stoatalk.app", host: "https://files-staging.stoatalk.app" },
  klipyKey: "DaLjx9fHEDRC7gRl3iFXkSjXiuObhmcp48IJOssQcAFJurEPJ76fD7B0ujQdPekP",
};

// a tag at the top of every page and "[S]" in the tab's title, so a staging page is never taken for the real one
{
  const markTitle = () => { if (!document.title.startsWith("[S] ")) document.title = "[S] " + document.title; };
  markTitle();
  const titleTag = document.querySelector("title");
  if (titleTag) new MutationObserver(markTitle).observe(titleTag, { childList: true, characterData: true, subtree: true });
  addEventListener("DOMContentLoaded", () => {
    const tag = document.createElement("div");
    tag.textContent = "STAGING";
    tag.style.cssText = "position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;" +
      "background:#b4532a;color:#fff;font:600 10px/16px system-ui,sans-serif;letter-spacing:.08em;padding:0 8px;border-radius:0 0 6px 6px";
    document.body.append(tag);
  });
}
