import { createMiddleware } from "hono/factory";
import type { User } from "../db/schema.js";
import { getSessionUser } from "../auth/routes.js";

export type AuthVariables = {
  user: User;
};

export const requireAdmin = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const user = getSessionUser(c);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("user", user);
    await next();
  },
);
