/* Site settings.
   firebase: the web app config from the Firebase console (Project settings > Your apps > Web app).
   It is public by design; what people can read and write is decided by database.rules.json.
   While it is null the page says the database isn't set up. Add ?emu to the URL to use the local emulator instead. */
window.CHAT_CONFIG = {
  firebase: null,
};
