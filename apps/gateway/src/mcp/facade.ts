import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { exposedToolName, parseExposedToolName } from "@yusetu/shared";
import { recordUsageEvent } from "../analytics/record.js";
import {
  estimateDirectCatalogTokens,
  estimateJsonTokens,
  estimateToolDescriptorTokens,
} from "../analytics/tokens.js";
import { VERSION, type ToolPresentation } from "../config.js";
import { getDb } from "../db/index.js";
import { upstreams } from "../db/schema.js";
import { getLogger } from "../logger.js";
import {
  catalogToolsForUser,
  visibleUpstreamIdsForUser,
} from "../upstreams/catalog.js";
import type { ToolRouter } from "./router.js";
import {
  META_CALL,
  META_GET_TOOL,
  META_LIST_MCPS,
  META_LIST_TOOLS,
  META_SEARCH_TOOLS,
  TINY_MCP_CATALOG_TOKENS,
  TINY_MCP_TOOL_COUNT,
  metaToolDescriptors,
  type ListToolsDetail,
} from "./meta-tools.js";
import { runtimeSnapshot, type SnapshotTool } from "./snapshot.js";
import { compressToolSchema } from "./schema-compress.js";
import { searchTools } from "./tool-search.js";
import type { UpstreamPool } from "../upstreams/pool.js";

function jsonResult(data: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data),
      },
    ],
    isError,
  };
}

function toolsForSlug(userId: string, slug: string): SnapshotTool[] {
  return catalogToolsForUser(userId).filter((t) => t.slug === slug);
}

function catalogHashForTools(tools: SnapshotTool[]): string {
  const parts = tools
    .slice()
    .sort((a, b) => a.originalName.localeCompare(b.originalName))
    .map((t) =>
      JSON.stringify([
        t.originalName,
        t.description ?? "",
        t.inputSchema ?? null,
      ]),
    );
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

function isTinyMcpCatalog(tools: SnapshotTool[]): boolean {
  if (tools.length === 0) return false;
  if (tools.length <= TINY_MCP_TOOL_COUNT) return true;
  return estimateDirectCatalogTokens(tools) <= TINY_MCP_CATALOG_TOKENS;
}

function parseListToolsDetail(raw: unknown): ListToolsDetail {
  const v = String(raw ?? "summary").trim().toLowerCase();
  if (v === "names" || v === "full" || v === "summary") return v;
  return "summary";
}

function shapeListedTool(
  t: SnapshotTool,
  detail: ListToolsDetail,
): Record<string, unknown> {
  if (detail === "names") return { tool: t.originalName };
  if (detail === "summary") {
    return {
      tool: t.originalName,
      description: t.description,
      hasSchema: true,
    };
  }
  return {
    tool: t.originalName,
    description: t.description,
    inputSchema: t.inputSchema,
  };
}

function toFlatListTool(t: SnapshotTool): Tool {
  return {
    name: t.exposedName,
    description: t.description
      ? `[${t.slug}] ${t.description}`
      : `[${t.slug}] ${t.originalName}`,
    inputSchema: (t.inputSchema ?? {
      type: "object",
      properties: {},
    }) as Tool["inputSchema"],
  };
}

function estimateListedToolsTokens(tools: Tool[]): number {
  return tools.reduce(
    (sum, t) =>
      sum +
      estimateToolDescriptorTokens(t.name, t.description ?? "", t.inputSchema),
    0,
  );
}

function estimateCallPayloadTokens(
  args: Record<string, unknown>,
  result: CallToolResult,
): number {
  // Call cost is comparable whether via gateway or direct; catalog savings
  // are captured once on tools/list (full upstream union vs meta tools).
  return estimateJsonTokens(args) + estimateJsonTokens(result.content);
}

function recordToolsListUsage(userId: string, listed: Tool[]): void {
  const callerCatalog = catalogToolsForUser(userId);
  recordUsageEvent({
    kind: "tools_list",
    mcpSlug: null,
    toolName: null,
    tokensViaGateway: estimateListedToolsTokens(listed),
    tokensIfDirect: estimateDirectCatalogTokens(callerCatalog),
    userId,
  });
}

function recordListToolsUsage(
  mcp: string,
  payload: unknown,
  opts?: { toolName?: string; userId?: string },
): void {
  const toolName = opts?.toolName ?? META_LIST_TOOLS;
  // via = actual meta discovery traffic; ifDirect = 0 so we don't double-count
  // tool definitions already attributed on tools/list.
  recordUsageEvent({
    kind: "list_tools",
    mcpSlug: mcp,
    toolName,
    tokensViaGateway: estimateJsonTokens(payload),
    tokensIfDirect: 0,
    userId: opts?.userId,
  });
}

function recordToolCallUsage(
  mcpSlug: string,
  toolName: string,
  args: Record<string, unknown>,
  result: CallToolResult,
  userId?: string,
): void {
  const tokens = estimateCallPayloadTokens(args, result);
  recordUsageEvent({
    kind: "tool_call",
    mcpSlug,
    toolName,
    tokensViaGateway: tokens,
    // Same payload size if the agent had called the MCP directly.
    tokensIfDirect: tokens,
    userId,
  });
}

const META_TOOL_NAMES = new Set([
  META_LIST_MCPS,
  META_LIST_TOOLS,
  META_SEARCH_TOOLS,
  META_GET_TOOL,
  META_CALL,
]);

async function handleMetaCall(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  router: ToolRouter,
  pool: UpstreamPool,
  schemaCompression: boolean,
): Promise<CallToolResult> {
  if (name === META_LIST_MCPS) {
    const db = getDb();
    const visible = visibleUpstreamIdsForUser(userId);
    const rows = db
      .select()
      .from(upstreams)
      .where(eq(upstreams.enabled, true))
      .all()
      .filter((row) => visible.has(row.id));
    const mcps = rows.map((row) => {
      const tools = toolsForSlug(userId, row.slug);
      const st = pool.getStatus(userId, row.id);
      return {
        slug: row.slug,
        name: row.name,
        transport: row.transport,
        authMode: row.authMode,
        status: st.status,
        toolCount: tools.length,
        tiny: isTinyMcpCatalog(tools),
      };
    });
    return jsonResult({
      mcps,
      hint: "For capability discovery prefer yusetu_search_tools { query }. Or pick one MCP → yusetu_list_tools → yusetu_get_tool → yusetu_call. Do not list tools for every MCP up front.",
    });
  }

  if (name === META_SEARCH_TOOLS) {
    const query = String(args.query ?? "").trim();
    if (!query) return jsonResult({ error: "query is required" }, true);
    const mcp =
      args.mcp !== undefined && args.mcp !== null && String(args.mcp).trim()
        ? String(args.mcp).trim()
        : undefined;
    const { tools: hits, k } = searchTools({
      query,
      mcp,
      k: args.k as number | undefined,
    });
    const allowed = new Set(
      catalogToolsForUser(userId).map((t) => `${t.slug}\0${t.originalName}`),
    );
    const tools = hits.filter((h) => allowed.has(`${h.mcp}\0${h.tool}`));

    const payload = {
      tools,
      k,
      hint: "Use yusetu_get_tool { mcp, tool } for inputSchema, then yusetu_call. Prefer search over listing every MCP.",
    };
    recordUsageEvent({
      kind: "search_tools",
      mcpSlug: mcp ?? null,
      toolName: META_SEARCH_TOOLS,
      tokensViaGateway: estimateJsonTokens(payload),
      // Catalog counterfactual lives on tools/list only — do not re-count schemas.
      tokensIfDirect: 0,
      userId,
    });
    return jsonResult(payload);
  }

  if (name === META_LIST_TOOLS) {
    const mcp = String(args.mcp ?? "").trim();
    if (!mcp) return jsonResult({ error: "mcp is required" }, true);
    const query = String(args.query ?? "")
      .trim()
      .toLowerCase();
    const detail = parseListToolsDetail(args.detail);
    const ifNoneMatch = String(args.ifNoneMatch ?? "").trim();

    const catalog = toolsForSlug(userId, mcp);
    const hash = catalogHashForTools(catalog);

    if (ifNoneMatch && ifNoneMatch === hash) {
      const unchangedPayload = {
        mcp,
        unchanged: true as const,
        hash,
        toolCount: catalog.length,
      };
      recordListToolsUsage(mcp, unchangedPayload, { userId });
      return jsonResult(unchangedPayload);
    }

    let matched = catalog;
    if (query) {
      matched = catalog.filter(
        (t) =>
          t.originalName.toLowerCase().includes(query) ||
          (t.description ?? "").toLowerCase().includes(query),
      );
    }
    if (matched.length === 0) {
      const errPayload = {
        error: `No tools for mcp "${mcp}"${query ? ` matching "${query}"` : ""}. Check yusetu_list_mcps and Rediscover in the dashboard.`,
        mcp,
        hash,
      };
      recordListToolsUsage(mcp, errPayload, { userId });
      return jsonResult(errPayload, true);
    }

    const tools = matched.map((t) => shapeListedTool(t, detail));
    const payload = {
      mcp,
      hash,
      detail,
      tools,
      hint: "Prefer yusetu_get_tool { mcp, tool } for inputSchema before yusetu_call. Use query to narrow; avoid detail=full unless needed.",
    };
    recordListToolsUsage(mcp, payload, { userId });
    return jsonResult(payload);
  }

  if (name === META_GET_TOOL) {
    const mcp = String(args.mcp ?? "").trim();
    const tool = String(args.tool ?? "").trim();
    if (!mcp || !tool) {
      return jsonResult({ error: "mcp and tool are required" }, true);
    }
    const found = toolsForSlug(userId, mcp).find((t) => t.originalName === tool);
    if (!found) {
      const errPayload = {
        error: `Tool "${tool}" not found on mcp "${mcp}". Use yusetu_list_tools to discover names.`,
        mcp,
        tool,
      };
      recordUsageEvent({
        kind: "get_tool",
        mcpSlug: mcp,
        toolName: META_GET_TOOL,
        tokensViaGateway: estimateJsonTokens(errPayload),
        tokensIfDirect: 0,
        userId,
      });
      return jsonResult(errPayload, true);
    }
    const inputSchema =
      found.inputSchema && schemaCompression
        ? compressToolSchema(found.inputSchema)
        : found.inputSchema;
    const payload = {
      mcp,
      tool: found.originalName,
      description: found.description,
      inputSchema,
    };
    recordUsageEvent({
      kind: "get_tool",
      mcpSlug: mcp,
      toolName: META_GET_TOOL,
      tokensViaGateway: estimateJsonTokens(payload),
      // Schema already in tools/list ifDirect; via still counts compressed fetch cost.
      tokensIfDirect: 0,
      userId,
    });
    return jsonResult(payload);
  }

  if (name === META_CALL) {
    const mcp = String(args.mcp ?? "").trim();
    const tool = String(args.tool ?? "").trim();
    const toolArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    if (!mcp || !tool) {
      return jsonResult({ error: "mcp and tool are required" }, true);
    }
    // Accept either original name or already-namespaced exposed name
    const exposed =
      tool.includes("__") ? tool : exposedToolName(mcp, tool);
    const result = await router.callTool(userId, exposed, toolArgs);
    recordToolCallUsage(mcp, tool, toolArgs, result, userId);
    return result;
  }

  return jsonResult({ error: `Unknown meta tool: ${name}` }, true);
}

/**
 * Create an MCP Server facade.
 * - flat: expose every upstream tool as slug__name (debug only)
 * - meta: expose yusetu_* meta tools; optionally inline tiny upstreams when inlineTinyMcps
 */
export function createFacadeServer(
  router: ToolRouter,
  pool: UpstreamPool,
  userId: string,
  presentation: ToolPresentation = "meta",
  inlineTinyMcps = false,
  schemaCompression = true,
): Server {
  const server = new Server(
    { name: "yusetu", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    if (presentation === "meta") {
      const tools = [...metaToolDescriptors()];
      if (inlineTinyMcps) {
        const bySlug = new Map<string, SnapshotTool[]>();
        for (const t of catalogToolsForUser(userId)) {
          const list = bySlug.get(t.slug);
          if (list) list.push(t);
          else bySlug.set(t.slug, [t]);
        }
        for (const slugTools of bySlug.values()) {
          if (!isTinyMcpCatalog(slugTools)) continue;
          for (const t of slugTools) {
            tools.push(toFlatListTool(t));
          }
        }
      }
      getLogger("data").info(
        {
          toolPresentation: presentation,
          inlineTinyMcps,
          schemaCompression,
          toolCount: tools.length,
          toolNames: tools.map((t) => t.name),
        },
        "mcp tools/list",
      );
      recordToolsListUsage(userId, tools);
      return { tools };
    }
    const tools = catalogToolsForUser(userId).map(toFlatListTool);
    getLogger("data").info(
      {
        toolPresentation: presentation,
        toolCount: tools.length,
        toolNames: tools.slice(0, 5).map((t) => t.name),
      },
      "mcp tools/list",
    );
    recordToolsListUsage(userId, tools);
    return { tools };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      if (presentation === "meta") {
        if (META_TOOL_NAMES.has(name)) {
          return handleMetaCall(
            name,
            args,
            userId,
            router,
            pool,
            schemaCompression,
          );
        }
        // Allow direct slug__tool calls as escape hatch — still record usage
        if (name.includes("__")) {
          const parsed = parseExposedToolName(name);
          const result = await router.callTool(userId, name, args);
          if (parsed) {
            recordToolCallUsage(parsed.slug, parsed.originalName, args, result, userId);
          }
          return result;
        }
        return jsonResult(
          {
            error: `Unknown tool "${name}". In meta mode use yusetu_search_tools or yusetu_list_mcps → yusetu_list_tools → yusetu_get_tool → yusetu_call.`,
          },
          true,
        );
      }

      const result = await router.callTool(userId, name, args);
      const parsed = parseExposedToolName(name);
      if (parsed) {
        recordToolCallUsage(parsed.slug, parsed.originalName, args, result, userId);
      }
      return result;
    },
  );

  return server;
}
