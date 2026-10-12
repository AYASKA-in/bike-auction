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

## WebSocket protocol v1

Server → client: `hello`, `auction.snapshot {serverTime, view}`, public events (`auction.scheduled|started|extended|cancelled|ended`, `bid.accepted`) each with `seq`, and `you.outbid` (only to the previous leader's sockets).
Client → server: `{"type":"ping"}` (auto-answered `pong`) and `{"type":"resync"}` (fresh snapshot).
Apply an event only if `seq === lastSeq + 1`; ignore older; on a gap go "stale" and resync (`apps/web/src/lib/live-auction.ts`).

## Admin (role ADMIN; every mutation written to `audit_log`)

| Method & path                                          | Body                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/admin/auctions`                          | `{startPriceMinor, reserveMinor?, startsAt, closesAt (ISO 8601), schedule=true, antiSniping=true}` → 201 details |
| `GET /api/v1/admin/auctions/:id`                       | → `{state (incl. reserve), view, ops}`                                                                           |
| `PATCH /api/v1/admin/auctions/:id`                     | any of `startPriceMinor, reserveMinor (null clears), startsAt, closesAt`; DRAFT/SCHEDULED only                   |
| `POST /api/v1/admin/auctions/:id/schedule`             | —                                                                                                                |
| `POST /api/v1/admin/auctions/:id/cancel`               | `{reason}` 3–500 chars                                                                                           |
| `POST /api/v1/admin/auctions/:id/retry-projection`     | — (ops: force D1 sync)                                                                                           |
| `GET /api/v1/admin/overview`, `/admin/security-events` | (Day 2)                                                                                                          |
