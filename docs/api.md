# API reference (v1)

All errors are RFC 9457 `application/problem+json` with `code` and `requestId`. Every response has `X-Request-Id`.
Identity comes only from the session cookie; clients never send user ids or timestamps.

## Buyer

| Method & path                                     | Auth                  | Notes                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/auctions/:id`                        | optional              | `PublicAuctionView` (no reserve amount, no user ids; `viewer` set when signed in). Resolves due start/close first.                                                                                     |
| `GET /api/v1/auctions/:id/bids?beforeSeq=&limit=` | optional              | Newest first, `limit` 1–100 (default 30). `{ items:[{seq,bidId,bidder,amountMinor,at,isYou}], nextBeforeSeq }`.                                                                                        |
| `POST /api/v1/auctions/:id/bids`                  | USER (admins get 403) | Header `Idempotency-Key` (16–128 `[A-Za-z0-9_-]`, required). Body `{ "amountMinor": <int paise> }` (strict). 201 `{bidId,seq,amountMinor,closesAt,minNextBidMinor}`. Header `Idempotent-Replayed: true | false`. |
| `GET /api/v1/auctions/:id/stream`                 | optional              | WebSocket (Origin checked). See `packages/contracts/src/ws.ts`.                                                                                                                                        |

Bid errors: `AUTH_REQUIRED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `BID_TOO_LOW` 409 (+`minNextBidMinor`) ·
`ALREADY_LEADING` 409 · `AUCTION_NOT_LIVE` / `AUCTION_ENDED` / `AUCTION_CANCELLED` 409 · `BID_UNREASONABLE` 422
(+`maxAcceptableMinor`) · `BID_INVALID_AMOUNT` 422 · `IDEMPOTENCY_KEY_REUSED` 422 · `VALIDATION_FAILED` 422 ·
`RATE_LIMITED` 429 (+`Retry-After`). A replayed key returns the _original_ outcome, including rejections.

## Catalogue (public, served from D1; no Durable Object fan-out)

| Method & path                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/auctions`                           | Query: `status` (`ACTIVE` default · `LIVE` · `UPCOMING` · `ENDED`), `sort` (`ending_soon` · `starting_soon` · `price_asc` · `price_desc` · `newest`), `q`, `make`, `city`, `yearMin/yearMax`, `ccMin/ccMax`, `priceMin/priceMax` (paise), `limit` 1–48 (default 24), `cursor`. → `{items: AuctionCard[], nextCursor}`. Keyset cursor bound to its sort. Drafts and cancelled never listed; no reserve amount, no RC/RTO number, no user ids. |
| `GET /api/v1/catalogue/facets`                   | Makes and cities with listed auctions.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/v1/auctions/:id/details`               | `{auctionId, title, terms, bike: PublicBike}` (specs, document status, latest inspection, images). 404 for drafts. Live price/state comes from `GET /auctions/:id` + the WebSocket, never from this.                                                                                                                                                                                                                                         |
| `GET /api/v1/images/bikes/<bikeId>/<uuid>.<ext>` | Private R2 object streamed by the Worker (`nosniff`, immutable cache). 503 when R2 isn't bound.                                                                                                                                                                                                                                                                                                                                              |

## WebSocket protocol v1

`GET /api/v1/auctions/:id/stream` (upgrade). Auth is the session cookie only: never a token in the URL. Origin is
checked (cross-site WebSocket hijacking). The socket's identity is fixed at connect time; reconnecting re-reads it.

Server → client: `hello {serverTime}`, `auction.snapshot {serverTime, view}` (on connect and on every resync;
`view.viewer` is personal), public events (`auction.scheduled|started|extended|cancelled|ended`,
`bid.accepted`) each with a contiguous `seq`, and `you.outbid` (only to the previous leader's sockets).
Client → server: `{"type":"ping"}` (auto-answered `pong`, doesn't wake the object) and `{"type":"resync"}`
(fresh snapshot; the object also resolves a due start/close first). At most 30 client messages per socket per
minute; more closes the socket with 1008.

**Client rules** (`apps/web/src/lib/live-auction.ts`, `live-feed.ts`):

- Apply an event only if `seq === lastSeq + 1`; ignore older/duplicates; on a gap → "stale" → resync; no
  snapshot within 5 s → reconnect.
- An HTTP view (`GET /auctions/:id`) is applied only if its seq ≥ lastSeq.
- "You're leading" comes only from a snapshot/HTTP `viewer`, or from your own 201 bid response whose seq is the
  latest applied bid. A later bid by someone else while you led = outbid (even if `you.outbid` was lost).
- Reconnect: back-off 0.5 s → 30 s with jitter; "failed" after 6 tries (keeps retrying); offline → wait for
  `online`; tab visible / bfcache restore → reconnect now or resync; heartbeat ping every 20 s, 45 s of silence =
  dead socket.
- Local countdown reaching zero only triggers a resync; the auction ends when `auction.ended` (or a snapshot)
  says so.
- After every snapshot or seq jump, reload the newest bid page (`GET /auctions/:id/bids`) and merge by seq.

## Admin (role ADMIN; every mutation written to `audit_log`)

| Method & path                                       | Body                                                                                                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/admin/auctions`                       | `{bikeId, startPriceMinor, reserveMinor?, startsAt, closesAt (ISO 8601), terms?, schedule=false, antiSniping=true}` → 201 details. Bike needs an inspection; 409 if it already has an open auction. Starts as DRAFT. |
| `GET /api/v1/admin/auctions?status=`                | Desk list incl. drafts (status derived from the schedule, same as KPIs)                                                                                                                                              |
| `GET /api/v1/admin/auctions/:id`                    | → `{state (incl. reserve), view, ops}`                                                                                                                                                                               |
| `PATCH /api/v1/admin/auctions/:id`                  | any of `startPriceMinor, reserveMinor (null clears), startsAt, closesAt`; DRAFT/SCHEDULED only                                                                                                                       |
| `POST /api/v1/admin/auctions/:id/schedule`          | —                                                                                                                                                                                                                    |
| `POST /api/v1/admin/auctions/:id/cancel`            | `{reason}` 3–500 chars                                                                                                                                                                                               |
| `POST /api/v1/admin/auctions/:id/retry-projection`  | — (ops: force D1 sync)                                                                                                                                                                                               |
| `GET /api/v1/admin/overview`                        | users by role, security events 24 h, `bikes`, `auctionsByStatus` (Desk KPIs)                                                                                                                                         |
| `GET /api/v1/admin/security-events`, `/admin/audit` | security log (Day 2); admin audit trail (Day 5)                                                                                                                                                                      |
| `GET/POST /api/v1/admin/bikes`                      | list / create (`BikeInput`, strict; cross-field rules in `packages/contracts/src/catalogue.ts`)                                                                                                                      |
| `GET/PATCH /api/v1/admin/bikes/:id`                 | `{bike, lockedReason, auctions}`; PATCH refused (409) once its auction is live/ended                                                                                                                                 |
| `PUT /api/v1/admin/bikes/:id/inspection`            | `InspectionInput`; each save is a new version                                                                                                                                                                        |
| `POST /api/v1/admin/bikes/:id/images?alt=`          | raw body, `Content-Type` image/jpeg·png·webp; ≤5 MB, 320–4096 px, magic bytes must match; max 12 per bike                                                                                                            |
| `PUT /api/v1/admin/bikes/:id/images/order`          | `{imageIds}` (first = cover)                                                                                                                                                                                         |
| `DELETE /api/v1/admin/bikes/:id/images/:imageId`    | metadata first, then the R2 object                                                                                                                                                                                   |
