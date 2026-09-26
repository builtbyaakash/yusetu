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
import { requireElevated, requireSession } from "./middleware/auth.js";
import {
  createUpstreamGrant,
  listUpstreamGrants,
  revokeUpstreamGrant,
} from "./admin/grants.js";
import {
  createInvite,
  handleJoin,
  listInvites,
  listMembers,
  patchMemberRole,
  removeMember,
  revokeInvite,
} from "./admin/team.js";
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
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
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
    config.inlineTinyMcps,
    config.schemaCompression,
  );

  app.get("/api/health", createHealthHandler(pool));

  app.post("/api/auth/setup", handleSetup);
  app.post("/api/auth/login", handleLogin);
  app.post("/api/auth/logout", handleLogout);
  app.post("/api/auth/join", handleJoin);
  app.get("/api/auth/me", handleMe);

  app.post("/api/team/invites", requireElevated, createInvite);
  app.get("/api/team/invites", requireElevated, listInvites);
  app.delete("/api/team/invites/:id", requireElevated, revokeInvite);
  app.get("/api/team/members", requireElevated, listMembers);
  app.patch("/api/team/members/:userId", requireElevated, patchMemberRole);
  app.delete("/api/team/members/:userId", requireElevated, removeMember);

  app.get("/api/upstreams", requireSession, (c) => upstreams.list(c));
  app.get("/api/upstreams/:id", requireSession, (c) => upstreams.get(c));
  app.post("/api/upstreams", requireSession, (c) => upstreams.create(c));
  app.patch("/api/upstreams/:id", requireSession, (c) => upstreams.update(c));
  app.delete("/api/upstreams/:id", requireSession, (c) => upstreams.remove(c));
  app.delete("/api/upstreams/:id/secrets/:key", requireSession, (c) =>
    upstreams.removeSecret(c),
  );
  app.get(
    "/api/upstreams/:id/grants",
    requireElevated,
    listUpstreamGrants,
  );
  app.post(
    "/api/upstreams/:id/grants",
    requireElevated,
    createUpstreamGrant,
  );
  app.delete(
    "/api/upstreams/:id/grants/:userId",
    requireElevated,
    revokeUpstreamGrant,
  );
  app.post("/api/upstreams/:id/discover", requireSession, (c) =>
    upstreams.discover(c),
  );
  app.post("/api/upstreams/:id/oauth/start", requireSession, (c) =>
    upstreamOauth.start(c),
  );
  app.get("/api/upstreams/:id/oauth/status", requireSession, (c) =>
    upstreamOauth.status(c),
  );
  app.post("/api/upstreams/:id/oauth/disconnect", requireSession, (c) =>
    upstreamOauth.disconnect(c),
  );

  // Outbound upstream OAuth callback (browser returns from AS)
  app.get(
    "/oauth/upstream/callback",
    createUpstreamOauthCallbackHandler(config, pool),
  );

  app.get("/api/tools", requireSession, listTools);
  app.patch("/api/tools/:id", requireSession, updateTool);

  app.post("/api/playground/call", requireSession, createPlaygroundHandler(router));

  app.get("/api/api-keys", requireSession, listApiKeys);
  app.post("/api/api-keys", requireSession, createApiKey);
  app.delete("/api/api-keys/:id", requireSession, deleteApiKey);

  app.get(
    "/api/analytics/usage",
    requireSession,
    createUsageAnalyticsHandler(config.toolPresentation),
  );

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
