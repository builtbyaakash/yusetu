import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getLogger } from "../logger.js";
import { assertSafeUpstreamUrl } from "../secrets/ssrf.js";

export type HttpTransport = "streamable-http" | "sse";

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/**
 * Fast URL-path heuristics (no network). Returns a preference or null if ambiguous.
 * Prefer SSE matches first — `/assets` must not count as SSE.
 */
export function heuristicHttpTransport(rawUrl: string): HttpTransport | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";

  if (path.includes("/sse") || last === "sse") {
    return "sse";
  }

  if (
    path.includes("/mcp") ||
    last === "mcp" ||
    path.includes("streamable") ||
    last === "message"
  ) {
    return "streamable-http";
  }

  return null;
}

async function probeTransport(
  kind: HttpTransport,
  rawUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const client = new Client(
    { name: "yusetu-transport-detect", version: "0.1.0" },
    { capabilities: {} },
  );
  const target = new URL(rawUrl);
  const transport =
    kind === "streamable-http"
      ? new StreamableHTTPClientTransport(target, { requestInit: {} })
      : new SSEClientTransport(target, { requestInit: {} });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void client.close().catch(() => undefined);
    void transport.close().catch(() => undefined);
  }, timeoutMs);

  try {
    await client.connect(transport);
    return !timedOut;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export type DetectHttpTransportOptions = {
  allowLocalhost: boolean;
  /** Short connect timeout for each probe attempt. */
  timeoutMs?: number;
};

/**
 * Resolve streamable-http vs sse for an HTTP MCP URL.
 * Heuristics first; if ambiguous, probe streamable then SSE.
 * Never throws for probe/auth failures — falls back to streamable-http.
 * Still throws on SSRF / invalid URL (caller should surface as 400).
 */
export async function detectHttpTransport(
  rawUrl: string,
  options: DetectHttpTransportOptions,
): Promise<HttpTransport> {
  const log = getLogger("control");
  await assertSafeUpstreamUrl(rawUrl, {
    allowLocalhost: options.allowLocalhost,
  });

  const heuristic = heuristicHttpTransport(rawUrl);
  if (heuristic) {
    log.info(
      { url: rawUrl, transport: heuristic, source: "heuristic" },
      "detected HTTP MCP transport",
    );
    return heuristic;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const streamableOk = await probeTransport(
    "streamable-http",
    rawUrl,
    timeoutMs,
  );
  if (streamableOk) {
    log.info(
      { url: rawUrl, transport: "streamable-http", source: "probe" },
      "detected HTTP MCP transport",
    );
    return "streamable-http";
  }

  const sseOk = await probeTransport("sse", rawUrl, timeoutMs);
  if (sseOk) {
    log.info(
      { url: rawUrl, transport: "sse", source: "probe" },
      "detected HTTP MCP transport",
    );
    return "sse";
  }

  // Auth headers / OAuth often required — do not block create/update.
  log.warn(
    { url: rawUrl },
    "HTTP transport probe failed (credentials may be required); defaulting to streamable-http",
  );
  return "streamable-http";
}
