import type { SnapshotTool } from "../mcp/snapshot.js";

export const ESTIMATOR_VERSION = "chars4-v1";

/**
 * Internal token estimate from serialized text length.
 * (ceil(chars/4) — not exposed in public analytics JSON.)
 */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokensFromText(JSON.stringify(value));
}

/** Serialize name + description + inputSchema the way tools/list would expose them. */
export function estimateToolDescriptorTokens(
  name: string,
  description: string,
  inputSchema: unknown,
): number {
  return estimateJsonTokens({
    name,
    description,
    inputSchema:
      inputSchema && typeof inputSchema === "object"
        ? inputSchema
        : { type: "object", properties: {} },
  });
}

/**
 * Counterfactual: tokens if this tool were listed via a direct MCP connection.
 * Uses original upstream name/description — not Yūsetu slug__ prefixes.
 */
export function estimateDirectToolTokens(tool: SnapshotTool): number {
  return estimateToolDescriptorTokens(
    tool.originalName,
    tool.description ?? tool.originalName,
    tool.inputSchema,
  );
}

export function estimateDirectCatalogTokens(tools: SnapshotTool[]): number {
  return tools.reduce((sum, t) => sum + estimateDirectToolTokens(t), 0);
}
