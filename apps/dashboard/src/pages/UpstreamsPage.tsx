import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { authApi, upstreamsApi } from "../api";
import type {
  AuthMeResponse,
  CreateUpstream,
  UpdateUpstream,
  Upstream,
  UpstreamOauthStatus,
  UpstreamVisibility,
} from "../api/types";
import { Modal } from "../components/Modal";
import { Toggle } from "../components/Toggle";
import { UpstreamForm } from "../components/UpstreamForm";
import { UpstreamGrantsPanel } from "../components/UpstreamGrantsPanel";

function statusBadge(status?: string) {
  switch (status) {
    case "healthy":
      return <span className="badge badge-success">Healthy</span>;
    case "unhealthy":
      return <span className="badge badge-danger">Unhealthy</span>;
    case "disabled":
      return <span className="badge badge-muted">Disabled</span>;
    default:
      return <span className="badge badge-warning">Unknown</span>;
  }
}

type VisibilityFilter = "all" | UpstreamVisibility;

function visibilityBadge(visibility?: UpstreamVisibility) {
  if (visibility === "shared") {
    return <span className="badge badge-success">Shared</span>;
  }
  return <span className="badge badge-muted">Personal</span>;
}

function canManageUpstream(u: Upstream, me: AuthMeResponse): boolean {
  if (u.visibility === "shared") {
    return me.capabilities.canManageSharedMcps;
  }
  return u.ownerUserId == null || u.ownerUserId === me.id;
}

function oauthBadge(status?: UpstreamOauthStatus, error?: string | null) {
  switch (status) {
    case "connected":
      return <span className="badge badge-success">OAuth connected</span>;
    case "pending":
      return <span className="badge badge-warning">OAuth pending</span>;
    case "error":
      return (
        <span
          className="badge badge-danger"
          title={error ?? "OAuth error"}
        >
          OAuth error
        </span>
      );
    case "disconnected":
    default:
      return <span className="badge badge-muted">OAuth disconnected</span>;
  }
}

export function UpstreamsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [modal, setModal] = useState<"create" | Upstream | null>(null);
  const [grantsFor, setGrantsFor] = useState<Upstream | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [oauthAlert, setOauthAlert] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [discoveryAlert, setDiscoveryAlert] = useState<string | null>(null);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>("all");

  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => authApi.me(),
  });

  const query = useQuery({
    queryKey: ["upstreams"],
    queryFn: () => upstreamsApi.list(),
  });

  const me = meQuery.data;
  const filteredUpstreams = useMemo(() => {
    const rows = query.data ?? [];
    if (visibilityFilter === "all") return rows;
    return rows.filter((u) => (u.visibility ?? "personal") === visibilityFilter);
  }, [query.data, visibilityFilter]);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["upstreams"] });

  useEffect(() => {
    const oauth = searchParams.get("oauth");
    if (!oauth) return;

    if (oauth === "connected") {
      setOauthAlert({
        type: "success",
        message: "OAuth connected successfully.",
      });
      invalidate();
    } else if (oauth === "error") {
      setOauthAlert({
        type: "error",
        message: "OAuth connection failed. Try Connect OAuth again.",
      });
    }

    const next = new URLSearchParams(searchParams);
    next.delete("oauth");
    setSearchParams(next, { replace: true });
    // Only react to the landing query once on mount / when oauth param appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: clear query, avoid loop
  }, [searchParams, setSearchParams]);

  async function startOauthFlow(id: string) {
    setOauthBusyId(id);
    setOauthAlert(null);
    try {
      const { authorizationUrl } = await upstreamsApi.startOauth(id);
      window.open(authorizationUrl, "_blank", "noopener,noreferrer");
      // Stay on Yusetu; poll until the other tab finishes OAuth.
      const started = Date.now();
      const poll = window.setInterval(() => {
        void (async () => {
          try {
            const status = await upstreamsApi.oauthStatus(id);
            if (status.connected || status.status === "error") {
              window.clearInterval(poll);
              setOauthBusyId(null);
              invalidate();
              void queryClient.invalidateQueries({ queryKey: ["tools"] });
              setOauthAlert({
                type: status.connected ? "success" : "error",
                message: status.connected
                  ? "OAuth connected. You can close the auth tab."
                  : status.errorMessage ??
                    "OAuth connection failed. Try Connect OAuth again.",
              });
            } else if (Date.now() - started > 5 * 60 * 1000) {
              window.clearInterval(poll);
              setOauthBusyId(null);
              setOauthAlert({
                type: "error",
                message: "OAuth timed out. Finish login in the other tab, or try again.",
              });
            }
          } catch {
            /* keep polling */
          }
        })();
      }, 2000);
    } catch (err) {
      setOauthAlert({
        type: "error",
        message:
          err instanceof ApiError ? err.message : "Failed to start OAuth.",
      });
      setOauthBusyId(null);
    }
  }

  async function disconnectOauth(id: string) {
    setOauthBusyId(id);
    setOauthAlert(null);
    try {
      await upstreamsApi.disconnectOauth(id);
      invalidate();
      setOauthAlert({
        type: "success",
        message: "OAuth disconnected.",
      });
    } catch (err) {
      setOauthAlert({
        type: "error",
        message:
          err instanceof ApiError
            ? err.message
            : "Failed to disconnect OAuth.",
      });
    } finally {
      setOauthBusyId(null);
    }
  }

  const createMutation = useMutation({
    mutationFn: (body: CreateUpstream) => upstreamsApi.create(body),
    onSuccess: (created, variables) => {
      setModal(null);
      setFormError(null);
      setDiscoveryAlert(
        created.discoveryError
          ? `MCP created, but tool discovery failed: ${created.discoveryError}. Use Rediscover after the server is reachable.`
          : null,
      );
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      if (variables.authMode === "oauth") {
        const connect = window.confirm(
          `MCP “${created.name}” created. Connect OAuth now?`,
        );
        if (connect) {
          void startOauthFlow(created.id);
        }
      }
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : "Create failed.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUpstream }) =>
      upstreamsApi.update(id, body),
    onSuccess: () => {
      setModal(null);
      setFormError(null);
      invalidate();
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : "Update failed.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => upstreamsApi.remove(id),
    onSuccess: invalidate,
  });

  const discoverMutation = useMutation({
    mutationFn: (id: string) => upstreamsApi.discover(id),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      upstreamsApi.update(id, { enabled }),
    onSuccess: invalidate,
  });

  function openCreate() {
    setFormError(null);
    setModal("create");
  }

  function openEdit(upstream: Upstream) {
    setFormError(null);
    setModal(upstream);
  }

  function isOauthConnected(u: Upstream) {
    return u.authMode === "oauth" && u.oauthStatus === "connected";
  }

  function needsOauthConnect(u: Upstream) {
    return u.authMode === "oauth" && u.oauthStatus !== "connected";
  }

  const filterOptions: { value: VisibilityFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "shared", label: "Shared" },
    { value: "personal", label: "Mine" },
  ];

  return (
    <div className="mcp-list">
      <div className="page-header">
        <div>
          <h1>MCPs</h1>
          <p>
            Tools are discovered on add; Rediscover refreshes.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Add MCP
          </button>
        </div>
      </div>

      {oauthAlert ? (
        <div
          className={`alert ${
            oauthAlert.type === "success" ? "alert-success" : "alert-error"
          }`}
        >
          {oauthAlert.message}
        </div>
      ) : null}

      {discoveryAlert ? (
        <div className="alert alert-error">{discoveryAlert}</div>
      ) : null}

      <div className="filter-bar" role="group" aria-label="Filter MCPs">
        <span className="filter-bar-label" id="mcp-visibility-filter-label">
          Show
        </span>
        <div className="segmented" aria-labelledby="mcp-visibility-filter-label">
          {filterOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={visibilityFilter === opt.value}
              className={`segmented-btn${
                visibilityFilter === opt.value ? " is-active" : ""
              }`}
              onClick={() => setVisibilityFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {query.isLoading ? <div className="empty">Loading MCPs…</div> : null}
      {query.error ? (
        <div className="alert alert-error">
          {query.error instanceof ApiError
            ? query.error.message
            : "Failed to load MCPs."}
        </div>
      ) : null}

      {query.data && query.data.length === 0 ? (
        <div className="empty">No MCPs yet. Add your first MCP server.</div>
      ) : null}

      {query.data &&
      query.data.length > 0 &&
      filteredUpstreams.length === 0 ? (
        <div className="empty">No MCPs match this filter.</div>
      ) : null}

      {filteredUpstreams.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table mcp-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Transport</th>
                <th>Status</th>
                <th className="col-num">Tools</th>
                <th className="col-enabled">Enabled</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUpstreams.map((u) => {
                const manageable = me ? canManageUpstream(u, me) : false;
                return (
                <tr key={u.id}>
                  <td className="cell-name">
                    <div className="badge-group">
                      {u.name}
                      {visibilityBadge(u.visibility)}
                    </div>
                  </td>
                  <td>
                    <code className="cell-slug">{u.slug}</code>
                  </td>
                  <td>
                    <div className="badge-group">
                      <span className="badge badge-muted">{u.transport}</span>
                      {u.gitUrl ? (
                        <span className="badge badge-muted">git</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="status-cell">
                      <div className="badge-group">
                        {statusBadge(u.status)}
                        {u.authMode === "oauth"
                          ? oauthBadge(u.oauthStatus, u.oauthError)
                          : null}
                      </div>
                      {needsOauthConnect(u) ? (
                        <button
                          type="button"
                          className="btn btn-primary btn-xs"
                          disabled={oauthBusyId === u.id}
                          onClick={() => void startOauthFlow(u.id)}
                        >
                          {oauthBusyId === u.id ? "Connecting…" : "Connect"}
                        </button>
                      ) : null}
                      {isOauthConnected(u) ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={oauthBusyId === u.id}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Disconnect OAuth for “${u.name}”?`,
                              )
                            ) {
                              void disconnectOauth(u.id);
                            }
                          }}
                        >
                          {oauthBusyId === u.id
                            ? "Disconnecting…"
                            : "Disconnect"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                  <td className="col-num">{u.toolCount ?? "—"}</td>
                  <td className="col-enabled">
                    <Toggle
                      checked={u.enabled}
                      aria-label={`Enable ${u.name}`}
                      disabled={toggleMutation.isPending || !manageable}
                      onChange={(enabled) =>
                        toggleMutation.mutate({ id: u.id, enabled })
                      }
                    />
                  </td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => openEdit(u)}
                      >
                        {manageable ? "Edit" : "View"}
                      </button>
                      {manageable ? (
                        <>
                          {(u.visibility ?? "personal") === "shared" &&
                          me?.capabilities.canManageSharedMcps ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setGrantsFor(u)}
                            >
                              Share
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={discoverMutation.isPending}
                            onClick={() => discoverMutation.mutate(u.id)}
                          >
                            Rediscover
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={deleteMutation.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete MCP “${u.name}”? This cannot be undone.`,
                                )
                              ) {
                                deleteMutation.mutate(u.id);
                              }
                            }}
                          >
                            Delete
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {modal === "create" ? (
        <Modal title="Add MCP" onClose={() => setModal(null)}>
          <UpstreamForm
            error={formError}
            submitting={createMutation.isPending}
            canChooseVisibility={me?.capabilities.canManageSharedMcps}
            onCancel={() => setModal(null)}
            onSubmit={(body) => createMutation.mutate(body as CreateUpstream)}
          />
        </Modal>
      ) : null}

      {modal && modal !== "create" ? (
        <Modal
          title={
            me && canManageUpstream(modal, me)
              ? `Edit ${modal.name}`
              : modal.name
          }
          onClose={() => setModal(null)}
        >
          <UpstreamForm
            initial={modal}
            error={formError}
            submitting={updateMutation.isPending}
            readOnly={Boolean(me && !canManageUpstream(modal, me))}
            onCancel={() => setModal(null)}
            onSubmit={(body) =>
              updateMutation.mutate({ id: modal.id, body })
            }
          />
        </Modal>
      ) : null}

      {grantsFor ? (
        <Modal
          title={`Share ${grantsFor.name}`}
          onClose={() => setGrantsFor(null)}
        >
          <UpstreamGrantsPanel
            upstream={grantsFor}
            onClose={() => setGrantsFor(null)}
          />
        </Modal>
      ) : null}
    </div>
  );
}
