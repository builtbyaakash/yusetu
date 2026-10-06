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
import {
  ConfirmDialog,
  type ConfirmIntent,
} from "../components/ConfirmDialog";
import { Drawer } from "../components/Drawer";
import { Menu, type MenuItem } from "../components/Menu";
import { Modal } from "../components/Modal";
import { Pagination, useClientPage } from "../components/Pagination";
import { EmptyState, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
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

type PageSurface =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; upstream: Upstream }
  | { kind: "detail"; upstream: Upstream }
  | { kind: "share"; upstream: Upstream };

type ManageAction = {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
};

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

  function liveUpstream(upstream: Upstream): Upstream {
    return query.data?.find((row) => row.id === upstream.id) ?? upstream;
  }

  function closeSurface() {
    setFormError(null);
    setSurface({ kind: "none" });
  }

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
    // Open synchronously under the user gesture; await would get a blank/blocked popup.
    const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
    try {
      const { authorizationUrl, status } = await upstreamsApi.startOauth(id);
      if (authorizationUrl) {
        if (popup) {
          popup.location.href = authorizationUrl;
        } else {
          window.location.assign(authorizationUrl);
          return;
        }
      } else {
        popup?.close();
        if (status === "connected") {
          invalidate();
          setOauthAlert({
            type: "success",
            message: "OAuth already connected.",
          });
          setOauthBusyId(null);
          return;
        }
        setOauthAlert({
          type: "error",
          message: "OAuth did not return an authorization URL. Try again.",
        });
        setOauthBusyId(null);
        return;
      }
      const started = Date.now();
      const poll = window.setInterval(() => {
        void (async () => {
          try {
            const oauthStatus = await upstreamsApi.oauthStatus(id);
            if (oauthStatus.connected || oauthStatus.status === "error") {
              window.clearInterval(poll);
              setOauthBusyId(null);
              invalidate();
              void queryClient.invalidateQueries({ queryKey: ["tools"] });
              setOauthAlert({
                type: oauthStatus.connected ? "success" : "error",
                message: oauthStatus.connected
                  ? "OAuth connected. You can close the auth tab."
                  : oauthStatus.errorMessage ??
                    "OAuth connection failed. Try Connect OAuth again.",
              });
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
      popup?.close();
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
      setSurface({ kind: "none" });
      setFormError(null);
      setDiscoveryAlert(
        created.discoveryError
          ? `MCP created, but tool discovery failed: ${created.discoveryError}. Use Rediscover after the server is reachable.`
          : null,
      );
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      toast.push(`Added ${created.name}.`, "success");
      if (variables.authMode === "oauth") {
        setConfirm({
          title: "Connect OAuth",
          message: `"${created.name}" is ready. Connect OAuth now?`,
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
    onSuccess: (updated) => {
      setSurface({ kind: "none" });
      setFormError(null);
      invalidate();
      toast.push(`Saved ${updated.name}.`, "success");
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : "Update failed.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) => upstreamsApi.remove(id),
    onSuccess: (_data, variables) => {
      setSurface((current) =>
        current.kind !== "none" &&
        current.kind !== "create" &&
        current.upstream.id === variables.id
          ? { kind: "none" }
          : current,
      );
      invalidate();
      toast.push(`Deleted ${variables.name}.`, "success");
    },
    onError: (err) => {
      toast.push(
        err instanceof ApiError ? err.message : "Delete failed.",
        "error",
      );
    },
  });

  const discoverMutation = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      upstreamsApi.discover(id),
    onSuccess: (updated, variables) => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tools"] });
      if (updated.discoveryError) {
        toast.push(
          `Rediscover failed for ${variables.name}. ${updated.discoveryError}`,
          "error",
        );
        return;
      }
      const count = updated.discovered ?? updated.toolCount;
      toast.push(
        count != null
          ? `Rediscovered ${count} tools for ${variables.name}.`
          : `Rediscovered tools for ${variables.name}.`,
        "success",
      );
    },
    onError: (err) => {
      toast.push(
        err instanceof ApiError ? err.message : "Rediscover failed.",
        "error",
      );
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({
      id,
      enabled,
    }: {
      id: string;
      enabled: boolean;
      name: string;
    }) => upstreamsApi.update(id, { enabled }),
    onSuccess: (_data, variables) => {
      invalidate();
      toast.push(
        variables.enabled
          ? `Enabled ${variables.name}.`
          : `Disabled ${variables.name}.`,
        "success",
      );
    },
    onError: (err) => {
      toast.push(
        err instanceof ApiError ? err.message : "Update failed.",
        "error",
      );
    },
  });

  function openCreate() {
    setFormError(null);
    setSurface({ kind: "create" });
  }

  function openEdit(upstream: Upstream) {
    setFormError(null);
    setSurface({ kind: "edit", upstream });
  }

  function openDetail(upstream: Upstream) {
    setSurface({ kind: "detail", upstream });
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
          err instanceof ApiError ? err.message : "Failed to open share panel.",
      });
    } finally {
      setShareBusyId(null);
    }
  }

  function askDelete(u: Upstream) {
    setConfirm({
      title: "Delete MCP",
      message: `Delete "${u.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        setConfirm(null);
        deleteMutation.mutate({ id: u.id, name: u.name });
      },
    });
  }

  function askDisconnect(u: Upstream) {
    setConfirm({
      title: "Disconnect OAuth",
      message: `Disconnect OAuth for "${u.name}"?`,
      confirmLabel: "Disconnect",
      danger: true,
      onConfirm: () => {
        setConfirm(null);
        void disconnectOauth(u.id);
      },
    });
  }

  function isOauthConnected(u: Upstream) {
    return u.authMode === "oauth" && u.oauthStatus === "connected";
  }

  function needsOauthConnect(u: Upstream) {
    return u.authMode === "oauth" && u.oauthStatus !== "connected";
  }

  function manageActions(u: Upstream): ManageAction[] {
    if (!me || !canManageUpstream(u, me)) return [];
    const actions: ManageAction[] = [
      { id: "edit", label: "Edit", run: () => openEdit(u) },
    ];
    if (me.capabilities.canManageSharedMcps) {
      actions.push({
        id: "share",
        label: shareBusyId === u.id ? "Sharing…" : "Share",
        disabled: shareBusyId === u.id,
        run: () => void openShare(u),
      });
    }
    actions.push(
      {
        id: "rediscover",
        label: "Rediscover",
        disabled: discoverMutation.isPending,
        run: () => discoverMutation.mutate({ id: u.id, name: u.name }),
      },
      {
        id: "delete",
        label: "Delete",
        danger: true,
        disabled: deleteMutation.isPending,
        run: () => askDelete(u),
      },
    );
    return actions;
  }

  const filterOptions: { value: VisibilityFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "shared", label: "Shared" },
    { value: "personal", label: "Mine" },
  ];

  const detail =
    surface.kind === "detail" ? liveUpstream(surface.upstream) : null;
  const editing =
    surface.kind === "edit" ? surface.upstream : null;
  const sharing = surface.kind === "share" ? surface.upstream : null;
  const detailActions = detail ? manageActions(detail) : [];

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

      {!query.isLoading && query.data && query.data.length === 0 ? (
        <EmptyState
          title="No MCPs yet"
          body="Add a server and Yusetu will discover its tools."
          action={
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              Add MCP
            </button>
          }
        />
      ) : null}

      {!query.isLoading &&
      query.data &&
      query.data.length > 0 &&
      filteredUpstreams.length === 0 ? (
        <EmptyState
          title="No MCPs in this view"
          body="Nothing matches this filter."
          action={
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setVisibilityFilter("all")}
            >
              Show all
            </button>
          }
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
                  const actions = manageActions(u);
                  const menuItems: MenuItem[] = actions.map((action) => ({
                    id: action.id,
                    label: action.label,
                    danger: action.danger,
                    disabled: action.disabled,
                    onSelect: action.run,
                  }));
                  return (
                    <tr
                      key={u.id}
                      className="mcp-row-clickable"
                      tabIndex={0}
                      aria-label={`Open ${u.name}`}
                      onClick={() => openDetail(u)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter") openDetail(u);
                      }}
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
                              onClick={(event) => {
                                event.stopPropagation();
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
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Toggle
                          checked={u.enabled}
                          aria-label={`Enable ${u.name}`}
                          disabled={toggleMutation.isPending || !manageable}
                          onChange={(enabled) =>
                            toggleMutation.mutate({
                              id: u.id,
                              enabled,
                              name: u.name,
                            })
                          }
                        />
                      </td>
                      <td
                        className="col-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {menuItems.length > 0 ? (
                          <Menu label="More" items={menuItems} align="end" />
                        ) : null}
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
        <Drawer title="Add MCP" wide onClose={closeSurface}>
          <UpstreamForm
            error={formError}
            submitting={createMutation.isPending}
            onCancel={closeSurface}
            onSubmit={(body) => createMutation.mutate(body as CreateUpstream)}
          />
        </Drawer>
      ) : null}

      {editing ? (
        <Drawer title={`Edit ${editing.name}`} wide onClose={closeSurface}>
          <UpstreamForm
            key={editing.id}
            initial={editing}
            error={formError}
            submitting={updateMutation.isPending}
            readOnly={Boolean(me && !canManageUpstream(editing, me))}
            onCancel={closeSurface}
            onSubmit={(body) =>
              updateMutation.mutate({ id: editing.id, body })
            }
          />
        </Drawer>
      ) : null}

      {detail ? (
        <Drawer
          title={detail.name}
          onClose={closeSurface}
          footer={
            detailActions.length > 0 ? (
              <>
                {detailActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className={
                      action.danger ? "btn btn-danger btn-sm" : "btn btn-ghost btn-sm"
                    }
                    disabled={action.disabled}
                    onClick={action.run}
                  >
                    {action.label}
                  </button>
                ))}
              </>
            ) : undefined
          }
        >
          <div className="mcp-detail-grid">
            <DetailRow label="Name">{detail.name}</DetailRow>
            <DetailRow label="Slug">
              <code>{detail.slug}</code>
            </DetailRow>
            <DetailRow label="Transport">
              <div className="badge-group">
                <span className="badge badge-muted">{detail.transport}</span>
                {detail.gitUrl ? (
                  <span className="badge badge-muted">git</span>
                ) : null}
              </div>
            </DetailRow>
            <DetailRow label="Status">{statusBadge(detail.status)}</DetailRow>
            <DetailRow label="OAuth">
              {detail.authMode === "oauth" ? (
                <div className="row-actions">
                  {oauthBadge(detail.oauthStatus, detail.oauthError)}
                  {needsOauthConnect(detail) ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={oauthBusyId === detail.id}
                      onClick={() => void startOauthFlow(detail.id)}
                    >
                      {oauthBusyId === detail.id ? "Connecting…" : "Connect"}
                    </button>
                  ) : null}
                  {isOauthConnected(detail) ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={oauthBusyId === detail.id}
                      onClick={() => askDisconnect(detail)}
                    >
                      {oauthBusyId === detail.id
                        ? "Disconnecting…"
                        : "Disconnect"}
                    </button>
                  ) : null}
                </div>
              ) : (
                "Not used"
              )}
            </DetailRow>
            <DetailRow label="Tools">{detail.toolCount ?? "—"}</DetailRow>
            <DetailRow label="Visibility">
              {visibilityBadge(detail.visibility)}
            </DetailRow>
          </div>
        </Drawer>
      ) : null}

      {sharing ? (
        <Modal title={`Share ${sharing.name}`} onClose={closeSurface}>
          <UpstreamGrantsPanel
            upstream={sharing}
            onClose={closeSurface}
            onUnshared={() => {
              closeSurface();
              invalidate();
            }}
          />
        </Modal>
      ) : null}

      <ConfirmDialog intent={confirm} onDismiss={() => setConfirm(null)} />
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mcp-detail-row">
      <span className="mcp-detail-label">{label}</span>
      <div className="mcp-detail-value">{children}</div>
    </div>
  );
}
