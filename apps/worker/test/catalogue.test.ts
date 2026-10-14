import { env } from "cloudflare:workers";
import { AuctionDetails, AuctionList, ProblemDetails, PublicBike } from "@bike/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  adminAndBuyer,
  bikeBody,
  call,
  createAuctionFor,
  inspectedBike,
  inspectionBody,
  iso,
  pngBytes,
} from "./catalogue-helpers";

let admin = "";
let buyer = "";
beforeAll(async () => {
  ({ admin, buyer } = await adminAndBuyer());
});
const problem = async (r: Response) => ProblemDetails.parse(await r.json());

describe("motorcycle records", () => {
  it("creates a validated bike (RTO code normalised) and reads it back", async () => {
    const res = await call("POST", "/admin/bikes", { cookie: admin, body: bikeBody() });
    expect(res.status).toBe(201);
    const bike = PublicBike.parse(await res.json());
    expect(bike).toMatchObject({
      rtoCode: "DL-3C",
      registrationState: "DL",
      repossessed: true,
      inspection: null,
      images: [],
    });
  });

  it.each([
    ["bad RTO code", { rtoCode: "DELHI" }],
    ["future year", { manufactureYear: 2999 }],
    ["registered before made", { manufactureYear: 2022, registrationYear: 2020 }],
    ["petrol without cc", { engineCc: null }],
    ["too many owners", { ownerCount: 9 }],
    ["negative km", { kmDriven: -1 }],
    ["unknown field (strict)", { registrationNumber: "DL3CAB1234" }],
    ["bad hypothecation", { hypothecation: "MAYBE" }],
  ])("rejects %s", async (_l, over) => {
    const res = await call("POST", "/admin/bikes", { cookie: admin, body: bikeBody(over) });
    expect(res.status).toBe(422);
    expect((await problem(res)).code).toBe("VALIDATION_FAILED");
  });

  it("electric bikes may omit engine cc; partial updates re-check cross-field rules", async () => {
    const id = (
      (await (
        await call("POST", "/admin/bikes", {
          cookie: admin,
          body: bikeBody({ fuel: "ELECTRIC", engineCc: null }),
        })
      ).json()) as { id: string }
    ).id;
    expect(
      (await call("PATCH", `/admin/bikes/${id}`, { cookie: admin, body: { fuel: "PETROL" } }))
        .status,
    ).toBe(422);
    expect(
      (
        await call("PATCH", `/admin/bikes/${id}`, {
          cookie: admin,
          body: { fuel: "PETROL", engineCc: 110 },
        })
      ).status,
    ).toBe(200);
  });

  it("buyers and anonymous users cannot create or modify bikes", async () => {
    expect((await call("POST", "/admin/bikes", { cookie: buyer, body: bikeBody() })).status).toBe(
      403,
    );
    expect((await call("POST", "/admin/bikes", { body: bikeBody() })).status).toBe(401);
  });
});

describe("inspection reports", () => {
  it("versions every save and exposes the latest", async () => {
    const id = await inspectedBike(admin);
    await call("PUT", `/admin/bikes/${id}/inspection`, {
      cookie: admin,
      body: inspectionBody({ grade: "A" }),
    });
    const { bike } = (await (
      await call("GET", `/admin/bikes/${id}`, { cookie: admin })
    ).json()) as { bike: { inspection: { version: number; grade: string } } };
    expect(bike.inspection).toMatchObject({ version: 2, grade: "A" });
  });

  it.each([
    [
      "POOR without an explanation",
      { sections: { ...inspectionBody().sections, tyres: { condition: "POOR", note: "" } } },
    ],
    [
      "grade A with a POOR section",
      {
        grade: "A",
        sections: {
          ...inspectionBody().sections,
          brakes: { condition: "POOR", note: "Pads gone" },
        },
      },
    ],
    ["missing section", { sections: { engine: { condition: "GOOD", note: "" } } }],
    ["future date", { inspectedAt: "2999-01-01" }],
  ])("rejects %s", async (_l, over) => {
    const id = (
      (await (await call("POST", "/admin/bikes", { cookie: admin, body: bikeBody() })).json()) as {
        id: string;
      }
    ).id;
    expect(
      (
        await call("PUT", `/admin/bikes/${id}/inspection`, {
          cookie: admin,
          body: inspectionBody(over),
        })
      ).status,
    ).toBe(422);
  });
});

describe("images (private R2 via the Worker)", () => {
  const upload = (id: string, bytes: BodyInit, type = "image/png", alt = "Left side view") =>
    call("POST", `/admin/bikes/${id}/images?alt=${encodeURIComponent(alt)}`, {
      cookie: admin,
      raw: bytes,
      type,
    });

  it("uploads, serves with safe headers, reorders the cover and deletes without orphans", async () => {
    const id = await inspectedBike(admin);
    expect((await upload(id, pngBytes(1200, 800))).status).toBe(201);
    const res = await upload(id, pngBytes(800, 1200), "image/png", "Odometer close-up");
    const bike = PublicBike.parse(await res.json());
    expect(bike.images.map((i) => [i.alt, i.width, i.height])).toEqual([
      ["Left side view", 1200, 800],
      ["Odometer close-up", 800, 1200],
    ]);
    const img = await call("GET", bike.images[0]!.url.replace("/api/v1", ""));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("cache-control")).toContain("immutable");
    const keyOf = (u: string) => u.replace("/api/v1/images/", "");
    expect(keyOf(bike.images[0]!.url)).toMatch(new RegExp(`^bikes/${id}/[0-9a-f-]{36}\\.png$`)); // random key, no filename

    const reordered = PublicBike.parse(
      await (
        await call("PUT", `/admin/bikes/${id}/images/order`, {
          cookie: admin,
          body: { imageIds: [bike.images[1]!.id, bike.images[0]!.id] },
        })
      ).json(),
    );
    expect(reordered.images[0]!.alt).toBe("Odometer close-up"); // new cover
    expect(
      (
        await call("PUT", `/admin/bikes/${id}/images/order`, {
          cookie: admin,
          body: { imageIds: [bike.images[0]!.id] },
        })
      ).status,
    ).toBe(422);

    const del = PublicBike.parse(
      await (
        await call("DELETE", `/admin/bikes/${id}/images/${bike.images[0]!.id}`, { cookie: admin })
      ).json(),
    );
    expect(del.images).toHaveLength(1);
    expect(await env.IMAGES.get(keyOf(bike.images[0]!.url))).toBeNull();
  });

  it.each([
    [
      "declared PNG but JPEG bytes",
      () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(0)]),
      "image/png",
      415,
    ],
    [
      "script disguised as an image",
      () => new TextEncoder().encode("<script>alert(1)</script>".padEnd(80, " ")),
      "image/png",
      415,
    ],
    [
      "SVG (not allowed)",
      () => new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>".padEnd(80)),
      "image/svg+xml",
      415,
    ],
    ["too small", () => pngBytes(100, 100), "image/png", 422],
    ["too large in pixels", () => pngBytes(9000, 3000), "image/png", 422],
    ["over 5 MB", () => pngBytes(1200, 800, 5 * 1024 * 1024 + 1), "image/png", 413],
  ] as const)("rejects %s", async (_l, bytes, type, status) => {
    const id = await inspectedBike(admin);
    const res = await upload(id, bytes(), type);
    expect(res.status).toBe(status);
    expect(
      PublicBike.parse(
        await (
          await call("GET", `/admin/bikes/${id}`, { cookie: admin })
        )
          .json()
          .then((j) => (j as { bike: unknown }).bike),
      ).images,
    ).toEqual([]);
  });

  it("requires alt text", async () => {
    const id = await inspectedBike(admin);
    expect((await upload(id, pngBytes(800, 800), "image/png", "")).status).toBe(422);
  });

  it("R2 failure: nothing is recorded", async () => {
    const id = await inspectedBike(admin);
    const spy = vi.spyOn(env.IMAGES, "put").mockRejectedValueOnce(new Error("r2 down"));
    try {
      expect((await upload(id, pngBytes(800, 800))).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM bike_images WHERE bike_id = ?`)
        .bind(id)
        .first())!.n,
    ).toBe(0);
  });

  it("D1 failure after the R2 write: the object is removed (no orphan)", async () => {
    const id = await inspectedBike(admin);
    // Fail exactly the metadata INSERT (after the object was written to R2).
    const realPrepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.trim().startsWith("INSERT INTO bike_images")) throw new Error("D1 unavailable");
      return realPrepare(sql);
    });
    try {
      expect((await upload(id, pngBytes(800, 800))).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect((await env.IMAGES.list({ prefix: `bikes/${id}/` })).objects).toHaveLength(0);
  });
});

describe("listing → auction workflow", () => {
  it("requires an inspection, creates a DRAFT, blocks a second open auction, schedules", async () => {
    const raw = (
      (await (await call("POST", "/admin/bikes", { cookie: admin, body: bikeBody() })).json()) as {
        id: string;
      }
    ).id;
    expect((await problem(await createAuctionFor(admin, raw))).detail).toMatch(/inspection/);

    const id = await inspectedBike(admin);
    const created = await createAuctionFor(admin, id, {
      startsAt: iso(3_600_000),
      closesAt: iso(7_200_000),
      terms: "Viewing Sat 10–4",
    });
    expect(created.status).toBe(201);
    const { state } = (await created.json()) as { state: { auctionId: string; status: string } };
    expect(state.status).toBe("DRAFT");
    expect((await createAuctionFor(admin, id)).status).toBe(409);
    // Drafts are not public.
    expect((await call("GET", `/auctions/${state.auctionId}/details`)).status).toBe(404);
    expect(
      (await call("POST", `/admin/auctions/${state.auctionId}/schedule`, { cookie: admin })).status,
    ).toBe(200);
    const details = AuctionDetails.parse(
      await (await call("GET", `/auctions/${state.auctionId}/details`)).json(),
    );
    expect(details).toMatchObject({ terms: "Viewing Sat 10–4", bike: { id } });
    expect(JSON.stringify(details)).not.toMatch(/7777777|created_by|createdBy/);
  });

  it("concurrent creates for one bike: the database admits exactly one", async () => {
    const id = await inspectedBike(admin);
    const results = await Promise.all(Array.from({ length: 5 }, () => createAuctionFor(admin, id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it("an auction failing domain validation leaves no listing behind", async () => {
    const id = await inspectedBike(admin);
    expect((await createAuctionFor(admin, id, { closesAt: iso(-61_000 + 1_000) })).status).toBe(
      422,
    );
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM auction_listings WHERE bike_id = ?`)
        .bind(id)
        .first())!.n,
    ).toBe(0);
    expect((await createAuctionFor(admin, id)).status).toBe(201);
  });

  it("locks the bike once its auction is live; cancelling releases it for a new auction", async () => {
    const id = await inspectedBike(admin);
    const { state } = (await (await createAuctionFor(admin, id, { schedule: true })).json()) as {
      state: { auctionId: string };
    };
    expect(
      (await call("PATCH", `/admin/bikes/${id}`, { cookie: admin, body: { kmDriven: 1 } })).status,
    ).toBe(409);
    expect(
      (
        await call("POST", `/admin/auctions/${state.auctionId}/cancel`, {
          cookie: admin,
          body: { reason: "Wrong photos" },
        })
      ).status,
    ).toBe(200);
    expect((await createAuctionFor(admin, id)).status).toBe(201);
  });

  it("every admin action is audited", async () => {
    const id = await inspectedBike(admin);
    const rows = await env.DB.prepare(
      `SELECT action FROM audit_log WHERE resource_id = ? ORDER BY created_at`,
    )
      .bind(id)
      .all();
    expect(rows.results.map((r) => r.action)).toEqual(["BIKE_CREATED", "INSPECTION_RECORDED"]);
  });
});

describe("public catalogue: GET /api/v1/auctions", () => {
  let ids: Record<string, string> = {};
  beforeAll(async () => {
    const mk = async (
      key: string,
      over: Record<string, unknown>,
      auction: Record<string, unknown>,
    ) => {
      const bike = await inspectedBike(admin, over);
      const res = await createAuctionFor(admin, bike, { schedule: true, ...auction });
      const r = (await res.json()) as { state?: { auctionId: string } };
      if (!r.state) throw new Error(`fixture ${key}: ${res.status} ${JSON.stringify(r)}`);
      ids[key] = r.state.auctionId;
    };
    ids = {};
    await mk(
      "cheapLive",
      {
        make: "Zeta",
        model: "Alpha",
        city: "Pune",
        manufactureYear: 2018,
        registrationYear: 2018,
        engineCc: 110,
      },
      { startPriceMinor: 2_000_000, closesAt: iso(7_200_000) },
    );
    await mk(
      "dearLive",
      {
        make: "Zeta",
        model: "Beta",
        city: "Pune",
        manufactureYear: 2022,
        registrationYear: 2022,
        engineCc: 350,
      },
      { startPriceMinor: 9_000_000, reserveMinor: 9_777_777, closesAt: iso(3_600_000) },
    );
    await mk(
      "upcoming",
      { make: "Zeta", model: "Gamma", city: "Kochi", engineCc: 150 },
      { startsAt: iso(3_600_000), closesAt: iso(7_200_000) },
    );
    await mk("draft", { make: "Zeta", model: "Delta" }, { schedule: false });
  });
  const list = async (qs: string) =>
    AuctionList.parse(await (await call("GET", `/auctions?${qs}`)).json());

  it("ACTIVE (default) returns live + upcoming, never drafts, and no reserve amounts", async () => {
    const r = await list("make=zeta");
    expect(r.items.map((i) => i.auctionId).sort()).toEqual(
      [ids.cheapLive, ids.dearLive, ids.upcoming].sort(),
    );
    expect(JSON.stringify(r)).not.toContain("7777777");
    expect(r.items.find((i) => i.auctionId === ids.upcoming)!.status).toBe("SCHEDULED");
  });

  it("filters combine (status, city, year, cc, price, keyword)", async () => {
    expect((await list("make=Zeta&status=LIVE")).items.map((i) => i.auctionId).sort()).toEqual(
      [ids.cheapLive, ids.dearLive].sort(),
    );
    expect((await list("make=Zeta&status=UPCOMING")).items.map((i) => i.auctionId)).toEqual([
      ids.upcoming,
    ]);
    expect((await list("make=Zeta&city=kochi")).items.map((i) => i.auctionId)).toEqual([
      ids.upcoming,
    ]);
    expect(
      (await list("make=Zeta&yearMin=2020&status=LIVE")).items.map((i) => i.auctionId),
    ).toEqual([ids.dearLive]);
    expect((await list("make=Zeta&ccMax=200&status=LIVE")).items.map((i) => i.auctionId)).toEqual([
      ids.cheapLive,
    ]);
    expect(
      (await list("make=Zeta&priceMin=5000000&status=LIVE")).items.map((i) => i.auctionId),
    ).toEqual([ids.dearLive]);
    expect((await list("q=gamm")).items.map((i) => i.auctionId)).toEqual([ids.upcoming]);
    expect((await list("q=100%25")).items).toEqual([]); // LIKE wildcards are escaped
  });

  it("sorts and paginates with a keyset cursor bound to its sort", async () => {
    expect(
      (await list("make=Zeta&status=LIVE&sort=ending_soon")).items.map((i) => i.auctionId),
    ).toEqual([ids.dearLive, ids.cheapLive]);
    expect(
      (await list("make=Zeta&status=LIVE&sort=price_asc")).items.map((i) => i.auctionId),
    ).toEqual([ids.cheapLive, ids.dearLive]);
    expect(
      (await list("make=Zeta&status=LIVE&sort=price_desc")).items.map((i) => i.auctionId),
    ).toEqual([ids.dearLive, ids.cheapLive]);
    const p1 = await list("make=Zeta&sort=price_asc&limit=1");
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await list(`make=Zeta&sort=price_asc&limit=1&cursor=${p1.nextCursor}`);
    const p3 = await list(`make=Zeta&sort=price_asc&limit=1&cursor=${p2.nextCursor}`);
    const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.auctionId);
    expect(new Set(all).size).toBe(3);
    expect(p3.nextCursor).toBeNull();
    expect((await call("GET", `/auctions?sort=price_desc&cursor=${p1.nextCursor}`)).status).toBe(
      422,
    ); // cursor bound to sort
  });

  it("card prices follow accepted bids via the projection; the live view comes from the DO", async () => {
    const { exports } = await import("cloudflare:workers");
    const res = await exports.default.fetch(
      `http://example.com/api/v1/auctions/${ids.cheapLive}/bids`,
      {
        method: "POST",
        headers: {
          origin: "http://example.com",
          "content-type": "application/json",
          cookie: buyer,
          "idempotency-key": `k-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ amountMinor: 2_000_000 }),
      },
    );
    expect(res.status).toBe(201);
    const { auctionStub } = await import("./helpers");
    await auctionStub(ids.cheapLive!).retryProjection();
    const card = (await list("make=Zeta&status=LIVE")).items.find(
      (i) => i.auctionId === ids.cheapLive,
    )!;
    expect(card).toMatchObject({ currentPriceMinor: 2_000_000, bidCount: 1 });
    const live = (await (await call("GET", `/auctions/${ids.cheapLive}`)).json()) as {
      currentPriceMinor: number;
      seq: number;
    };
    expect(live.currentPriceMinor).toBe(2_000_000);
  });

  it("rejects invalid query parameters", async () => {
    expect((await call("GET", "/auctions?status=DRAFT")).status).toBe(422);
    expect((await call("GET", "/auctions?yearMin=2022&yearMax=2020")).status).toBe(422);
    expect((await call("GET", "/auctions?limit=500")).status).toBe(422);
    expect((await call("GET", "/auctions?cursor=garbage")).status).toBe(422);
  });

  it("facets list makes and cities with public listings", async () => {
    const f = (await (await call("GET", "/catalogue/facets")).json()) as {
      makes: string[];
      cities: string[];
    };
    expect(f.makes).toContain("Zeta");
    expect(f.cities).toEqual(expect.arrayContaining(["Pune", "Kochi"]));
  });
});

describe("demo catalogue seeding", () => {
  it("creates 8 inspected listings with live, upcoming, ended and draft auctions, once", async () => {
    const seed = () =>
      call("POST", "/internal/seed", { raw: "" }).then(async () =>
        (await import("cloudflare:workers")).exports.default.fetch(
          "http://example.com/api/v1/internal/seed",
          {
            method: "POST",
            headers: { authorization: `Bearer ${env.SEED_TOKEN}` },
          },
        ),
      );
    const first = (await (await seed()).json()) as {
      catalogue: { bikes: number; auctions: string[] };
    };
    expect(first.catalogue.bikes).toBe(8);
    const again = (await (await seed()).json()) as { catalogue: { bikes: number } };
    expect(again.catalogue.bikes).toBe(0);
    await new Promise((r) => setTimeout(r, 4_500)); // the two short demo auctions close by themselves
    for (const id of first.catalogue.auctions)
      await (await import("./helpers")).auctionStub(id).getView(null);
    const statuses = await env.DB.prepare(
      `SELECT r.status, COUNT(*) AS n FROM auction_listings l JOIN auctions_rm r ON r.id = l.auction_id WHERE l.created_by = 'seed' GROUP BY r.status`,
    ).all<{ status: string; n: number }>();
    const by = Object.fromEntries(statuses.results.map((s) => [s.status, s.n]));
    expect(by).toMatchObject({ LIVE: 3, SCHEDULED: 2, DRAFT: 1, ENDED: 2 });
    const ended = AuctionList.parse(
      await (await call("GET", "/auctions?status=ENDED&q=Access")).json(),
    );
    expect(ended.items[0]).toMatchObject({ status: "ENDED", outcome: "SOLD" });
    // Ended auctions default to "recently ended" (closing time, newest first).
    const all = AuctionList.parse(await (await call("GET", "/auctions?status=ENDED")).json());
    const closes = all.items.map((i) => i.closesAt);
    expect(closes.length).toBeGreaterThanOrEqual(2);
    expect(closes).toEqual([...closes].sort((a, b) => b - a));
  }, 30_000);
});

describe("admin overview KPIs", () => {
  it("counts bikes and auctions by status for the desk", async () => {
    const { admin } = await adminAndBuyer();
    const bikeId = await inspectedBike(admin);
    await createAuctionFor(admin, bikeId);
    const res = await call("GET", "/admin/overview", { cookie: admin });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bikes: number;
      auctionsByStatus: { status: string; n: number }[];
    };
    expect(body.bikes).toBeGreaterThanOrEqual(1);
    expect(body.auctionsByStatus.find((r) => r.status === "DRAFT")?.n).toBeGreaterThanOrEqual(1);
  });
});
