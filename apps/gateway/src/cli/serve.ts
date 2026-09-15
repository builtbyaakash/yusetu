import { serve } from "@hono/node-server";
import type { GatewayConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { assertMasterKeyIfNeeded } from "../db/boot-checks.js";
import { closeDb, openDb } from "../db/index.js";
import { initLogger, getLogger } from "../logger.js";
import { createApp } from "../app.js";
import { rebuildSnapshotFromDb } from "../mcp/rebuild-snapshot.js";
import { ToolRouter } from "../mcp/router.js";
import { UpstreamPool } from "../upstreams/pool.js";

export type ServeHandles = {
  config: GatewayConfig;
  pool: UpstreamPool;
  close: () => Promise<void>;
};

export async function startServer(
  overrides?: Partial<Pick<GatewayConfig, "host" | "port">>,
): Promise<ServeHandles> {
  const loaded = loadConfig();
  const config: GatewayConfig = {
    ...loaded,
    ...(overrides?.host !== undefined ? { host: overrides.host } : {}),
    ...(overrides?.port !== undefined ? { port: overrides.port } : {}),
  };
  initLogger(config);
  const log = getLogger("control");

  openDb(config.dbPath);
  assertMasterKeyIfNeeded(config);
  rebuildSnapshotFromDb();

  const pool = new UpstreamPool(config);
  const router = new ToolRouter(pool);
  const app = createApp(config, pool, router);

  // Populate healthy/unhealthy/disabled without waiting for first tool call.
  pool.warmAll();

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (info) => {
      log.info(
        {
          host: info.address,
          port: info.port,
          mcp: `http://${config.host}:${info.port}/mcp`,
          health: `http://${config.host}:${info.port}/api/health`,
        },
        "yusetu gateway listening",
      );
    },
  );

  const close = async () => {
    await pool.closeAll();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
  };

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return { config, pool, close };
}
