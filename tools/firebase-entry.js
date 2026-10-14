// Bundle source for site/js/vendor/firebase.js (npm run vendor): only the Firebase pieces the app uses.
export { initializeApp } from "firebase/app";
export { getAuth, signInAnonymously } from "firebase/auth";
export { getDatabase, connectDatabaseEmulator, ref, child, get, set, update, remove, push, onValue, onChildAdded, onChildChanged, onChildRemoved, onDisconnect, query, orderByChild, limitToLast, serverTimestamp } from "firebase/database";
