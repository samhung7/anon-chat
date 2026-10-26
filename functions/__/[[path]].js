/* Google sign-in's own pages (the pop-up and the frame it talks to, /__/auth/*, and the settings they read,
   /__/firebase/*), served at stoatalk.app by passing them on to Firebase's, so the sign-in runs on the site's own
   address (site/js/config.js authDomain). Google then names stoatalk.app on its sign-in screen, and Safari and the
   iPhone app added to the home screen, which won't share the sign-in with another site, let it through. A Cloudflare
   Pages Function: `pages deploy site` picks up functions/ beside it. Only stoatalk.app passes requests on; staging
   and previews sign in at their own Firebase project's address. */
export const FIREBASE_AUTH = "anon-chat-2792b.firebaseapp.com";

export function onRequest({ request }) {
  const url = new URL(request.url);
  if (url.hostname !== "stoatalk.app" || !/^\/__\/(auth|firebase)\//.test(url.pathname)) return new Response(null, { status: 404 });
  url.hostname = FIREBASE_AUTH;
  return fetch(new Request(url, request));
}
