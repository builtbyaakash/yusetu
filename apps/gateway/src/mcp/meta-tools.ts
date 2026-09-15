import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const META_LIST_MCPS = "yusetu_list_mcps";
export const META_LIST_TOOLS = "yusetu_list_tools";
export const META_GET_TOOL = "yusetu_get_tool";
export const META_CALL = "yusetu_call";

/** Inline upstreams into tools/list when catalog is this small. */
export const TINY_MCP_TOOL_COUNT = 3;
/** Or when full direct catalog estimate is at most this many tokens. */
export const TINY_MCP_CATALOG_TOKENS = 2000;

export type ListToolsDetail = "names" | "summary" | "full";

/** Descriptors exposed when TOOL_PRESENTATION=meta (plus tiny upstream tools). */
export function metaToolDescriptors(): Tool[] {
  return [
    {
      name: META_LIST_MCPS,
      description:
        "List connected MCP servers (slugs). Do not list tools for every MCP up front — pick one slug, then use yusetu_list_tools with an optional query. Small MCPs may already appear as slug__tool entries in tools/list; large ones need yusetu_list_tools. For documentation MCPs, prefer TOC / path / specific-page tools before broad search when those tools exist.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: META_LIST_TOOLS,
      description:
        "List tools for one MCP by slug. Prefer detail=summary (default) then yusetu_get_tool for the schema before yusetu_call. Use query to filter instead of listing everything. Pass ifNoneMatch with a prior hash to skip an unchanged catalog. If a tool already appears in tools/list as slug__name, call it directly or via yusetu_call.",
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
        "Get the full descriptor (description + inputSchema) for one tool on an MCP. Prefer after yusetu_list_tools with detail=summary, before yusetu_call. If the tool already appears in tools/list as slug__name, you may call it directly or via yusetu_call instead.",
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
        "Call a tool on an MCP. Prefer yusetu_list_tools (summary) → yusetu_get_tool → yusetu_call, or call slug__tool directly if it already appears in tools/list. For documentation MCPs, prefer TOC / path / specific-page tools before broad search when available.",
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
