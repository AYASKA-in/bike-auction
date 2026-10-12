import { z } from "zod";
import { AuctionOutcome, AuctionStatus } from "./auction";

/**
 * Motorcycle catalogue. D1 is the source of truth for listings; each auction DO owns live state.
 * Privacy by design: we store the RTO code (e.g. "DL-3C"), never the full registration number,
 * the previous owner's identity, or the lender's account details.
 */
export const Fuel = z.enum(["PETROL", "ELECTRIC"]);
export const RcStatus = z.enum(["ORIGINAL", "DUPLICATE", "PENDING_TRANSFER"]);
/** NONE: no loan. ACTIVE: hypothecated, NOC pending from lender. NOC_ISSUED: loan closed, NOC available. */
export const Hypothecation = z.enum(["NONE", "ACTIVE", "NOC_ISSUED"]);
export const InspectionGrade = z.enum(["A", "B", "C", "D"]);
export const Condition = z.enum(["GOOD", "FAIR", "POOR"]);
export const INSPECTION_SECTIONS = [
  "engine",
  "transmission",
  "electricals",
  "battery",
  "brakes",
  "tyres",
  "suspension",
  "frame",
  "body",
] as const;
export type InspectionSection = (typeof INSPECTION_SECTIONS)[number];

const thisYear = () => new Date().getUTCFullYear();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const core = {
  make: text(2, 40),
  model: text(1, 60),
  variant: text(1, 60).nullable(),
  manufactureYear: z.number().int().min(1990),
  registrationYear: z.number().int().min(1990),
  fuel: Fuel,
  engineCc: z.number().int().min(50).max(2000).nullable(),
  kmDriven: z.number().int().min(0).max(500_000),
  ownerCount: z.number().int().min(1).max(6),
  /** State code + RTO number, e.g. DL-3C, MH-02, KA-05. The state is its first two letters. */
  rtoCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}-\d{1,2}[A-Z]{0,2}$/, "Use an RTO code like DL-3C or MH-02"),
  rcStatus: RcStatus,
  hypothecation: Hypothecation,
  insuranceValidTill: z.iso.date().nullable(),
  city: text(2, 60),
  /** Where the bike can be inspected/collected, e.g. "Okhla Phase II yard". */
  yard: text(2, 80),
  repossessed: z.boolean(),
  /** Sold "as is, where is": the buyer accepts the condition described in the inspection. */
  asIsWhereIs: z.boolean(),
  colour: text(2, 30).nullable(),
  description: z.string().trim().max(2000),
};

type BikeLike = {
  manufactureYear?: number | undefined;
  registrationYear?: number | undefined;
  fuel?: string | undefined;
  engineCc?: number | null | undefined;
};

/** Cross-field rules shared by create and patch (a patch is re-checked against the merged row). */
export function bikeIssues(b: BikeLike): { path: string; message: string }[] {
  const y = thisYear();
  const out: { path: string; message: string }[] = [];
  if (b.manufactureYear !== undefined && b.manufactureYear > y)
    out.push({ path: "manufactureYear", message: "Year is in the future" });
  if (b.registrationYear !== undefined && b.registrationYear > y)
    out.push({ path: "registrationYear", message: "Year is in the future" });
  if (
    b.manufactureYear !== undefined &&
    b.registrationYear !== undefined &&
    b.registrationYear < b.manufactureYear
  ) {
    out.push({ path: "registrationYear", message: "Registered before it was made" });
  }
  if (b.fuel === "PETROL" && b.engineCc === null)
    out.push({ path: "engineCc", message: "Engine capacity is required for petrol bikes" });
  return out;
}

const issues = (b: BikeLike, ctx: z.RefinementCtx) =>
  bikeIssues(b).forEach((i) =>
    ctx.addIssue({ code: "custom", path: [i.path], message: i.message }),
  );

export const BikeInput = z
  .strictObject({
    ...core,
    variant: core.variant.default(null),
    engineCc: core.engineCc.default(null),
    insuranceValidTill: core.insuranceValidTill.default(null),
    colour: core.colour.default(null),
    description: core.description.default(""),
    repossessed: core.repossessed.default(false),
    asIsWhereIs: core.asIsWhereIs.default(true),
  })
  .superRefine(issues);
export type BikeInput = z.input<typeof BikeInput>;

/** Partial update: absent = unchanged (no defaults). */
export const BikePatch = z
  .strictObject(core)
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update")
  .superRefine(issues);
export type BikePatch = z.infer<typeof BikePatch>;

const Section = z.strictObject({
  condition: Condition,
  note: z.string().trim().max(200).default(""),
});

/** A structured inspection report. Each save creates a new version; the latest is shown. */
export const InspectionInput = z
  .strictObject({
    grade: InspectionGrade,
    sections: z.strictObject(
      Object.fromEntries(INSPECTION_SECTIONS.map((k) => [k, Section])) as Record<
        InspectionSection,
        typeof Section
      >,
    ),
    visibleDamage: z.string().trim().max(1000).default(""),
    mechanicalIssues: z.string().trim().max(1000).default(""),
    inspectorNotes: z.string().trim().max(2000).default(""),
    inspectorName: text(2, 80),
    inspectedAt: z.iso.date(),
  })
  .superRefine((r, ctx) => {
    if (r.inspectedAt > new Date().toISOString().slice(0, 10)) {
      ctx.addIssue({
        code: "custom",
        path: ["inspectedAt"],
        message: "Inspection date is in the future",
      });
    }
    const poor = Object.values(r.sections).filter((s) => s.condition === "POOR").length;
    if (r.grade === "A" && poor > 0)
      ctx.addIssue({
        code: "custom",
        path: ["grade"],
        message: "Grade A cannot have POOR sections",
      });
    for (const [k, s] of Object.entries(r.sections)) {
      if (s.condition === "POOR" && s.note.length < 3) {
        ctx.addIssue({
          code: "custom",
          path: ["sections", k, "note"],
          message: "Explain every POOR rating",
        });
      }
    }
  });
export type InspectionInput = z.input<typeof InspectionInput>;

export const Inspection = z.strictObject({
  version: z.number().int().positive(),
  grade: InspectionGrade,
  sections: z.record(z.string(), z.strictObject({ condition: Condition, note: z.string() })),
  visibleDamage: z.string(),
  mechanicalIssues: z.string(),
  inspectorNotes: z.string(),
  inspectorName: z.string(),
  inspectedAt: z.string(),
});
export type Inspection = z.infer<typeof Inspection>;

export const BikeImage = z.strictObject({
  id: z.string(),
  url: z.string(),
  alt: z.string(),
  position: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
});

export const PublicBike = z.strictObject({
  id: z.string(),
  make: z.string(),
  model: z.string(),
  variant: z.string().nullable(),
  manufactureYear: z.number().int(),
  registrationYear: z.number().int(),
  fuel: Fuel,
  engineCc: z.number().int().nullable(),
  kmDriven: z.number().int(),
  ownerCount: z.number().int(),
  rtoCode: z.string(),
  registrationState: z.string(),
  rcStatus: RcStatus,
  hypothecation: Hypothecation,
  insuranceValidTill: z.string().nullable(),
  city: z.string(),
  yard: z.string(),
  repossessed: z.boolean(),
  asIsWhereIs: z.boolean(),
  colour: z.string().nullable(),
  description: z.string(),
  inspection: Inspection.nullable(),
  images: z.array(BikeImage),
});
export type PublicBike = z.infer<typeof PublicBike>;

/** Buyer-facing list status. SCHEDULED is shown as UPCOMING; drafts and cancelled lots are hidden. */
export const ListStatus = z.enum(["ACTIVE", "LIVE", "UPCOMING", "ENDED"]);
export type ListStatus = z.infer<typeof ListStatus>;
export const ListSort = z.enum([
  "ending_soon",
  "starting_soon",
  "price_asc",
  "price_desc",
  "newest",
]);
export type ListSort = z.infer<typeof ListSort>;

export const AuctionCard = z.strictObject({
  auctionId: z.string(),
  status: AuctionStatus,
  outcome: AuctionOutcome.nullable(),
  title: z.string(),
  make: z.string(),
  model: z.string(),
  variant: z.string().nullable(),
  manufactureYear: z.number().int(),
  kmDriven: z.number().int(),
  ownerCount: z.number().int(),
  fuel: Fuel,
  engineCc: z.number().int().nullable(),
  city: z.string(),
  inspectionGrade: InspectionGrade.nullable(),
  repossessed: z.boolean(),
  startPriceMinor: z.number().int(),
  currentPriceMinor: z.number().int().nullable(),
  bidCount: z.number().int(),
  startsAt: z.number().int(),
  closesAt: z.number().int(),
  hasReserve: z.boolean(),
  reserveMet: z.boolean(),
  coverUrl: z.string().nullable(),
});
export type AuctionCard = z.infer<typeof AuctionCard>;

export const AuctionList = z.strictObject({
  items: z.array(AuctionCard),
  nextCursor: z.string().nullable(),
});
export type AuctionList = z.infer<typeof AuctionList>;

/** Static listing content (D1). Live price/status always come from GET /auctions/:id (the DO). */
export const AuctionDetails = z.strictObject({
  auctionId: z.string(),
  title: z.string(),
  terms: z.string(),
  bike: PublicBike,
});
export type AuctionDetails = z.infer<typeof AuctionDetails>;

export function bikeTitle(b: {
  make: string;
  model: string;
  variant: string | null;
  manufactureYear: number;
}): string {
  return [b.manufactureYear, b.make, b.model, b.variant].filter(Boolean).join(" ");
}
