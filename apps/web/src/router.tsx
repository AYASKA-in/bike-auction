import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "./components/app-shell";
import { CatalogueSearch } from "./lib/catalogue-search";
import { MyBidsSearch } from "./lib/me";
import { AuditSearch } from "./lib/ops";
import { SettlementsSearch } from "./lib/settlement-search";
import { meQuery } from "./lib/session";
import { HomePage } from "./routes/home";
import { NotFoundPage } from "./routes/not-found";

type RouterContext = { queryClient: QueryClient };

// Pages other than home are split into their own chunks and loaded on navigation (or on link
// hover/focus via defaultPreload: "intent").
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});

// Only same-site relative paths are accepted as post-login redirects (no open redirect).
const RedirectSearch = z.object({
  redirect: z
    .string()
    .regex(/^\/(?!\/)[\w\-/?=&%.]*$/)
    .optional()
    .catch(undefined),
});

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: RedirectSearch,
  beforeLoad: async ({ context, search }) => {
    if (await context.queryClient.ensureQueryData(meQuery))
      throw redirect({ to: search.redirect ?? "/" });
  },
  component: lazyRouteComponent(() => import("./routes/login"), "LoginPage"),
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: RedirectSearch,
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ to: "/" });
  },
  component: lazyRouteComponent(() => import("./routes/register"), "RegisterPage"),
});

const auctionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auctions",
  validateSearch: CatalogueSearch,
  component: lazyRouteComponent(() => import("./routes/auctions"), "AuctionsPage"),
});
const auctionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auctions/$auctionId",
  component: lazyRouteComponent(() => import("./routes/auction-detail"), "AuctionDetailPage"),
});

// Buyer pages. UX guard only: the API independently returns 401/403 (test/me.test.ts).
const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/me",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
    if (me.role === "ADMIN") throw redirect({ to: "/admin" });
  },
});
const myBidsRoute = createRoute({
  getParentRoute: () => meRoute,
  path: "/bids",
  validateSearch: MyBidsSearch,
  component: lazyRouteComponent(() => import("./routes/my-bids"), "MyBidsPage"),
});
const purchasesRoute = createRoute({
  getParentRoute: () => meRoute,
  path: "/purchases",
  component: lazyRouteComponent(() => import("./routes/purchases"), "PurchasesPage"),
});
const depositRoute = createRoute({
  getParentRoute: () => meRoute,
  path: "/deposit",
  component: lazyRouteComponent(() => import("./routes/purchases"), "DepositPage"),
});
const watchlistRoute = createRoute({
  getParentRoute: () => meRoute,
  path: "/watchlist",
  component: lazyRouteComponent(() => import("./routes/watchlist"), "WatchlistPage"),
});

// Account & privacy (any signed-in user, admins included). UX guard only: the API independently
// returns 401 (test/privacy.test.ts).
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: lazyRouteComponent(() => import("./routes/account"), "AccountPage"),
});
// Public Privacy Notice, linked from the sign-up consent checkbox.
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: lazyRouteComponent(() => import("./routes/account"), "PrivacyPage"),
});

// UX guard only; the API enforces roles independently (test/authz.test.ts).
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
    if (me.role !== "ADMIN") throw redirect({ to: "/" });
  },
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./routes/admin"), "AdminPage"),
});
const adminBikesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/bikes",
  component: lazyRouteComponent(() => import("./routes/admin-bikes"), "AdminBikesPage"),
});
const adminBikeNewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/bikes/new",
  component: lazyRouteComponent(() => import("./routes/admin-bike-edit"), "AdminBikeNewPage"),
});
const adminBikeRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/bikes/$bikeId",
  component: lazyRouteComponent(() => import("./routes/admin-bike-edit"), "AdminBikeEditPage"),
});

// Day 8: admin observability (live ops, audit trail, per-auction ops).
const adminOpsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/ops",
  component: lazyRouteComponent(() => import("./routes/admin-ops"), "AdminOpsPage"),
});
const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/audit",
  validateSearch: AuditSearch,
  component: lazyRouteComponent(() => import("./routes/admin-audit"), "AdminAuditPage"),
});
const adminAuctionRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/auctions/$auctionId",
  component: lazyRouteComponent(() => import("./routes/admin-auction"), "AdminAuctionPage"),
});

// Settlement (docs/settlement.md): payments after the hammer, deposits.
const adminSettlementsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/settlements",
  validateSearch: SettlementsSearch,
  component: lazyRouteComponent(() => import("./routes/admin-settlements"), "AdminSettlementsPage"),
});
const adminSettlementRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/settlements/$settlementId",
  component: lazyRouteComponent(() => import("./routes/admin-settlements"), "AdminSettlementPage"),
});
const adminDepositsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/deposits",
  component: lazyRouteComponent(() => import("./routes/admin-settlements"), "AdminDepositsPage"),
});

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([
      homeRoute,
      loginRoute,
      registerRoute,
      auctionsRoute,
      auctionDetailRoute,
      meRoute.addChildren([myBidsRoute, watchlistRoute, purchasesRoute, depositRoute]),
      accountRoute,
      privacyRoute,
      adminRoute.addChildren([
        adminIndexRoute,
        adminBikesRoute,
        adminBikeNewRoute,
        adminBikeRoute,
        adminOpsRoute,
        adminAuditRoute,
        adminAuctionRoute,
        adminSettlementsRoute,
        adminSettlementRoute,
        adminDepositsRoute,
      ]),
    ]),
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
