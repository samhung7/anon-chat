/* The interface in several languages. Each js/i18n/<lang>.js adds one dictionary with I18N.add; this file loads
   first (in <head>) so the page knows its language before anything paints. The language is the one picked in the
   home menu (chat-lang), or else the device's own language, or else English. */
(() => {
  const LANGS = [["zh-TW", "繁體中文"], ["zh-CN", "简体中文"], ["en", "English"], ["ja", "日本語"], ["ko", "한국어"],
    ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["pt", "Português"]];
  const has = (l) => LANGS.some(([c]) => c === l);
  const dicts = {};
  let saved = null;
  try { saved = localStorage.getItem("chat-lang"); } catch (e) {}
  // the device's first language only: zh-TW / zh-HK / zh-Hant read Traditional, any other Chinese Simplified
  function deviceLang() {
    const l = String((navigator.languages && navigator.languages[0]) || navigator.language || "en").toLowerCase();
    if (l.startsWith("zh")) return /hant|tw|hk|mo/.test(l) ? "zh-TW" : "zh-CN";
    const base = l.split("-")[0];
    return has(base) ? base : "en";
  }
  const I18N = {
    LANGS,
    lang: has(saved) ? saved : deviceLang(),
    add: (lang, d) => { dicts[lang] = d; },
    // a string with {name} slots filled in; a missing translation falls back to English, then Traditional Chinese
    t(key, vars) {
      let s = dicts[I18N.lang]?.[key] ?? dicts.en?.[key] ?? dicts["zh-TW"]?.[key] ?? key;
      if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
      return s;
    },
    // pick a language for good (null: follow the device again)
    set(lang) {
      try { lang ? localStorage.setItem("chat-lang", lang) : localStorage.removeItem("chat-lang"); } catch (e) {}
      I18N.lang = has(lang) ? lang : deviceLang();
      I18N.apply();
    },
    // fill the page's fixed text: data-i18n="key" sets the text, data-i18n-attr="placeholder:key;aria-label:key2" attributes
    apply(root = document) {
      root.querySelectorAll("[data-i18n]").forEach((e) => { e.textContent = I18N.t(e.dataset.i18n); });
      root.querySelectorAll("[data-i18n-attr]").forEach((e) => e.dataset.i18nAttr.split(";").forEach((p) => {
        const [a, k] = p.split(":"); e.setAttribute(a, I18N.t(k));
      }));
      document.documentElement.lang = I18N.lang;
      document.documentElement.classList.remove("l10n");
    },
  };
  window.I18N = I18N;
  // light or dark as picked in the home menu (chat-theme); without a pick the device decides
  I18N.theme = (pick) => {
    if (pick !== undefined) { try { pick ? localStorage.setItem("chat-theme", pick) : localStorage.removeItem("chat-theme"); } catch (e) {} }
    let v = null;
    try { v = localStorage.getItem("chat-theme"); } catch (e) {}
    v = v === "light" || v === "dark" ? v : null;
    v ? document.documentElement.setAttribute("data-theme", v) : document.documentElement.removeAttribute("data-theme");
    return v;
  };
  I18N.theme();
  // the page is written in Traditional Chinese; in any other language keep it out of sight until it's translated
  document.documentElement.lang = I18N.lang;
  if (I18N.lang !== "zh-TW") document.documentElement.classList.add("l10n");
  // a room's link opens straight into the room: keep the home page off screen until app.js decides
  if (/[?&]room=/.test(location.search)) document.documentElement.classList.add("opening");
})();
