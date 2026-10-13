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

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([
      homeRoute,
      loginRoute,
      registerRoute,
      auctionsRoute,
      auctionDetailRoute,
      adminRoute.addChildren([adminIndexRoute, adminBikesRoute, adminBikeNewRoute, adminBikeRoute]),
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
