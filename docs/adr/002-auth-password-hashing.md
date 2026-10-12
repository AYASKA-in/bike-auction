# ADR 002: Password hashing in a Durable Object (provisional)

**Context.** Workers Free allows 10 ms CPU per request. Better Auth's scrypt costs about 91 ms (measured, native).
**Decision.** Plan A: Better Auth + D1, with `password.hash/verify` delegated via RPC to a sharded
`PasswordHasherDO` that calls Better Auth's own functions. **Status: provisional** until a deployed Free-plan test
shows no CPU-limit errors (Day 2).
**Fallbacks.** Plan B: Firebase Auth as credential custodian with our own HttpOnly session and roles in D1.
Plan C: Workers Paid ($5/mo).
**Rejected.** Lowering hash cost to fit 10 ms (insecure); custom crypto.
