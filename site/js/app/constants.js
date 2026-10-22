/* What the app is made of: fixed lists, limits and timings. The database rules (tools/rules.py) enforce the
   same limits on the server; change both together. */
export const APP = "StoaTalk";
export const CFG = window.CHAT_CONFIG || {};
export const params = new URLSearchParams(location.search);

export const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
export const CODE_RE = /^[2-9A-HJKMNP-Z]{4}$/;
export const REACTS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
// each animal; its name in the current language (text.js avatars()) is also the default nickname
export const ANIMALS = ["🐻", "🦊", "🐼", "🐯", "🦁", "🐸", "🐵", "🐧", "🦉", "🐙", "🦄", "🐶", "🐱", "🐰", "🐨", "🐲"];
// the drawn version of each animal, in avatars/ (any other emoji someone has stays an emoji)
export const ANIMAL_ART = { "🐻": "bear", "🦊": "fox", "🐼": "panda", "🐯": "tiger", "🦁": "lion", "🐸": "frog", "🐵": "monkey", "🐧": "penguin", "🦉": "owl", "🐙": "octopus", "🦄": "unicorn", "🐶": "dog", "🐱": "cat", "🐰": "rabbit", "🐨": "koala", "🐲": "dragon" };

// longest texts, in characters (the rules check the same)
export const LIMITS = {
  text: 1000, question: 300, answer: 2000,
  name: 12, shownName: 24, avatar: 8, roomTitle: 40, roomDesc: 500, recordTitle: 60,
  postTitle: 60, postBody: 20000, postEx: 200, postPhotos: 9,
  pollQ: 200, pollOpt: 80, pollOpts: 10, drawTitle: 60, gifUrl: 500, gifTitle: 120,
  cap: 1000,
};
export const DAY = 864e5;          // a room nobody wrote in for this long is gone
export const MAX_LOAD = 2000;      // the most messages loaded on entering a room
export const GROUP_MS = 180000;    // messages from one person this close together share one header
export const FRESH_MS = 60000;     // a message this new still notifies (older ones are history loading)
export const POST_GAP_MS = 1000;   // posts from this device go out at least this far apart (the rules allow 800 ms)
export const CONNECT_MS = 20000;   // opening or joining a room gives up on a server this slow to answer, instead of spinning on
export const IDLE_MS = 60000;      // a hidden page with no room on screen lets go of its connection after this long

// GIFs come from the KLIPY search and only from KLIPY's servers (database.rules.json checks the same)
export const KLIPY_KEY = CFG.klipyKey;
export const GIF_HOST = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//;
