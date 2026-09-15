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
      description:
        "List connected MCP servers (slugs). For \"I need X\" capability discovery, prefer yusetu_search_tools first. Otherwise pick one slug, then yusetu_list_tools. Flow: yusetu_search_tools (or yusetu_list_mcps → yusetu_list_tools) → yusetu_get_tool → yusetu_call. For documentation MCPs, prefer TOC / path / specific-page tools before broad search when those tools exist.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: META_SEARCH_TOOLS,
      description:
        "Search all enabled tools across MCPs by natural-language query (BM25). Prefer this when you need a capability (\"I need X\") and do not already know the MCP slug. Returns compact hits (mcp, tool, description, score) without inputSchema — then yusetu_get_tool → yusetu_call.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query over tool names and descriptions",
          },
          mcp: {
            type: "string",
            description: "Optional MCP slug to restrict search to one server",
          },
          k: {
            type: "number",
            description: "Max hits to return (default 3, max 10)",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: META_LIST_TOOLS,
      description:
        "List tools for one MCP by slug. Prefer yusetu_search_tools when looking for a capability across MCPs. Prefer detail=summary (default) then yusetu_get_tool for the schema before yusetu_call. Use query to filter instead of listing everything. Pass ifNoneMatch with a prior hash to skip an unchanged catalog.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: {
            type: "string",
            description: "MCP slug, e.g. linear or github",
          },
          query: {
            type: "string",
            description: "Optional case-insensitive filter on tool name/description",
          },
          detail: {
            type: "string",
            enum: ["names", "summary", "full"],
            description:
              "names = tool name only; summary (default) = name+description+hasSchema (no inputSchema); full = include inputSchema",
          },
          ifNoneMatch: {
            type: "string",
            description:
              "Optional catalog hash from a prior list_tools response; if unchanged, returns { unchanged: true } without tools",
          },
        },
        required: ["mcp"],
        additionalProperties: false,
      },
    },
    {
      name: META_GET_TOOL,
      description:
        "Get the full descriptor (description + inputSchema) for one tool on an MCP. Prefer after yusetu_search_tools or yusetu_list_tools with detail=summary, before yusetu_call.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: {
            type: "string",
            description: "MCP slug",
          },
          tool: {
            type: "string",
            description: "Tool name as listed by yusetu_list_tools (original name, not slug__prefixed)",
          },
        },
        required: ["mcp", "tool"],
        additionalProperties: false,
      },
    },
    {
      name: META_CALL,
      description:
        "Call a tool on an MCP. Prefer yusetu_search_tools or yusetu_list_tools (summary) → yusetu_get_tool → yusetu_call. For documentation MCPs, prefer TOC / path / specific-page tools before broad search when available.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: {
            type: "string",
            description: "MCP slug",
          },
          tool: {
            type: "string",
            description:
              "Tool name as listed by yusetu_list_tools (original name, not slug__prefixed)",
          },
          arguments: {
            type: "object",
            description: "Arguments object matching the tool input schema",
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
