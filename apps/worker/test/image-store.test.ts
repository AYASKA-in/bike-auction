import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { imageStore, kvStore, r2Store, type ImageStore } from "../src/lib/image-store";

const text = async (s: ReadableStream) =>
  new TextDecoder().decode(await new Response(s).arrayBuffer());

describe.each([
  ["R2", () => r2Store(env.IMAGES)],
  ["KV (free-plan fallback)", () => kvStore(env.PHOTOS)],
])("image store: %s", (_name, make: () => ImageStore) => {
  it("stores, serves, lists and deletes an image", async () => {
    const store = make();
    const prefix = `bikes/test_${crypto.randomUUID()}/`;
    const key = `${prefix}a.jpg`;
    await store.put(key, new TextEncoder().encode("jpeg-bytes"), "image/jpeg");

    const got = await store.get(key);
    expect(got?.contentType).toBe("image/jpeg");
    expect(got?.etag).toBeTruthy();
    expect(await text(got!.body)).toBe("jpeg-bytes");

    const page = await store.list(prefix, 10);
    expect(page.items.map((i) => i.key)).toEqual([key]);
    expect(page.items[0]!.uploadedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(page.cursor).toBeNull();

    await store.delete([key]);
    expect(await store.get(key)).toBeNull();
    expect((await store.list(prefix, 10)).items).toEqual([]);
  });

  it("pages through a listing with a cursor", async () => {
    const store = make();
    const prefix = `bikes/test_${crypto.randomUUID()}/`;
    for (const n of [1, 2, 3])
      await store.put(`${prefix}${n}.png`, new Uint8Array([n]), "image/png");
    const first = await store.list(prefix, 2);
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBeTruthy();
    const second = await store.list(prefix, 2, first.cursor!);
    expect([...first.items, ...second.items].map((i) => i.key).sort()).toEqual(
      [1, 2, 3].map((n) => `${prefix}${n}.png`),
    );
    expect(second.cursor).toBeNull();
    await store.delete([1, 2, 3].map((n) => `${prefix}${n}.png`));
  });
});

describe("image store selection", () => {
  it("prefers R2, falls back to KV, and is null when neither is bound", () => {
    expect(imageStore({ IMAGES: env.IMAGES, PHOTOS: env.PHOTOS })?.kind).toBe("r2");
    expect(imageStore({ PHOTOS: env.PHOTOS })?.kind).toBe("kv");
    expect(imageStore({})).toBeNull();
  });
});
