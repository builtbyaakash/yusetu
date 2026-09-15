import { config as loadDotenv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/gateway/src → repo root */
export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const GATEWAY_ROOT = path.resolve(__dirname, "../..");

loadDotenv({ path: path.join(REPO_ROOT, ".env") });

export const VERSION = "0.1.0";

export type LogToolArgsMode = "none" | "redacted" | "full";
export type ToolPresentation = "flat" | "meta";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseToolPresentation(value: string | undefined): ToolPresentation {
  const v = (value ?? "meta").trim().toLowerCase();
  return v === "flat" ? "flat" : "meta";
}

function resolveDataDir(): string {
  const raw = process.env.YUSETU_DATA_DIR?.trim();
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
  }
  return path.join(REPO_ROOT, "data");
}

export type GatewayConfig = {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  masterKeyBase64: string | undefined;
  /** Absolute public origin for OAuth redirect URIs (e.g. https://gateway.example.com). */
  publicOrigin: string | undefined;
  requireMcpAuth: boolean;
  enableMcpOauth: boolean;
  /** flat = debug only (all tools); meta = production default (yusetu_* meta tools) */
  toolPresentation: ToolPresentation;
  /** When meta: optionally inline tiny upstream catalogs as slug__tool in tools/list. Default false. */
  inlineTinyMcps: boolean;
  /** When true, compress inputSchema returned by yusetu_get_tool. Default true. */
  schemaCompression: boolean;
  logLevel: string;
  logToolArgs: LogToolArgsMode;
  dashboardDist: string;
};

export function loadConfig(): GatewayConfig {
  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const logToolArgsRaw = (process.env.LOG_TOOL_ARGS ?? "none").toLowerCase();
  const logToolArgs: LogToolArgsMode =
    logToolArgsRaw === "full" || logToolArgsRaw === "redacted"
      ? logToolArgsRaw
      : "none";

  return {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number(process.env.PORT ?? "8080") || 8080,
    dataDir,
    dbPath: path.join(dataDir, "gateway.db"),
    masterKeyBase64: process.env.GATEWAY_MASTER_KEY?.trim() || undefined,
    publicOrigin: process.env.PUBLIC_ORIGIN?.trim() || undefined,
    requireMcpAuth: parseBool(process.env.REQUIRE_MCP_AUTH, true),
    enableMcpOauth: parseBool(process.env.ENABLE_MCP_OAUTH, true),
    toolPresentation: parseToolPresentation(process.env.TOOL_PRESENTATION),
    inlineTinyMcps: parseBool(process.env.INLINE_TINY_MCPS, false),
    schemaCompression: parseBool(process.env.SCHEMA_COMPRESSION, true),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    logToolArgs,
    dashboardDist: path.resolve(GATEWAY_ROOT, "../dashboard/dist"),
  };
}
