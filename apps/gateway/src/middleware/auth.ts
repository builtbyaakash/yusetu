import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AuthContext } from "../auth/context.js";
import { isElevatedRole, parseRole } from "../auth/context.js";
import type { User } from "../db/schema.js";
import { getSessionUser } from "../auth/routes.js";

export type AuthVariables = {
  user: User;
};

export function authContextFromUser(user: User): AuthContext {
  return {
    userId: user.id,
    username: user.username,
    role: parseRole(user.role),
  };
}

export function getRequestAuth(c: Context): AuthContext | null {
  const user = c.get("user") as User | undefined;
  if (!user) return null;
  return authContextFromUser(user);
}

export const requireSession = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const user = getSessionUser(c);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("user", user);
    await next();
  },
);

export const requireElevated = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const user = getSessionUser(c);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!isElevatedRole(parseRole(user.role))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    c.set("user", user);
    await next();
  },
);