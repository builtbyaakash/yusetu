import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const META_LIST_MCPS = "yusetu_list_mcps";
export const META_LIST_TOOLS = "yusetu_list_tools";
export const META_GET_TOOL = "yusetu_get_tool";
export const META_CALL = "yusetu_call";
export const META_SEARCH_TOOLS = "yusetu_search_tools";

/** Inline upstreams into tools/list when catalog is this small (only if INLINE_TINY_MCPS=true). */
export const TINY_MCP_TOOL_COUNT = 3;
/** Or when full direct catalog estimate is at most this many tokens. */
export const TINY_MCP_CATALOG_TOKENS = 2000;

export type ListToolsDetail = "names" | "summary" | "full";

/** Descriptors exposed when TOOL_PRESENTATION=meta. */
export function metaToolDescriptors(): Tool[] {
  return [
    {
      name: META_LIST_MCPS,
      description: "List connected MCP server slugs.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: META_SEARCH_TOOLS,
      description:
        "Search tools across MCPs by query. Preferred path: search → yusetu_get_tool → yusetu_call. Do not list every MCP up front. Avoid detail=full unless needed.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          mcp: { type: "string" },
          k: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: META_LIST_TOOLS,
      description:
        "List tools for one MCP. Default detail=summary (no schemas). Pass ifNoneMatch to skip unchanged catalogs.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: { type: "string" },
          query: { type: "string" },
          detail: {
            type: "string",
            enum: ["names", "summary", "full"],
          },
          ifNoneMatch: { type: "string" },
        },
        required: ["mcp"],
        additionalProperties: false,
      },
    },
    {
      name: META_GET_TOOL,
      description:
        "Get description + inputSchema for one tool. Prefer after search or list_tools summary.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: { type: "string" },
          tool: { type: "string" },
          ifNoneMatch: { type: "string" },
          raw: { type: "boolean" },
        },
        required: ["mcp", "tool"],
        additionalProperties: false,
      },
    },
    {
      name: META_CALL,
      description: "Call a tool on an MCP by slug and tool name.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: { type: "string" },
          tool: { type: "string" },
          arguments: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["mcp", "tool"],
        additionalProperties: false,
      },
    },
  ];
}

export const META_TOOL_COUNT = metaToolDescriptors().length;
