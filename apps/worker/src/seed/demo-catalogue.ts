import { imageStore } from "../lib/image-store";
import {
  BikeInput,
  InspectionInput,
  INSPECTION_SECTIONS,
  type InspectionSection,
} from "@bike/contracts";
import { insertBike, titleFor } from "../catalogue/bikes";
import { newId } from "../lib/ids";

/**
 * FICTIONAL demo listings (clearly labelled in each description). Realistic Indian used two-wheeler
 * data: years, kilometres, RTO codes, prices and loan/NOC situations. No real vehicles or owners.
 * No photographs are bundled (we only ship images we are authorised to use); the UI shows placeholders.
 */
type Demo = {
  bike: BikeInput;
  grade: "A" | "B" | "C" | "D";
  poor?: Partial<Record<InspectionSection, string>>;
  fair?: InspectionSection[];
  damage?: string;
  issues?: string;
  startRupees: number;
  reserveRupees: number | null;
  /** live: closes in N hours · upcoming: starts in N hours · ended: closes seconds after seeding */
  plan:
    | { kind: "live"; closesInH: number }
    | { kind: "upcoming"; startsInH: number }
    | { kind: "ended" }
    | { kind: "draft" };
};

const LABEL = "Demo listing: fictional data for evaluation.";

const D = (b: Omit<BikeInput, "description"> & { notes: string }): BikeInput => {
  const { notes, ...rest } = b;
  return { ...rest, description: `${LABEL} ${notes}` };
};

export const DEMO_CATALOGUE: Demo[] = [
  {
    bike: D({
      make: "Royal Enfield",
      model: "Classic 350",
      variant: "Signals",
      manufactureYear: 2021,
      registrationYear: 2021,
      fuel: "PETROL",
      engineCc: 349,
      kmDriven: 18_400,
      ownerCount: 1,
      rtoCode: "DL-3C",
      rcStatus: "ORIGINAL",
      hypothecation: "NOC_ISSUED",
      insuranceValidTill: "2027-03-14",
      city: "New Delhi",
      yard: "Okhla Phase II yard",
      repossessed: true,
      asIsWhereIs: true,
      colour: "Stormrider Sand",
      notes:
        "Recovered by a lending partner; loan closed and NOC available. Serviced at an authorised centre in 2025.",
    }),
    grade: "A",
    startRupees: 1_25_000,
    reserveRupees: 1_40_000,
    plan: { kind: "live", closesInH: 0.5 }, // "ending soon" in a fresh demo
  },
  {
    bike: D({
      make: "Honda",
      model: "Activa 6G",
      variant: "DLX",
      manufactureYear: 2022,
      registrationYear: 2022,
      fuel: "PETROL",
      engineCc: 109,
      kmDriven: 9_800,
      ownerCount: 1,
      rtoCode: "HR-26",
      rcStatus: "ORIGINAL",
      hypothecation: "NONE",
      insuranceValidTill: "2026-12-01",
      city: "Gurugram",
      yard: "Sector 37 yard",
      repossessed: false,
      asIsWhereIs: true,
      colour: "Pearl Siren Blue",
      notes: "Single owner, daily office commute. Both keys present.",
    }),
    grade: "A",
    startRupees: 52_000,
    reserveRupees: null,
    plan: { kind: "live", closesInH: 5 },
  },
  {
    bike: D({
      make: "Bajaj",
      model: "Pulsar NS200",
      variant: "ABS",
      manufactureYear: 2019,
      registrationYear: 2019,
      fuel: "PETROL",
      engineCc: 199,
      kmDriven: 31_200,
      ownerCount: 2,
      rtoCode: "UP-16",
      rcStatus: "ORIGINAL",
      hypothecation: "ACTIVE",
      insuranceValidTill: null,
      city: "Noida",
      yard: "Sector 63 yard",
      repossessed: true,
      asIsWhereIs: true,
      colour: "Graphite Black",
      notes: "Repossessed; hypothecation active, lender NOC issued to the buyer on full payment.",
    }),
    grade: "C",
    fair: ["suspension", "body"],
    poor: { tyres: "Rear tyre worn below 2 mm; replace before use." },
    damage: "Scratches on the left tank shroud.",
    issues: "Clutch cable needs adjustment.",
    startRupees: 68_000,
    reserveRupees: 78_000,
    plan: { kind: "live", closesInH: 26 },
  },
  {
    bike: D({
      make: "TVS",
      model: "Jupiter",
      variant: "ZX",
      manufactureYear: 2020,
      registrationYear: 2020,
      fuel: "PETROL",
      engineCc: 110,
      kmDriven: 24_600,
      ownerCount: 1,
      rtoCode: "MH-02",
      rcStatus: "ORIGINAL",
      hypothecation: "NOC_ISSUED",
      insuranceValidTill: "2026-11-20",
      city: "Mumbai",
      yard: "Andheri East yard",
      repossessed: true,
      asIsWhereIs: true,
      colour: "Starlight Blue",
      notes: "Bank recovery; NOC issued.",
    }),
    grade: "B",
    fair: ["battery", "body"],
    damage: "Minor dent on the floorboard.",
    startRupees: 38_000,
    reserveRupees: 45_000,
    plan: { kind: "upcoming", startsInH: 0.25 }, // "starting soon"
  },
  {
    bike: D({
      make: "Hero",
      model: "Splendor Plus",
      variant: "i3S",
      manufactureYear: 2022,
      registrationYear: 2022,
      fuel: "PETROL",
      engineCc: 97,
      kmDriven: 14_300,
      ownerCount: 1,
      rtoCode: "KA-05",
      rcStatus: "ORIGINAL",
      hypothecation: "NONE",
      insuranceValidTill: "2027-01-09",
      city: "Bengaluru",
      yard: "Peenya yard",
      repossessed: false,
      asIsWhereIs: true,
      colour: "Black with Purple",
      notes: "Very economical commuter; service book available.",
    }),
    grade: "A",
    startRupees: 45_000,
    reserveRupees: null,
    plan: { kind: "upcoming", startsInH: 24 },
  },
  {
    bike: D({
      make: "TVS",
      model: "Apache RTR 160",
      variant: "4V",
      manufactureYear: 2020,
      registrationYear: 2021,
      fuel: "PETROL",
      engineCc: 159,
      kmDriven: 27_900,
      ownerCount: 2,
      rtoCode: "TN-09",
      rcStatus: "DUPLICATE",
      hypothecation: "NOC_ISSUED",
      insuranceValidTill: "2026-10-30",
      city: "Chennai",
      yard: "Ambattur yard",
      repossessed: true,
      asIsWhereIs: true,
      colour: "Racing Red",
      notes: "Duplicate RC issued by the RTO after the original was lost.",
    }),
    grade: "B",
    fair: ["brakes", "tyres"],
    startRupees: 70_000,
    reserveRupees: 80_000,
    plan: { kind: "ended" },
  },
  {
    bike: D({
      make: "Suzuki",
      model: "Access 125",
      variant: "Special Edition",
      manufactureYear: 2022,
      registrationYear: 2022,
      fuel: "PETROL",
      engineCc: 124,
      kmDriven: 11_200,
      ownerCount: 1,
      rtoCode: "RJ-14",
      rcStatus: "ORIGINAL",
      hypothecation: "NONE",
      insuranceValidTill: "2027-05-22",
      city: "Jaipur",
      yard: "Sitapura yard",
      repossessed: false,
      asIsWhereIs: true,
      colour: "Metallic Matte Grey",
      notes: "Lightly used; new battery fitted in 2025.",
    }),
    grade: "A",
    startRupees: 55_000,
    reserveRupees: null,
    plan: { kind: "ended" },
  },
  {
    bike: D({
      make: "Yamaha",
      model: "FZ-S",
      variant: "V3.0 FI",
      manufactureYear: 2021,
      registrationYear: 2021,
      fuel: "PETROL",
      engineCc: 149,
      kmDriven: 21_500,
      ownerCount: 1,
      rtoCode: "GJ-01",
      rcStatus: "PENDING_TRANSFER",
      hypothecation: "ACTIVE",
      insuranceValidTill: "2026-12-15",
      city: "Ahmedabad",
      yard: "Naroda yard",
      repossessed: true,
      asIsWhereIs: true,
      colour: "Matte Blue",
      notes: "Repossessed; RC transfer to the lender pending at the RTO.",
    }),
    grade: "B",
    fair: ["electricals"],
    issues: "Indicator relay intermittent.",
    startRupees: 76_000,
    reserveRupees: 85_000,
    plan: { kind: "draft" },
  },
];

export function demoInspection(d: Demo): InspectionInput {
  const sections = Object.fromEntries(
    INSPECTION_SECTIONS.map((k) => {
      const poor = d.poor?.[k];
      if (poor) return [k, { condition: "POOR", note: poor }];
      if (d.fair?.includes(k)) return [k, { condition: "FAIR", note: "Normal wear for age." }];
      return [k, { condition: "GOOD", note: "" }];
    }),
  ) as InspectionInput["sections"];
  const today = new Date().toISOString().slice(0, 10);
  return {
    grade: d.grade,
    sections,
    visibleDamage: d.damage ?? "",
    mechanicalIssues: d.issues ?? "",
    inspectorNotes: "Demo inspection (fictional).",
    inspectorName: "Demo Inspector",
    inspectedAt: today,
  };
}

/**
 * Creates the demo catalogue. Idempotent PER LISTING (key: make + model + RTO code), so a run that
 * failed half-way is completed by the next run instead of being skipped.
 */
export async function seedCatalogue(
  env: Env,
  buyers: { a: string; b: string },
): Promise<{ bikes: number; auctions: string[] }> {
  const auctions: string[] = [];
  const now = Date.now();
  const H = 3_600_000;
  let created = 0;
  for (const d of DEMO_CATALOGUE) {
    const bike = BikeInput.parse(d.bike);
    const exists = await env.DB.prepare(
      `SELECT 1 FROM bikes b JOIN auction_listings l ON l.bike_id = b.id
       WHERE b.created_by = 'seed' AND b.make = ? AND b.model = ? AND b.rto_code = ?`,
    )
      .bind(bike.make, bike.model, bike.rtoCode)
      .first();
    if (exists) continue;
    created += 1;
    const bikeId = newId("bike");
    await insertBike(env.DB, bikeId, bike, "seed");
    const insp = InspectionInput.parse(demoInspection(d));
    await env.DB.prepare(
      `INSERT INTO bike_inspections (bike_id, version, grade, sections_json, visible_damage, mechanical_issues, inspector_notes,
         inspector_name, inspected_at, created_by, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'seed', ?)`,
    )
      .bind(
        bikeId,
        insp.grade,
        JSON.stringify(insp.sections),
        insp.visibleDamage,
        insp.mechanicalIssues,
        insp.inspectorNotes,
        insp.inspectorName,
        insp.inspectedAt,
        now,
      )
      .run();

    const auctionId = newId("auc");
    const p = d.plan;
    const startsAt =
      p.kind === "upcoming"
        ? now + p.startsInH * H
        : p.kind === "draft"
          ? now + 48 * H
          : now - 61_000;
    const closesAt =
      p.kind === "live"
        ? now + p.closesInH * H
        : p.kind === "ended"
          ? now + 4_000
          : startsAt + (p.kind === "draft" ? 24 : 6) * H;
    await env.DB.prepare(
      `INSERT INTO auction_listings (auction_id, bike_id, title, terms, active, created_by, created_at) VALUES (?, ?, ?, ?, 1, 'seed', ?)`,
    )
      .bind(
        auctionId,
        bikeId,
        titleFor(bike),
        "Sold as is, where is. Inspection at the yard by appointment. Demo terms.",
        now,
      )
      .run();
    const stub = env.AUCTION.get(env.AUCTION.idFromName(auctionId));
    const r = await stub.create({
      auctionId,
      startPriceMinor: d.startRupees * 100,
      reserveMinor: d.reserveRupees === null ? null : d.reserveRupees * 100,
      startsAt,
      closesAt,
      schedule: p.kind !== "draft",
      antiSniping: p.kind !== "ended", // the short demo auctions must close on time
    });
    if (!r.ok) throw new Error(`seed auction failed: ${r.error.message}`);
    // Real bids through the real engine for live and soon-to-end demo auctions.
    if (p.kind === "live" || p.kind === "ended") {
      let price = d.startRupees * 100;
      const ladder = p.kind === "ended" ? 3 : 2;
      for (let i = 0; i < ladder; i++) {
        await stub.placeBid({
          userId: i % 2 === 0 ? buyers.a : buyers.b,
          amountMinor: price,
          idempotencyKey: `seed-${auctionId}-${i}`,
          requestId: "seed",
        });
        price += price < 1_00_000_00 ? 50_000 : 1_00_000;
      }
    }
    await stub.retryProjection();
    auctions.push(auctionId);
  }
  return { bikes: created, auctions };
}

/**
 * Removes everything the demo seed created (and nothing else): auctions listed by 'seed' are
 * cancelled in their Durable Objects if still open, then their D1 rows and the seed bikes go.
 * Bid ledgers inside the old auction objects remain (unreachable: no listing points at them).
 */
export async function resetDemoCatalogue(env: Env): Promise<{ auctions: number; bikes: number }> {
  const db = env.DB;
  const listings = await db
    .prepare(`SELECT auction_id FROM auction_listings WHERE created_by = 'seed'`)
    .all<{ auction_id: string }>();
  const ids = listings.results.map((r) => r.auction_id);
  for (const id of ids) {
    try {
      const stub = env.AUCTION.get(env.AUCTION.idFromName(id));
      await stub.cancel("Demo data reset");
    } catch {
      // already ended/cancelled or never created: nothing to cancel
    }
  }
  const bikes = await db
    .prepare(`SELECT id FROM bikes WHERE created_by = 'seed'`)
    .all<{ id: string }>();
  const bikeIds = bikes.results.map((r) => r.id);
  const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");
  const stmts: D1PreparedStatement[] = [];
  if (ids.length > 0) {
    for (const table of ["watchlist", "user_bids_rm", "auction_bids_rm"]) {
      stmts.push(
        db.prepare(`DELETE FROM ${table} WHERE auction_id IN (${inList(ids.length)})`).bind(...ids),
      );
    }
    stmts.push(
      db
        .prepare(`DELETE FROM auction_listings WHERE auction_id IN (${inList(ids.length)})`)
        .bind(...ids),
    );
    stmts.push(
      db.prepare(`DELETE FROM auctions_rm WHERE id IN (${inList(ids.length)})`).bind(...ids),
    );
  }
  if (bikeIds.length > 0) {
    const imgs = await db
      .prepare(`SELECT r2_key FROM bike_images WHERE bike_id IN (${inList(bikeIds.length)})`)
      .bind(...bikeIds)
      .all<{ r2_key: string }>();
    const store = imageStore(env);
    if (store && imgs.results.length > 0) await store.delete(imgs.results.map((r) => r.r2_key));
    for (const table of ["bike_images", "bike_inspections"]) {
      stmts.push(
        db
          .prepare(`DELETE FROM ${table} WHERE bike_id IN (${inList(bikeIds.length)})`)
          .bind(...bikeIds),
      );
    }
    stmts.push(
      db
        .prepare(
          `DELETE FROM bikes WHERE id IN (${inList(bikeIds.length)}) AND created_by = 'seed'`,
        )
        .bind(...bikeIds),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { auctions: ids.length, bikes: bikeIds.length };
}
