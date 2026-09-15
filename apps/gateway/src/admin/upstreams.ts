import { and, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import {
  CreateUpstreamSchema,
  UpdateUpstreamSchema,
  slugifyUpstreamName,
  type UpstreamAuthMode,
  type UpstreamTransport,
} from "@yusetu/shared";
import type { GatewayConfig } from "../config.js";
import { getDb } from "../db/index.js";
import {
  tools,
  upstreamSecrets,
  upstreams,
  type Upstream,
} from "../db/schema.js";
import { getLogger } from "../logger.js";
import { rebuildSnapshotFromDb } from "../mcp/rebuild-snapshot.js";
import {
  encryptSecret,
  requireMasterKey,
} from "../secrets/crypto.js";
import { assertSafeUpstreamUrl } from "../secrets/ssrf.js";
import { detectHttpTransport } from "../upstreams/detect-transport.js";
import { discoverUpstreamTools } from "../upstreams/discover.js";
import {
  ensureGitCheckout,
  removeMcpSourceDir,
  runInstallCommand,
} from "../upstreams/git-source.js";
import {
  ensureUpstreamOauthRow,
  getUpstreamOauthRow,
} from "../upstreams/oauth-provider.js";
import type { UpstreamPool } from "../upstreams/pool.js";

function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseArgs(argsJson: string | null): string[] | null {
  if (!argsJson) return null;
  try {
    return JSON.parse(argsJson) as string[];
  } catch {
    return null;
  }
}

function secretKeysFor(upstreamId: string): string[] {
  const db = getDb();
  return db
    .select({ keyName: upstreamSecrets.keyName })
    .from(upstreamSecrets)
    .where(eq(upstreamSecrets.upstreamId, upstreamId))
    .all()
    .map((row) => row.keyName);
}

function serializeUpstream(
  row: Upstream,
  extras?: {
    toolCount?: number;
    status?: "healthy" | "unhealthy" | "unknown" | "disabled";
  },
) {
  const authMode = (row.authMode ?? "none") as UpstreamAuthMode;
  const oauthRow =
    authMode === "oauth" ? getUpstreamOauthRow(row.id) : undefined;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    transport: row.transport as UpstreamTransport,
    command: row.command,
    argsJson: parseArgs(row.argsJson),
    cwd: row.cwd,
    url: row.url,
    gitUrl: row.gitUrl,
    gitRef: row.gitRef,
    installCommand: row.installCommand,
    enabled: row.enabled,
    timeoutMs: row.timeoutMs,
    authMode,
    oauthStatus:
      oauthRow?.status ?? (authMode === "oauth" ? "disconnected" : null),
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
    secretKeys: secretKeysFor(row.id),
    toolCount: extras?.toolCount,
    status:
      extras?.status ??
      (row.enabled ? ("unknown" as const) : ("disabled" as const)),
  };
}

async function validateHttpUrl(
  url: string | undefined | null,
  transport: string,
  pool: UpstreamPool,
): Promise<void> {
  if (transport === "stdio" || !url) return;
  await assertSafeUpstreamUrl(url, { allowLocalhost: pool.allowLocalhost() });
}

/**
 * When transport is HTTP-ish and a URL is present, overwrite with detected
 * streamable-http | sse. stdio is left unchanged. Probe/auth failures fall
 * back inside detectHttpTransport (never blocks create).
 */
async function resolveStoredTransport(
  transport: UpstreamTransport,
  url: string | undefined | null,
  pool: UpstreamPool,
): Promise<UpstreamTransport> {
  if (transport === "stdio" || !url) return transport;
  return detectHttpTransport(url, { allowLocalhost: pool.allowLocalhost() });
}

function storeSecrets(
  upstreamId: string,
  secrets: Record<string, string> | undefined,
  config: GatewayConfig,
): void {
  if (!secrets || Object.keys(secrets).length === 0) return;
  const masterKey = requireMasterKey(config.masterKeyBase64);
  const db = getDb();
  for (const [rawKey, rawValue] of Object.entries(secrets)) {
    const keyName = rawKey.trim();
    const value = rawValue.trim();
    if (!keyName || !value) continue;
    const enc = encryptSecret(value, masterKey);
    const existing = db
      .select()
      .from(upstreamSecrets)
      .where(eq(upstreamSecrets.upstreamId, upstreamId))
      .all()
      .find((r) => r.keyName === keyName);

    if (existing) {
      db.update(upstreamSecrets)
        .set({
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
        })
        .where(eq(upstreamSecrets.id, existing.id))
        .run();
    } else {
      db.insert(upstreamSecrets)
        .values({
          id: crypto.randomUUID(),
          upstreamId,
          keyName,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
        })
        .run();
    }
  }
}

/** Delete secret rows by key name. Returns how many keys were removed. */
function deleteSecrets(
  upstreamId: string,
  keys: string[] | undefined,
): number {
  if (!keys || keys.length === 0) return 0;
  const db = getDb();
  let removed = 0;
  for (const rawKey of keys) {
    const keyName = rawKey.trim();
    if (!keyName) continue;
    const result = db
      .delete(upstreamSecrets)
      .where(
        and(
          eq(upstreamSecrets.upstreamId, upstreamId),
          eq(upstreamSecrets.keyName, keyName),
        ),
      )
      .run();
    if (result.changes > 0) removed += 1;
  }
  return removed;
}

export function createUpstreamHandlers(
  config: GatewayConfig,
  pool: UpstreamPool,
) {
  const log = getLogger("control");

  return {
    async list(c: Context) {
      const db = getDb();
      const rows = db.select().from(upstreams).all();
      // Probe any enabled upstream still lacking a cached status (e.g. race
      // before warmAll finishes, or after invalidate).
      await Promise.all(
        rows.map(async (row) => {
          if (!row.enabled) {
            pool.setDisabled(row.id);
            return;
          }
          if (pool.getStatus(row.id).status === "unknown") {
            await pool.ensureStatus(row.id);
          }
        }),
      );
      return c.json(
        rows.map((row) => {
          const toolCount =
            db
              .select({ value: count() })
              .from(tools)
              .where(eq(tools.upstreamId, row.id))
              .get()?.value ?? 0;
          const status = !row.enabled
            ? ("disabled" as const)
            : pool.getStatus(row.id).status;
          return serializeUpstream(row, { toolCount, status });
        }),
      );
    },

    async get(c: Context) {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing id" }, 400);
      const db = getDb();
      const row = db.select().from(upstreams).where(eq(upstreams.id, id)).get();
      if (!row) return c.json({ error: "Not found" }, 404);
      if (!row.enabled) {
        pool.setDisabled(id);
      } else if (pool.getStatus(id).status === "unknown") {
        await pool.ensureStatus(id);
      }
      const toolCount =
        db
          .select({ value: count() })
          .from(tools)
          .where(eq(tools.upstreamId, id))
          .get()?.value ?? 0;
      const status = !row.enabled
        ? ("disabled" as const)
        : pool.getStatus(row.id).status;
      return c.json(serializeUpstream(row, { toolCount, status }));
    },

    async create(c: Context) {
      const parsed = CreateUpstreamSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.flatten() },
          400,
        );
      }
      const data = parsed.data;
      if (data.transport === "stdio" && !data.command) {
        return c.json({ error: "command is required for stdio transport" }, 400);
      }
      if (data.transport !== "stdio" && !data.url) {
        return c.json({ error: "url is required for HTTP transports" }, 400);
      }
      if (data.authMode === "oauth" && data.transport === "stdio") {
        return c.json(
          { error: "authMode oauth is only valid for HTTP transports" },
          400,
        );
      }

      try {
        await validateHttpUrl(data.url, data.transport, pool);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      let transport = data.transport;
      try {
        transport = await resolveStoredTransport(
          data.transport,
          data.url,
          pool,
        );
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      const db = getDb();
      const baseSlug = slugifyUpstreamName(data.name);
      let slug = baseSlug;
      for (let n = 2; ; n++) {
        const taken = db
          .select()
          .from(upstreams)
          .where(eq(upstreams.slug, slug))
          .get();
        if (!taken) break;
        if (n > 100) {
          return c.json({ error: "could not allocate unique slug" }, 409);
        }
        const suffix = `-${n}`;
        slug = `${baseSlug.slice(0, 64 - suffix.length)}${suffix}`;
      }

      const user = c.get("user") as { id: string };
      const id = crypto.randomUUID();
      const now = new Date();

      const gitUrl = emptyToNull(data.gitUrl);
      const gitRef = emptyToNull(data.gitRef);
      const installCommand = emptyToNull(data.installCommand);
      let cwd = data.cwd ?? null;

      if (gitUrl) {
        try {
          const checkout = await ensureGitCheckout({
            dataDir: config.dataDir,
            slug,
            gitUrl,
            gitRef,
          });
          if (installCommand) {
            await runInstallCommand(checkout, installCommand);
          }
          cwd = checkout;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            { slug, gitUrl, err: message },
            "git MCP source clone/install failed",
          );
          await removeMcpSourceDir(config.dataDir, slug);
          return c.json({ error: message }, 400);
        }
      }

      try {
        db.insert(upstreams)
          .values({
            id,
            slug,
            name: data.name,
            transport,
            command: data.command ?? null,
            argsJson: data.argsJson ? JSON.stringify(data.argsJson) : null,
            cwd,
            url: data.url ?? null,
            gitUrl,
            gitRef,
            installCommand,
            enabled: data.enabled,
            timeoutMs: data.timeoutMs,
            authMode: data.authMode,
            createdAt: now,
            createdByUserId: user.id,
          })
          .run();

        storeSecrets(id, data.secrets, config);
        if (data.authMode === "oauth") {
          ensureUpstreamOauthRow(id);
        }
      } catch (err) {
        db.delete(upstreams).where(eq(upstreams.id, id)).run();
        if (gitUrl) {
          await removeMcpSourceDir(config.dataDir, slug);
        }
        throw err;
      }

      rebuildSnapshotFromDb();
      log.info({ upstreamId: id, slug, transport }, "upstream created");

      let discovered: number | undefined;
      let discoveryError: string | undefined;

      if (!data.enabled) {
        log.info({ upstreamId: id }, "skip auto-discover; upstream disabled");
      } else if (data.authMode === "oauth") {
        log.info(
          { upstreamId: id },
          "skip auto-discover until OAuth connected",
        );
      } else {
        try {
          const result = await discoverUpstreamTools(id, pool);
          discovered = result.discovered;
        } catch (err) {
          discoveryError = err instanceof Error ? err.message : String(err);
          log.error(
            { upstreamId: id, err: discoveryError },
            "auto-discover failed",
          );
        }
      }

      const row = db.select().from(upstreams).where(eq(upstreams.id, id)).get()!;
      const toolCount =
        discovered ??
        db
          .select({ value: count() })
          .from(tools)
          .where(eq(tools.upstreamId, id))
          .get()?.value ??
        0;
      const status = !row.enabled
        ? ("disabled" as const)
        : pool.getStatus(id).status;
      return c.json(
        {
          ...serializeUpstream(row, { toolCount, status }),
          ...(discovered !== undefined ? { discovered } : {}),
          ...(discoveryError ? { discoveryError } : {}),
        },
        201,
      );
    },

    async update(c: Context) {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing id" }, 400);
      const parsed = UpdateUpstreamSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.flatten() },
          400,
        );
      }
      const db = getDb();
      const row = db.select().from(upstreams).where(eq(upstreams.id, id)).get();
      if (!row) return c.json({ error: "Not found" }, 404);

      const data = parsed.data;
      const nextTransport = data.transport ?? row.transport;
      const nextUrl = data.url !== undefined ? data.url : row.url;
      const nextAuthMode = data.authMode ?? row.authMode;
      const nextCommand =
        data.command !== undefined ? data.command : row.command;

      if (nextAuthMode === "oauth" && nextTransport === "stdio") {
        return c.json(
          { error: "authMode oauth is only valid for HTTP transports" },
          400,
        );
      }

      const nextGitUrlPreview =
        data.gitUrl !== undefined ? emptyToNull(data.gitUrl) : row.gitUrl;
      if (nextGitUrlPreview && nextTransport !== "stdio") {
        return c.json(
          { error: "gitUrl requires transport to be stdio" },
          400,
        );
      }
      if (nextGitUrlPreview && !nextCommand?.trim()) {
        return c.json(
          { error: "gitUrl requires command to run the MCP" },
          400,
        );
      }

      try {
        await validateHttpUrl(nextUrl, nextTransport, pool);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      // Re-detect when URL or HTTP transport is in the body (edit save / URL change).
      let resolvedTransport = nextTransport as UpstreamTransport;
      const shouldRedetect =
        nextTransport !== "stdio" &&
        !!nextUrl &&
        (data.url !== undefined ||
          data.transport === "sse" ||
          data.transport === "streamable-http");
      if (shouldRedetect) {
        try {
          resolvedTransport = await resolveStoredTransport(
            nextTransport as UpstreamTransport,
            nextUrl,
            pool,
          );
        } catch (err) {
          return c.json(
            { error: err instanceof Error ? err.message : String(err) },
            400,
          );
        }
      }

      const nextGitUrl =
        data.gitUrl !== undefined ? emptyToNull(data.gitUrl) : row.gitUrl;
      const nextGitRef =
        data.gitRef !== undefined ? emptyToNull(data.gitRef) : row.gitRef;
      const nextInstallCommand =
        data.installCommand !== undefined
          ? emptyToNull(data.installCommand)
          : row.installCommand;

      const gitSourceChanged =
        nextGitUrl !== row.gitUrl ||
        nextGitRef !== row.gitRef ||
        nextInstallCommand !== row.installCommand;

      let cwd =
        data.cwd !== undefined ? (data.cwd ?? null) : row.cwd;

      if (nextGitUrl && (gitSourceChanged || !row.gitUrl)) {
        try {
          const checkout = await ensureGitCheckout({
            dataDir: config.dataDir,
            slug: row.slug,
            gitUrl: nextGitUrl,
            gitRef: nextGitRef,
          });
          if (nextInstallCommand) {
            await runInstallCommand(checkout, nextInstallCommand);
          }
          cwd = checkout;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            { upstreamId: id, slug: row.slug, gitUrl: nextGitUrl, err: message },
            "git MCP source clone/install failed",
          );
          return c.json({ error: message }, 400);
        }
      } else if (!nextGitUrl && row.gitUrl) {
        // Cleared git source — drop managed checkout; keep client cwd if provided.
        await removeMcpSourceDir(config.dataDir, row.slug);
        if (data.cwd === undefined) {
          // Previous cwd was the managed path; clear it unless client set a new one.
          cwd = null;
        }
      }

      db.update(upstreams)
        .set({
          name: data.name ?? row.name,
          transport: resolvedTransport,
          command: data.command !== undefined ? data.command ?? null : row.command,
          argsJson:
            data.argsJson !== undefined
              ? data.argsJson
                ? JSON.stringify(data.argsJson)
                : null
              : row.argsJson,
          cwd,
          url: data.url !== undefined ? data.url ?? null : row.url,
          gitUrl: nextGitUrl,
          gitRef: nextGitRef,
          installCommand: nextInstallCommand,
          enabled: data.enabled ?? row.enabled,
          timeoutMs: data.timeoutMs ?? row.timeoutMs,
          authMode: nextAuthMode,
        })
        .where(eq(upstreams.id, id))
        .run();

      if (data.removeSecrets?.length) {
        deleteSecrets(id, data.removeSecrets);
      }
      if (data.secrets) {
        storeSecrets(id, data.secrets, config);
      }

      if (nextAuthMode === "oauth") {
        ensureUpstreamOauthRow(id);
      }

      await pool.invalidate(id);
      if (!(data.enabled ?? row.enabled)) {
        pool.setDisabled(id);
      }
      rebuildSnapshotFromDb();

      const updated = db.select().from(upstreams).where(eq(upstreams.id, id)).get()!;
      const enabled = updated.enabled;
      const connectionChanged =
        (data.url !== undefined && data.url !== row.url) ||
        (data.command !== undefined && data.command !== row.command) ||
        (data.argsJson !== undefined &&
          JSON.stringify(data.argsJson) !== row.argsJson) ||
        cwd !== row.cwd ||
        gitSourceChanged ||
        resolvedTransport !== row.transport;

      let discovered: number | undefined;
      let discoveryError: string | undefined;

      if (!enabled || !connectionChanged) {
        // no auto-discover
      } else if (updated.authMode === "oauth") {
        log.info(
          { upstreamId: id },
          "skip auto-discover until OAuth connected",
        );
      } else {
        try {
          const result = await discoverUpstreamTools(id, pool);
          discovered = result.discovered;
        } catch (err) {
          discoveryError = err instanceof Error ? err.message : String(err);
          log.error(
            { upstreamId: id, err: discoveryError },
            "auto-discover failed",
          );
        }
      }

      const toolCount =
        discovered ??
        db
          .select({ value: count() })
          .from(tools)
          .where(eq(tools.upstreamId, id))
          .get()?.value ??
        0;
      const status = !enabled
        ? ("disabled" as const)
        : pool.getStatus(id).status;
      return c.json({
        ...serializeUpstream(updated, { toolCount, status }),
        ...(discovered !== undefined ? { discovered } : {}),
        ...(discoveryError ? { discoveryError } : {}),
      });
    },

    async removeSecret(c: Context) {
      const id = c.req.param("id");
      const rawKey = c.req.param("key");
      if (!id) return c.json({ error: "Missing id" }, 400);
      if (!rawKey) return c.json({ error: "Missing key" }, 400);

      const keyName = (() => {
        try {
          return decodeURIComponent(rawKey).trim();
        } catch {
          return rawKey.trim();
        }
      })();
      if (!keyName) return c.json({ error: "Missing key" }, 400);

      const db = getDb();
      const row = db.select().from(upstreams).where(eq(upstreams.id, id)).get();
      if (!row) return c.json({ error: "Not found" }, 404);

      const removed = deleteSecrets(id, [keyName]);
      if (removed === 0) {
        return c.json({ error: "Secret key not found" }, 404);
      }

      await pool.invalidate(id);
      if (!row.enabled) {
        pool.setDisabled(id);
      }
      rebuildSnapshotFromDb();
      log.info({ upstreamId: id, keyName }, "upstream secret deleted");

      const toolCount =
        db
          .select({ value: count() })
          .from(tools)
          .where(eq(tools.upstreamId, id))
          .get()?.value ?? 0;
      const status = !row.enabled
        ? ("disabled" as const)
        : pool.getStatus(id).status;
      return c.json(serializeUpstream(row, { toolCount, status }));
    },

    async remove(c: Context) {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing id" }, 400);
      const db = getDb();
      const row = db.select().from(upstreams).where(eq(upstreams.id, id)).get();
      if (!row) return c.json({ error: "Not found" }, 404);

      await pool.invalidate(id);
      db.delete(upstreams).where(eq(upstreams.id, id)).run();
      rebuildSnapshotFromDb();
      if (row.gitUrl) {
        await removeMcpSourceDir(config.dataDir, row.slug);
      }
      log.info({ upstreamId: id, slug: row.slug }, "upstream deleted");
      return c.body(null, 204);
    },

    async discover(c: Context) {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing id" }, 400);
      const db = getDb();
      const row = db.select().from(upstreams).where(eq(upstreams.id, id)).get();
      if (!row) return c.json({ error: "Not found" }, 404);

      try {
        await discoverUpstreamTools(id, pool);
        const refreshed = db
          .select()
          .from(upstreams)
          .where(eq(upstreams.id, id))
          .get()!;
        const toolCount =
          db
            .select({ value: count() })
            .from(tools)
            .where(eq(tools.upstreamId, id))
            .get()?.value ?? 0;
        return c.json(
          serializeUpstream(refreshed, {
            toolCount,
            status: pool.getStatus(id).status,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ upstreamId: id, err: message }, "discover failed");
        return c.json({ error: message }, 502);
      }
    },
  };
}
