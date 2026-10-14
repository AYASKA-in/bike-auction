import { imageStore, type ImageStore } from "../lib/image-store";
import { BikeInput, BikePatch, bikeIssues, InspectionInput } from "@bike/contracts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { bikeLockReason, getBike, insertBike, updateBike, type BikeRow } from "../catalogue/bikes";
import {
  imageDimensions,
  imageKey,
  MAX_DIMENSION,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_BIKE,
  MIN_DIMENSION,
  sniffImage,
} from "../catalogue/images";
import { newId } from "../lib/ids";
import { errorFields } from "../lib/logger";
import { AppError } from "../lib/problem";
import type { AppEnv } from "../types";

/** Admin catalogue routes (mounted under the admin router, which enforces ADMIN). All audited. */
export const adminBikeRoutes = new Hono<AppEnv>();

const BikeId = z.string().regex(/^bike_[a-f0-9]{32}$/);
function bikeId(c: Context<AppEnv>): string {
  const p = BikeId.safeParse(c.req.param("id"));
  if (!p.success) throw new AppError("NOT_FOUND", "Bike not found");
  return p.data;
}

export async function audit(
  c: Context<AppEnv>,
  action: string,
  type: string,
  id: string,
  metadata: Record<string, unknown> = {},
) {
  await c.env.DB.prepare(
    `INSERT INTO audit_log (id, actor_user_id, action, resource_type, resource_id, metadata_json, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("aud"),
      c.get("user")!.id,
      action,
      type,
      id,
      JSON.stringify(metadata),
      c.get("requestId"),
      Date.now(),
    )
    .run();
}

export async function json<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new AppError(
      "VALIDATION_FAILED",
      i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid body",
      {
        fields: parsed.error.issues
          .slice(0, 20)
          .map((x) => ({ path: x.path.join("."), message: x.message })),
      },
    );
  }
  return parsed.data;
}

/** Image storage is optional per deployment (R2, else KV); absent → 503, not a crash. */
function images(c: Context<AppEnv>): ImageStore {
  const store = imageStore(c.env);
  if (!store)
    throw new AppError("SERVICE_UNAVAILABLE", "Image storage is not enabled on this deployment");
  return store;
}

async function assertEditable(c: Context<AppEnv>, id: string) {
  const exists = await c.env.DB.prepare(`SELECT 1 FROM bikes WHERE id = ?`).bind(id).first();
  if (!exists) throw new AppError("NOT_FOUND", "Bike not found");
  const locked = await bikeLockReason(c.env.DB, id);
  if (locked) throw new AppError("CONFLICT", locked);
}

adminBikeRoutes.get("/bikes", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.make, b.model, b.variant, b.manufacture_year AS manufactureYear, b.city, b.km_driven AS kmDriven,
       b.repossessed, b.updated_at AS updatedAt,
       (SELECT grade FROM bike_inspections i WHERE i.bike_id = b.id ORDER BY version DESC LIMIT 1) AS inspectionGrade,
       (SELECT COUNT(*) FROM bike_images i WHERE i.bike_id = b.id) AS imageCount,
       (SELECT r2_key FROM bike_images i WHERE i.bike_id = b.id ORDER BY position LIMIT 1) AS coverKey,
       (SELECT l.auction_id FROM auction_listings l WHERE l.bike_id = b.id AND l.active = 1 LIMIT 1) AS openAuctionId
     FROM bikes b ORDER BY b.updated_at DESC LIMIT 500`,
  ).all<Record<string, unknown>>();
  return c.json({
    items: rows.results.map(({ coverKey, repossessed, ...r }) => ({
      ...r,
      repossessed: repossessed === 1,
      coverUrl: coverKey ? `/api/v1/images/${String(coverKey)}` : null,
    })),
  });
});

adminBikeRoutes.post("/bikes", async (c) => {
  const input = await json(c, BikeInput);
  const id = newId("bike");
  await insertBike(c.env.DB, id, input, c.get("user")!.id);
  await audit(c, "BIKE_CREATED", "bike", id, { make: input.make, model: input.model });
  return c.json(await getBike(c.env.DB, id), 201);
});

adminBikeRoutes.get("/bikes/:id", async (c) => {
  const bike = await getBike(c.env.DB, bikeId(c));
  if (!bike) throw new AppError("NOT_FOUND", "Bike not found");
  const auctions = await c.env.DB.prepare(
    `SELECT l.auction_id AS auctionId, l.active, r.status, r.starts_at AS startsAt, r.closes_at AS closesAt
     FROM auction_listings l LEFT JOIN auctions_rm r ON r.id = l.auction_id WHERE l.bike_id = ? ORDER BY l.created_at DESC`,
  )
    .bind(bike.id)
    .all();
  return c.json({
    bike,
    lockedReason: await bikeLockReason(c.env.DB, bike.id),
    auctions: auctions.results,
  });
});

adminBikeRoutes.patch("/bikes/:id", async (c) => {
  const id = bikeId(c);
  const patch = await json(c, BikePatch);
  await assertEditable(c, id);
  const current = (await c.env.DB.prepare(`SELECT * FROM bikes WHERE id = ?`)
    .bind(id)
    .first<BikeRow>())!;
  const problem = bikeIssues({
    manufactureYear: patch.manufactureYear ?? current.manufacture_year,
    registrationYear: patch.registrationYear ?? current.registration_year,
    fuel: patch.fuel ?? current.fuel,
    engineCc: patch.engineCc === undefined ? current.engine_cc : patch.engineCc,
  })[0];
  if (problem) throw new AppError("VALIDATION_FAILED", `${problem.path}: ${problem.message}`);
  await updateBike(
    c.env.DB,
    id,
    Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  );
  await audit(c, "BIKE_UPDATED", "bike", id, { fields: Object.keys(patch) });
  return c.json(await getBike(c.env.DB, id));
});

/** Saves a NEW inspection version (history is kept). */
adminBikeRoutes.put("/bikes/:id/inspection", async (c) => {
  const id = bikeId(c);
  const r = await json(c, InspectionInput);
  await assertEditable(c, id);
  const next = (await c.env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM bike_inspections WHERE bike_id = ?`,
  )
    .bind(id)
    .first<{ v: number }>())!.v;
  await c.env.DB.prepare(
    `INSERT INTO bike_inspections (bike_id, version, grade, sections_json, visible_damage, mechanical_issues, inspector_notes,
       inspector_name, inspected_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      next,
      r.grade,
      JSON.stringify(r.sections),
      r.visibleDamage,
      r.mechanicalIssues,
      r.inspectorNotes,
      r.inspectorName,
      r.inspectedAt,
      c.get("user")!.id,
      Date.now(),
    )
    .run();
  await c.env.DB.prepare(`UPDATE bikes SET updated_at = ? WHERE id = ?`).bind(Date.now(), id).run();
  await audit(c, "INSPECTION_RECORDED", "bike", id, { version: next, grade: r.grade });
  return c.json(await getBike(c.env.DB, id));
});

/**
 * Upload one image: raw body, `Content-Type: image/jpeg|png|webp`, ≤ 5 MB, 320–4096 px per side,
 * `?alt=` description. The admin UI resizes/re-encodes in the browser first (strips EXIF/GPS);
 * the server independently re-checks type (magic bytes), size and dimensions.
 */
adminBikeRoutes.post("/bikes/:id/images", async (c) => {
  const id = bikeId(c);
  const bucket = images(c);
  const alt = z.string().trim().min(3).max(120).safeParse(c.req.query("alt"));
  if (!alt.success)
    throw new AppError(
      "VALIDATION_FAILED",
      "Add ?alt= with a short description (3–120 characters)",
    );
  if (Number(c.req.header("content-length") ?? "0") > MAX_IMAGE_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Images must be 5 MB or smaller");
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) throw new AppError("VALIDATION_FAILED", "Empty upload");
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new AppError("PAYLOAD_TOO_LARGE", "Images must be 5 MB or smaller");
  const sniffed = sniffImage(bytes);
  const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!sniffed || sniffed.contentType !== declared) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Upload a JPEG, PNG or WebP image (its content must match its type)",
    );
  }
  const dims = imageDimensions(bytes, sniffed.contentType);
  if (!dims) throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Could not read the image dimensions");
  if (
    Math.min(dims.width, dims.height) < MIN_DIMENSION ||
    Math.max(dims.width, dims.height) > MAX_DIMENSION
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Images must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels per side`,
    );
  }
  await assertEditable(c, id);
  const count = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxPos FROM bike_images WHERE bike_id = ?`,
  )
    .bind(id)
    .first<{ n: number; maxPos: number }>())!;
  if (count.n >= MAX_IMAGES_PER_BIKE)
    throw new AppError("CONFLICT", `A bike can have at most ${MAX_IMAGES_PER_BIKE} images`);

  // Write object first, then metadata; if metadata fails, remove the object (no orphans).
  const key = imageKey(id, sniffed.ext);
  try {
    await bucket.put(key, bytes, sniffed.contentType);
  } catch (err) {
    c.get("log").error("image.put_failed", { store: bucket.kind, ...errorFields(err) });
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "Image storage failed. Nothing was saved; try again.",
    );
  }
  const imageId = newId("img");
  try {
    await c.env.DB.prepare(
      `INSERT INTO bike_images (id, bike_id, r2_key, content_type, bytes, width, height, alt, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        imageId,
        id,
        key,
        sniffed.contentType,
        bytes.byteLength,
        dims.width,
        dims.height,
        alt.data,
        count.maxPos + 1,
        Date.now(),
      )
      .run();
  } catch (err) {
    c.get("log").error("image.d1_insert_failed", errorFields(err));
    await bucket
      .delete([key])
      .catch((e: unknown) =>
        c.get("log").error("image.orphan_cleanup_failed", { key, ...errorFields(e) }),
      );
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "Saving the image failed. Nothing was saved; try again.",
    );
  }
  await audit(c, "IMAGE_UPLOADED", "bike", id, { imageId, bytes: bytes.byteLength, ...dims });
  return c.json(await getBike(c.env.DB, id), 201);
});

/** Reorder: the first id becomes the cover photo. Must list every image exactly once. */
adminBikeRoutes.put("/bikes/:id/images/order", async (c) => {
  const id = bikeId(c);
  const { imageIds } = await json(
    c,
    z.strictObject({ imageIds: z.array(z.string()).min(1).max(MAX_IMAGES_PER_BIKE) }),
  );
  await assertEditable(c, id);
  const existing = (
    await c.env.DB.prepare(`SELECT id FROM bike_images WHERE bike_id = ?`)
      .bind(id)
      .all<{ id: string }>()
  ).results.map((r) => r.id);
  if (
    existing.length !== imageIds.length ||
    new Set(imageIds).size !== imageIds.length ||
    !imageIds.every((x) => existing.includes(x))
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "imageIds must list every image of this bike exactly once",
    );
  }
  await c.env.DB.batch(
    imageIds.map((imgId, i) =>
      c.env.DB.prepare(`UPDATE bike_images SET position = ? WHERE id = ?`).bind(i, imgId),
    ),
  );
  await audit(c, "IMAGES_REORDERED", "bike", id, { coverImageId: imageIds[0] });
  return c.json(await getBike(c.env.DB, id));
});

adminBikeRoutes.delete("/bikes/:id/images/:imageId", async (c) => {
  const id = bikeId(c);
  const imageId = c.req.param("imageId");
  const row = await c.env.DB.prepare(`SELECT r2_key FROM bike_images WHERE id = ? AND bike_id = ?`)
    .bind(imageId, id)
    .first<{ r2_key: string }>();
  if (!row) throw new AppError("NOT_FOUND", "Image not found");
  await assertEditable(c, id);
  // Metadata first: if R2 delete then fails, the object is unreachable (logged for cleanup), never a broken listing.
  await c.env.DB.prepare(`DELETE FROM bike_images WHERE id = ?`).bind(imageId).run();
  await images(c)
    .delete([row.r2_key])
    .catch((e: unknown) =>
      c.get("log").error("image.delete_failed", { key: row.r2_key, ...errorFields(e) }),
    );
  await audit(c, "IMAGE_DELETED", "bike", id, { imageId });
  return c.json(await getBike(c.env.DB, id));
});
