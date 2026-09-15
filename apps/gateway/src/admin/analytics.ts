import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { upstreams, usageEvents } from "../db/schema.js";
import {
  estimateDirectCatalogTokens,
  estimateDirectToolTokens,
  estimateToolDescriptorTokens,
} from "../analytics/tokens.js";
import type { ToolPresentation } from "../config.js";
import { metaToolDescriptors } from "../mcp/meta-tools.js";
import { runtimeSnapshot } from "../mcp/snapshot.js";

/**
 * Usage analytics aggregates all recorded events (all-time).
 * Savings = counterfactual (connect each MCP separately) minus actual gateway traffic.
 *
 * In meta mode, catalog exposure (full upstream union vs ~5 meta tools) is attributed
 * from the live snapshot whenever there is any usage — not only when a tools/list
 * event was recorded. MCP clients often cache tools/list, so relying on that event
 * alone made savings look like 0% after invoke-only traffic.
 *
 * Event kinds:
 * - tools_list (mcpSlug null): shared catalog discovery via tokens
 * - list_tools / search_tools / get_tool: secondary discovery (via only in meta)
 * - tool_call: per-MCP invoke (via ≈ ifDirect)
 */
export type UsageAnalyticsResponse = {
  totalCalls: number;
  tokensViaYusetu: number;
  tokensIfDirect: number;
  tokensSaved: number;
  savingsPercent: number | null;
  /** Tool-definition / catalog exposure only (meta list vs full union). */
  catalogTokensVia: number;
  catalogTokensIfDirect: number;
  catalogTokensSaved: number;
  catalogSavingsPercent: number | null;
  /** Discovery traffic: catalog exposure + list_tools + search_tools + get_tool. */
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
    discoveryTokensVia: number;
    discoveryTokensIfDirect: number;
    invokeTokensVia: number;
    invokeTokensIfDirect: number;
    catalogTokens: number;
    toolCount: number;
  }>;
};

function isDiscoveryKind(kind: string): boolean {
  return (
    kind === "tools_list" ||
    kind === "list_tools" ||
    kind === "search_tools" ||
    kind === "get_tool"
  );
}

function estimateMetaToolsListTokens(): number {
  return metaToolDescriptors().reduce(
    (sum, t) =>
      sum +
      estimateToolDescriptorTokens(t.name, t.description ?? "", t.inputSchema),
    0,
  );
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

function pctSaved(saved: number, ifDirect: number): number | null {
  if (ifDirect <= 0) return null;
  return Math.round((saved / ifDirect) * 10_000) / 100;
}

export function createUsageAnalyticsHandler(
  toolPresentation: ToolPresentation = "meta",
) {
  return async (c: Context) => {
    const db = getDb();
    const tools = runtimeSnapshot.list();
    const upstreamRows = db
      .select()
      .from(upstreams)
      .where(eq(upstreams.enabled, true))
      .all();

    const nameBySlug = new Map(upstreamRows.map((u) => [u.slug, u.name]));

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

    const catalogTokensTotal = estimateDirectCatalogTokens(tools);
    const events = db.select().from(usageEvents).all();

    let totalCalls = 0;
    let tokensViaYusetu = 0;
    let tokensIfDirect = 0;
    let discoveryTokensVia = 0;
    let discoveryTokensIfDirect = 0;
    let invokeTokensVia = 0;
    let invokeTokensIfDirect = 0;
    let toolsListVia = 0;
    let sawToolsList = false;

    const usageBySlug = new Map<string, Agg>();

    for (const ev of events) {
      if (ev.kind === "tools_list") {
        sawToolsList = true;
        toolsListVia += ev.tokensViaGateway;
        tokensViaYusetu += ev.tokensViaGateway;
        discoveryTokensVia += ev.tokensViaGateway;
        // Meta: catalog ifDirect comes from the live snapshot below (clients
        // often cache tools/list, so event ifDirect alone is unreliable).
        // Flat: tools/list already exposes the full union — use event ifDirect.
        if (toolPresentation !== "meta") {
          tokensIfDirect += ev.tokensIfDirect;
          discoveryTokensIfDirect += ev.tokensIfDirect;
        }
        continue;
      }

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

    const hasUsage = events.length > 0;
    let catalogTokensVia = 0;
    let catalogTokensIfDirect = 0;

    if (toolPresentation === "meta" && hasUsage && catalogTokensTotal > 0) {
      catalogTokensVia = sawToolsList ? toolsListVia : estimateMetaToolsListTokens();
      catalogTokensIfDirect = catalogTokensTotal;

      if (!sawToolsList) {
        // Attribute the always-on meta tools/list cost even when the client
        // never re-listed after a reconnect / analytics wipe.
        tokensViaYusetu += catalogTokensVia;
        discoveryTokensVia += catalogTokensVia;
      }

      tokensIfDirect += catalogTokensIfDirect;
      discoveryTokensIfDirect += catalogTokensIfDirect;

      // Per-MCP: credit each active MCP's catalog as the direct-connect cost.
      for (const [slug, usage] of usageBySlug) {
        const cat = catalogBySlug.get(slug);
        if (!cat || cat.catalogTokens <= 0) continue;
        if (
          usage.calls <= 0 &&
          usage.tokensViaYusetu <= 0 &&
          usage.discoveryTokensVia <= 0
        ) {
          continue;
        }
        usage.tokensIfDirect += cat.catalogTokens;
        usage.discoveryTokensIfDirect += cat.catalogTokens;
      }
    } else if (toolPresentation !== "meta" && sawToolsList) {
      catalogTokensVia = toolsListVia;
      catalogTokensIfDirect = events
        .filter((e) => e.kind === "tools_list")
        .reduce((s, e) => s + e.tokensIfDirect, 0);
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
    const catalogTokensSaved = Math.max(
      0,
      catalogTokensIfDirect - catalogTokensVia,
    );

    const body: UsageAnalyticsResponse = {
      totalCalls,
      tokensViaYusetu,
      tokensIfDirect,
      tokensSaved,
      savingsPercent: pctSaved(tokensSaved, tokensIfDirect),
      catalogTokensVia,
      catalogTokensIfDirect,
      catalogTokensSaved,
      catalogSavingsPercent: pctSaved(catalogTokensSaved, catalogTokensIfDirect),
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
