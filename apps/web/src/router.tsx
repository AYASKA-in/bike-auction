import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "./components/app-shell";
import { meQuery } from "./lib/session";
import { AdminPage } from "./routes/admin";
import { AdminBikeEditPage, AdminBikeNewPage } from "./routes/admin-bike-edit";
import { AdminBikesPage } from "./routes/admin-bikes";
import { AuctionDetailPage } from "./routes/auction-detail";
import { AuctionsPage, CatalogueSearch } from "./routes/auctions";
import { HomePage } from "./routes/home";
import { LoginPage } from "./routes/login";
import { NotFoundPage } from "./routes/not-found";
import { RegisterPage } from "./routes/register";

type RouterContext = { queryClient: QueryClient };

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
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: RedirectSearch,
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ to: "/" });
  },
  component: RegisterPage,
});

const auctionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auctions",
  validateSearch: CatalogueSearch,
  component: AuctionsPage,
});
const auctionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auctions/$auctionId",
  component: AuctionDetailPage,
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
  component: AdminPage,
});
const adminBikesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/bikes",
  component: AdminBikesPage,
});
const adminBikeNewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/bikes/new",
  component: AdminBikeNewPage,
});
const adminBikeRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/bikes/$bikeId",
  component: AdminBikeEditPage,
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
