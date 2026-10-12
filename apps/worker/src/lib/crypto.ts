const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, k);
  }
  return k;
}

/** Keyed, non-reversible identifier (e.g. for emails/IPs in logs and throttle tables). */
export async function hmacHex(secret: string, purpose: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    enc.encode(`${purpose}:${value}`),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for secrets/tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}
