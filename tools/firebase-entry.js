// Bundle source for site/js/vendor/firebase.js (npm run vendor): only the Firebase pieces the app uses.
export { initializeApp } from "firebase/app";
// initializeAuth rather than getAuth: getAuth also sets up sign-in pop-ups, which on phones first loads Google's
// script and an iframe from another site before anyone can sign in (seconds on mobile data); anonymous sign-in needs neither
export { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, signInAnonymously } from "firebase/auth";
export { getDatabase, connectDatabaseEmulator, ref, child, get, set, update, remove, push, onValue, onChildAdded, onChildChanged, onChildRemoved, onDisconnect, goOffline, goOnline, query, orderByChild, startAfter, limitToFirst, limitToLast, serverTimestamp, increment } from "firebase/database";
