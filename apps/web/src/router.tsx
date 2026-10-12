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

// UX guard only; the API enforces roles independently (test/authz.test.ts).
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
    if (me.role !== "ADMIN") throw redirect({ to: "/" });
  },
  component: AdminPage,
});

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([homeRoute, loginRoute, registerRoute, adminRoute]),
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
