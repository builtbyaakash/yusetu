import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { teamApi, upstreamsApi } from "../api";
import type { Upstream, UpstreamGrant } from "../api/types";

type GrantsPanelProps = {
  upstream: Upstream;
  onClose: () => void;
};

export function UpstreamGrantsPanel({ upstream, onClose }: GrantsPanelProps) {
  const queryClient = useQueryClient();
  const [addUserId, setAddUserId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const grantsQuery = useQuery({
    queryKey: ["upstreams", upstream.id, "grants"],
    queryFn: () => upstreamsApi.listGrants(upstream.id),
  });

  const membersQuery = useQuery({
    queryKey: ["team", "members"],
    queryFn: () => teamApi.listMembers(),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["upstreams", upstream.id, "grants"],
    });
    void queryClient.invalidateQueries({ queryKey: ["upstreams"] });
  };

  const createMutation = useMutation({
    mutationFn: (userId: string) =>
      upstreamsApi.createGrant(upstream.id, { userId }),
    onSuccess: () => {
      setAddUserId("");
      setFormError(null);
      invalidate();
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError ? err.message : "Failed to add grant.",
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) =>
      upstreamsApi.revokeGrant(upstream.id, userId),
    onSuccess: () => {
      setFormError(null);
      invalidate();
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError ? err.message : "Failed to revoke grant.",
      );
    },
  });

  const grantedIds = useMemo(() => {
    const rows = grantsQuery.data ?? [];
    return new Set(rows.map((g: UpstreamGrant) => g.userId));
  }, [grantsQuery.data]);

  const addableMembers = useMemo(() => {
    const members = membersQuery.data ?? [];
    return members.filter(
      (m) => m.role === "member" && !grantedIds.has(m.id),
    );
  }, [membersQuery.data, grantedIds]);

  return (
    <div className="stack">
      <p className="hint">
        Members listed here can use “{upstream.name}”. Others never see it.
        Owners and admins always have access.
      </p>

      {formError ? <div className="alert alert-error">{formError}</div> : null}
      {grantsQuery.error ? (
        <div className="alert alert-error">
          {grantsQuery.error instanceof ApiError
            ? grantsQuery.error.message
            : "Failed to load grants."}
        </div>
      ) : null}

      {grantsQuery.isLoading ? <div className="empty">Loading grants…</div> : null}

      {(grantsQuery.data?.length ?? 0) === 0 && !grantsQuery.isLoading ? (
        <div className="empty">No member grants yet.</div>
      ) : null}

      {(grantsQuery.data?.length ?? 0) > 0 ? (
        <ul className="grant-roster">
          {grantsQuery.data!.map((g) => (
            <li key={g.id} className="grant-row">
              <span className="grant-row-name">{g.username}</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={revokeMutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke access for “${g.username}”? They will stop seeing this MCP.`,
                    )
                  ) {
                    revokeMutation.mutate(g.userId);
                  }
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!addUserId) return;
          createMutation.mutate(addUserId);
        }}
      >
        <div className="field">
          <label htmlFor={`grant-member-${upstream.id}`}>Add member</label>
          <select
            id={`grant-member-${upstream.id}`}
            className="select"
            value={addUserId}
            onChange={(e) => setAddUserId(e.target.value)}
            disabled={membersQuery.isLoading || addableMembers.length === 0}
          >
            <option value="">
              {addableMembers.length === 0
                ? "No members left to grant"
                : "Select a member…"}
            </option>
            {addableMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.username}
              </option>
            ))}
          </select>
        </div>
        <div className="row-actions form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!addUserId || createMutation.isPending}
          >
            {createMutation.isPending ? "Adding…" : "Grant access"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </form>
    </div>
  );
}
