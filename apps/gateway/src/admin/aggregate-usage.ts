import {
  ESTIMATOR_VERSION,
  estimateToolDescriptorTokens,
} from "../analytics/tokens.js";
import type { ToolPresentation } from "../config.js";
import { metaToolDescriptors } from "../mcp/meta-tools.js";

export type UsageEventRow = {
  kind: string;
  mcpSlug: string | null;
  tokensViaGateway: number;
  tokensIfDirect: number;
  callCount: number;
  createdAt?: Date | string | null;
};

export type CatalogBySlug = Map<
  string,
  { toolCount: number; catalogTokens: number }
>;

export type AggregateUsageInput = {
  toolPresentation: ToolPresentation;
  events: UsageEventRow[];
  upstreamRows: Array<{ slug: string; name: string }>;
  catalogBySlug: CatalogBySlug;
  catalogToolCount: number;
  /** Today's direct catalog size (opportunity card only; not historical savings). */
  currentDirectCatalogTokens: number;
  rangeStartMs?: number | null;
};

export type UsageAnalyticsResponse = {
  totalCalls: number;
  tokensViaYusetu: number;
  tokensIfDirect: number;
  tokensSaved: number;
  savingsPercent: number | null;
  catalogTokensVia: number;
  catalogTokensIfDirect: number;
  catalogTokensSaved: number;
  catalogSavingsPercent: number | null;
  /** Unclamped catalog delta (may be negative). */
  catalogTokensDelta: number;
  discoveryTokensVia: number;
  discoveryTokensIfDirect: number;
  /** Discovery excluding tools_list (list/search/get/list_mcps). */
  discoveryOverheadVia: number;
  invokeTokensVia: number;
  invokeTokensIfDirect: number;
  /** catalog delta − discovery overhead (signed). */
  netTokensSaved: number;
  netSavingsPercent: number | null;
  toolsListCount: number;
  /** True when historical catalog used a live opportunity fallback (no tools_list rows). */
  catalogFromLiveSnapshot: boolean;
  estimatorVersion: string;
  currentOpportunity: {
    via: number;
    ifDirect: number;
    saved: number;
    catalogToolCount: number;
  };
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
    netSaved: number;
  }>;
  sharedOverhead: { exposureVia: number };
};

function isSecondaryDiscovery(kind: string): boolean {
  return (
    kind === "list_tools" ||
    kind === "list_mcps" ||
    kind === "search_tools" ||
    kind === "get_tool"
  );
}

export function estimateMetaToolsListTokens(): number {
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

function pctSaved(saved: number, ifDirect: number): number | null {
  if (ifDirect <= 0) return null;
  return Math.round((saved / ifDirect) * 10_000) / 100;
}

function eventTimeMs(ev: UsageEventRow): number | null {
  if (!ev.createdAt) return null;
  const t =
    ev.createdAt instanceof Date
      ? ev.createdAt.getTime()
      : new Date(ev.createdAt).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure usage aggregation. Historical catalog savings come only from stored
 * tools_list rows (via and ifDirect). Live catalog is currentOpportunity only.
 */
export function aggregateUsage(input: AggregateUsageInput): UsageAnalyticsResponse {
  const {
    toolPresentation,
    upstreamRows,
    catalogBySlug,
    catalogToolCount,
    currentDirectCatalogTokens,
    rangeStartMs,
  } = input;

  const events = input.events.filter((ev) => {
    if (rangeStartMs == null) return true;
    const t = eventTimeMs(ev);
    if (t == null) return true;
    return t >= rangeStartMs;
  });

  const metaVia = estimateMetaToolsListTokens();
  const nameBySlug = new Map(upstreamRows.map((u) => [u.slug, u.name]));

  let totalCalls = 0;
  let tokensViaYusetu = 0;
  let tokensIfDirect = 0;
  let discoveryTokensVia = 0;
  let discoveryTokensIfDirect = 0;
  let discoveryOverheadVia = 0;
  let invokeTokensVia = 0;
  let invokeTokensIfDirect = 0;
  let catalogTokensVia = 0;
  let catalogTokensIfDirect = 0;
  let toolsListCount = 0;
  let catalogFromLiveSnapshot = false;

  const usageBySlug = new Map<string, Agg>();

  for (const ev of events) {
    if (ev.kind === "tools_list") {
      toolsListCount += 1;
      catalogTokensVia += ev.tokensViaGateway;
      catalogTokensIfDirect += ev.tokensIfDirect;
      tokensViaYusetu += ev.tokensViaGateway;
      tokensIfDirect += ev.tokensIfDirect;
      discoveryTokensVia += ev.tokensViaGateway;
      discoveryTokensIfDirect += ev.tokensIfDirect;
      continue;
    }

    tokensViaYusetu += ev.tokensViaGateway;
    tokensIfDirect += ev.tokensIfDirect;

    if (isSecondaryDiscovery(ev.kind)) {
      discoveryTokensVia += ev.tokensViaGateway;
      discoveryTokensIfDirect += ev.tokensIfDirect;
      discoveryOverheadVia += ev.tokensViaGateway;
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
    } else if (isSecondaryDiscovery(ev.kind)) {
      row.discoveryTokensVia += ev.tokensViaGateway;
      row.discoveryTokensIfDirect += ev.tokensIfDirect;
    }
    usageBySlug.set(ev.mcpSlug, row);
  }

  const hasUsage = events.length > 0;

  // Cached client with usage but no stored tools/list: do NOT invent historical
  // savings. Opportunity card still shows today's meta vs direct.
  if (
    toolPresentation === "meta" &&
    hasUsage &&
    toolsListCount === 0 &&
    currentDirectCatalogTokens > 0
  ) {
    catalogFromLiveSnapshot = true;
  }

  const emptyCatalog = { toolCount: 0, catalogTokens: 0 };

  const byMcp = upstreamRows
    .map((u) => {
      const usage = usageBySlug.get(u.slug) ?? emptyAgg();
      const cat = catalogBySlug.get(u.slug) ?? emptyCatalog;
      return {
        slug: u.slug,
        name: nameBySlug.get(u.slug) ?? u.name,
        calls: usage.calls,
        tokensViaYusetu: usage.tokensViaYusetu,
        tokensIfDirect: usage.tokensIfDirect,
        discoveryTokensVia: usage.discoveryTokensVia,
        discoveryTokensIfDirect: usage.discoveryTokensIfDirect,
        invokeTokensVia: usage.invokeTokensVia,
        invokeTokensIfDirect: usage.invokeTokensIfDirect,
        catalogTokens: cat.catalogTokens,
        toolCount: cat.toolCount,
        // Per-MCP net uses measured traffic only; catalogTokens is today's exposure.
        netSaved: usage.tokensIfDirect - usage.tokensViaYusetu,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  for (const [slug, usage] of usageBySlug) {
    if (byMcp.some((r) => r.slug === slug)) continue;
    const cat = catalogBySlug.get(slug) ?? emptyCatalog;
    byMcp.push({
      slug,
      name: nameBySlug.get(slug) ?? slug,
      calls: usage.calls,
      tokensViaYusetu: usage.tokensViaYusetu,
      tokensIfDirect: usage.tokensIfDirect,
      discoveryTokensVia: usage.discoveryTokensVia,
      discoveryTokensIfDirect: usage.discoveryTokensIfDirect,
      invokeTokensVia: usage.invokeTokensVia,
      invokeTokensIfDirect: usage.invokeTokensIfDirect,
      catalogTokens: cat.catalogTokens,
      toolCount: cat.toolCount,
      netSaved: usage.tokensIfDirect - usage.tokensViaYusetu,
    });
  }
  byMcp.sort((a, b) => a.slug.localeCompare(b.slug));

  const catalogTokensDelta = catalogTokensIfDirect - catalogTokensVia;
  const catalogTokensSaved = Math.max(0, catalogTokensDelta);
  const netTokensSaved = catalogTokensDelta - discoveryOverheadVia;
  const tokensSaved = tokensIfDirect - tokensViaYusetu;

  const currentOpportunity = {
    via: metaVia,
    ifDirect: currentDirectCatalogTokens,
    saved: currentDirectCatalogTokens - metaVia,
    catalogToolCount,
  };

  return {
    totalCalls,
    tokensViaYusetu,
    tokensIfDirect,
    tokensSaved,
    savingsPercent: pctSaved(Math.max(0, tokensSaved), tokensIfDirect),
    catalogTokensVia,
    catalogTokensIfDirect,
    catalogTokensSaved,
    catalogSavingsPercent: pctSaved(catalogTokensSaved, catalogTokensIfDirect),
    catalogTokensDelta,
    discoveryTokensVia,
    discoveryTokensIfDirect,
    discoveryOverheadVia,
    invokeTokensVia,
    invokeTokensIfDirect,
    netTokensSaved,
    netSavingsPercent: pctSaved(
      Math.max(0, netTokensSaved),
      catalogTokensIfDirect,
    ),
    toolsListCount,
    catalogFromLiveSnapshot,
    estimatorVersion: ESTIMATOR_VERSION,
    currentOpportunity,
    mcpCount: upstreamRows.length,
    catalogToolCount,
    byMcp,
    sharedOverhead: { exposureVia: catalogTokensVia },
  };
}
