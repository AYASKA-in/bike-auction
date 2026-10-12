import type { Role } from "@bike/contracts";

/**
 * Reviewer demo accounts. These credentials are intentionally public (README) and used nowhere
 * else. They exist only where an operator runs the seed endpoint.
 */
export const DEMO_ACCOUNTS: readonly {
  email: string;
  password: string;
  name: string;
  role: Role;
}[] = [
  {
    email: "admin@bikeauction.demo",
    password: "Demo-Admin-2026!",
    name: "Kabir Singh",
    role: "ADMIN",
  },
  {
    email: "buyer.a@bikeauction.demo",
    password: "Demo-BuyerA-2026!",
    name: "Aarav Mehta",
    role: "USER",
  },
  {
    email: "buyer.b@bikeauction.demo",
    password: "Demo-BuyerB-2026!",
    name: "Bhavna Rao",
    role: "USER",
  },
];
