import { env, exports } from "cloudflare:workers";
import { BASE, mockTurnstile, signIn, signUp } from "./auth-helpers";

export async function adminAndBuyer() {
  const spy = mockTurnstile();
  try {
    const buyer = (await signUp()).cookie;
    const a = await signUp();
    await env.DB.prepare(`UPDATE "user" SET role = 'ADMIN' WHERE email = ?`).bind(a.email).run();
    const admin = (await signIn(a.email, a.password)).cookie;
    return { admin, buyer };
  } finally {
    spy.mockRestore();
  }
}

export function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; raw?: BodyInit; type?: string } = {},
) {
  const headers: Record<string, string> = { origin: BASE };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.type) headers["content-type"] = opts.type;
  return exports.default.fetch(`${BASE}/api/v1${path}`, {
    method,
    headers,
    ...(opts.body !== undefined
      ? { body: JSON.stringify(opts.body) }
      : opts.raw !== undefined
        ? { body: opts.raw }
        : {}),
  });
}

export const bikeBody = (over: Record<string, unknown> = {}) => ({
  make: "Royal Enfield",
  model: "Classic 350",
  variant: "Signals",
  manufactureYear: 2021,
  registrationYear: 2021,
  fuel: "PETROL",
  engineCc: 349,
  kmDriven: 18_400,
  ownerCount: 1,
  rtoCode: "dl-3c",
  rcStatus: "ORIGINAL",
  hypothecation: "NOC_ISSUED",
  insuranceValidTill: "2027-03-14",
  city: "New Delhi",
  yard: "Okhla Phase II yard",
  repossessed: true,
  asIsWhereIs: true,
  colour: "Stormrider Sand",
  description: "Test listing",
  ...over,
});

const sections = [
  "engine",
  "transmission",
  "electricals",
  "battery",
  "brakes",
  "tyres",
  "suspension",
  "frame",
  "body",
];
export const inspectionBody = (over: Record<string, unknown> = {}) => ({
  grade: "B",
  sections: Object.fromEntries(sections.map((k) => [k, { condition: "GOOD", note: "" }])),
  visibleDamage: "Scratch on tank",
  mechanicalIssues: "",
  inspectorNotes: "Starts first kick",
  inspectorName: "R. Sharma",
  inspectedAt: "2026-10-01",
  ...over,
});

/** Minimal PNG header (signature + IHDR) with the given dimensions; enough for type/dimension checks. */
export function pngBytes(width: number, height: number, totalBytes = 64): Uint8Array {
  const b = new Uint8Array(Math.max(totalBytes, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

/** Creates an inspected bike and returns its id. */
export async function inspectedBike(admin: string, over: Record<string, unknown> = {}) {
  const bike = (await (
    await call("POST", "/admin/bikes", { cookie: admin, body: bikeBody(over) })
  ).json()) as { id: string };
  await call("PUT", `/admin/bikes/${bike.id}/inspection`, {
    cookie: admin,
    body: inspectionBody(),
  });
  return bike.id;
}

export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

export async function createAuctionFor(
  admin: string,
  bikeId: string,
  over: Record<string, unknown> = {},
) {
  return call("POST", "/admin/auctions", {
    cookie: admin,
    body: {
      bikeId,
      startPriceMinor: 5_000_000,
      reserveMinor: 7_777_777,
      startsAt: iso(-61_000),
      closesAt: iso(3_600_000),
      ...over,
    },
  });
}
