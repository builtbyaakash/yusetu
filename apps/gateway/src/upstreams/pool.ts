import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { eq } from "drizzle-orm";
import type { GatewayConfig } from "../config.js";
import { getDb } from "../db/index.js";
import {
  settings,
  upstreamSecrets,
  upstreams,
  type Upstream,
} from "../db/schema.js";
import { getLogger } from "../logger.js";
import { decryptSecret, requireMasterKey } from "../secrets/crypto.js";
import { assertSafeUpstreamUrl } from "../secrets/ssrf.js";
import {
  buildDockerStdioLaunch,
  isDockerAvailable,
  resolveIsolationImage,
} from "./docker-isolate.js";
import {
  createUpstreamOAuthProvider,
  resolvePublicOrigin,
  type UpstreamOAuthProvider,
} from "./oauth-provider.js";

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
  /** Debounces concurrent status probes for the same upstream. */
  #probing = new Map<string, Promise<UpstreamStatusEntry>>();
  #config: GatewayConfig;
  #statuses = new Map<string, UpstreamStatusEntry>();

  constructor(config: GatewayConfig) {
    this.#config = config;
  }

  getStatus(upstreamId: string): UpstreamStatusEntry {
    return this.#statuses.get(upstreamId) ?? { status: "unknown" as const };
  }

  setDisabled(upstreamId: string): void {
    this.#statuses.set(upstreamId, { status: "disabled" });
  }

  /**
   * Ensure a non-unknown status by attempting connect (reuses getClient).
   * Concurrent callers for the same id share one in-flight probe.
   */
  async ensureStatus(upstreamId: string): Promise<UpstreamStatusEntry> {
    const existing = this.#statuses.get(upstreamId);
    if (existing) return existing;

    const inflight = this.#probing.get(upstreamId);
    if (inflight) return inflight;

    const promise = (async (): Promise<UpstreamStatusEntry> => {
      try {
        await this.getClient(upstreamId);
      } catch {
        // #connect already recorded unhealthy / disabled
      }
      return this.getStatus(upstreamId);
    })();

    this.#probing.set(upstreamId, promise);
    try {
      return await promise;
    } finally {
      this.#probing.delete(upstreamId);
    }
  }

  /**
   * Mark disabled upstreams and kick off background probes for enabled ones.
   * Does not block; safe to call on gateway start.
   */
  warmAll(): void {
    const db = getDb();
    const rows = db.select().from(upstreams).all();
    for (const row of rows) {
      if (!row.enabled) {
        this.setDisabled(row.id);
      } else {
        void this.ensureStatus(row.id);
      }
    }
  }

  async invalidate(upstreamId: string): Promise<void> {
    this.#statuses.delete(upstreamId);
    const existing = this.#clients.get(upstreamId);
    if (existing) {
      this.#clients.delete(upstreamId);
      try {
        await existing.close();
      } catch {
        /* ignore */
      }
    }
  }

  async closeAll(): Promise<void> {
    const closes = [...this.#clients.values()].map((c) => c.close());
    this.#clients.clear();
    await Promise.allSettled(closes);
  }

  loadSecrets(upstreamId: string): Record<string, string> {
    const db = getDb();
    const rows = db
      .select()
      .from(upstreamSecrets)
      .where(eq(upstreamSecrets.upstreamId, upstreamId))
      .all();
    if (rows.length === 0) return {};
    const masterKey = requireMasterKey(this.#config.masterKeyBase64);
    const out: Record<string, string> = {};
    for (const row of rows) {
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

  async getClient(upstreamId: string): Promise<Client> {
    const cached = this.#clients.get(upstreamId);
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.client;
    }

    const inflight = this.#connecting.get(upstreamId);
    if (inflight) return inflight;

    const promise = this.#connect(upstreamId);
    this.#connecting.set(upstreamId, promise);
    try {
      return await promise;
    } finally {
      this.#connecting.delete(upstreamId);
    }
  }

  #oauthProviderFor(upstream: Upstream): UpstreamOAuthProvider | undefined {
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
    );
  }

  async #connect(upstreamId: string): Promise<Client> {
    const log = getLogger("data", { upstreamId });
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
      this.#statuses.set(upstreamId, { status: "disabled" });
      throw new Error(`Upstream disabled: ${upstream.slug}`);
    }

    const secrets = this.loadSecrets(upstreamId);
    const { env, headers } = splitSecrets(secrets);

    try {
      const { client, close } = await this.#openTransport(upstream, env, headers);
      this.#clients.set(upstreamId, {
        client,
        close,
        lastUsedAt: Date.now(),
      });
      this.#statuses.set(upstreamId, { status: "healthy" });
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
      this.#statuses.set(upstreamId, { status: "unhealthy", error: message });
      log.error({ err: message, slug: upstream.slug }, "upstream connect failed");
      throw err instanceof UnauthorizedError
        ? new Error(message)
        : err;
    }
  }

  async #openTransport(
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
        const checkout = upstream.cwd?.trim();
        if (!checkout) {
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
          checkoutAbs: checkout,
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
        getLogger("data", { upstreamId: upstream.id }).info(
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
        cwd: isolation === "docker" ? undefined : upstream.cwd ?? undefined,
        env: childEnv,
        // Must drain piped stderr or verbose servers fill the pipe and deadlock.
        stderr: "pipe",
      });
      const stderrLog = getLogger("data", {
        upstreamId: upstream.id,
        slug: upstream.slug,
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

    const authProvider = this.#oauthProviderFor(upstream);

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
