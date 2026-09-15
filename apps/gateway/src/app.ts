import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { GatewayConfig } from "./config.js";
import {
  handleLogin,
  handleLogout,
  handleMe,
  handleSetup,
} from "./auth/routes.js";
import { createUpstreamHandlers } from "./admin/upstreams.js";
import { listTools, updateTool } from "./admin/tools.js";
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
} from "./admin/api-keys.js";
import { createPlaygroundHandler } from "./admin/playground.js";
import { createUsageAnalyticsHandler } from "./admin/analytics.js";
import { createHealthHandler } from "./admin/routes.js";
import { createMcpHttpHandler } from "./mcp/http.js";
import type { ToolRouter } from "./mcp/router.js";
import { requireAdmin } from "./middleware/auth.js";
import { createMcpAuthMiddleware } from "./middleware/mcp-auth.js";
import { createOauthAuthorizeRoutes } from "./oauth/authorize.js";
import { createOauthMetadataRoutes } from "./oauth/metadata.js";
import { createOauthRegisterRoutes } from "./oauth/register.js";
import { createOauthTokenRoutes } from "./oauth/token.js";
import type { UpstreamPool } from "./upstreams/pool.js";
import {
  createUpstreamOauthCallbackHandler,
  createUpstreamOauthHandlers,
} from "./upstreams/oauth-routes.js";

function isNonSpaPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/mcp") ||
    pathname.startsWith("/oauth") ||
    pathname.startsWith("/.well-known")
  );
}

export function createApp(
  config: GatewayConfig,
  pool: UpstreamPool,
  router: ToolRouter,
): Hono {
  const app = new Hono();
  const upstreams = createUpstreamHandlers(config, pool);
  const upstreamOauth = createUpstreamOauthHandlers(config, pool);
  const mcpAuth = createMcpAuthMiddleware(config);
  const mcpHandler = createMcpHttpHandler(
    router,
    pool,
    config.toolPresentation,
  );

  app.get("/api/health", createHealthHandler(pool));

  app.post("/api/auth/setup", handleSetup);
  app.post("/api/auth/login", handleLogin);
  app.post("/api/auth/logout", handleLogout);
  app.get("/api/auth/me", handleMe);

  app.get("/api/upstreams", requireAdmin, (c) => upstreams.list(c));
  app.get("/api/upstreams/:id", requireAdmin, (c) => upstreams.get(c));
  app.post("/api/upstreams", requireAdmin, (c) => upstreams.create(c));
  app.patch("/api/upstreams/:id", requireAdmin, (c) => upstreams.update(c));
  app.delete("/api/upstreams/:id", requireAdmin, (c) => upstreams.remove(c));
  app.delete("/api/upstreams/:id/secrets/:key", requireAdmin, (c) =>
    upstreams.removeSecret(c),
  );
  app.post("/api/upstreams/:id/discover", requireAdmin, (c) =>
    upstreams.discover(c),
  );
  app.post("/api/upstreams/:id/oauth/start", requireAdmin, (c) =>
    upstreamOauth.start(c),
  );
  app.get("/api/upstreams/:id/oauth/status", requireAdmin, (c) =>
    upstreamOauth.status(c),
  );
  app.post("/api/upstreams/:id/oauth/disconnect", requireAdmin, (c) =>
    upstreamOauth.disconnect(c),
  );

  // Outbound upstream OAuth callback (browser returns from AS)
  app.get(
    "/oauth/upstream/callback",
    createUpstreamOauthCallbackHandler(config, pool),
  );

  app.get("/api/tools", requireAdmin, listTools);
  app.patch("/api/tools/:id", requireAdmin, updateTool);

  app.post("/api/playground/call", requireAdmin, createPlaygroundHandler(router));

  app.get("/api/api-keys", requireAdmin, listApiKeys);
  app.post("/api/api-keys", requireAdmin, createApiKey);
  app.delete("/api/api-keys/:id", requireAdmin, deleteApiKey);

  app.get("/api/analytics/usage", requireAdmin, createUsageAnalyticsHandler());

  if (config.enableMcpOauth) {
    app.route("/", createOauthMetadataRoutes());
    app.route("/", createOauthRegisterRoutes());
    app.route("/", createOauthAuthorizeRoutes());
    app.route("/", createOauthTokenRoutes());
  }

  app.all("/mcp", mcpAuth, (c) => mcpHandler(c));
  // Legacy SSE endpoint intentionally omitted — use Streamable HTTP at /mcp.
  // See mcp/http.ts for notes.

  const dashboardDist = config.dashboardDist;
  if (existsSync(dashboardDist)) {
    app.use(
      "/*",
      serveStatic({
        root: dashboardDist,
      }),
    );

    app.get("*", async (c) => {
      if (isNonSpaPath(c.req.path)) {
        return c.json({ error: "Not found" }, 404);
      }
      const indexPath = path.join(dashboardDist, "index.html");
      if (!existsSync(indexPath)) {
        return c.text("Dashboard index missing", 404);
      }
      const html = await readFile(indexPath, "utf8");
      return c.html(html);
    });
  } else {
    app.get("/", (c) =>
      c.json({
        name: "yusetu",
        message: "Gateway running. Dashboard dist not found.",
        health: "/api/health",
        mcp: "/mcp",
      }),
    );
  }

  return app;
}
