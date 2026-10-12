/**
 * Browser-side photo preparation: decode → resize (long side ≤ 2000 px, keeps inspection detail) →
 * re-encode as WebP (JPEG fallback). Re-encoding through a canvas drops EXIF (GPS, phone model).
 * The server re-validates type, size and dimensions independently.
 */
export const MAX_SIDE = 2000;
export const MIN_SIDE = 320;

export async function preparePhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image`);
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  if (Math.min(w, h) < MIN_SIDE)
    throw new Error(`${file.name} is too small (at least ${MIN_SIDE} px per side)`);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.85));
  if (blob && blob.type === "image/webp") return blob;
  const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  if (!jpeg) throw new Error("Could not encode the image");
  return jpeg;
}
