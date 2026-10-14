/**
 * Photo storage behind one small interface, so a deployment can use either backend:
 *
 * - **R2** (`IMAGES`): preferred when bound. Needs R2 enabled on the account.
 * - **Workers KV** (`PHOTOS`): fallback that works on the Free plan with no payment method
 *   (1 GB storage, 1,000 writes/day). Values are ≤ 25 MiB; our images are ≤ 5 MB. KV is eventually
 *   consistent across locations, which is fine here: image keys are random and never rewritten.
 *
 * Neither bound → `null`, and callers answer 503 / show placeholders (unchanged behaviour).
 */
export type StoredImage = { body: ReadableStream; contentType: string; etag: string };
export type ListedImage = { key: string; uploadedAt: number };

export interface ImageStore {
  readonly kind: "r2" | "kv";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
  delete(keys: string[]): Promise<void>;
  list(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: ListedImage[]; cursor: string | null }>;
}

type Bindings = { IMAGES?: R2Bucket; PHOTOS?: KVNamespace };

export function imageStore(env: unknown): ImageStore | null {
  const b = env as Bindings;
  if (b.IMAGES) return r2Store(b.IMAGES);
  if (b.PHOTOS) return kvStore(b.PHOTOS);
  return null;
}

export function r2Store(bucket: R2Bucket): ImageStore {
  return {
    kind: "r2",
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        body: obj.body,
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
        etag: obj.httpEtag,
      };
    },
    async delete(keys) {
      if (keys.length > 0) await bucket.delete(keys);
    },
    async list(prefix, limit, cursor) {
      const page = await bucket.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
      return {
        items: page.objects.map((o) => ({ key: o.key, uploadedAt: o.uploaded.getTime() })),
        cursor: page.truncated ? page.cursor : null,
      };
    },
  };
}

type KvMeta = { contentType: string; uploadedAt: number };

export function kvStore(kv: KVNamespace): ImageStore {
  return {
    kind: "kv",
    async put(key, bytes, contentType) {
      const metadata: KvMeta = { contentType, uploadedAt: Date.now() };
      await kv.put(key, bytes, { metadata });
    },
    async get(key) {
      const { value, metadata } = await kv.getWithMetadata<KvMeta>(key, "stream");
      if (!value) return null;
      // Keys are random and immutable, so the key itself is a stable validator.
      return {
        body: value,
        contentType: metadata?.contentType ?? "application/octet-stream",
        etag: `"${key.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      };
    },
    async delete(keys) {
      // KV's Worker binding deletes one key per call.
      for (const k of keys) await kv.delete(k);
    },
    async list(prefix, limit, cursor) {
      const page = await kv.list<KvMeta>({ prefix, limit, ...(cursor ? { cursor } : {}) });
      return {
        items: page.keys.map((k) => ({ key: k.name, uploadedAt: k.metadata?.uploadedAt ?? 0 })),
        cursor: page.list_complete ? null : page.cursor,
      };
    },
  };
}
