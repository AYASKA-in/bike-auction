import { Role } from "@bike/contracts";
import { createMiddleware } from "hono/factory";
import { getAuth } from "../auth/auth";
import { AppError } from "../lib/problem";
import type { AppEnv } from "../types";

/** Resolves the session (if any) from the cookie. Never trusts identity from headers or body. */
export const loadSession = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await getAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) {
    const role = Role.safeParse((session.user as { role?: unknown }).role);
    c.set("user", {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: role.success ? role.data : "USER",
    });
  } else {
    c.set("user", null);
  }
  await next();
});

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) throw new AppError("AUTH_REQUIRED", "Sign in to continue");
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) throw new AppError("AUTH_REQUIRED", "Sign in to continue");
  if (user.role !== "ADMIN") throw new AppError("FORBIDDEN", "Administrator access required");
  await next();
});
