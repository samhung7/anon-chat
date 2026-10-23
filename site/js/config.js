/* Site settings.
   firebase: the web app config from the Firebase console (Project settings > Your apps > Web app).
   It is public by design; what people can read and write is decided by database.rules.json. authDomain is the site's
   own address: functions/__/ passes Google sign-in's pages on to Firebase's (anon-chat-2792b.firebaseapp.com).
   While it is null the page says the database isn't set up. Add ?emu to the URL to use the local emulator instead.
   photos: the photo upload service (worker/, a Cloudflare Worker) and the public address of the R2 bucket it stores them in.
   klipyKey: API key from https://klipy.com/developers (KLIPY GIF search). Empty hides the GIF button. */
window.CHAT_CONFIG = {
  firebase: {
    apiKey: "AIzaSyDClHtcxtD5JMaKRmveZWItpOTrCSTbobY",
    authDomain: "stoatalk.app",
    databaseURL: "https://anon-chat-2792b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "anon-chat-2792b",
    appId: "1:443180094611:web:a5c2f0005aff1428dfe966",
  },
  photos: { api: "https://api.stoatalk.app", host: "https://files.stoatalk.app" },
  klipyKey: "DaLjx9fHEDRC7gRl3iFXkSjXiuObhmcp48IJOssQcAFJurEPJ76fD7B0ujQdPekP", // public by design: it ships to every browser that searches
};
