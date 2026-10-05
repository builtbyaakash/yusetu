import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { mcpGroupsApi, upstreamsApi } from "../api";
import type { McpGroup } from "../api/types";
import { ConfirmDialog, type ConfirmIntent } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { EmptyState, TableSkeleton } from "../components/Skeleton";

export function GroupsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<McpGroup | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<ConfirmIntent | null>(null);

  const groupsQuery = useQuery({
    queryKey: ["mcp-groups"],
    queryFn: () => mcpGroupsApi.list(),
  });

  const upstreamsQuery = useQuery({
    queryKey: ["upstreams"],
    queryFn: () => upstreamsApi.list(),
  });

  useEffect(() => {
    if (!editing) return;
    setRenameValue(editing.name);
    setMemberIds([...editing.upstreamIds]);
  }, [editing]);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["mcp-groups"] });

  const createMutation = useMutation({
    mutationFn: (groupName: string) => mcpGroupsApi.create({ name: groupName }),
    onSuccess: () => {
      setName("");
      invalidate();
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, nextName }: { id: string; nextName: string }) =>
      mcpGroupsApi.update(id, { name: nextName }),
    onSuccess: (updated) => {
      setEditing(updated);
      invalidate();
    },
  });

  const membersMutation = useMutation({
    mutationFn: ({
      id,
      upstreamIds,
    }: {
      id: string;
      upstreamIds: string[];
    }) => mcpGroupsApi.replaceMembers(id, { upstreamIds }),
    onSuccess: (updated) => {
      setEditing(updated);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => mcpGroupsApi.remove(id),
    onSuccess: () => {
      setEditing(null);
      setConfirm(null);
      invalidate();
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  }

  function handleRename(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === editing.name) return;
    renameMutation.mutate({ id: editing.id, nextName: trimmed });
  }

  function handleSaveMembers(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    membersMutation.mutate({ id: editing.id, upstreamIds: memberIds });
  }

  function toggleMember(upstreamId: string) {
    setMemberIds((prev) =>
      prev.includes(upstreamId)
        ? prev.filter((id) => id !== upstreamId)
        : [...prev, upstreamId],
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Groups</h1>
          <p>
            Bundle visible MCPs by use case. Attach groups to API keys in
            Settings.
          </p>
        </div>
      </div>

      <section className="page-section">
        <h2>Create group</h2>
        <form className="form" onSubmit={handleCreate}>
          {createMutation.error ? (
            <div className="alert alert-error">
              {createMutation.error instanceof ApiError
                ? createMutation.error.message
                : "Failed to create group."}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="group-name">Name</label>
            <input
              id="group-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="coding"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating…" : "Create group"}
          </button>
        </form>
      </section>

      <section className="page-section page-section--wide">
        <h2>Your groups</h2>
        {groupsQuery.isLoading ? <TableSkeleton rows={4} cols={4} /> : null}
        {groupsQuery.error ? (
          <div className="alert alert-error">
            {groupsQuery.error instanceof ApiError
              ? groupsQuery.error.message
              : "Failed to load groups."}
          </div>
        ) : null}
        {groupsQuery.data && groupsQuery.data.length === 0 ? (
          <EmptyState
            title="No groups yet"
            body="Create a group, attach MCPs, then mint a scoped API key for that group."
          />
        ) : null}
        {groupsQuery.data && groupsQuery.data.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Members</th>
                  <th>Created</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {groupsQuery.data.map((group) => (
                  <tr key={group.id}>
                    <td className="cell-name">{group.name}</td>
                    <td>
                      {group.upstreamIds.length === 0
                        ? "None"
                        : `${group.upstreamIds.length} MCP${
                            group.upstreamIds.length === 1 ? "" : "s"
                          }`}
                    </td>
                    <td>{formatDate(group.createdAt)}</td>
                    <td className="col-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditing(group)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={deleteMutation.isPending}
                        onClick={() =>
                          setConfirm({
                            title: "Delete group",
                            message: `Delete “${group.name}”? Keys that only used this group will expose an empty catalog until you attach another.`,
                            confirmLabel: "Delete",
                            danger: true,
                            onConfirm: () => deleteMutation.mutate(group.id),
                          })
                        }
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {editing ? (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <form className="form" onSubmit={handleRename}>
            {renameMutation.error ? (
              <div className="alert alert-error">
                {renameMutation.error instanceof ApiError
                  ? renameMutation.error.message
                  : "Failed to rename group."}
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="rename-group">Name</label>
              <input
                id="rename-group"
                className="input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-ghost btn-sm"
              disabled={
                renameMutation.isPending ||
                renameValue.trim() === editing.name ||
                !renameValue.trim()
              }
            >
              {renameMutation.isPending ? "Saving…" : "Rename"}
            </button>
          </form>

          <form className="form" onSubmit={handleSaveMembers}>
            <h3>Members</h3>
            <p className="hint">
              Choose from MCPs visible in your catalog. Ungrouped MCPs stay
              available in the dashboard but not on scoped keys.
            </p>
            {membersMutation.error ? (
              <div className="alert alert-error">
                {membersMutation.error instanceof ApiError
                  ? membersMutation.error.message
                  : "Failed to update members."}
              </div>
            ) : null}
            {upstreamsQuery.isLoading ? (
              <div className="empty">Loading MCPs…</div>
            ) : null}
            {upstreamsQuery.error ? (
              <div className="alert alert-error">
                {upstreamsQuery.error instanceof ApiError
                  ? upstreamsQuery.error.message
                  : "Failed to load MCPs."}
              </div>
            ) : null}
            {upstreamsQuery.data && upstreamsQuery.data.length === 0 ? (
              <div className="empty">No MCPs in your catalog yet.</div>
            ) : null}
            {upstreamsQuery.data && upstreamsQuery.data.length > 0 ? (
              <div className="field">
                {upstreamsQuery.data.map((u) => (
                  <label key={u.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={memberIds.includes(u.id)}
                      onChange={() => toggleMember(u.id)}
                    />
                    <span>
                      {u.name}
                      <span className="hint"> ({u.slug})</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={membersMutation.isPending}
              >
                {membersMutation.isPending ? "Saving…" : "Save members"}
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

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
