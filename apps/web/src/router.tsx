import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";
import { HomePage } from "./routes/home";
import { NotFoundPage } from "./routes/not-found";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute]),
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
