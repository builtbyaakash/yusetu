import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { analyticsApi } from "../api";
import type { UsageAnalytics } from "../api/types";
import { Pagination, useClientPage } from "../components/Pagination";

type RangeKey = "7d" | "30d" | "90d" | "all";

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function signedTokens(n: number): string {
  if (n > 0) return `−${formatTokens(n)}`;
  if (n < 0) return `+${formatTokens(Math.abs(n))}`;
  return formatTokens(0);
}

function netSaved(row: {
  tokensViaYusetu: number;
  tokensIfDirect: number;
  netSaved?: number;
}): number {
  if (typeof row.netSaved === "number") return row.netSaved;
  return row.tokensIfDirect - row.tokensViaYusetu;
}

function McpUsageChart({ rows }: { rows: UsageAnalytics["byMcp"] }) {
  const withUsage = rows
    .filter((r) => r.tokensViaYusetu > 0 || r.tokensIfDirect > 0)
    .map((r) => ({
      ...r,
      saved: netSaved(r),
    }))
    .sort((a, b) => b.tokensViaYusetu - a.tokensViaYusetu);

  if (withUsage.length === 0) {
    return (
      <div className="analytics-chart-empty">
        No per-MCP usage yet. Numbers appear after agents call tools through the
        gateway.
      </div>
    );
  }

  const max = Math.max(
    ...withUsage.flatMap((r) => [
      r.tokensViaYusetu,
      r.invokeTokensVia ?? 0,
      r.discoveryTokensVia ?? 0,
    ]),
    1,
  );

  return (
    <div className="mcp-usage-chart" role="list" aria-label="Token usage by MCP">
      {withUsage.map((row) => {
        const viaPct = Math.max(2, (row.tokensViaYusetu / max) * 100);
        const discovery = row.discoveryTokensVia ?? 0;
        const invoke = row.invokeTokensVia ?? 0;
        return (
          <article key={row.slug} className="mcp-usage-row" role="listitem">
            <header className="mcp-usage-row-head">
              <div className="mcp-usage-row-title">
                <span className="mcp-usage-row-name">{row.name || row.slug}</span>
                <code className="mcp-usage-row-slug">{row.slug}</code>
              </div>
              <span className="mcp-usage-saved">
                Net {signedTokens(row.saved)}
                <span className="mcp-usage-saved-pct">
                  · {formatTokens(row.catalogTokens)} defs today
                </span>
              </span>
            </header>

            <div className="mcp-usage-bars">
              <div className="mcp-usage-bar-row">
                <span className="mcp-usage-bar-label">Discovery + invoke</span>
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
              <p className="hint" style={{ margin: "0.25rem 0 0" }}>
                discovery {formatTokens(discovery)} · invoke{" "}
                {formatTokens(invoke)}
              </p>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>("30d");
  const query = useQuery({
    queryKey: ["analytics", "usage", range],
    queryFn: () => analyticsApi.usage(range),
  });

  const data = query.data;
  const hasUsage =
    data != null &&
    (data.totalCalls > 0 ||
      data.tokensViaYusetu > 0 ||
      data.tokensIfDirect > 0 ||
      (data.toolsListCount ?? 0) > 0);
  const hasCatalog =
    data != null && (data.mcpCount > 0 || data.catalogToolCount > 0);
  const catalogExposureHint =
    hasCatalog && data
      ? `Meta mode exposes ~5 gateway tools vs ${formatTokens(data.catalogToolCount)} catalog tools if connected directly.`
      : null;

  const catalogDelta = data?.catalogTokensDelta ?? data?.catalogTokensSaved ?? 0;
  const discoveryOverhead = data?.discoveryOverheadVia ?? 0;
  const net =
    data?.netTokensSaved ??
    catalogDelta - discoveryOverhead;

  const mcpRows = useMemo(
    () =>
      (data?.byMcp ?? []).filter(
        (r) =>
          r.calls > 0 || r.tokensViaYusetu > 0 || r.tokensIfDirect > 0,
      ),
    [data?.byMcp],
  );
  const {
    page: mcpPage,
    setPage: setMcpPage,
    pageItems: pagedMcpRows,
    total: mcpTotal,
  } = useClientPage(mcpRows);

  return (
    <div className="analytics">
      <div className="page-header">
        <div>
          <h1>Analytics</h1>
          <p>
            Observed context tokens through Yūsetu vs connecting each MCP
            separately.
          </p>
        </div>
        <div className="page-header-actions" role="group" aria-label="Range">
          {(["7d", "30d", "90d", "all"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={
                range === key ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"
              }
              onClick={() => setRange(key)}
            >
              {key === "all" ? "All" : key}
            </button>
          ))}
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
        <section className="page-section">
          <div className="empty analytics-empty">
            <p>
              No usage recorded yet. After agents connect to the gateway and list
              or call tools, token savings and per-MCP usage will show up here.
            </p>
            {data.mcpCount > 0 ? (
              <p className="hint">
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
              <p className="hint">
                Add and enable MCPs, then point an agent at this gateway.
              </p>
            )}
          </div>
        </section>
      ) : null}

      {data && hasUsage ? (
        <>
          <p className="hint analytics-exposure-hint">
            Observed estimate · {data.estimatorVersion ?? "chars4-v1"}
            {catalogExposureHint ? ` · ${catalogExposureHint}` : null}
          </p>

          {data.catalogFromLiveSnapshot ? (
            <div className="alert">
              No tools/list was stored in this range. Historical catalog savings
              are unknown. The opportunity card below uses today&apos;s catalog
              only.
            </div>
          ) : null}

          <section className="page-section page-section--wide">
            <div className="analytics-hero analytics-hero--savings">
              <div className="analytics-hero-top">
                <p className="analytics-hero-label">
                  Estimated context tokens avoided
                </p>
                {data.netSavingsPercent != null ? (
                  <span className="analytics-savings-badge">
                    {net >= 0 ? "−" : "+"}
                    {data.netSavingsPercent}%
                  </span>
                ) : null}
              </div>
              <p className="analytics-hero-value">{signedTokens(net)}</p>
              <p className="analytics-hero-sub">
                Catalog delta after discovery overhead ·{" "}
                {formatTokens(data.toolsListCount ?? 0)} observed tools/list
                {data.toolsListCount === 1 ? "" : "s"} · invokes ≈ equal either
                way
              </p>
            </div>

            <div className="analytics-compare">
              <div className="analytics-compare-item">
                <span className="analytics-compare-label">
                  Definitions if direct
                </span>
                <span className="analytics-compare-stat analytics-compare-stat--lg">
                  {formatTokens(data.catalogTokensIfDirect ?? 0)}
                </span>
              </div>
              <div className="analytics-compare-item">
                <span className="analytics-compare-label">Meta tools/list</span>
                <span className="analytics-compare-stat analytics-compare-stat--lg">
                  −{formatTokens(data.catalogTokensVia ?? 0)}
                </span>
              </div>
              <div className="analytics-compare-item">
                <span className="analytics-compare-label">
                  Discovery overhead
                </span>
                <span className="analytics-compare-stat analytics-compare-stat--lg">
                  −{formatTokens(discoveryOverhead)}
                </span>
                <span className="analytics-compare-hint">
                  list / search / get
                </span>
              </div>
              <div className="analytics-compare-item analytics-compare-item--savings">
                <span className="analytics-compare-label">Net saved</span>
                <span className="analytics-compare-stat analytics-compare-stat--lg analytics-compare-stat--saved">
                  {signedTokens(net)}
                </span>
              </div>
            </div>

            {data.currentOpportunity ? (
              <div className="analytics-compare" style={{ marginTop: "1rem" }}>
                <div className="analytics-compare-item">
                  <span className="analytics-compare-label">
                    Current opportunity (snapshot)
                  </span>
                  <span className="analytics-compare-stat analytics-compare-stat--lg">
                    {signedTokens(data.currentOpportunity.saved)}
                  </span>
                  <span className="analytics-compare-hint">
                    Today&apos;s meta list vs{" "}
                    {formatTokens(data.currentOpportunity.catalogToolCount)}{" "}
                    tools · not claimed historical savings
                  </span>
                </div>
                <div className="analytics-compare-item">
                  <span className="analytics-compare-label">
                    Shared meta overhead
                  </span>
                  <span className="analytics-compare-stat analytics-compare-stat--lg">
                    {formatTokens(data.sharedOverhead?.exposureVia ?? 0)}
                  </span>
                </div>
                <div className="analytics-compare-item">
                  <span className="analytics-compare-label">Calls</span>
                  <span className="analytics-compare-stat analytics-compare-stat--lg">
                    {formatTokens(data.totalCalls)}
                  </span>
                </div>
                <div className="analytics-compare-item">
                  <span className="analytics-compare-label">
                    Invoke via ≈ if direct
                  </span>
                  <span className="analytics-compare-stat analytics-compare-stat--lg">
                    {formatTokens(data.invokeTokensVia ?? 0)}
                  </span>
                </div>
              </div>
            ) : null}
          </section>

          <section className="page-section page-section--wide analytics-chart-section">
            <h2>Usage by MCP</h2>
            <McpUsageChart rows={data.byMcp} />
          </section>

          {mcpRows.length > 0 ? (
            <section className="page-section page-section--wide">
              <h2>Per MCP</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>MCP</th>
                      <th className="col-num">Calls</th>
                      <th className="col-num">Discovery</th>
                      <th className="col-num">Invoke</th>
                      <th className="col-num">Defs today</th>
                      <th className="col-num">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedMcpRows.map((row) => {
                      const saved = netSaved(row);
                      return (
                        <tr key={row.slug}>
                          <td className="cell-name">
                            {row.name}{" "}
                            <code className="cell-slug">{row.slug}</code>
                          </td>
                          <td className="col-num">
                            {formatTokens(row.calls)}
                          </td>
                          <td className="col-num">
                            {formatTokens(row.discoveryTokensVia ?? 0)}
                          </td>
                          <td className="col-num">
                            {formatTokens(row.invokeTokensVia ?? 0)}
                          </td>
                          <td className="col-num">
                            {formatTokens(row.catalogTokens)}
                          </td>
                          <td className="col-num">
                            <span className="analytics-saved-cell">
                              {signedTokens(saved)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination
                total={mcpTotal}
                page={mcpPage}
                onPageChange={setMcpPage}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
