/* Checks a Firebase ID token (what signInAnonymously gives every device) and says whose it is.
   The token is a JWT signed by Google with RS256; the public keys are published as a JWK set and rotate, so they're
   cached only for as long as Google's response says. */
const KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const UID = /^[A-Za-z0-9]{1,128}$/;
const SKEW = 300; // seconds of clock difference allowed between Google and here

export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(unb64u(s)));

let cached = { keys: null, until: 0 };
async function googleKeys() {
  if (cached.keys && cached.until > Date.now()) return cached.keys;
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error("keys " + res.status);
  const age = +(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1] || 3600);
  cached = { keys: (await res.json()).keys, until: Date.now() + age * 1000 };
  return cached.keys;
}

// verify(token, env) gives the uid the token was issued to, or null; getKeys is replaceable for tests
export function verifier(getKeys = googleKeys) {
  return async (token, env) => {
    try {
      const [h, p, s] = String(token).split(".");
      if (!h || !p || !s) return null;
      const head = json(h);
      if (head.alg !== "RS256") return null;
      const jwk = (await getKeys()).find((k) => k.kid === head.kid);
      if (!jwk) return null;
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), new TextEncoder().encode(h + "." + p)))) return null;
      const c = json(p), now = Date.now() / 1000;
      if (c.aud !== env.PROJECT_ID || c.iss !== "https://securetoken.google.com/" + env.PROJECT_ID) return null;
      if (!(c.exp > now) || !(c.iat <= now + SKEW) || !(c.auth_time <= now + SKEW)) return null;
      return typeof c.sub === "string" && UID.test(c.sub) ? c.sub : null;
    } catch (e) { return null; }
  };
}
