/** Public reviewer accounts (mirrors apps/worker/src/seed/demo-accounts.ts). Demo mode only. */
export const DEMO_ACCOUNTS = [
  { label: "Buyer A", email: "buyer.a@bikeauction.demo", password: "Demo-BuyerA-2026!" },
  { label: "Buyer B", email: "buyer.b@bikeauction.demo", password: "Demo-BuyerB-2026!" },
  { label: "Admin", email: "admin@bikeauction.demo", password: "Demo-Admin-2026!" },
] as const;
