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
import { ConfirmDialog, type ConfirmIntent } from "../components/ConfirmDialog";
import { Drawer } from "../components/Drawer";
import { Menu } from "../components/Menu";
import { Modal } from "../components/Modal";
import { Pagination, useClientPage } from "../components/Pagination";
import { EmptyState, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { Toggle } from "../components/Toggle";
import { UpstreamForm } from "../components/UpstreamForm";
import { UpstreamGrantsPanel } from "../components/UpstreamGrantsPanel";

type VisibilityFilter = "all" | UpstreamVisibility;

type PageSurface =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; upstream: Upstream }
  | { kind: "detail"; upstream: Upstream }
  | { kind: "share"; upstream: Upstream };

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

function visibilityBadge(visibility?: UpstreamVisibility) {
  if (visibility === "shared") {
    return <span className="badge badge-success">Shared</span>;
  }
  return <span className="badge badge-muted">Mine</span>;
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
        <span className="badge badge-danger" title={error ?? "OAuth error"}>
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
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [surface, setSurface] = useState<PageSurface>({ kind: "none" });
  const [confirm, setConfirm] = useState<ConfirmIntent | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [oauthAlert, setOauthAlert] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [discoveryAlert, setDiscoveryAlert] = useState<string | null>(null);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>("all");
  const [shareBusyId, setShareBusyId] = useState<string | null>(null);

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

  const {
    page: mcpPage,
    setPage: setMcpPage,
    pageItems: pagedUpstreams,
    total: mcpTotal,
  } = useClientPage(filteredUpstreams);

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
      toast.push("OAuth connected.", "success");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clear oauth query once
  }, [searchParams, setSearchParams]);

  async function startOauthFlow(id: string) {
    setOauthBusyId(id);
    setOauthAlert(null);
    try {
      const { authorizationUrl } = await upstreamsApi.startOauth(id);
      window.open(authorizationUrl, "_blank", "noopener,noreferrer");
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
              const ok = status.connected;
              setOauthAlert({
                type: ok ? "success" : "error",
                message: ok
                  ? "OAuth connected. You can close the auth tab."
                  : status.errorMessage ??
                    "OAuth connection failed. Try Connect OAuth again.",
              });
              toast.push(
                ok ? "OAuth connected." : "OAuth connection failed.",
                ok ? "success" : "error",
              );
            } else if (Date.now() - started > 5 * 60 * 1000) {
              window.clearInterval(poll);
              setOauthBusyId(null);
              setOauthAlert({
                type: "error",
                message:
                  "OAuth timed out. Finish login in the other tab, or try again.",
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
      setConfirm(null);
      setOauthAlert({ type: "success", message: "OAuth disconnected." });
      toast.push("OAuth disconnected.", "success");
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
      setSurface({ kind: "none" });
      setFormError(null);
      setDiscoveryAlert(
        created.discoveryError
          ? `MCP created, but tool discovery failed: ${created.discoveryError}. Use Rediscover after the server is reachable.`
          : null,
      );
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      toast.push(`“${created.name}” created.`, "success");
      if (variables.authMode === "oauth") {
        setConfirm({
          title: "Connect OAuth?",
          message: `MCP “${created.name}” was created. Connect OAuth now?`,
          confirmLabel: "Connect OAuth",
          onConfirm: () => {
            setConfirm(null);
            void startOauthFlow(created.id);
          },
        });
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
      setSurface({ kind: "none" });
      setFormError(null);
      invalidate();
      toast.push("MCP updated.", "success");
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : "Update failed.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => upstreamsApi.remove(id),
    onSuccess: () => {
      setConfirm(null);
      setSurface({ kind: "none" });
      invalidate();
      toast.push("MCP deleted.", "success");
    },
  });

  const discoverMutation = useMutation({
    mutationFn: (id: string) => upstreamsApi.discover(id),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      toast.push("Tools rediscovered.", "success");
    },
    onError: (err) => {
      toast.push(
        err instanceof ApiError ? err.message : "Rediscover failed.",
        "error",
      );
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      upstreamsApi.update(id, { enabled }),
    onSuccess: (_data, vars) => {
      invalidate();
      toast.push(vars.enabled ? "MCP enabled." : "MCP disabled.", "success");
    },
  });

  function openCreate() {
    setFormError(null);
    setSurface({ kind: "create" });
  }

  async function openShare(u: Upstream) {
    if (!me?.capabilities.canManageSharedMcps) return;
    setShareBusyId(u.id);
    setOauthAlert(null);
    try {
      let target = u;
      if ((u.visibility ?? "personal") === "personal") {
        const promoted = await upstreamsApi.promote(u.id);
        target = {
          ...u,
          visibility: promoted.visibility ?? "shared",
          ownerUserId: promoted.ownerUserId ?? null,
        };
        invalidate();
      }
      setSurface({ kind: "share", upstream: target });
    } catch (err) {
      setOauthAlert({
        type: "error",
        message:
          err instanceof ApiError
            ? err.message
            : "Failed to open share panel.",
      });
    } finally {
      setShareBusyId(null);
    }
  }

  function isOauthConnected(u: Upstream) {
    return u.authMode === "oauth" && u.oauthStatus === "connected";
  }

  function needsOauthConnect(u: Upstream) {
    return u.authMode === "oauth" && u.oauthStatus !== "connected";
  }

  const detailUpstream =
    surface.kind === "detail"
      ? (query.data?.find((u) => u.id === surface.upstream.id) ??
        surface.upstream)
      : null;

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
          <p>Tools are discovered on add; Rediscover refreshes.</p>
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

      {query.isLoading ? <TableSkeleton rows={6} cols={7} /> : null}
      {query.error ? (
        <div className="alert alert-error">
          {query.error instanceof ApiError
            ? query.error.message
            : "Failed to load MCPs."}
        </div>
      ) : null}

      {query.data && query.data.length === 0 ? (
        <EmptyState
          title="No MCPs yet"
          body="Add your first MCP server. Tools discover on create; then group them and mint a scoped key."
          action={
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              Add MCP
            </button>
          }
        />
      ) : null}

      {query.data &&
      query.data.length > 0 &&
      filteredUpstreams.length === 0 ? (
        <EmptyState
          title="No MCPs match this filter"
          body="Try All, or switch between Shared and Mine."
        />
      ) : null}

      {filteredUpstreams.length > 0 ? (
        <>
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
                {pagedUpstreams.map((u) => {
                  const manageable = me ? canManageUpstream(u, me) : false;
                  return (
                    <tr
                      key={u.id}
                      className="mcp-row-clickable"
                      onClick={() =>
                        setSurface({ kind: "detail", upstream: u })
                      }
                    >
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
                          <span className="badge badge-muted">
                            {u.transport}
                          </span>
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
                              onClick={(e) => {
                                e.stopPropagation();
                                void startOauthFlow(u.id);
                              }}
                            >
                              {oauthBusyId === u.id ? "Connecting…" : "Connect"}
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="col-num">{u.toolCount ?? "—"}</td>
                      <td
                        className="col-enabled"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Toggle
                          checked={u.enabled}
                          aria-label={`Enable ${u.name}`}
                          disabled={toggleMutation.isPending || !manageable}
                          onChange={(enabled) =>
                            toggleMutation.mutate({ id: u.id, enabled })
                          }
                        />
                      </td>
                      <td
                        className="col-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Menu
                          label="More"
                          align="end"
                          items={[
                            {
                              id: "edit",
                              label: manageable ? "Edit" : "View",
                              onSelect: () => {
                                setFormError(null);
                                setSurface({ kind: "edit", upstream: u });
                              },
                            },
                            ...(manageable && me?.capabilities.canManageSharedMcps
                              ? [
                                  {
                                    id: "share",
                                    label:
                                      shareBusyId === u.id
                                        ? "Sharing…"
                                        : "Share",
                                    disabled: shareBusyId === u.id,
                                    onSelect: () => void openShare(u),
                                  },
                                ]
                              : []),
                            ...(manageable
                              ? [
                                  {
                                    id: "rediscover",
                                    label: "Rediscover",
                                    disabled: discoverMutation.isPending,
                                    onSelect: () =>
                                      discoverMutation.mutate(u.id),
                                  },
                                  {
                                    id: "delete",
                                    label: "Delete",
                                    danger: true,
                                    disabled: deleteMutation.isPending,
                                    onSelect: () =>
                                      setConfirm({
                                        title: "Delete MCP",
                                        message: `Delete “${u.name}”? This cannot be undone.`,
                                        confirmLabel: "Delete",
                                        danger: true,
                                        onConfirm: () =>
                                          deleteMutation.mutate(u.id),
                                      }),
                                  },
                                ]
                              : []),
                          ]}
                        />
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
        </>
      ) : null}

      {surface.kind === "create" ? (
        <Drawer
          wide
          title="Add MCP"
          onClose={() => setSurface({ kind: "none" })}
        >
          <UpstreamForm
            error={formError}
            submitting={createMutation.isPending}
            onCancel={() => setSurface({ kind: "none" })}
            onSubmit={(body) => createMutation.mutate(body as CreateUpstream)}
          />
        </Drawer>
      ) : null}

      {surface.kind === "edit" ? (
        <Drawer
          wide
          title={
            me && canManageUpstream(surface.upstream, me)
              ? `Edit ${surface.upstream.name}`
              : surface.upstream.name
          }
          onClose={() => setSurface({ kind: "none" })}
        >
          <UpstreamForm
            initial={surface.upstream}
            error={formError}
            submitting={updateMutation.isPending}
            readOnly={Boolean(me && !canManageUpstream(surface.upstream, me))}
            onCancel={() => setSurface({ kind: "none" })}
            onSubmit={(body) =>
              updateMutation.mutate({ id: surface.upstream.id, body })
            }
          />
        </Drawer>
      ) : null}

      {detailUpstream ? (
        <Drawer
          title={detailUpstream.name}
          onClose={() => setSurface({ kind: "none" })}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setFormError(null);
                  setSurface({ kind: "edit", upstream: detailUpstream });
                }}
              >
                {me && canManageUpstream(detailUpstream, me) ? "Edit" : "View"}
              </button>
              {me && canManageUpstream(detailUpstream, me) ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={discoverMutation.isPending}
                  onClick={() => discoverMutation.mutate(detailUpstream.id)}
                >
                  Rediscover
                </button>
              ) : null}
            </>
          }
        >
          <div className="mcp-detail-grid">
            <div className="mcp-detail-row">
              <span className="mcp-detail-label">Slug</span>
              <code className="cell-slug">{detailUpstream.slug}</code>
            </div>
            <div className="mcp-detail-row">
              <span className="mcp-detail-label">Transport</span>
              <div className="badge-group">
                <span className="badge badge-muted">
                  {detailUpstream.transport}
                </span>
                {detailUpstream.gitUrl ? (
                  <span className="badge badge-muted">git</span>
                ) : null}
              </div>
            </div>
            <div className="mcp-detail-row">
              <span className="mcp-detail-label">Visibility</span>
              <div>{visibilityBadge(detailUpstream.visibility)}</div>
            </div>
            <div className="mcp-detail-row">
              <span className="mcp-detail-label">Status</span>
              <div className="badge-group">
                {statusBadge(detailUpstream.status)}
                {detailUpstream.authMode === "oauth"
                  ? oauthBadge(
                      detailUpstream.oauthStatus,
                      detailUpstream.oauthError,
                    )
                  : null}
              </div>
            </div>
            <div className="mcp-detail-row">
              <span className="mcp-detail-label">Tools</span>
              <span className="mcp-detail-value">
                {detailUpstream.toolCount ?? "—"}
              </span>
            </div>
            {detailUpstream.authMode === "oauth" ? (
              <div className="mcp-detail-row">
                <span className="mcp-detail-label">OAuth</span>
                <div className="row-actions">
                  {needsOauthConnect(detailUpstream) ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={oauthBusyId === detailUpstream.id}
                      onClick={() => void startOauthFlow(detailUpstream.id)}
                    >
                      {oauthBusyId === detailUpstream.id
                        ? "Connecting…"
                        : "Connect OAuth"}
                    </button>
                  ) : null}
                  {isOauthConnected(detailUpstream) ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={oauthBusyId === detailUpstream.id}
                      onClick={() =>
                        setConfirm({
                          title: "Disconnect OAuth",
                          message: `Disconnect OAuth for “${detailUpstream.name}”?`,
                          confirmLabel: "Disconnect",
                          danger: true,
                          onConfirm: () =>
                            void disconnectOauth(detailUpstream.id),
                        })
                      }
                    >
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </Drawer>
      ) : null}

      {surface.kind === "share" ? (
        <Modal
          title={`Share ${surface.upstream.name}`}
          onClose={() => setSurface({ kind: "none" })}
        >
          <UpstreamGrantsPanel
            upstream={surface.upstream}
            onClose={() => setSurface({ kind: "none" })}
            onUnshared={() => {
              setSurface({ kind: "none" });
              invalidate();
            }}
          />
        </Modal>
      ) : null}

      <ConfirmDialog
        intent={confirm}
        onDismiss={() => setConfirm(null)}
        busy={deleteMutation.isPending || oauthBusyId != null}
      />
    </div>
  );
}
