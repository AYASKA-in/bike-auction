import type { Inspection } from "@bike/contracts";
import { bikeTitle, type BikeInput, type PublicBike } from "@bike/contracts";
import { imageUrl } from "./images";

type BikeData = Omit<PublicBike, "id" | "images" | "inspection" | "registrationState">;

export type BikeRow = {
  id: string;
  make: string;
  model: string;
  variant: string | null;
  manufacture_year: number;
  registration_year: number;
  fuel: "PETROL" | "ELECTRIC";
  engine_cc: number | null;
  km_driven: number;
  owner_count: number;
  rto_code: string;
  rc_status: PublicBike["rcStatus"];
  hypothecation: PublicBike["hypothecation"];
  insurance_valid_till: string | null;
  city: string;
  yard: string;
  repossessed: number;
  as_is_where_is: number;
  colour: string | null;
  description: string;
};

type InspectionRow = {
  version: number;
  grade: Inspection["grade"];
  sections_json: string;
  visible_damage: string;
  mechanical_issues: string;
  inspector_notes: string;
  inspector_name: string;
  inspected_at: string;
};

type ImageRow = {
  id: string;
  r2_key: string;
  alt: string;
  position: number;
  width: number;
  height: number;
};

const COLUMNS: [keyof BikeData, keyof BikeRow][] = [
  ["make", "make"],
  ["model", "model"],
  ["variant", "variant"],
  ["manufactureYear", "manufacture_year"],
  ["registrationYear", "registration_year"],
  ["fuel", "fuel"],
  ["engineCc", "engine_cc"],
  ["kmDriven", "km_driven"],
  ["ownerCount", "owner_count"],
  ["rtoCode", "rto_code"],
  ["rcStatus", "rc_status"],
  ["hypothecation", "hypothecation"],
  ["insuranceValidTill", "insurance_valid_till"],
  ["city", "city"],
  ["yard", "yard"],
  ["repossessed", "repossessed"],
  ["asIsWhereIs", "as_is_where_is"],
  ["colour", "colour"],
  ["description", "description"],
];

export function toColumns(b: Partial<BikeData>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, col] of COLUMNS) {
    const v = b[field];
    if (v !== undefined) out[col] = typeof v === "boolean" ? (v ? 1 : 0) : v;
  }
  return out;
}

function toInspection(r: InspectionRow | undefined): Inspection | null {
  if (!r) return null;
  return {
    version: r.version,
    grade: r.grade,
    sections: JSON.parse(r.sections_json) as Inspection["sections"],
    visibleDamage: r.visible_damage,
    mechanicalIssues: r.mechanical_issues,
    inspectorNotes: r.inspector_notes,
    inspectorName: r.inspector_name,
    inspectedAt: r.inspected_at,
  };
}

/** Buyer-safe bike record: allow-listed fields only (no created_by, no internal ids beyond bike id). */
export function fromRow(
  r: BikeRow,
  inspection: InspectionRow | undefined,
  images: ImageRow[],
): PublicBike {
  return {
    id: r.id,
    make: r.make,
    model: r.model,
    variant: r.variant,
    manufactureYear: r.manufacture_year,
    registrationYear: r.registration_year,
    fuel: r.fuel,
    engineCc: r.engine_cc,
    kmDriven: r.km_driven,
    ownerCount: r.owner_count,
    rtoCode: r.rto_code,
    registrationState: r.rto_code.slice(0, 2),
    rcStatus: r.rc_status,
    hypothecation: r.hypothecation,
    insuranceValidTill: r.insurance_valid_till,
    city: r.city,
    yard: r.yard,
    repossessed: r.repossessed === 1,
    asIsWhereIs: r.as_is_where_is === 1,
    colour: r.colour,
    description: r.description,
    inspection: toInspection(inspection),
    images: images.map((i) => ({
      id: i.id,
      url: imageUrl(i.r2_key),
      alt: i.alt,
      position: i.position,
      width: i.width,
      height: i.height,
    })),
  };
}

export async function getBike(db: D1Database, id: string): Promise<PublicBike | null> {
  const [rows, insp, imgs] = await db.batch([
    db.prepare(`SELECT * FROM bikes WHERE id = ?`).bind(id),
    db
      .prepare(`SELECT * FROM bike_inspections WHERE bike_id = ? ORDER BY version DESC LIMIT 1`)
      .bind(id),
    db
      .prepare(
        `SELECT id, r2_key, alt, position, width, height FROM bike_images WHERE bike_id = ? ORDER BY position, created_at`,
      )
      .bind(id),
  ]);
  const row = rows?.results[0] as BikeRow | undefined;
  if (!row) return null;
  return fromRow(
    row,
    insp?.results[0] as InspectionRow | undefined,
    (imgs?.results ?? []) as ImageRow[],
  );
}

export async function insertBike(
  db: D1Database,
  id: string,
  b: BikeData,
  actor: string,
): Promise<void> {
  const cols = {
    id,
    ...toColumns(b),
    created_by: actor,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const keys = Object.keys(cols);
  await db
    .prepare(`INSERT INTO bikes (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .bind(...Object.values(cols))
    .run();
}

export async function updateBike(
  db: D1Database,
  id: string,
  patch: Partial<BikeData>,
): Promise<void> {
  const cols = { ...toColumns(patch), updated_at: Date.now() };
  const keys = Object.keys(cols);
  await db
    .prepare(`UPDATE bikes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...Object.values(cols), id)
    .run();
}

/**
 * A bike is locked once one of its auctions is live (or due to start) or finished: buyers bid on
 * what they saw, and history must stay true. Drafts, scheduled-but-not-started and cancelled
 * auctions do not lock it.
 */
export async function bikeLockReason(
  db: D1Database,
  bikeId: string,
  now = Date.now(),
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT 1 FROM auction_listings l JOIN auctions_rm r ON r.id = l.auction_id
       WHERE l.bike_id = ? AND (r.status IN ('LIVE','ENDED') OR (r.status = 'SCHEDULED' AND r.starts_at <= ?)) LIMIT 1`,
    )
    .bind(bikeId, now)
    .first();
  return row
    ? "This bike has a live or finished auction, so its listing can no longer change"
    : null;
}

export function titleFor(
  b: Pick<BikeInput, "make" | "model" | "manufactureYear"> & {
    variant?: string | null | undefined;
  },
): string {
  return bikeTitle({
    make: b.make,
    model: b.model,
    variant: b.variant ?? null,
    manufactureYear: b.manufactureYear,
  });
}
