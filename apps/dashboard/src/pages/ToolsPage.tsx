import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { toolsApi, upstreamsApi } from "../api";
import { Toggle } from "../components/Toggle";

export function ToolsPage() {
  const queryClient = useQueryClient();
  const [upstreamId, setUpstreamId] = useState("");

  const upstreamsQuery = useQuery({
    queryKey: ["upstreams"],
    queryFn: () => upstreamsApi.list(),
  });

  const toolsQuery = useQuery({
    queryKey: ["tools", upstreamId || "all"],
    queryFn: () => toolsApi.list(upstreamId || undefined),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      toolsApi.update(id, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const tools = useMemo(() => toolsQuery.data ?? [], [toolsQuery.data]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tools</h1>
          <p>
            Aggregated catalog with exposed names and enable toggles
            {tools.length > 0 ? ` · ${tools.length} tools` : null}.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <div className="field field-filter">
          <label htmlFor="tools-upstream">Filter by MCP</label>
          <select
            id="tools-upstream"
            className="select"
            value={upstreamId}
            onChange={(e) => setUpstreamId(e.target.value)}
          >
            <option value="">All MCPs</option>
            {(upstreamsQuery.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.slug})
              </option>
            ))}
          </select>
        </div>
      </div>

      {toolsQuery.isLoading ? <div className="empty">Loading tools…</div> : null}
      {toolsQuery.error ? (
        <div className="alert alert-error">
          {toolsQuery.error instanceof ApiError
            ? toolsQuery.error.message
            : "Failed to load tools."}
        </div>
      ) : null}

      {!toolsQuery.isLoading && tools.length === 0 ? (
        <div className="empty">
          No tools discovered yet. Add an MCP and run Rediscover.
        </div>
      ) : null}

      {tools.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table tools-table">
            <thead>
              <tr>
                <th className="col-tool-name">Exposed name</th>
                <th className="col-tool-name">Original</th>
                <th className="col-tool-mcp">MCP</th>
                <th className="col-tool-desc">Description</th>
                <th className="col-enabled">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id}>
                  <td className="col-tool-name">
                    <code className="cell-tool-name">{tool.exposedName}</code>
                  </td>
                  <td className="col-tool-name">
                    <code className="cell-tool-name">{tool.originalName}</code>
                  </td>
                  <td className="col-tool-mcp">
                    <span className="badge badge-muted">
                      {tool.upstreamName ?? tool.upstreamSlug}
                    </span>
                  </td>
                  <td className="col-tool-desc">
                    <span className="cell-desc" title={tool.description || undefined}>
                      {tool.description || "—"}
                    </span>
                  </td>
                  <td className="col-enabled">
                    <Toggle
                      checked={tool.enabled}
                      aria-label={`Enable ${tool.exposedName}`}
                      disabled={toggleMutation.isPending}
                      onChange={(enabled) =>
                        toggleMutation.mutate({ id: tool.id, enabled })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
