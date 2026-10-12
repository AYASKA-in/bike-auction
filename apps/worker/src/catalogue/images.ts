/**
 * Upload validation. The Content-Type header is never trusted on its own: the bytes must carry the
 * matching magic number, and dimensions are read from the file header itself.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_BIKE = 12;
export const MIN_DIMENSION = 320;
export const MAX_DIMENSION = 4096;

export type ImageType = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
};

export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { contentType: "image/jpeg", ext: "jpg" };
  if (
    b.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  ) {
    return { contentType: "image/png", ext: "png" };
  }
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP")
    return { contentType: "image/webp", ext: "webp" };
  return null;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

/** Width/height from the file header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X). null if unreadable. */
export function imageDimensions(
  b: Uint8Array,
  type: ImageType["contentType"],
): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (type === "image/png") return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        const len = dv.getUint16(i + 2);
        // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    const chunk = ascii(b, 12, 16);
    if (chunk === "VP8 ")
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { width: w, height: h };
    }
  } catch {
    return null;
  }
  return null;
}

export const IMAGE_KEY = /^bikes\/[A-Za-z0-9_-]{3,64}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export function imageKey(bikeId: string, ext: ImageType["ext"]): string {
  return `bikes/${bikeId}/${crypto.randomUUID()}.${ext}`;
}

export function imageUrl(key: string): string {
  return `/api/v1/images/${key}`;
}
