/* Site settings.
   firebase: the web app config from the Firebase console (Project settings > Your apps > Web app).
   It is public by design; what people can read and write is decided by database.rules.json.
   While it is null the page says the database isn't set up. Add ?emu to the URL to use the local emulator instead.
   klipyKey: API key from https://klipy.com/developers (KLIPY GIF search). Empty hides the GIF button. */
window.CHAT_CONFIG = {
  firebase: {
    apiKey: "AIzaSyDClHtcxtD5JMaKRmveZWItpOTrCSTbobY",
    authDomain: "anon-chat-2792b.firebaseapp.com",
    databaseURL: "https://anon-chat-2792b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "anon-chat-2792b",
    appId: "1:443180094611:web:a5c2f0005aff1428dfe966",
  },
  klipyKey: "",
};
