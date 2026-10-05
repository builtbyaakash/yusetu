import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { apiKeysApi, mcpGroupsApi } from "../api";
import type {
  ApiKey,
  ApiKeyScopeMode,
  CreateApiKeyResponse,
} from "../api/types";
import { ConfirmDialog, type ConfirmIntent } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { EmptyState, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { mcpGatewayEndpoints } from "../lib/endpoints";

type SettingsTab = "keys" | "connection" | "advanced";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<SettingsTab>("keys");
  const [name, setName] = useState("");
  const [scopeMode, setScopeMode] = useState<ApiKeyScopeMode>("groups");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editScopeMode, setEditScopeMode] =
    useState<ApiKeyScopeMode>("groups");
  const [editGroupIds, setEditGroupIds] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<ConfirmIntent | null>(null);

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

  const groupsQuery = useQuery({
    queryKey: ["mcp-groups"],
    queryFn: () => mcpGroupsApi.list(),
  });

  useEffect(() => {
    if (!editing) return;
    setEditScopeMode(editing.scopeMode);
    setEditGroupIds([...editing.groupIds]);
  }, [editing]);

  const createMutation = useMutation({
    mutationFn: () =>
      apiKeysApi.create({
        name: name.trim(),
        scopeMode,
        groupIds: scopeMode === "groups" ? groupIds : [],
      }),
    onSuccess: (data) => {
      setCreated(data);
      setName("");
      setScopeMode("groups");
      setGroupIds([]);
      toast.push("API key created. Copy it now.", "success");
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({
      id,
      scopeMode: nextMode,
      groupIds: nextGroups,
    }: {
      id: string;
      scopeMode: ApiKeyScopeMode;
      groupIds: string[];
    }) =>
      apiKeysApi.patch(id, {
        scopeMode: nextMode,
        groupIds: nextMode === "groups" ? nextGroups : [],
      }),
    onSuccess: () => {
      setEditing(null);
      toast.push("Key scope updated.", "success");
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiKeysApi.remove(id),
    onSuccess: () => {
      setConfirm(null);
      toast.push("API key revoked.", "success");
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate();
  }

  function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    patchMutation.mutate({
      id: editing.id,
      scopeMode: editScopeMode,
      groupIds: editGroupIds,
    });
  }

  function toggleCreateGroup(id: string) {
    setGroupIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
  }

  function toggleEditGroup(id: string) {
    setEditGroupIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
  }

  async function copyText(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    toast.push("Copied.", "success");
    window.setTimeout(() => setCopied(null), 1500);
  }

  const groups = groupsQuery.data ?? [];
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "keys", label: "API keys" },
    { id: "connection", label: "Connect Cursor" },
    { id: "advanced", label: "Advanced" },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Mint a key, then point Cursor at this gateway.</p>
        </div>
      </div>

      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={
              tab === t.id ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"
            }
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "keys" ? (
        <>
          <section className="page-section">
            <h2>Create API key</h2>
            <p className="hint">
              Scoped keys only expose MCPs in the groups you attach. Create
              groups on the Groups page first.
            </p>
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
              <div className="field">
                <label htmlFor="key-scope">Scope</label>
                <select
                  id="key-scope"
                  className="select"
                  value={scopeMode}
                  onChange={(e) =>
                    setScopeMode(e.target.value as ApiKeyScopeMode)
                  }
                >
                  <option value="groups">Groups</option>
                  <option value="unrestricted">Unrestricted</option>
                </select>
              </div>
              {scopeMode === "groups" ? (
                <div className="field">
                  <label>Groups</label>
                  {groupsQuery.isLoading ? (
                    <p className="hint">Loading groups…</p>
                  ) : null}
                  {groupsQuery.error ? (
                    <div className="alert alert-error">
                      {groupsQuery.error instanceof ApiError
                        ? groupsQuery.error.message
                        : "Failed to load groups."}
                    </div>
                  ) : null}
                  {groupsQuery.isSuccess && groups.length === 0 ? (
                    <p className="hint">
                      No groups yet. The key will expose an empty catalog until
                      you attach groups.
                    </p>
                  ) : null}
                  {groups.map((g) => (
                    <label key={g.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={groupIds.includes(g.id)}
                        onChange={() => toggleCreateGroup(g.id)}
                      />
                      <span>{g.name}</span>
                    </label>
                  ))}
                </div>
              ) : null}
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
                <p>Copy this key now. It will not be shown again.</p>
                <div className="copy-row">
                  <div className="key-reveal">{created.key}</div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      void copyText("created-key", created.key)
                    }
                  >
                    {copied === "created-key" ? "Copied" : "Copy to clipboard"}
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="page-section page-section--wide">
            <h2>API keys</h2>
            {keysQuery.isLoading ? <TableSkeleton rows={3} cols={5} /> : null}
            {keysQuery.error ? (
              <div className="alert alert-error">
                {keysQuery.error instanceof ApiError
                  ? keysQuery.error.message
                  : "Failed to load keys."}
              </div>
            ) : null}
            {keysQuery.data && keysQuery.data.length === 0 ? (
              <EmptyState
                title="No API keys yet"
                body="Create a scoped key above, then paste it into your Cursor MCP config."
              />
            ) : null}
            {keysQuery.data && keysQuery.data.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Scope</th>
                      <th>Prefix</th>
                      <th>Created</th>
                      <th>Last used</th>
                      <th className="col-actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {keysQuery.data.map((key) => (
                      <tr key={key.id}>
                        <td className="cell-name">{key.name}</td>
                        <td>{scopeBadge(key)}</td>
                        <td>
                          <code className="cell-slug">{key.keyPrefix}…</code>
                        </td>
                        <td>{formatDate(key.createdAt)}</td>
                        <td>
                          {key.lastUsedAt ? formatDate(key.lastUsedAt) : "—"}
                        </td>
                        <td className="col-actions">
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setEditing(key)}
                            >
                              Edit scope
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={deleteMutation.isPending}
                              onClick={() =>
                                setConfirm({
                                  title: "Revoke API key",
                                  message: `Revoke “${key.name}”? Clients using it will stop working.`,
                                  confirmLabel: "Revoke",
                                  danger: true,
                                  onConfirm: () =>
                                    deleteMutation.mutate(key.id),
                                })
                              }
                            >
                              Revoke
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {tab === "connection" ? (
        <section className="page-section page-section--wide">
          <div className="settings-connect-card">
            <h2>Connect Cursor</h2>
            <p className="hint">
              Create an API key on the API keys tab, then paste this into Cursor
              MCP settings. Replace the bearer token with your key.
            </p>
            <div className="field">
              <div className="section-heading-row">
                <label>mcpServers snippet</label>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void copyText("snippet", configSnippet)}
                >
                  {copied === "snippet" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="result-box">{configSnippet}</pre>
            </div>
          </div>

          <h2>Endpoints</h2>
          <p className="hint">Point any MCP client at these gateway URLs.</p>

          <div className="field">
            <label>Streamable HTTP</label>
            <div className="copy-row">
              <code className="key-reveal">{endpoints.streamableHttp}</code>
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
            <div className="copy-row">
              <code className="key-reveal">{endpoints.health}</code>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void copyText("health", endpoints.health)}
              >
                {copied === "health" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {tab === "advanced" ? (
        <section className="page-section">
          <h2>OAuth discovery</h2>
          <p className="hint">
            For clients that discover authorization servers via PRM metadata.
          </p>

          <div className="field">
            <label>Protected resource metadata (PRM)</label>
            <div className="copy-row">
              <code className="key-reveal">
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
            <div className="copy-row">
              <code className="key-reveal">
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
        </section>
      ) : null}

      {editing ? (
        <Modal
          title={`Edit scope · ${editing.name}`}
          onClose={() => setEditing(null)}
        >
          <form className="form" onSubmit={handleEditSave}>
            {patchMutation.error ? (
              <div className="alert alert-error">
                {patchMutation.error instanceof ApiError
                  ? patchMutation.error.message
                  : "Failed to update scope."}
              </div>
            ) : null}
            <p className="hint">Changing scope does not rotate the secret.</p>
            <div className="field">
              <label htmlFor="edit-key-scope">Scope</label>
              <select
                id="edit-key-scope"
                className="select"
                value={editScopeMode}
                onChange={(e) =>
                  setEditScopeMode(e.target.value as ApiKeyScopeMode)
                }
              >
                <option value="groups">Groups</option>
                <option value="unrestricted">Unrestricted</option>
              </select>
            </div>
            {editScopeMode === "groups" ? (
              <div className="field">
                <label>Groups</label>
                {groups.length === 0 ? (
                  <p className="hint">No groups yet.</p>
                ) : null}
                {groups.map((g) => (
                  <label key={g.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={editGroupIds.includes(g.id)}
                      onChange={() => toggleEditGroup(g.id)}
                    />
                    <span>{g.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={patchMutation.isPending}
              >
                {patchMutation.isPending ? "Saving…" : "Save scope"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      <ConfirmDialog
        intent={confirm}
        onDismiss={() => setConfirm(null)}
        busy={deleteMutation.isPending}
      />
    </div>
  );
}

function scopeBadge(key: ApiKey) {
  if (key.scopeMode === "unrestricted") {
    return <span className="badge badge-warning">Unrestricted</span>;
  }
  const n = key.groupIds.length;
  return (
    <span className="badge badge-muted">
      {n === 0 ? "0 groups" : `${n} group${n === 1 ? "" : "s"}`}
    </span>
  );
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
