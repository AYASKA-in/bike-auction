/**
 * Per-auction bidder pseudonyms: "Bidder K7Q2".
 *
 * code = Crockford-base32( HMAC-SHA256(secret, "pseudonym:v1:<auctionId>:<userId>") )[0..n]
 *
 * - Stable within an auction, unlinkable across auctions (different HMAC input), not reversible
 *   without the server secret. The domain stays platform-free: the HMAC is an injected adapter
 *   (Web Crypto in the Worker, `apps/worker/src/lib/crypto.ts`).
 * - Collisions: 4 chars = 20 bits. With 50 bidders the chance two share a code is about 0.1%, so the
 *   caller passes `isTakenByOther` and the code grows to 6, 8, … chars until unique. Codes are
 *   display labels only; identity is always the user id.
 */
export type HmacSha256 = (secret: string, message: string) => Promise<Uint8Array>;

export const PSEUDONYM_MIN_SECRET_LENGTH = 32;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTHS = [4, 6, 8, 10, 12, 16] as const;

/** Big-endian base32 of the first ⌈5·length/8⌉ bytes, `length` characters. */
export function encodeBase32(bytes: Uint8Array, length: number): string {
  if (length * 5 > bytes.length * 8) throw new RangeError("Not enough bytes for requested length");
  let out = "";
  let buffer = 0;
  let bits = 0;
  let i = 0;
  while (out.length < length) {
    if (bits < 5) {
      buffer = (buffer << 8) | bytes[i++]!;
      bits += 8;
    }
    bits -= 5;
    out += CROCKFORD[(buffer >>> bits) & 31];
  }
  return out;
}

export function pseudonymMessage(auctionId: string, userId: string): string {
  if (auctionId.includes(":")) throw new Error("auctionId must not contain ':'");
  return `pseudonym:v1:${auctionId}:${userId}`;
}

/** Shortest code (4, 6, 8…) not already used by a *different* bidder in this auction. */
export function codeFromDigest(
  digest: Uint8Array,
  isTakenByOther: (code: string) => boolean = () => false,
): string {
  for (const len of LENGTHS) {
    const code = encodeBase32(digest, len);
    if (!isTakenByOther(code)) return code;
  }
  throw new Error("Pseudonym collision could not be resolved"); // ~2^-80: unreachable in practice
}

export function formatPseudonym(code: string): string {
  return `Bidder ${code}`;
}

export async function bidderPseudonym(
  hmac: HmacSha256,
  secret: string,
  auctionId: string,
  userId: string,
  isTakenByOther?: (code: string) => boolean,
): Promise<string> {
  if (typeof secret !== "string" || secret.length < PSEUDONYM_MIN_SECRET_LENGTH) {
    throw new Error(`Pseudonym secret must be at least ${PSEUDONYM_MIN_SECRET_LENGTH} characters`);
  }
  const digest = await hmac(secret, pseudonymMessage(auctionId, userId));
  if (digest.length < 32) throw new Error("HMAC-SHA256 adapter must return 32 bytes");
  return formatPseudonym(codeFromDigest(digest, isTakenByOther));
}
