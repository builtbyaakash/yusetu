import { getDb } from "../db/index.js";
import { usageEvents } from "../db/schema.js";
import { getLogger } from "../logger.js";

export type UsageEventKind =
  | "tools_list"
  | "list_tools"
  | "search_tools"
  | "get_tool"
  | "tool_call";

export type RecordUsageInput = {
  kind: UsageEventKind;
  mcpSlug?: string | null;
  toolName?: string | null;
  tokensViaGateway: number;
  tokensIfDirect: number;
  callCount?: number;
  /** Caller user id when known (session / API key / OAuth). */
  userId?: string | null;
};

/**
 * Persist a usage analytics row. Never throws — MCP responses must not fail
 * because of analytics.
 */
export function recordUsageEvent(input: RecordUsageInput): void {
  try {
    getDb()
      .insert(usageEvents)
      .values({
        id: crypto.randomUUID(),
        createdAt: new Date(),
        kind: input.kind,
        mcpSlug: input.mcpSlug ?? null,
        toolName: input.toolName ?? null,
        tokensViaGateway: Math.max(0, Math.round(input.tokensViaGateway)),
        tokensIfDirect: Math.max(0, Math.round(input.tokensIfDirect)),
        callCount: input.callCount ?? 1,
        userId: input.userId ?? null,
      })
      .run();
  } catch (err) {
    getLogger("data").warn({ err }, "usage analytics insert failed");
  }
}
