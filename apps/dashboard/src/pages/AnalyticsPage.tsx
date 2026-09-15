import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { analyticsApi } from "../api";
import type { UsageAnalytics } from "../api/types";

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function tokensSaved(row: {
  tokensViaYusetu: number;
  tokensIfDirect: number;
}): number {
  return Math.max(0, row.tokensIfDirect - row.tokensViaYusetu);
}

function savingsPct(row: {
  tokensViaYusetu: number;
  tokensIfDirect: number;
}): number | null {
  if (row.tokensIfDirect <= 0) return null;
  return (
    Math.round((tokensSaved(row) / row.tokensIfDirect) * 10_000) / 100
  );
}

function McpUsageChart({ rows }: { rows: UsageAnalytics["byMcp"] }) {
  const withUsage = rows
    .filter((r) => r.tokensViaYusetu > 0 || r.tokensIfDirect > 0)
    .map((r) => ({
      ...r,
      saved: tokensSaved(r),
      pct: savingsPct(r),
    }))
    .sort((a, b) => b.tokensIfDirect - a.tokensIfDirect);

  if (withUsage.length === 0) {
    return (
      <div className="analytics-chart-empty">
        No per-MCP usage yet. Numbers appear after agents call tools through the
        gateway.
      </div>
    );
  }

  const max = Math.max(
    ...withUsage.flatMap((r) => [r.tokensViaYusetu, r.tokensIfDirect]),
    1,
  );

  return (
    <div className="mcp-usage-chart" role="list" aria-label="Token usage by MCP">
      {withUsage.map((row) => {
        const viaPct = Math.max(2, (row.tokensViaYusetu / max) * 100);
        const directPct = Math.max(2, (row.tokensIfDirect / max) * 100);
        return (
          <article key={row.slug} className="mcp-usage-row" role="listitem">
            <header className="mcp-usage-row-head">
              <div className="mcp-usage-row-title">
                <span className="mcp-usage-row-name">{row.name || row.slug}</span>
                <code className="mcp-usage-row-slug">{row.slug}</code>
              </div>
              {row.saved > 0 ? (
                <span className="mcp-usage-saved">
                  Saved {formatTokens(row.saved)}
                  {row.pct != null ? (
                    <span className="mcp-usage-saved-pct">−{row.pct}%</span>
                  ) : null}
                </span>
              ) : null}
            </header>

            <div className="mcp-usage-bars">
              <div className="mcp-usage-bar-row">
                <span className="mcp-usage-bar-label">Via Yūsetu</span>
                <div className="mcp-usage-bar-track">
                  <div
                    className="mcp-usage-bar-fill mcp-usage-bar-fill--via"
                    style={{ width: `${viaPct}%` }}
                  />
                </div>
                <span className="mcp-usage-bar-value">
                  {formatTokens(row.tokensViaYusetu)}
                </span>
              </div>
              <div className="mcp-usage-bar-row">
                <span className="mcp-usage-bar-label">If direct</span>
                <div className="mcp-usage-bar-track">
                  <div
                    className="mcp-usage-bar-fill mcp-usage-bar-fill--direct"
                    style={{ width: `${directPct}%` }}
                  />
                </div>
                <span className="mcp-usage-bar-value">
                  {formatTokens(row.tokensIfDirect)}
                </span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function AnalyticsPage() {
  const query = useQuery({
    queryKey: ["analytics", "usage"],
    queryFn: () => analyticsApi.usage(),
  });

  const data = query.data;
  const hasUsage =
    data != null &&
    (data.totalCalls > 0 ||
      data.tokensViaYusetu > 0 ||
      data.tokensIfDirect > 0);
  const hasCatalog =
    data != null && (data.mcpCount > 0 || data.catalogToolCount > 0);
  const catalogExposureHint =
    hasCatalog && data
      ? `Meta mode exposes ~5 gateway tools vs ${formatTokens(data.catalogToolCount)} catalog tools if connected directly.`
      : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Analytics</h1>
          <p>
            Actual usage through Yūsetu vs configuring each MCP separately.
          </p>
        </div>
      </div>

      {query.isLoading ? <div className="empty">Loading analytics…</div> : null}
      {query.error ? (
        <div className="alert alert-error">
          {query.error instanceof ApiError
            ? query.error.message
            : "Failed to load analytics."}
        </div>
      ) : null}

      {data && !hasUsage ? (
        <div className="empty analytics-empty">
          <p>
            No usage recorded yet. After agents connect to the gateway and list
            or call tools, token savings and per-MCP usage will show up here.
          </p>
          {data.mcpCount > 0 ? (
            <p className="hint" style={{ marginBottom: 0 }}>
              {data.mcpCount} enabled MCP{data.mcpCount === 1 ? "" : "s"} ·{" "}
              {data.catalogToolCount} tools available
              {catalogExposureHint ? (
                <>
                  <br />
                  {catalogExposureHint}
                </>
              ) : null}
            </p>
          ) : (
            <p className="hint" style={{ marginBottom: 0 }}>
              Add and enable MCPs, then point an agent at this gateway.
            </p>
          )}
        </div>
      ) : null}

      {data && hasUsage ? (
        <div className="stack" style={{ maxWidth: 860 }}>
          {catalogExposureHint ? (
            <p className="hint" style={{ margin: 0 }}>
              {catalogExposureHint}
            </p>
          ) : null}
          <section className="analytics-hero analytics-hero--savings">
            <div className="analytics-hero-top">
              <p className="analytics-hero-label">Tool-definition tokens saved</p>
              {(data.catalogSavingsPercent ?? data.savingsPercent) != null ? (
                <span className="analytics-savings-badge">
                  −{data.catalogSavingsPercent ?? data.savingsPercent}%
                </span>
              ) : null}
            </div>
            <p className="analytics-hero-value">
              {formatTokens(data.catalogTokensSaved ?? data.tokensSaved)}
            </p>
            <p className="analytics-hero-sub">
              vs exposing the full catalog on tools/list (invoke payloads are
              unchanged)
            </p>
          </section>

          <div className="analytics-compare">
            <div className="analytics-compare-item analytics-compare-item--savings">
              <span className="analytics-compare-label">Catalog saved</span>
              <span className="analytics-compare-stat analytics-compare-stat--lg analytics-compare-stat--saved">
                −{formatTokens(data.catalogTokensSaved ?? data.tokensSaved)}
              </span>
              {(data.catalogSavingsPercent ?? data.savingsPercent) != null ? (
                <span className="analytics-compare-hint">
                  {data.catalogSavingsPercent ?? data.savingsPercent}% fewer
                  definition tokens
                </span>
              ) : null}
            </div>
            <div className="analytics-compare-item">
              <span className="analytics-compare-label">
                Calls through Yūsetu
              </span>
              <span className="analytics-compare-stat analytics-compare-stat--lg">
                {formatTokens(data.totalCalls)}
              </span>
            </div>
            <div className="analytics-compare-item">
              <span className="analytics-compare-label">All tokens via Yūsetu</span>
              <span className="analytics-compare-stat analytics-compare-stat--lg">
                {formatTokens(data.tokensViaYusetu)}
              </span>
            </div>
            <div className="analytics-compare-item">
              <span className="analytics-compare-label">All tokens if direct</span>
              <span className="analytics-compare-stat analytics-compare-stat--lg">
                {formatTokens(data.tokensIfDirect)}
              </span>
              {data.savingsPercent != null ? (
                <span className="analytics-compare-hint">
                  {data.savingsPercent}% overall (includes invokes)
                </span>
              ) : null}
            </div>
          </div>

          <section className="analytics-chart-section">
            <h2>Usage by MCP</h2>
            <McpUsageChart rows={data.byMcp} />
          </section>

          {data.byMcp.some(
            (r) => r.calls > 0 || r.tokensViaYusetu > 0 || r.tokensIfDirect > 0,
          ) ? (
            <div>
              <h2 style={{ marginBottom: "0.75rem" }}>Per MCP</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>MCP</th>
                      <th>Calls</th>
                      <th>Via Yūsetu</th>
                      <th>If direct</th>
                      <th>Saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byMcp
                      .filter(
                        (r) =>
                          r.calls > 0 ||
                          r.tokensViaYusetu > 0 ||
                          r.tokensIfDirect > 0,
                      )
                      .map((row) => {
                        const saved = tokensSaved(row);
                        const pct = savingsPct(row);
                        return (
                          <tr key={row.slug}>
                            <td>
                              {row.name}{" "}
                              <code className="hint">{row.slug}</code>
                            </td>
                            <td>{formatTokens(row.calls)}</td>
                            <td>{formatTokens(row.tokensViaYusetu)}</td>
                            <td>{formatTokens(row.tokensIfDirect)}</td>
                            <td>
                              <span className="analytics-saved-cell">
                                −{formatTokens(saved)}
                                {pct != null ? (
                                  <span className="analytics-saved-pct">
                                    −{pct}%
                                  </span>
                                ) : null}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
