/* Light or dark, as picked in the home menu (chat-theme); without a pick the device decides. Loads in <head>, so
   the page paints in the right colours from the start. THEME.get() is the pick (null: the device's), THEME.set()
   changes it (null: follow the device again). */
(() => {
  const read = () => { try { const v = localStorage.getItem("chat-theme"); return v === "light" || v === "dark" ? v : null; } catch (e) { return null; } };
  const apply = (v) => (v ? document.documentElement.setAttribute("data-theme", v) : document.documentElement.removeAttribute("data-theme"));
  window.THEME = {
    get: read,
    set(pick) {
      try { pick ? localStorage.setItem("chat-theme", pick) : localStorage.removeItem("chat-theme"); } catch (e) {}
      apply(read());
    },
  };
  apply(read());
})();
