# Assumptions and trade-offs (living document)

- Modelled on liquidation auctions for used and bank/NBFC-repossessed two-wheelers in India. EMD, KYC,
  payments and RC transfer are out of scope; the system determines the winner.
- Money is integer paise; display uses en-IN grouping (₹2,81,500). Times shown in IST.
- Server time is authoritative; client clocks only drive visuals (NTP-style offset).
- The default increment ladder (₹250/₹500/₹1,000/₹2,500 by price band, ₹1,000 band inclusive of ₹3,00,000) is an assumption, configurable per auction.
- D1 read models may lag the authoritative DO by seconds (eventual consistency, measured as projection lag).
- Free Cloudflare tier is the deployment target; it has hard daily quotas (see spike-results.md).
- Password hashing runs in a Durable Object (Plan A), pending Free-plan verification on Day 2.
- Trade-off: the per-auction single coordinator caps one auction's write throughput (~1,000 req/s soft limit
  per object) in exchange for simple, provable ordering; many auctions scale independently.
- The current leader cannot raise their own bid until proxy bidding (P1) exists (`ALREADY_LEADING`).
- Fat-finger limit: a bid may not exceed max(minimum next bid, 3 × current or start price); absolute ceiling ₹1 crore.
- Soft-close window is exclusive: a bid with exactly 2:00 remaining does not extend.
- A reserve, if set, must be ≥ the start price. Buyers learn only whether one exists and whether it is met.
- Idempotent retries return the ORIGINAL result, including rejections (a retry is the same intent; a new click
  uses a new key). Records are kept ≥ 24 h.
- Cancellation needs a 3–500 character reason; an auction whose close time has passed cannot be cancelled.
