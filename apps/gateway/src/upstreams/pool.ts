import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import type { GatewayConfig } from "../config.js";
import { getDb } from "../db/index.js";
import {
  settings,
  upstreamSecrets,
  upstreams,
  userUpstreamSecrets,
  type Upstream,
} from "../db/schema.js";
import { getLogger } from "../logger.js";
import { decryptSecret, requireMasterKey } from "../secrets/crypto.js";
import { assertSafeUpstreamUrl } from "../secrets/ssrf.js";
import { poolClientKey } from "./catalog.js";
import {
  buildDockerStdioLaunch,
  isDockerAvailable,
  resolveIsolationImage,
} from "./docker-isolate.js";
import { ensureGitCheckout } from "./git-source.js";
import {
  createUpstreamOAuthProvider,
  resolvePublicOrigin,
  type UpstreamOAuthProvider,
} from "./oauth-provider.js";

export { poolClientKey } from "./catalog.js";

type PooledClient = {
  client: Client;
  close: () => Promise<void>;
  lastUsedAt: number;
};

function parseArgsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return [];
}

function splitSecrets(
  secrets: Record<string, string>,
): { env: Record<string, string>; headers: Record<string, string> } {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(secrets)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) continue;
    if (key.toLowerCase().startsWith("header.")) {
      headers[key.slice("header.".length)] = value;
    } else {
      env[key] = value;
    }
  }
  return { env, headers };
}

type UpstreamStatusEntry = {
  status: "healthy" | "unhealthy" | "unknown" | "disabled";
  error?: string;
};

export class UpstreamPool {
  #clients = new Map<string, PooledClient>();
  #connecting = new Map<string, Promise<Client>>();
  /** Debounces concurrent status probes for the same pool key. */
  #probing = new Map<string, Promise<UpstreamStatusEntry>>();
  #config: GatewayConfig;
  #statuses = new Map<string, UpstreamStatusEntry>();
  #disabledUpstreams = new Set<string>();

  constructor(config: GatewayConfig) {
    this.#config = config;
  }

  getStatus(userId: string, upstreamId: string): UpstreamStatusEntry {
    if (this.#disabledUpstreams.has(upstreamId)) {
      return { status: "disabled" };
    }
    return (
      this.#statuses.get(poolClientKey(userId, upstreamId)) ?? {
        status: "unknown" as const,
      }
    );
  }

  setDisabled(upstreamId: string): void {
    this.#disabledUpstreams.add(upstreamId);
  }

  clearDisabled(upstreamId: string): void {
    this.#disabledUpstreams.delete(upstreamId);
  }

  /**
   * Ensure a non-unknown status by attempting connect (reuses getClient).
   * Concurrent callers for the same pool key share one in-flight probe.
   */
  async ensureStatus(
    userId: string,
    upstreamId: string,
  ): Promise<UpstreamStatusEntry> {
    const key = poolClientKey(userId, upstreamId);
    const existing = this.#statuses.get(key);
    if (existing) return existing;

    const inflight = this.#probing.get(key);
    if (inflight) return inflight;

    const promise = (async (): Promise<UpstreamStatusEntry> => {
      try {
        await this.getClient(userId, upstreamId);
      } catch {
        // #connect already recorded unhealthy / disabled
      }
      return this.getStatus(userId, upstreamId);
    })();

    this.#probing.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#probing.delete(key);
    }
  }

  /**
   * Pool clients are per-user; nothing to warm without a caller userId.
   */
  warmAll(): void {
    getLogger("control").info(
      "warmAll skipped — upstream clients are keyed by userId:upstreamId",
    );
  }

  async invalidate(userId: string, upstreamId: string): Promise<void> {
    const key = poolClientKey(userId, upstreamId);
    this.#statuses.delete(key);
    const existing = this.#clients.get(key);
    if (existing) {
      this.#clients.delete(key);
      try {
        await existing.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Drop every cached client for an upstream (admin definition / shared secret changes). */
  async invalidateAllForUpstream(upstreamId: string): Promise<void> {
    const suffix = `:${upstreamId}`;
    for (const key of [...this.#clients.keys()]) {
      if (!key.endsWith(suffix)) continue;
      this.#statuses.delete(key);
      const existing = this.#clients.get(key);
      this.#clients.delete(key);
      if (existing) {
        try {
          await existing.close();
        } catch {
          /* ignore */
        }
      }
    }
    for (const key of [...this.#statuses.keys()]) {
      if (key.endsWith(suffix)) this.#statuses.delete(key);
    }
  }

  async closeAll(): Promise<void> {
    const closes = [...this.#clients.values()].map((c) => c.close());
    this.#clients.clear();
    await Promise.allSettled(closes);
  }

  loadSecrets(userId: string, upstreamId: string): Record<string, string> {
    const db = getDb();
    const masterKey = requireMasterKey(this.#config.masterKeyBase64);
    const out: Record<string, string> = {};

    const baseRows = db
      .select()
      .from(upstreamSecrets)
      .where(eq(upstreamSecrets.upstreamId, upstreamId))
      .all();
    for (const row of baseRows) {
      out[row.keyName] = decryptSecret(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
        },
        masterKey,
      );
    }

    const overlayRows = db
      .select()
      .from(userUpstreamSecrets)
      .where(
        and(
          eq(userUpstreamSecrets.userId, userId),
          eq(userUpstreamSecrets.upstreamId, upstreamId),
        ),
      )
      .all();
    for (const row of overlayRows) {
      out[row.keyName] = decryptSecret(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
        },
        masterKey,
      );
    }

    return out;
  }

  allowLocalhost(): boolean {
    const db = getDb();
    const row = db
      .select()
      .from(settings)
      .where(eq(settings.key, "allowLocalhost"))
      .get();
    return row?.value === "true" || row?.value === "1";
  }

  async getClient(userId: string, upstreamId: string): Promise<Client> {
    const key = poolClientKey(userId, upstreamId);
    const cached = this.#clients.get(key);
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.client;
    }

    const inflight = this.#connecting.get(key);
    if (inflight) return inflight;

    const promise = this.#connect(userId, upstreamId);
    this.#connecting.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#connecting.delete(key);
    }
  }

  #oauthProviderFor(
    upstream: Upstream,
    userId: string,
  ): UpstreamOAuthProvider | undefined {
    if (upstream.authMode !== "oauth") return undefined;
    if (upstream.transport === "stdio" || !upstream.url) return undefined;
    const publicOrigin = resolvePublicOrigin(
      this.#config,
      `http://${this.#config.host}:${this.#config.port}`,
    );
    return createUpstreamOAuthProvider(
      upstream.id,
      publicOrigin,
      this.#config,
      userId,
    );
  }

  async #connect(userId: string, upstreamId: string): Promise<Client> {
    const key = poolClientKey(userId, upstreamId);
    const log = getLogger("data", { upstreamId, userId });
    const db = getDb();
    const upstream = db
      .select()
      .from(upstreams)
      .where(eq(upstreams.id, upstreamId))
      .get();

    if (!upstream) {
      throw new Error(`Upstream not found: ${upstreamId}`);
    }
    if (!upstream.enabled) {
      this.setDisabled(upstreamId);
      throw new Error(`Upstream disabled: ${upstream.slug}`);
    }
    this.clearDisabled(upstreamId);

    const secrets = this.loadSecrets(userId, upstreamId);
    const { env, headers } = splitSecrets(secrets);

    try {
      const { client, close } = await this.#openTransport(
        userId,
        upstream,
        env,
        headers,
      );
      this.#clients.set(key, {
        client,
        close,
        lastUsedAt: Date.now(),
      });
      this.#statuses.set(key, { status: "healthy" });
      log.info({ slug: upstream.slug, transport: upstream.transport }, "upstream connected");
      return client;
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (
        err instanceof UnauthorizedError ||
        (err instanceof Error && err.name === "UnauthorizedError")
      ) {
        message = "OAuth required — connect from dashboard";
      }
      this.#statuses.set(key, { status: "unhealthy", error: message });
      log.error({ err: message, slug: upstream.slug }, "upstream connect failed");
      throw err instanceof UnauthorizedError
        ? new Error(message)
        : err;
    }
  }

  async #resolveStdioCwd(
    userId: string,
    upstream: Upstream,
  ): Promise<string | undefined> {
    if (upstream.gitUrl?.trim()) {
      return ensureGitCheckout({
        dataDir: this.#config.dataDir,
        userId,
        slug: upstream.slug,
        gitUrl: upstream.gitUrl,
        gitRef: upstream.gitRef,
        installCommand: upstream.installCommand,
      });
    }
    return upstream.cwd?.trim() || undefined;
  }

  async #openTransport(
    userId: string,
    upstream: Upstream,
    env: Record<string, string>,
    headers: Record<string, string>,
  ): Promise<{ client: Client; close: () => Promise<void> }> {
    const client = new Client(
      { name: "yusetu-gateway", version: "0.1.0" },
      { capabilities: {} },
    );

    if (upstream.transport === "stdio") {
      if (!upstream.command) {
        throw new Error(`stdio upstream ${upstream.slug} missing command`);
      }

      const isolation = (upstream.isolation ?? "host") as "host" | "docker";
      const isolationNetwork = (upstream.isolationNetwork ?? "none") as
        | "none"
        | "bridge";
      const innerArgs = parseArgsJson(upstream.argsJson);
      let spawnCommand = upstream.command;
      let spawnArgs = innerArgs;
      let childEnv: Record<string, string>;
      const checkoutAbs = await this.#resolveStdioCwd(userId, upstream);

      if (isolation === "docker") {
        const dockerCfg = {
          nodeImage: this.#config.dockerIsolationNodeImage,
          uvImage: this.#config.dockerIsolationUvImage,
          dockerBin: this.#config.dockerBin,
        };
        if (!(await isDockerAvailable(dockerCfg.dockerBin))) {
          throw new Error(
            `Upstream ${upstream.slug} requires Docker isolation but Docker is not available. Install Docker or set isolation=host (trusted repos only).`,
          );
        }
        if (!checkoutAbs) {
          throw new Error(
            `Docker isolation for ${upstream.slug} requires a checkout cwd (Git-sourced MCP)`,
          );
        }
        const image = resolveIsolationImage(
          upstream.command,
          upstream.isolationImage,
          dockerCfg,
        );
        // Only that MCP's secrets — not the gateway process environment.
        const launch = buildDockerStdioLaunch({
          slug: upstream.slug,
          checkoutAbs,
          command: upstream.command,
          args: innerArgs,
          env: {
            ...env,
            UV_PYTHON_PREFERENCE: env.UV_PYTHON_PREFERENCE ?? "only-managed",
          },
          network: isolationNetwork,
          image,
          dockerBin: dockerCfg.dockerBin,
        });
        spawnCommand = launch.command;
        spawnArgs = launch.args;
        // Docker CLI needs host PATH; container gets secrets via -e flags above.
        childEnv = { ...getDefaultEnvironment() };
      } else {
        childEnv = { ...getDefaultEnvironment(), ...env };
        if (upstream.command === "uv" || upstream.command === "uvx") {
          childEnv.UV_PYTHON_PREFERENCE =
            childEnv.UV_PYTHON_PREFERENCE ?? "only-managed";
        }
        getLogger("data", { upstreamId: upstream.id, userId }).info(
          {
            slug: upstream.slug,
            envKeys: Object.keys(env).sort(),
            isolation: "host",
          },
          "spawning stdio upstream on host (no container isolation)",
        );
      }

      const transport = new StdioClientTransport({
        command: spawnCommand,
        args: spawnArgs,
        cwd: isolation === "docker" ? undefined : checkoutAbs,
        env: childEnv,
        // Must drain piped stderr or verbose servers fill the pipe and deadlock.
        stderr: "pipe",
      });
      const stderrLog = getLogger("data", {
        upstreamId: upstream.id,
        slug: upstream.slug,
        userId,
      });
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk).trimEnd();
        if (text) stderrLog.info({ line: text }, "stdio upstream stderr");
      });
      await client.connect(transport);
      return {
        client,
        close: async () => {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        },
      };
    }

    if (!upstream.url) {
      throw new Error(`HTTP upstream ${upstream.slug} missing url`);
    }

    await assertSafeUpstreamUrl(upstream.url, {
      allowLocalhost: this.allowLocalhost(),
    });

    const requestInit: RequestInit = {
      headers: { ...headers },
    };

    const authProvider = this.#oauthProviderFor(upstream, userId);

    if (upstream.transport === "streamable-http") {
      const transport = new StreamableHTTPClientTransport(new URL(upstream.url), {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
      });
      await client.connect(transport);
      return {
        client,
        close: async () => {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        },
      };
    }

    // legacy SSE
    const transport = new SSEClientTransport(new URL(upstream.url), {
      requestInit,
      ...(authProvider ? { authProvider } : {}),
    });
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      },
    };
  }
}
