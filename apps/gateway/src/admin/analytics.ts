import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { upstreams, usageEvents } from "../db/schema.js";
import {
  estimateDirectCatalogTokens,
  estimateDirectToolTokens,
} from "../analytics/tokens.js";
import type { ToolPresentation } from "../config.js";
import { runtimeSnapshot } from "../mcp/snapshot.js";
import { aggregateUsage } from "./aggregate-usage.js";

export type { UsageAnalyticsResponse } from "./aggregate-usage.js";

function parseRangeStartMs(raw: string | undefined): number | null {
  const v = (raw ?? "30d").trim().toLowerCase();
  if (v === "all") return null;
  if (v === "7d") return Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (v === "90d") return Date.now() - 90 * 24 * 60 * 60 * 1000;
  // default 30d
  return Date.now() - 30 * 24 * 60 * 60 * 1000;
}

/**
 * Usage analytics. Historical catalog savings sum stored tools_list via/ifDirect.
 * Today's live catalog is reported only as currentOpportunity (not invented history).
 */
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
    const rangeStartMs = parseRangeStartMs(c.req.query("range"));

    const body = aggregateUsage({
      toolPresentation,
      events,
      upstreamRows: upstreamRows.map((u) => ({ slug: u.slug, name: u.name })),
      catalogBySlug,
      catalogToolCount: tools.length,
      currentDirectCatalogTokens: estimateDirectCatalogTokens(tools),
      rangeStartMs,
    });

    return c.json(body);
  };
}
