# Assumptions and trade-offs (living document)

- Modelled on liquidation auctions for used and bank/NBFC-repossessed two-wheelers in India. EMD, KYC,
  payments and RC transfer are out of scope; the system determines the winner.
- Money is integer paise; display uses en-IN grouping (₹2,81,500). Times shown in IST.
- Server time is authoritative; client clocks only drive visuals (NTP-style offset).
- The default increment ladder (₹250/₹500/₹1,000/₹2,500 by price band) is an assumption, configurable per auction.
- D1 read models may lag the authoritative DO by seconds (eventual consistency, measured as projection lag).
- Free Cloudflare tier is the deployment target; it has hard daily quotas (see spike-results.md).
- Password hashing runs in a Durable Object (Plan A), pending Free-plan verification on Day 2.
- Trade-off: the per-auction single coordinator caps one auction's write throughput (~1,000 req/s soft limit
  per object) in exchange for simple, provable ordering; many auctions scale independently.
