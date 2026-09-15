import { getSqlite } from "../db/index.js";
import { runtimeSnapshot, type SnapshotTool } from "./snapshot.js";

export type ToolSearchHit = {
  mcp: string;
  tool: string;
  description: string | null;
  score: number;
};

export type SearchToolsInput = {
  query: string;
  mcp?: string;
  /** Default 3; clamped to [1, 10]. */
  k?: number;
};

const DEFAULT_K = 3;
const MAX_K = 10;

function ensureToolSearchTable(): void {
  getSqlite().exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS tool_search USING fts5(
  slug,
  original_name,
  description,
  tokenize = 'porter'
);
`);
}

/**
 * Build a safe FTS5 MATCH expression: strip quotes/specials, AND tokens,
 * prefix each token for partial matches.
 */
export function buildFtsMatchQuery(raw: string): string | null {
  const tokens = raw
    .replace(/["'^:(){}[\]\\*~+-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && /^[a-z0-9_./]+$/.test(t));
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(" AND ");
}

function clampK(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_K;
  return Math.min(MAX_K, Math.max(1, Math.floor(n)));
}

/** Clear + reindex from the current runtime snapshot (enabled tools only). */
export function rebuildToolSearchIndex(): void {
  ensureToolSearchTable();
  const sqlite = getSqlite();
  const clear = sqlite.prepare(`DELETE FROM tool_search`);
  const insert = sqlite.prepare(
    `INSERT INTO tool_search(slug, original_name, description) VALUES (?, ?, ?)`,
  );
  const tools = runtimeSnapshot.list();
  const tx = sqlite.transaction((rows: SnapshotTool[]) => {
    clear.run();
    for (const t of rows) {
      insert.run(t.slug, t.originalName, t.description ?? "");
    }
  });
  tx(tools);
}

/**
 * BM25/FTS5 search over enabled tools. Returns top-k hits (higher score = better).
 */
export function searchTools(input: SearchToolsInput): {
  tools: ToolSearchHit[];
  k: number;
} {
  ensureToolSearchTable();
  const k = clampK(input.k);
  const match = buildFtsMatchQuery(input.query);
  if (!match) {
    return { tools: [], k };
  }

  const mcpFilter = input.mcp?.trim() || undefined;

  const sqlite = getSqlite();
  // bm25(): lower is better → return -bm25 as score (higher = better).
  // No SQL LIMIT when mcp is set — FTS slug match is not case-exact; post-filter then apply k.
  const rows = sqlite
    .prepare(
      `SELECT slug AS mcp, original_name AS tool, description,
              -bm25(tool_search) AS score
       FROM tool_search
       WHERE tool_search MATCH ?
       ORDER BY bm25(tool_search)`,
    )
    .all(match) as Array<{
    mcp: string;
    tool: string;
    description: string;
    score: number;
  }>;

  let tools: ToolSearchHit[] = rows.map((r) => ({
    mcp: r.mcp,
    tool: r.tool,
    description: r.description || null,
    score: typeof r.score === "number" ? r.score : Number(r.score) || 0,
  }));

  if (mcpFilter) {
    tools = tools.filter((t) => t.mcp === mcpFilter);
  }

  return {
    tools: tools.slice(0, k),
    k,
  };
}
