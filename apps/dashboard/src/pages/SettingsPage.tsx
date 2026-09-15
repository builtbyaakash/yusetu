import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { apiKeysApi } from "../api";
import type { CreateApiKeyResponse } from "../api/types";
import { mcpGatewayEndpoints } from "../lib/endpoints";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const endpoints = useMemo(() => mcpGatewayEndpoints(), []);

  const configSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            yusetu: {
              url: endpoints.streamableHttp,
              headers: {
                Authorization: "Bearer <your-api-key>",
              },
            },
          },
        },
        null,
        2,
      ),
    [endpoints.streamableHttp],
  );

  const keysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => apiKeysApi.list(),
  });

  const createMutation = useMutation({
    mutationFn: (keyName: string) => apiKeysApi.create({ name: keyName }),
    onSuccess: (data) => {
      setCreated(data);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiKeysApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  }

  async function copyText(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Connection endpoints and API keys.</p>
        </div>
      </div>

      <section className="stack" style={{ maxWidth: 720 }}>
        <h2>Connection</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Point MCP clients at these gateway URLs.
        </p>

        <div className="field">
          <label>Streamable HTTP</label>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <code className="key-reveal" style={{ flex: 1, margin: 0 }}>
              {endpoints.streamableHttp}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                void copyText("streamableHttp", endpoints.streamableHttp)
              }
            >
              {copied === "streamableHttp" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="field">
          <label>Health</label>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <code className="key-reveal" style={{ flex: 1, margin: 0 }}>
              {endpoints.health}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void copyText("health", endpoints.health)}
            >
              {copied === "health" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <h3 style={{ marginTop: "0.5rem", marginBottom: 0 }}>OAuth discovery</h3>

        <div className="field">
          <label>Protected resource metadata (PRM)</label>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <code className="key-reveal" style={{ flex: 1, margin: 0 }}>
              {endpoints.oauthProtectedResource}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                void copyText(
                  "oauthProtectedResource",
                  endpoints.oauthProtectedResource,
                )
              }
            >
              {copied === "oauthProtectedResource" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="field">
          <label>Authorization server metadata</label>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <code className="key-reveal" style={{ flex: 1, margin: 0 }}>
              {endpoints.oauthAuthorizationServer}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                void copyText(
                  "oauthAuthorizationServer",
                  endpoints.oauthAuthorizationServer,
                )
              }
            >
              {copied === "oauthAuthorizationServer" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="field">
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <label style={{ margin: 0 }}>Client config example</label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void copyText("snippet", configSnippet)}
            >
              {copied === "snippet" ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="result-box" style={{ margin: 0 }}>
            {configSnippet}
          </pre>
        </div>
      </section>

      <section className="stack" style={{ maxWidth: 720, marginTop: "1.5rem" }}>
        <h2>Create API key</h2>
        <form className="form" onSubmit={handleCreate}>
          {createMutation.error ? (
            <div className="alert alert-error">
              {createMutation.error instanceof ApiError
                ? createMutation.error.message
                : "Failed to create key."}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="key-name">Name</label>
            <input
              id="key-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cursor-local"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating…" : "Create key"}
          </button>
        </form>

        {created ? (
          <div className="alert alert-success">
            <p style={{ marginBottom: "0.5rem", color: "inherit" }}>
              Copy this key now — it will not be shown again.
            </p>
            <div className="key-reveal">{created.key}</div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginTop: "0.75rem" }}
              onClick={() => void navigator.clipboard.writeText(created.key)}
            >
              Copy to clipboard
            </button>
          </div>
        ) : null}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>API keys</h2>
        {keysQuery.isLoading ? <div className="empty">Loading keys…</div> : null}
        {keysQuery.error ? (
          <div className="alert alert-error">
            {keysQuery.error instanceof ApiError
              ? keysQuery.error.message
              : "Failed to load keys."}
          </div>
        ) : null}
        {keysQuery.data && keysQuery.data.length === 0 ? (
          <div className="empty">No API keys yet.</div>
        ) : null}
        {keysQuery.data && keysQuery.data.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keysQuery.data.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <code>{key.keyPrefix}…</code>
                    </td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>
                      {key.lastUsedAt ? formatDate(key.lastUsedAt) : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Revoke API key “${key.name}”?`,
                            )
                          ) {
                            deleteMutation.mutate(key.id);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
