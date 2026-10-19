// Bundle source for site/js/vendor/firebase-ops.js (npm run vendor): the Firebase pieces site/admin.html uses.
// Kept apart from firebase.js so Google sign-in (its pop-up code) never loads for people who only chat.
export { initializeApp } from "firebase/app";
export { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
export { getDatabase, connectDatabaseEmulator, ref, get, update, onValue, serverTimestamp } from "firebase/database";
