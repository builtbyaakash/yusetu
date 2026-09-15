import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { upstreams, usageEvents } from "../db/schema.js";
import { estimateDirectToolTokens } from "../analytics/tokens.js";
import { runtimeSnapshot } from "../mcp/snapshot.js";

/**
 * Usage analytics aggregates all recorded events (all-time).
 * Savings = counterfactual (connect each MCP separately) minus actual gateway traffic.
 *
 * Event kinds:
 * - tools_list (mcpSlug null): shared catalog discovery — counted in global totals only
 * - list_tools: per-MCP discovery
 * - tool_call: per-MCP invoke
 */
export type UsageAnalyticsResponse = {
  totalCalls: number;
  tokensViaYusetu: number;
  tokensIfDirect: number;
  tokensSaved: number;
  savingsPercent: number | null;
  /** Discovery traffic: tools_list + list_tools (+ get_tool when recorded). */
  discoveryTokensVia: number;
  discoveryTokensIfDirect: number;
  /** Invoke traffic: tool_call only. */
  invokeTokensVia: number;
  invokeTokensIfDirect: number;
  mcpCount: number;
  catalogToolCount: number;
  byMcp: Array<{
    slug: string;
    name: string;
    calls: number;
    tokensViaYusetu: number;
    tokensIfDirect: number;
    /** list_tools (and similar) for this MCP. */
    discoveryTokensVia: number;
    discoveryTokensIfDirect: number;
    /** tool_call for this MCP. */
    invokeTokensVia: number;
    invokeTokensIfDirect: number;
    catalogTokens: number;
    toolCount: number;
  }>;
};

function isDiscoveryKind(kind: string): boolean {
  return kind === "tools_list" || kind === "list_tools";
}

function emptyAgg() {
  return {
    calls: 0,
    tokensViaYusetu: 0,
    tokensIfDirect: 0,
    discoveryTokensVia: 0,
    discoveryTokensIfDirect: 0,
    invokeTokensVia: 0,
    invokeTokensIfDirect: 0,
  };
}

type Agg = ReturnType<typeof emptyAgg>;

function toMcpRow(
  slug: string,
  name: string,
  usage: Agg,
  catalog: { toolCount: number; catalogTokens: number },
) {
  return {
    slug,
    name,
    calls: usage.calls,
    tokensViaYusetu: usage.tokensViaYusetu,
    tokensIfDirect: usage.tokensIfDirect,
    discoveryTokensVia: usage.discoveryTokensVia,
    discoveryTokensIfDirect: usage.discoveryTokensIfDirect,
    invokeTokensVia: usage.invokeTokensVia,
    invokeTokensIfDirect: usage.invokeTokensIfDirect,
    catalogTokens: catalog.catalogTokens,
    toolCount: catalog.toolCount,
  };
}

export function createUsageAnalyticsHandler() {
  return async (c: Context) => {
    const db = getDb();
    const tools = runtimeSnapshot.list();
    const upstreamRows = db
      .select()
      .from(upstreams)
      .where(eq(upstreams.enabled, true))
      .all();

    const nameBySlug = new Map(upstreamRows.map((u) => [u.slug, u.name]));

    // Catalog context (current enabled tools) — not from events
    const catalogBySlug = new Map<
      string,
      { toolCount: number; catalogTokens: number }
    >();
    for (const t of tools) {
      const existing = catalogBySlug.get(t.slug);
      const tokens = estimateDirectToolTokens(t);
      if (existing) {
        existing.toolCount += 1;
        existing.catalogTokens += tokens;
      } else {
        catalogBySlug.set(t.slug, { toolCount: 1, catalogTokens: tokens });
      }
    }

    const events = db.select().from(usageEvents).all();

    let totalCalls = 0;
    let tokensViaYusetu = 0;
    let tokensIfDirect = 0;
    let discoveryTokensVia = 0;
    let discoveryTokensIfDirect = 0;
    let invokeTokensVia = 0;
    let invokeTokensIfDirect = 0;

    const usageBySlug = new Map<string, Agg>();

    for (const ev of events) {
      // Global totals include every event (tools_list with null slug included).
      tokensViaYusetu += ev.tokensViaGateway;
      tokensIfDirect += ev.tokensIfDirect;

      if (isDiscoveryKind(ev.kind)) {
        discoveryTokensVia += ev.tokensViaGateway;
        discoveryTokensIfDirect += ev.tokensIfDirect;
      } else if (ev.kind === "tool_call") {
        totalCalls += ev.callCount;
        invokeTokensVia += ev.tokensViaGateway;
        invokeTokensIfDirect += ev.tokensIfDirect;
      }

      if (!ev.mcpSlug) continue;
      const row = usageBySlug.get(ev.mcpSlug) ?? emptyAgg();
      row.tokensViaYusetu += ev.tokensViaGateway;
      row.tokensIfDirect += ev.tokensIfDirect;
      if (ev.kind === "tool_call") {
        row.calls += ev.callCount;
        row.invokeTokensVia += ev.tokensViaGateway;
        row.invokeTokensIfDirect += ev.tokensIfDirect;
      } else if (isDiscoveryKind(ev.kind)) {
        row.discoveryTokensVia += ev.tokensViaGateway;
        row.discoveryTokensIfDirect += ev.tokensIfDirect;
      }
      usageBySlug.set(ev.mcpSlug, row);
    }

    const emptyCatalog = { toolCount: 0, catalogTokens: 0 };

    const byMcp = upstreamRows
      .map((u) =>
        toMcpRow(
          u.slug,
          nameBySlug.get(u.slug) ?? u.name,
          usageBySlug.get(u.slug) ?? emptyAgg(),
          catalogBySlug.get(u.slug) ?? emptyCatalog,
        ),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug));

    // Include slugs that appeared in events but are no longer enabled
    for (const [slug, usage] of usageBySlug) {
      if (byMcp.some((r) => r.slug === slug)) continue;
      byMcp.push(
        toMcpRow(
          slug,
          nameBySlug.get(slug) ?? slug,
          usage,
          catalogBySlug.get(slug) ?? emptyCatalog,
        ),
      );
    }
    byMcp.sort((a, b) => a.slug.localeCompare(b.slug));

    const tokensSaved = Math.max(0, tokensIfDirect - tokensViaYusetu);
    const savingsPercent =
      tokensIfDirect > 0
        ? Math.round((tokensSaved / tokensIfDirect) * 10_000) / 100
        : null;

    const body: UsageAnalyticsResponse = {
      totalCalls,
      tokensViaYusetu,
      tokensIfDirect,
      tokensSaved,
      savingsPercent,
      discoveryTokensVia,
      discoveryTokensIfDirect,
      invokeTokensVia,
      invokeTokensIfDirect,
      mcpCount: upstreamRows.length,
      catalogToolCount: tools.length,
      byMcp,
    };

    return c.json(body);
  };
}
