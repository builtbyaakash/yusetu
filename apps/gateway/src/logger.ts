import pino from "pino";
import type { GatewayConfig, LogToolArgsMode } from "./config.js";

export type Plane = "data" | "control";

let rootLogger: pino.Logger | undefined;
let toolArgsMode: LogToolArgsMode = "none";

export function initLogger(config: GatewayConfig): pino.Logger {
  toolArgsMode = config.logToolArgs;
  rootLogger = pino({
    level: config.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return rootLogger;
}

export function getLogger(plane: Plane, bindings?: Record<string, unknown>): pino.Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: "info" });
  }
  return rootLogger.child({ plane, ...bindings });
}

export function formatToolArgs(args: unknown): unknown | undefined {
  if (toolArgsMode === "none") return undefined;
  if (toolArgsMode === "full") return args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(args as Record<string, unknown>)) {
      redacted[key] = "[redacted]";
    }
    return redacted;
  }
  return "[redacted]";
}
